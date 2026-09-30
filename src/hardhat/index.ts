import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAddress, http, isAddress, isHex, type Address } from "viem";
import { readSafe } from "../account.js";
import type { AddOptions, SafeBatch } from "../batch.js";
import { publicClientFor } from "../client.js";
import {
  assertCallTargetsHaveCode,
  executeOnFork,
  localNodeVersion,
  type ForkExecution,
  type ForkOptions,
} from "../fork.js";
import { batchFileCalls, createBatchFile, validateChecksum, type BatchFile } from "../tx-builder.js";
import type { Eip1193Provider } from "../types.js";

export interface UnknownSignerTx {
  from: string;
  to?: string;
  value?: string;
  data?: string;
}

export interface HardhatDeployRuntime {
  network: {
    name: string;
    provider: Eip1193Provider;
    // `object`, not `{ url?; httpHeaders? }`: in-process Hardhat's config shares no key with that weak type,
    // so a real `hre` would not be assignable.
    config?: object;
  };
  config?: { paths: { root: string } };
  deployments: {
    catchUnknownSigner(
      action: Promise<unknown> | (() => Promise<unknown>),
      options?: { log?: boolean },
    ): Promise<UnknownSignerTx | null>;
  };
}

// Shown in the Safe UI and excluded from the checksum; the Transaction Builder ignores chainId and Safe on import.
const FORK_MARKER = "FORK REHEARSAL, DO NOT SIGN: ";

/**
 * Runs a hardhat-deploy action (`execute` or `rawTx`). If the `from` account can't be signed for, the call is
 * queued on `batch` under that account instead. Returns true when the call is left to the Safe, including when
 * the same call is already queued (see `SafeBatch.add`).
 */
export async function queueIfUnknownSigner(
  hre: HardhatDeployRuntime,
  batch: SafeBatch,
  action: Promise<unknown> | (() => Promise<unknown>),
  options: AddOptions = {},
): Promise<boolean> {
  // Hand the action to hardhat-deploy before awaiting anything else: an already-started promise that rejects
  // while unobserved would crash Node.
  const run = typeof action === "function" ? action() : action;
  let result: unknown;
  const settled = run.then(
    r => {
      result = r;
    },
    () => undefined,
  );
  const tx = await hre.deployments.catchUnknownSigner(run, { log: false });
  if (!tx) {
    await settled;
    await warnIfSentBySafe(hre, result);
    return false;
  }
  if (!tx.to) throw new Error(`Unsigned tx from ${tx.from} deploys a contract; only calls can be queued for a Safe`);
  const data = tx.data || "0x";
  if (!isHex(data)) throw new Error(`Unsigned tx from ${tx.from} has non-hex data`);
  const from = getAddress(tx.from);
  const to = getAddress(tx.to);
  if (!batch.add(from, { to, data, value: BigInt(tx.value ?? 0) }, options)) {
    console.warn(`Skipped a call from ${from} to ${to}: the same call is already queued for that contract`);
  }
  return true;
}

const checkedSenders = new WeakMap<HardhatDeployRuntime, Set<string>>();

// A Safe has no key, so a receipt sent by one means the node impersonated it (hardhat-deploy's autoImpersonate,
// or an impersonation on the node): the call ran directly instead of being queued and rehearsed through the Safe.
async function warnIfSentBySafe(hre: HardhatDeployRuntime, result: unknown): Promise<void> {
  const from = (result as { from?: unknown } | null | undefined)?.from;
  if (typeof from !== "string" || !isAddress(from, { strict: false })) return;
  const checked = checkedSenders.get(hre) ?? new Set<string>();
  checkedSenders.set(hre, checked);
  if (checked.has(from.toLowerCase())) return;
  checked.add(from.toLowerCase());
  try {
    const client = publicClientFor(hre.network.provider);
    if (!(await readSafe(client, getAddress(from)))) return;
  } catch {
    return;
  }
  console.warn(
    `Safe ${from} executed a call directly because the node impersonates it, so the call was not queued or ` +
      "rehearsed through the Safe. Set HARDHAT_DEPLOY_NO_IMPERSONATION=1 (or `autoImpersonate: false`) and " +
      "don't impersonate the Safe on the node.",
  );
}

export interface FlushOptions {
  name: string;
  description?: string;
  /** Relative to the Hardhat project root. Defaults to `safe-batches/<network>`. */
  outDir?: string;
  /** Execute the written files. Defaults to true on a local Hardhat or Anvil node. */
  rehearse?: boolean;
  /** Allow calls with calldata to addresses without code, which otherwise fail the flush. */
  allowCallsWithoutCode?: boolean;
}

export interface FlushedBatch {
  safe: Address;
  file: string;
  calls: number;
  execution?: ForkExecution;
}

