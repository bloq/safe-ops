import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { getAddress, http, isAddress, isHex, type Address } from "viem";
import { readSafe } from "../account.js";
import { CallQueue, type AddOptions } from "../batch.js";
import { sameCall } from "../call.js";
import { describeError, localNodeVersion, publicClientFor } from "../client.js";
import { rehearseSafeBatch, type ForkExecution } from "../fork.js";
import {
  proposeSafeBatch,
  readSafeQueue,
  resolveTxService,
  safeBatchStatus,
  type TxService,
  type ProposalSigner,
  type ProposeSafeBatchResult,
  type SafeProposal,
} from "../propose.js";
import { batchSafe, createSafeBatch, validateSafeBatch, type SafeBatch } from "../tx-builder.js";
import { kept, printFile, printFolder, refused, rehearsed, verdict } from "./output.js";
import type { Eip1193Provider, SafeCall } from "../types.js";

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
  config?: { paths: { root: string }; networks?: Record<string, object> };
  deployments: {
    catchUnknownSigner(
      action: Promise<unknown> | (() => Promise<unknown>),
      options?: { log?: boolean },
    ): Promise<UnknownSignerTx | null>;
  };
  getNamedAccounts?(): Promise<Record<string, string>>;
}

// Shown in the Safe UI and excluded from the checksum. The Transaction Builder still imports a fork file (on another
// chain it only warns), so the marker is what tells signers not to sign it.
const FORK_MARKER = "FORK REHEARSAL, DO NOT SIGN: ";

/** Which Safe Transaction Service to use, for staging, proposing and the tasks. */
export interface SafeServiceOptions {
  /** Defaults to the `SAFE_API_KEY` environment variable; api.safe.global requires one. */
  apiKey?: string;
  /** A service instead of Safe's own for the chain: one URL, or URLs by chain id (e.g. for chains Safe doesn't serve). */
  txServiceUrl?: string | Record<number, string>;
}

function serviceFor(chainId: number, options: SafeServiceOptions): Promise<TxService> {
  const apiKey = options.apiKey ?? process.env.SAFE_API_KEY;
  const { txServiceUrl } = options;
  const url = typeof txServiceUrl === "string" ? txServiceUrl : txServiceUrl?.[chainId];
  return resolveTxService(chainId, { ...(apiKey ? { apiKey } : {}), ...(url ? { txServiceUrl: url } : {}) });
}

export interface StageOptions extends AddOptions, SafeServiceOptions {}

interface StagingRun {
  chainId: number;
  local: boolean;
  dir: string;
  createdAt: number;
  queue: CallQueue;
  files: Map<Address, string>;
  /** Per Safe, checked to be one on first sight: its plain pending proposals on uncontested nonces (none on a fork). */
  safes: Map<Address, Promise<SafeProposal[]>>;
  /** Staging steps run one at a time, so concurrent calls can't race on a file. */
  steps: Promise<unknown>;
}

const runs = new WeakMap<HardhatDeployRuntime, Promise<StagingRun>>();

/**
 * Stages an owner transaction for its Safe. Pass a hardhat-deploy action (`() => execute(...)`): it runs directly
 * when hardhat-deploy can sign for `from`, and is staged when it can't. Or pass what `catchUnknownSigner` returned
 * (`null` stages nothing). Each run stages into one file per Safe, written after every call:
 * `safe-batches/<network>/<timestamp>-<safe>.json` (on a local node, `<safe>.json`, marked as a fork rehearsal).
 * On a live network, a call already pending for the Safe is skipped, so the file holds only what is left to propose.
 * Returns true when the transaction is left to the Safe, including when the same call is already staged or pending.
 * The service options are read on the first call for each Safe.
 */
export async function stageSafeTx(
  hre: HardhatDeployRuntime,
  txOrAction: UnknownSignerTx | null | Promise<unknown> | (() => Promise<unknown>),
  options: StageOptions = {},
): Promise<boolean> {
  const tx =
    typeof txOrAction === "function" || txOrAction instanceof Promise
      ? await catchUnknownSigner(hre, txOrAction)
      : txOrAction;
  if (!tx) return false;
  if (!tx.to) throw new Error(`Unsigned tx from ${tx.from} deploys a contract; only calls can be staged for a Safe`);
  const data = tx.data || "0x";
  if (!isHex(data)) throw new Error(`Unsigned tx from ${tx.from} has non-hex data`);
  const safe = getAddress(tx.from);
  const call = { to: getAddress(tx.to), data, value: BigInt(tx.value ?? 0) };
  const run = await stagingRun(hre);
  const step = run.steps.then(() => stage(hre, run, safe, call, options));
  run.steps = step.catch(() => undefined);
  return step;
}

