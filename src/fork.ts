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
import { publicClientFor } from "./client.js";
import { encodeMultiSendCall, resolveMultiSendCallOnly } from "./multisend.js";
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
  const info = await readSafe(client, getAddress(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  // 1.0.0 has no ExecutionSuccess event, so a rehearsal could not tell success from failure.
  if (/^1\.0\./.test(info.version)) throw new Error(`Safe ${info.address} is ${info.version}; 1.0.x is unsupported`);

  const normalized = calls.map(normalizeCall);
  if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(client, normalized);
  const [to, value, data, operation] = await safeTxFields(client, info.version, normalized);
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

/** Rejects calldata sent to an address without code: the EVM treats it as a successful no-op. */
export async function assertCallTargetsHaveCode(client: PublicClient, calls: readonly SafeCall[]): Promise<void> {
  for (const [i, call] of calls.entries()) {
    if (call.data === "0x") continue;
    const code = await client.getCode({ address: call.to });
    if (!code || code === "0x") {
      throw new Error(
        `Call ${i} sends calldata to ${call.to}, which has no code here; pass allowCallsWithoutCode if that is intended`,
      );
    }
  }
}

/** Ascending by numeric address value, the order `checkSignatures` requires. Locale-independent. */
export function sortOwners(owners: readonly Address[]): Address[] {
  // Owners are unique, so no two compare equal.
  return [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/**
 * The client version when `provider` is a local Hardhat or Anvil node, else undefined. Impersonation on a live RPC
 * that happens to support it (e.g. a hosted fork) must never be mistaken for a rehearsal.
 */
export async function localNodeVersion(provider: Eip1193Provider): Promise<string | undefined> {
  try {
    const version = String(await provider.request({ method: "web3_clientVersion" }));
    return /^(HardhatNetwork|anvil)\//i.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The first and the deepest message in an error's cause chain; the deepest is the node's, with the revert reason. */
export function describeError(error: unknown): string {
  const messages: string[] = [];
  for (let e: unknown = error; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
    const { shortMessage, details, message } = e as Record<string, unknown>;
    const text = [shortMessage, details, message].find(m => typeof m === "string" && m.length > 0) as
      string | undefined;
    if (text && !messages.includes(text)) messages.push(text);
  }
  const first = messages[0] ?? String(error);
  const deepest = messages.at(-1) ?? first;
  return deepest === first ? first : `${first} (${deepest})`;
}

async function safeTxFields(
  client: PublicClient,
  version: string,
  calls: readonly Required<SafeCall>[],
): Promise<readonly [Address, bigint, Hex, typeof CALL | typeof DELEGATE_CALL]> {
  const [only] = calls;
  if (calls.length === 1 && only) return [only.to, only.value, only.data, CALL];
  return [await resolveMultiSendCallOnly(client, version), 0n, encodeMultiSendCall(calls), DELEGATE_CALL];
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