/**
 * Writes one Transaction Builder file per Safe in `batch`. On a local Hardhat or Anvil node the files are read back
 * and executed, so the rehearsal runs exactly what signers will import, and the file name is marked as a fork
 * rehearsal. On any other node, file names carry a timestamp and an existing file is never replaced. If any write
 * or rehearsal fails, every file this flush wrote is removed.
 */
export async function flushSafeBatch(
  hre: HardhatDeployRuntime,
  batch: SafeBatch,
  options: FlushOptions,
): Promise<FlushedBatch[]> {
  if (batch.size === 0) return [];
  const prefix = slug(options.name);
  if (!prefix) throw new Error(`Batch name ${JSON.stringify(options.name)} needs at least one letter or digit`);

  const provider = hre.network.provider;
  const client = publicClientFor(provider);
  const chainId = await client.getChainId();
  // Decided by the node, not the network name: a fork can have any name, and `localhost` can point anywhere.
  const local = (await localNodeVersion(provider)) !== undefined;
  const rehearse = options.rehearse ?? local;

  for (const safe of batch.safes) {
    if (!(await readSafe(client, safe))) throw new Error(`Queued owner ${safe} is not a Safe`);
    if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(client, batch.calls(safe));
  }

  const root = hre.config?.paths.root ?? process.cwd();
  const outDir = path.resolve(root, options.outDir ?? path.join("safe-batches", hre.network.name));
  await mkdir(outDir, { recursive: true });

  const createdAt = Date.now();
  // Live runs flush under fixed names, so a timestamp keeps a second run from colliding with the first.
  const suffix = local ? "" : `-${new Date(createdAt).toISOString().replace(/[-:.]/g, "")}`;
  const flushed: FlushedBatch[] = [];
  try {
    for (const safe of batch.safes) {
      const file = createBatchFile({
        chainId,
        safe,
        calls: batch.calls(safe),
        name: local ? `${FORK_MARKER}${options.name}` : options.name,
        createdAt,
        ...(options.description === undefined ? {} : { description: options.description }),
      });
      const entry = {
        safe,
        file: path.join(outDir, `${prefix}-${chainId}-${safe}${suffix}.json`),
        calls: file.transactions.length,
      };
      await writeFile(entry.file, `${JSON.stringify(file, null, 2)}\n`, { flag: local ? "w" : "wx" });
      flushed.push(entry);
    }
    if (rehearse) {
      const node = nodeProvider(hre);
      const forkOptions = { allowCallsWithoutCode: options.allowCallsWithoutCode ?? false };
      for (const entry of flushed) entry.execution = await executeBatchFileOnFork(node, entry.file, forkOptions);
    }
  } catch (error) {
    // A failed flush must not leave a valid-looking file behind for signers or a retry.
    await Promise.all(flushed.map(({ file }) => rm(file, { force: true })));
    throw error;
  }
  batch.clear();
  return flushed;
}

/**
 * The node itself for an HTTP network such as `localhost`. Hardhat's own provider for a network with `accounts`
 * (e.g. keys from .env) signs every `eth_sendTransaction` locally and rejects impersonated senders (HH103).
 */
export function nodeProvider(hre: HardhatDeployRuntime): Eip1193Provider {
  const { url, httpHeaders } = (hre.network.config ?? {}) as { url?: string; httpHeaders?: Record<string, string> };
  if (!url) return hre.network.provider;
  const transport = http(url, { fetchOptions: { headers: httpHeaders ?? {} }, retryCount: 0, timeout: 120_000 });
  return { request: transport({}).request };
}

export async function readBatchFile(filePath: string): Promise<BatchFile> {
  const file = JSON.parse(await readFile(filePath, "utf8")) as BatchFile;
  if (!validateChecksum(file)) throw new Error(`${filePath} has an invalid checksum`);
  return file;
}

export interface RehearseOptions extends ForkOptions {
  /** Rehearse a file made for another chain, e.g. a mainnet file on a Hardhat fork running as 31337. */
  allowChainMismatch?: boolean;
}

export async function executeBatchFileOnFork(
  provider: Eip1193Provider,
  filePath: string,
  options: RehearseOptions = {},
): Promise<ForkExecution> {
  const file = await readBatchFile(filePath);
  const safe = file.meta.createdFromSafeAddress;
  if (!safe) throw new Error(`${filePath} does not name its Safe (meta.createdFromSafeAddress)`);
  const chainId = await publicClientFor(provider).getChainId();
  if (!options.allowChainMismatch && file.chainId !== String(chainId)) {
    throw new Error(`${filePath} is for chain ${file.chainId}, but the fork runs chain ${chainId}`);
  }
  return executeOnFork(provider, getAddress(safe), batchFileCalls(file), options);
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
