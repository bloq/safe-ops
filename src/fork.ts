import {
  concatHex,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  numberToHex,
  pad,
  parseEther,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { CALL, DELEGATE_CALL, EXECUTION_SUCCESS_TOPIC, safeAbi } from "./abi.js";
import { readSafe } from "./account.js";
import { normalizeCall } from "./call.js";
import { assertCallTargetsHaveCode, describeError, localNodeVersion, publicClientFor } from "./client.js";
import { safeTxFields } from "./multisend.js";
import { batchSafe, safeBatchCalls, validateSafeBatch, type SafeBatch } from "./tx-builder.js";
import type { Eip1193Provider, SafeCall } from "./types.js";

export interface ForkExecution {
  safe: Address;
  safeTxHash: Hash;
  txHash: Hash;
  nonce: bigint;
  approvers: Address[];
  /** The Safe transaction's target: the single call's `to`, or MultiSendCallOnly for a batch. */
  to: Address;
  operation: typeof CALL | typeof DELEGATE_CALL;
}

export interface ForkOptions {
  /** Allow a call with calldata to an address that has no code, which would otherwise silently do nothing. */
  allowCallsWithoutCode?: boolean;
}

/**
 * Executes `calls` as one Safe transaction on a fork (Hardhat or Anvil): the first `threshold` owners are
 * impersonated to `approveHash`, then `execTransaction` runs with pre-validated signatures. Batches go through
 * MultiSendCallOnly exactly as the Safe UI would, so the whole batch reverts if any call reverts. Owners stay
 * impersonated afterwards.
 */
export async function executeOnFork(
  provider: Eip1193Provider,
  safe: Address,
  calls: readonly SafeCall[],
  options: ForkOptions = {},
): Promise<ForkExecution> {
  if (calls.length === 0) throw new Error("No calls to execute");
  const node = await localNodeVersion(provider);
  if (!node) throw new Error("Refusing to rehearse: expected a local Hardhat or Anvil node");
  // A Hardhat fork answers eth_call at the fork block with the remote chain id, so a safeTxHash read there differs
  // from the one the Safe computes when executing (GS025). One local block moves calls to the fork's own chain id.
  if (/^HardhatNetwork\//i.test(node)) await provider.request({ method: "hardhat_mine", params: ["0x1"] });
  const client = publicClientFor(provider);
  const info = await readSafe(provider, getAddress(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  // 1.0.0 has no ExecutionSuccess event, so a rehearsal could not tell success from failure.
  if (/^1\.0\./.test(info.version)) throw new Error(`Safe ${info.address} is ${info.version}; 1.0.x is unsupported`);

  const normalized = calls.map(normalizeCall);
  if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(client, normalized);
  const [to, value, data, operation] = await safeTxFields(provider, info.version, normalized);
  const nonce = await client.readContract({ address: info.address, abi: safeAbi, functionName: "nonce" });
  const txArgs = [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
  const safeTxHash = await client.readContract({
    address: info.address,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [...txArgs, nonce],
  });

  const approvers = sortOwners(info.owners.slice(0, Number(info.threshold)));
  const executor = approvers[0];
  if (!executor) throw new Error(`Safe ${info.address} has no owners`);

  for (const owner of approvers) {
    await impersonate(provider, client, owner);
    const approve = encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] });
    await send(provider, client, owner, info.address, approve);
  }

  const signatures = concatHex(approvers.map(o => concatHex([pad(o), pad("0x0"), "0x01"])));
  const exec = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...txArgs, signatures] });
  const receipt = await send(provider, client, executor, info.address, exec);

  if (!emittedExecutionSuccess(receipt.logs, info.address, safeTxHash)) {
    throw new Error(`Safe ${info.address} did not emit ExecutionSuccess for ${safeTxHash}`);
  }
  return { safe: info.address, safeTxHash, txHash: receipt.transactionHash, nonce, approvers, to, operation };
}

export interface RehearseOptions extends ForkOptions {
  /** Rehearse a batch made for another chain, e.g. a mainnet batch on a Hardhat fork running as 31337. */
  allowChainMismatch?: boolean;
}

/** Executes exactly the batch's calls through its Safe on a fork, after checking its checksum and chain. */
export async function rehearseSafeBatch(
  provider: Eip1193Provider,
  batch: SafeBatch,
  options: RehearseOptions = {},
): Promise<ForkExecution> {
  if (!validateSafeBatch(batch)) throw new Error("Batch has an invalid checksum; it was edited after it was written");
  const chainId = await publicClientFor(provider).getChainId();
  if (!options.allowChainMismatch && batch.chainId !== String(chainId)) {
    throw new Error(`Batch is for chain ${batch.chainId}, but the fork runs chain ${chainId}`);
  }
  return executeOnFork(provider, batchSafe(batch), safeBatchCalls(batch), options);
}

interface LogLike {
  address: string;
  topics: readonly (string | undefined)[];
  data: string;
}

/** Whether `safe` emitted ExecutionSuccess for `safeTxHash`: topic1 from 1.4.1 on, the first data word before. */
export function emittedExecutionSuccess(logs: readonly LogLike[], safe: Address, safeTxHash: Hash): boolean {
  const hash = safeTxHash.toLowerCase();
  return logs.some(
    l =>
      isAddressEqual(getAddress(l.address), safe) &&
      l.topics[0] === EXECUTION_SUCCESS_TOPIC &&
      (l.topics[1]?.toLowerCase() === hash || l.data.slice(0, 66).toLowerCase() === hash),
  );
}

/** Ascending by numeric address value, the order `checkSignatures` requires. Locale-independent. */
export function sortOwners(owners: readonly Address[]): Address[] {
  // Owners are unique, so no two compare equal.
  return [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

const MIN_BALANCE = parseEther("1");

async function impersonate(provider: Eip1193Provider, client: PublicClient, account: Address): Promise<void> {
  await provider.request({ method: "hardhat_impersonateAccount", params: [account] });
  if ((await client.getBalance({ address: account })) < MIN_BALANCE) {
    await provider.request({ method: "hardhat_setBalance", params: [account, numberToHex(MIN_BALANCE)] });
  }
}

async function send(provider: Eip1193Provider, client: PublicClient, from: Address, to: Address, data: Hex) {
  try {
    await client.call({ account: from, to, data });
  } catch (error) {
    throw new Error(`Call from ${from} to ${to} would revert: ${describeError(error)}`, { cause: error });
  }
  let hash: Hash;
  try {
    hash = (await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] })) as Hash;
  } catch (error) {
    if (!/HH103|not managed by the node/.test(String(error))) throw error;
    throw new Error(
      `Can't send from impersonated ${from}: this provider signs with local keys (Hardhat \`accounts\`, e.g. from .env). ` +
        "Rehearse through the node itself, e.g. nodeProvider(hre) from @bloq/safe-ops/hardhat.",
      { cause: error },
    );
  }
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} from ${from} reverted`);
  return receipt;
}