async function stage(
  hre: HardhatDeployRuntime,
  run: StagingRun,
  safe: Address,
  call: Required<SafeCall>,
  options: StageOptions,
): Promise<boolean> {
  const { chainId, local, dir, createdAt, queue, files, safes } = run;
  let pending = safes.get(safe);
  if (!pending) {
    pending = pendingProposals(hre, run, safe, options);
    safes.set(safe, pending);
    // A failed check (e.g. an RPC blip) is retried by the next call.
    pending.catch(() => safes.delete(safe));
  }
  const proposals = await pending;
  const first = !files.has(safe);
  // A deploy script regenerates calls it can't see queued; proposing them again would make the batch revert or repeat.
  // Pending proposals execute before this file, so only calls staged before anything else for the Safe can be left to
  // them: a later one would run ahead of calls the script made first. Those are kept, and the file reads as partial.
  const queued =
    first && !options.allowDuplicate ? proposals.find(p => p.calls.some(c => sameCall(c, call))) : undefined;
  if (queued) {
    console.warn(`Skipped a call from ${safe} to ${call.to}: it is already pending at nonce ${queued.nonce}`);
    return true;
  }
  if (!queue.add(safe, call, options)) {
    console.warn(`Skipped a call from ${safe} to ${call.to}: the same call is already staged for that contract`);
    return true;
  }

  const stamp = new Date(createdAt).toISOString();
  const file = path.join(dir, `${local ? "" : `${compactStamp(stamp)}-`}${safe6(safe)}.json`);
  files.set(safe, file);
  const title = `Deploy ${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
  const batch = createSafeBatch({
    chainId,
    safe,
    calls: queue.calls(safe),
    name: local ? `${FORK_MARKER}${title}` : title,
    createdAt,
  });
  // A live run never replaces a file it didn't start; a local run replaces its previous rehearsal file.
  await writeFile(file, `${JSON.stringify(batch, null, 2)}\n`, { flag: first && !local ? "wx" : "w" });
  return true;
}

async function pendingProposals(
  hre: HardhatDeployRuntime,
  run: StagingRun,
  safe: Address,
  options: SafeServiceOptions,
): Promise<SafeProposal[]> {
  if (!(await readSafe(hre.network.provider, safe))) throw new Error(`Owner ${safe} is not a Safe`);
  if (run.local) return [];
  try {
    const queue = await readSafeQueue(hre.network.provider, await serviceFor(run.chainId, options), safe);
    // Only a proposal that runs its calls as a batch would can stand in for them, as in safeBatchStatus.
    return queue.proposals.filter(p => p.plain && !queue.contestedNonces.includes(p.nonce));
  } catch (error) {
    // Staging goes on without the check: a file that overlaps pending proposals is kept as partial, never proposed.
    console.warn(`Staging for Safe ${safe} without checking its pending proposals: ${describeError(error)}`);
    return [];
  }
}

function stagingRun(hre: HardhatDeployRuntime): Promise<StagingRun> {
  let run = runs.get(hre);
  if (!run) {
    run = startRun(hre);
    runs.set(hre, run);
    // A run that failed to start (e.g. an RPC blip) is retried by the next call.
    run.catch(() => runs.delete(hre));
  }
  return run;
}

async function startRun(hre: HardhatDeployRuntime): Promise<StagingRun> {
  const dir = stagedDir(hre);
  await mkdir(dir, { recursive: true });
  return {
    chainId: await publicClientFor(hre.network.provider).getChainId(),
    local: await isLocal(hre),
    dir,
    createdAt: Date.now(),
    queue: new CallQueue(),
    files: new Map(),
    safes: new Map(),
    steps: Promise.resolve(),
  };
}

// A fork: the node reports Hardhat or Anvil, or the network has a usual fork name (the node check misses hosted
// forks). Staging marks its files as rehearsals, and proposing never posts from one.
async function isLocal(hre: HardhatDeployRuntime): Promise<boolean> {
  return (
    (await localNodeVersion(hre.network.provider)) !== undefined || ["hardhat", "localhost"].includes(hre.network.name)
  );
}

async function catchUnknownSigner(
  hre: HardhatDeployRuntime,
  action: Promise<unknown> | (() => Promise<unknown>),
): Promise<UnknownSignerTx | null> {
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
  }
  return tx;
}

const checkedSenders = new WeakMap<HardhatDeployRuntime, Set<string>>();

// A Safe has no key, so a receipt sent by one means the node impersonated it (hardhat-deploy's autoImpersonate,
// or an impersonation on the node): the call ran directly instead of being staged and rehearsed through the Safe.
async function warnIfSentBySafe(hre: HardhatDeployRuntime, result: unknown): Promise<void> {
  const from = (result as { from?: unknown } | null | undefined)?.from;
  if (typeof from !== "string" || !isAddress(from, { strict: false })) return;
  const checked = checkedSenders.get(hre) ?? new Set<string>();
  checkedSenders.set(hre, checked);
  if (checked.has(from.toLowerCase())) return;
  checked.add(from.toLowerCase());
  try {
    if (!(await readSafe(hre.network.provider, getAddress(from)))) return;
  } catch {
    return;
  }
  console.warn(
    `Safe ${from} executed a call directly because the node impersonates it, so the call was not staged or ` +
      "rehearsed through the Safe. Set HARDHAT_DEPLOY_NO_IMPERSONATION=1 (or `autoImpersonate: false`) and " +
      "don't impersonate the Safe on the node.",
  );
}

export interface ProposeStagedOptions extends SafeServiceOptions {
  /** An owner or proposer of the Safes. Defaults to Hardhat's `deployer` account, signing with `personal_sign`. */
  signer?: ProposalSigner;
  /** Staged files to handle. Defaults to this run's files, or every staged file for the network if none. */
  files?: string[];
  /** The app the Safe UI names as each proposal's origin. Defaults to `safe-ops`. */
  origin?: string;
  allowCallsWithoutCode?: boolean;
  /**
   * Skip the confirmation for files this run did not stage (explicit `files`, or older staged files). Without it,
   * those are only proposed after a yes on a terminal, and refused without one (e.g. in CI).
   */
  yes?: boolean;
  /** Asks the question; defaults to a [y/N] prompt on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface StagedResult {
  file: string;
  safe: Address;
  /** Set on a live network: what the Safe service said, and the proposal if one was made. */
  status?: ProposeSafeBatchResult;
  /** Set on a local node: the rehearsal through the Safe. */
  execution?: ForkExecution;
  /** Whether the file was deleted: once proposed, pending or executed, it must not be imported again. */
  removed: boolean;
  /** Why the file was not handled: refused (fork file, edited, wrong chain) or failed (e.g. the service said no). */
  failure?: string;
}

/**
 * Handles staged files at the end of a deploy, or later. On a live network each file is checked against its Safe
 * (see `safeBatchStatus`) and proposed exactly as written when fresh, then deleted; a file whose calls are already
 * pending or executed is deleted without proposing; a file that partly overlaps them is kept and reported. Files this
 * run did not stage are first shown as a plan and need a yes (or `yes`). On a local node, or a network named `hardhat`
 * or `localhost`, files are rehearsed through the Safe instead and kept. A file that is refused or fails doesn't stop
 * the others; the call throws at the end if any did.
 */
export async function proposeStagedSafeBatches(
  hre: HardhatDeployRuntime,
  options: ProposeStagedOptions = {},
): Promise<StagedResult[]> {
  const run = await runs.get(hre)?.catch(() => undefined);
  runs.delete(hre);
  await run?.steps;
  const ours = run ? [...run.files.values()] : [];
  const provider = hre.network.provider;
  const local = await isLocal(hre);
  // A fork rehearses only what this run staged: leftovers from other fork runs belong to other state.
  const files = options.files ?? (ours.length > 0 || local ? ours : await listStagedFiles(hre));
  if (!options.files && ours.length > 0) {
    const older = (await listStagedFiles(hre)).filter(f => !ours.includes(f));
    if (older.length > 0) console.log(`Left for later: ${older.map(f => path.basename(f)).join(", ")}\n`);
  }
  const results: StagedResult[] = [];
  const handle = async (file: string, act: (batch: SafeBatch) => Promise<Omit<StagedResult, "file">>) => {
    const batch = await readSafeBatch(file);
    const line = { file, safe: batchSafe(batch), calls: batch.transactions.length };
    try {
      const result = { file, ...(await act(batch)) };
      results.push(result);
      const lines = result.failure
        ? refused(result.failure)
        : result.execution
          ? rehearsed(result.execution.txHash)
          : result.status
            ? verdict(result.status, false)
            : kept();
      printFile(line, lines);
    } catch (error) {
      const failure = describeError(error);
      results.push({ file, safe: line.safe, removed: false, failure });
      printFile(line, refused(failure));
    }
  };

  if (local) {
    const node = nodeProvider(hre);
    for (const file of files) {
      await handle(file, async batch => {
        const execution = await rehearseSafeBatch(node, batch, rehearseOptions(options));
        return { safe: execution.safe, execution, removed: false };
      });
    }
    return finish(results);
  }

  if (files.length === 0) return results;
  const service = await serviceFor(await publicClientFor(provider).getChainId(), options);
  // The deploy that just staged a file is the decision to propose it; anything else is shown first and confirmed.
  // Files from a plan: only those it counted to propose or delete are acted on, whatever changed since.
  const approved = files.some(f => !ours.includes(f)) ? await approve(hre, service, files, options) : undefined;
  if (approved?.size === 0) return results;
  const signer = options.signer ?? (await deployerSigner(hre));
  // After a file for a Safe fails, later ones for it wait: one that may have landed would share their nonce, and one
  // that didn't would end up behind them.
  const stopped = new Set<Address>();
  for (const file of files) {
    await handle(file, async batch => {
      const safe = batchSafe(batch);
      if (stopped.has(safe)) return { safe, removed: false, failure: "skipped: an earlier file for this Safe failed" };
      const refusal = refusalOf(batch, service);
      if (refusal) return { safe, removed: false, failure: refusal };
      if (approved && !approved.has(file)) return { safe, removed: false };
      // Checked again here: the plan may be stale by now.
      const status = await proposeSafeBatch(provider, service, signer, batch, {
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...rehearseOptions(options),
      });
      const removed = shouldDelete(status);
      if (removed) await rm(file, { force: true });
      return { safe, status, removed };
    });
    const last = results.at(-1);
    if (last?.failure) stopped.add(last.safe);
  }
  return finish(results);
}

function finish(results: StagedResult[]): StagedResult[] {
  const failed = results.filter(r => r.failure);
  if (failed.length > 0) {
    const reasons = failed.map(r => `${path.basename(r.file)}: ${r.failure}`).join("; ");
    throw new Error(`${failed.length} staged file(s) refused or failed: ${reasons}`);
  }
  return results;
}

// Prints the plan for `files` and asks whether to carry it out.
async function approve(
  hre: HardhatDeployRuntime,
  service: TxService,
  files: string[],
  options: ProposeStagedOptions,
): Promise<Set<string>> {
  printFolder(stagedDir(hre), files.length);
  const toPropose = new Set<string>();
  const toDelete = new Set<string>();
  const refusals: string[] = [];
  // Fresh files for one Safe are proposed one after another, so each takes the next nonce.
  const nextNonce = new Map<string, bigint>();
  for (const file of files) {
    const batch = await readSafeBatch(file);
    const safe = batchSafe(batch);
    const refusal = refusalOf(batch, service);
    if (refusal) refusals.push(`${path.basename(file)}: ${refusal}`);
    let status = refusal ? undefined : await safeBatchStatus(hre.network.provider, service, batch);
    if (status?.status === "fresh") {
      const nonce = nextNonce.get(safe) ?? status.nextNonce;
      nextNonce.set(safe, nonce + 1n);
      status = { ...status, nextNonce: nonce };
      toPropose.add(file);
    } else if (status && shouldDelete(status)) toDelete.add(file);
    printFile(
      { file, safe, calls: batch.transactions.length },
      refusal ? refused(refusal) : status ? verdict(status, true) : [],
    );
  }
  const approved = new Set([...toPropose, ...toDelete]);
  if (approved.size === 0) {
    if (refusals.length > 0) throw new Error(`${refusals.length} staged file(s) refused: ${refusals.join("; ")}`);
    console.log("Nothing to propose or delete.");
    return approved;
  }
  if (options.yes) return approved;
  const question = `Propose ${toPropose.size} file(s) and delete ${toDelete.size}? [y/N] `;
  return (await ask(question, options)) ? approved : new Set();
}

async function ask(question: string, options: ProposeStagedOptions): Promise<boolean> {
  if (options.confirm) return options.confirm(question);
  if (!process.stdin.isTTY) {
    throw new Error("Not proposing files this run did not stage without a confirmation: use a terminal or --yes");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

// Why a file can't be proposed at all, before asking the Safe service anything.
function refusalOf(batch: SafeBatch, service: TxService): string | undefined {
  // The marker is outside the checksum and isn't posted, so signers would never see it.
  if (batch.meta.name.startsWith(FORK_MARKER)) return "fork rehearsal file, never proposed";
  if (!validateSafeBatch(batch)) return "invalid checksum (edited after staging), refused";
  if (batch.chainId !== String(service.chainId)) return `for chain ${batch.chainId}, refused`;
  return undefined;
}

// Once proposed, pending (on an uncontested nonce) or executed, a file must not be imported or proposed again.
function shouldDelete(result: ProposeSafeBatchResult): boolean {
  return !!result.proposal || (!!result.match && (result.status === "executed" || !result.contested));
}

// What proposeStagedSafeBatches would do with a batch, without proposing or deleting anything.
async function predict(provider: Eip1193Provider, service: TxService, batch: SafeBatch): Promise<string[]> {
  const refusal = refusalOf(batch, service);
  if (refusal) return refused(refusal);
  // One file the service can't answer for (e.g. still indexing its Safe) doesn't hide the others.
  return safeBatchStatus(provider, service, batch).then(
    status => verdict(status, true),
    (error: unknown) => refused(describeError(error)),
  );
}

export interface StagedSafeBatch {
  file: string;
  batch: SafeBatch;
}

/** Staged files for a network (default: the current one), oldest first. */
export async function listStagedSafeBatches(
  hre: HardhatDeployRuntime,
  network = hre.network.name,
): Promise<StagedSafeBatch[]> {
  const files = await listStagedFiles(hre, network);
  return Promise.all(files.map(async file => ({ file, batch: await readSafeBatch(file) })));
}

/**
 * The files this run has staged so far, e.g. to record them or to stop the deploy once something is left to the Safe.
 * Empty once `proposeStagedSafeBatches` has handled them.
 */
export async function stagedFilesThisRun(hre: HardhatDeployRuntime): Promise<string[]> {
  const run = await runs.get(hre)?.catch(() => undefined);
  await run?.steps;
  return run ? [...run.files.values()] : [];
}

/** Deletes a staged file, e.g. one that should never be proposed. */
export async function discardSafeBatch(file: string): Promise<void> {
  await rm(file);
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

interface TaskArgs {
  from?: string;
  file?: string;
  yes?: boolean;
}

/** The part of Hardhat's `task()` builder the Safe tasks use, so this package doesn't import Hardhat. */
export interface TaskDefinition {
  addOptionalParam(name: string, description?: string): TaskDefinition;
  addFlag(name: string, description?: string): TaskDefinition;
  setAction(action: (args: TaskArgs, hre: HardhatDeployRuntime) => Promise<unknown>): TaskDefinition;
}

export interface SafeTasksOptions extends SafeServiceOptions {
  /** The proposer for `safe:propose`. Defaults to Hardhat's `deployer` account. */
  signer?: (hre: HardhatDeployRuntime) => ProposalSigner | Promise<ProposalSigner>;
}

/**
 * Registers `safe:list`, `safe:rehearse`, `safe:propose` and `safe:discard`. In hardhat.config, pass Hardhat's
 * `task`: `registerSafeTasks(task)`.
 */
export function registerSafeTasks(
  task: (name: string, description?: string) => TaskDefinition,
  options: SafeTasksOptions = {},
): void {
  const serviceOptions: SafeServiceOptions = {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.txServiceUrl ? { txServiceUrl: options.txServiceUrl } : {}),
  };

  task("safe:list", "List staged Safe batches and, on a live network, what safe:propose would do with each")
    .addOptionalParam("from", "Network whose staged files to list (default: --network)")
    .setAction(async (args, hre) => {
      const staged = await listStagedSafeBatches(hre, args.from);
      // Status needs the Safe service of the files' own chain: only the live network itself.
      const live = staged.length > 0 && (args.from ?? hre.network.name) === hre.network.name && !(await isLocal(hre));
      const chainId = live ? await publicClientFor(hre.network.provider).getChainId() : undefined;
      const service = chainId === undefined ? undefined : await serviceFor(chainId, serviceOptions);
      printFolder(stagedDir(hre, args.from), staged.length);
      for (const { file, batch } of staged) {
        const lines = service ? await predict(hre.network.provider, service, batch) : [];
        printFile({ file, safe: batchSafe(batch), calls: batch.transactions.length }, lines);
      }
    });

  task("safe:rehearse", "Rehearse staged batches of --from on an in-process fork of it (use --network hardhat)")
    .addOptionalParam("from", "Network whose staged files to rehearse, forked from its URL")
    .addOptionalParam("file", "One staged file instead of all")
    .setAction(async (args, hre) => {
      if (!args.from) throw new Error("Pass --from <network>, e.g. --from mainnet");
      // A reset on any other network would wipe a running node's state.
      if (hre.network.name !== "hardhat") throw new Error("Run safe:rehearse with --network hardhat");
      const { url } = (hre.config?.networks?.[args.from] ?? {}) as { url?: string };
      if (!url) throw new Error(`Network ${args.from} has no URL to fork`);
      const chainId = await publicClientFor({ request: http(url)({}).request }).getChainId();
      await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
      for (const file of args.file ? [args.file] : await listStagedFiles(hre, args.from)) {
        const batch = await readSafeBatch(file);
        // The in-process fork keeps Hardhat's own chain id, so check the batch against the forked chain instead.
        if (batch.chainId !== String(chainId))
          throw new Error(`${path.basename(file)} is for chain ${batch.chainId}, not ${args.from}`);
        const execution = await rehearseSafeBatch(hre.network.provider, batch, { allowChainMismatch: true });
        printFile({ file, safe: execution.safe, calls: batch.transactions.length }, rehearsed(execution.txHash));
      }
    });

  task("safe:propose", "Show the plan for staged Safe batches, then propose them after a yes")
    .addOptionalParam("file", "One staged file instead of all")
    .addFlag("yes", "Skip the confirmation, e.g. in CI")
    .setAction(async (args, hre) => {
      await proposeStagedSafeBatches(hre, {
        files: args.file ? [args.file] : await listStagedFiles(hre),
        ...(args.yes ? { yes: true } : {}),
        ...(options.signer ? { signer: await options.signer(hre) } : {}),
        ...serviceOptions,
      });
    });

  task("safe:discard", "Delete a staged Safe batch")
    .addOptionalParam("file", "The staged file")
    .setAction(async args => {
      if (!args.file) throw new Error("Pass --file <staged file>");
      await discardSafeBatch(args.file);
    });
}

// Signs through Hardhat's provider as the `deployer` named account. proposeSafeBatch checks that the signature
// recovers to that address before posting, so a misconfigured account fails before reaching the service.
async function deployerSigner(hre: HardhatDeployRuntime): Promise<ProposalSigner> {
  const address = (await hre.getNamedAccounts?.())?.deployer;
  if (!address) throw new Error("No proposer: pass `signer`, or set Hardhat's `deployer` named account");
  return {
    address,
    signMessage: ({ message }) =>
      hre.network.provider.request({ method: "personal_sign", params: [message.raw, address] }) as Promise<string>,
  };
}

function rehearseOptions(options: ProposeStagedOptions) {
  return options.allowCallsWithoutCode ? { allowCallsWithoutCode: true } : {};
}

function stagedDir(hre: HardhatDeployRuntime, network = hre.network.name): string {
  return path.resolve(hre.config?.paths.root ?? process.cwd(), "safe-batches", network);
}

async function listStagedFiles(hre: HardhatDeployRuntime, network = hre.network.name): Promise<string[]> {
  const dir = stagedDir(hre, network);
  const names = await readdir(dir).catch(() => []);
  return names
    .filter(n => n.endsWith(".json"))
    .sort()
    .map(n => path.join(dir, n));
}

async function readSafeBatch(file: string): Promise<SafeBatch> {
  return JSON.parse(await readFile(file, "utf8")) as SafeBatch;
}

// "2026-10-01T15:30:00.123Z" -> "20261001T153000Z": sorts in order, unique to the second.
function compactStamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

// The first 6 hex digits name the Safe in a file name; the file holds the full address.
function safe6(safe: Address): string {
  return safe.slice(0, 8).toLowerCase();
}
