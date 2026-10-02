import {
  batchSafe,
  createSafeBatch,
  describeError,
  localNodeVersion,
  normalizeCall,
  proposeSafeBatch,
  publicClientFor,
  readSafe,
  readSafeQueue,
  rehearseSafeBatch,
  resolveTxService,
  safeBatchStatus,
  sameCall,
  validateSafeBatch
} from "../chunk-XSEYUO2X.js";

// src/hardhat/index.ts
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path2 from "path";
import { createInterface } from "readline/promises";
import { getAddress as getAddress2, http, isAddress, isHex } from "viem";

// src/batch.ts
import { getAddress } from "viem";
var CallQueue = class {
  #groups = /* @__PURE__ */ new Map();
  /** Returns false when the call was dropped as a duplicate. */
  add(safe, call, options = {}) {
    const key = getAddress(safe);
    const normalized = normalizeCall(call);
    const calls = this.#groups.get(key) ?? [];
    const latest = latestCallTo(calls, normalized.to);
    if (!options.allowDuplicate && latest && sameCall(latest, normalized)) return false;
    calls.push(normalized);
    this.#groups.set(key, calls);
    return true;
  }
  get safes() {
    return [...this.#groups.keys()];
  }
  calls(safe) {
    return [...this.#groups.get(getAddress(safe)) ?? []];
  }
  get size() {
    let total = 0;
    for (const calls of this.#groups.values()) total += calls.length;
    return total;
  }
  clear() {
    this.#groups.clear();
  }
};
function latestCallTo(calls, to) {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call?.to === to) return call;
  }
  return void 0;
}

// src/hardhat/output.ts
import path from "path";
var colors = process.stdout.isTTY && !process.env.NO_COLOR;
var paint = (code) => (text) => colors ? `\x1B[${code}m${text}\x1B[0m` : text;
var green = paint(32);
var yellow = paint(33);
var red = paint(31);
var cyan = paint(36);
var dim = paint(2);
var bold = paint(1);
function short(hex) {
  return `${hex.slice(0, 6)}\u2026${hex.slice(-4)}`;
}
var at = (p) => `nonce ${p.nonce} (${short(p.safeTxHash)})`;
function heading({ file, safe, calls }) {
  return `${bold(path.basename(file))}   Safe ${short(safe)}   ${calls} call${calls === 1 ? "" : "s"}`;
}
function verdict(result, planned) {
  const { match } = result;
  const lines = result.proposal ? [green(`\u2192 proposed at ${at(result.proposal)}`)] : result.status === "fresh" ? [cyan(`\u2192 propose at nonce ${result.nextNonce}`)] : match && result.status === "executed" ? [green(`\u2713 already executed at ${at(match)}`) + dim(planned ? " \u2192 delete" : ", deleted")] : match && !result.contested ? [green(`\u2713 already pending at ${at(match)}`) + dim(planned ? " \u2192 delete" : ", deleted")] : match ? [yellow(`\u2717 pending at ${at(match)}, but that nonce has competing proposals`) + dim(" \u2192 keep")] : [
    red(`\u2717 partial: shares calls with ${result.overlapping.map(at).join(", ")}`) + dim(" \u2192 keep"),
    dim(
      result.overlapping.every((p) => p.executed) ? "  part of it already ran: rerun the deploy to stage what is still needed, or discard this file" : "  wait for those to execute or reject them, then rerun the deploy, or discard this file"
    )
  ];
  if (result.status === "fresh" && result.missingNonces.length > 0) {
    const gaps = result.missingNonces.join(", ");
    lines.push(yellow(`! nonce ${gaps} has no proposal yet; this one can't execute until it does`));
  }
  for (const p of result.touched) lines.push(yellow(`! ${at(p)} changed these contracts since staging`));
  return lines;
}
function refused(reason) {
  return [red(`\u2717 ${reason}`)];
}
function kept() {
  return [dim("\u2192 kept, as planned")];
}
function rehearsed(txHash) {
  return [green(`\u2713 rehearsed through the Safe in tx ${short(txHash)}`)];
}
function printFile(line, lines) {
  console.log([heading(line), ...lines.map((l) => `  ${l}`), ""].join("\n"));
}
function printFolder(dir, count) {
  console.log(`${dim(`safe-batches/${path.basename(dir)}`)}  (${count} staged)
`);
}

// src/hardhat/index.ts
var FORK_MARKER = "FORK REHEARSAL, DO NOT SIGN: ";
function serviceFor(chainId, options) {
  const apiKey = options.apiKey ?? process.env.SAFE_API_KEY;
  const { txServiceUrl } = options;
  const url = typeof txServiceUrl === "string" ? txServiceUrl : txServiceUrl?.[chainId];
  return resolveTxService(chainId, { ...apiKey ? { apiKey } : {}, ...url ? { txServiceUrl: url } : {} });
}
var runs = /* @__PURE__ */ new WeakMap();
async function stageSafeTx(hre, txOrAction, options = {}) {
  const tx = typeof txOrAction === "function" || txOrAction instanceof Promise ? await catchUnknownSigner(hre, txOrAction) : txOrAction;
  if (!tx) return false;
  if (!tx.to) throw new Error(`Unsigned tx from ${tx.from} deploys a contract; only calls can be staged for a Safe`);
  const data = tx.data || "0x";
  if (!isHex(data)) throw new Error(`Unsigned tx from ${tx.from} has non-hex data`);
  const safe = getAddress2(tx.from);
  const call = { to: getAddress2(tx.to), data, value: BigInt(tx.value ?? 0) };
  const run = await stagingRun(hre);
  const step = run.steps.then(() => stage(hre, run, safe, call, options));
  run.steps = step.catch(() => void 0);
  return step;
}
async function stage(hre, run, safe, call, options) {
  const { chainId, local, dir, createdAt, queue, files, safes } = run;
  let pending = safes.get(safe);
  if (!pending) {
    pending = pendingProposals(hre, run, safe, options);
    safes.set(safe, pending);
    pending.catch(() => safes.delete(safe));
  }
  const proposals = await pending;
  const first = !files.has(safe);
  const queued = first && !options.allowDuplicate ? proposals.find((p) => p.calls.some((c) => sameCall(c, call))) : void 0;
  if (queued) {
    console.warn(`Skipped a call from ${safe} to ${call.to}: it is already pending at nonce ${queued.nonce}`);
    return true;
  }
  if (!queue.add(safe, call, options)) {
    console.warn(`Skipped a call from ${safe} to ${call.to}: the same call is already staged for that contract`);
    return true;
  }
  const stamp = new Date(createdAt).toISOString();
  const file = path2.join(dir, `${local ? "" : `${compactStamp(stamp)}-`}${safe6(safe)}.json`);
  files.set(safe, file);
  const title = `Deploy ${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
  const batch = createSafeBatch({
    chainId,
    safe,
    calls: queue.calls(safe),
    name: local ? `${FORK_MARKER}${title}` : title,
    createdAt
  });
  await writeFile(file, `${JSON.stringify(batch, null, 2)}
`, { flag: first && !local ? "wx" : "w" });
  return true;
}
async function pendingProposals(hre, run, safe, options) {
  if (!await readSafe(hre.network.provider, safe)) throw new Error(`Owner ${safe} is not a Safe`);
  if (run.local) return [];
  try {
    const queue = await readSafeQueue(hre.network.provider, await serviceFor(run.chainId, options), safe);
    return queue.proposals.filter((p) => p.plain && !queue.contestedNonces.includes(p.nonce));
  } catch (error) {
    console.warn(`Staging for Safe ${safe} without checking its pending proposals: ${describeError(error)}`);
    return [];
  }
}
function stagingRun(hre) {
  let run = runs.get(hre);
  if (!run) {
    run = startRun(hre);
    runs.set(hre, run);
    run.catch(() => runs.delete(hre));
  }
  return run;
}
async function startRun(hre) {
  const dir = stagedDir(hre);
  await mkdir(dir, { recursive: true });
  return {
    chainId: await publicClientFor(hre.network.provider).getChainId(),
    local: await isLocal(hre),
    dir,
    createdAt: Date.now(),
    queue: new CallQueue(),
    files: /* @__PURE__ */ new Map(),
    safes: /* @__PURE__ */ new Map(),
    steps: Promise.resolve()
  };
}
async function isLocal(hre) {
  return await localNodeVersion(hre.network.provider) !== void 0 || ["hardhat", "localhost"].includes(hre.network.name);
}
async function catchUnknownSigner(hre, action) {
  const run = typeof action === "function" ? action() : action;
  let result;
  const settled = run.then(
    (r) => {
      result = r;
    },
    () => void 0
  );
  const tx = await hre.deployments.catchUnknownSigner(run, { log: false });
  if (!tx) {
    await settled;
    await warnIfSentBySafe(hre, result);
  }
  return tx;
}
var checkedSenders = /* @__PURE__ */ new WeakMap();
async function warnIfSentBySafe(hre, result) {
  const from = result?.from;
  if (typeof from !== "string" || !isAddress(from, { strict: false })) return;
  const checked = checkedSenders.get(hre) ?? /* @__PURE__ */ new Set();
  checkedSenders.set(hre, checked);
  if (checked.has(from.toLowerCase())) return;
  checked.add(from.toLowerCase());
  try {
    if (!await readSafe(hre.network.provider, getAddress2(from))) return;
  } catch {
    return;
  }
  console.warn(
    `Safe ${from} executed a call directly because the node impersonates it, so the call was not staged or rehearsed through the Safe. Set HARDHAT_DEPLOY_NO_IMPERSONATION=1 (or \`autoImpersonate: false\`) and don't impersonate the Safe on the node.`
  );
}
async function proposeStagedSafeBatches(hre, options = {}) {
  const run = await runs.get(hre)?.catch(() => void 0);
  runs.delete(hre);
  await run?.steps;
  const ours = run ? [...run.files.values()] : [];
  const provider = hre.network.provider;
  const local = await isLocal(hre);
  const files = options.files ?? (ours.length > 0 || local ? ours : await listStagedFiles(hre));
  if (!options.files && ours.length > 0) {
    const older = (await listStagedFiles(hre)).filter((f) => !ours.includes(f));
    if (older.length > 0) console.log(`Left for later: ${older.map((f) => path2.basename(f)).join(", ")}
`);
  }
  const results = [];
  const handle = async (file, act) => {
    const batch = await readSafeBatch(file);
    const line = { file, safe: batchSafe(batch), calls: batch.transactions.length };
    try {
      const result = { file, ...await act(batch) };
      results.push(result);
      const lines = result.failure ? refused(result.failure) : result.execution ? rehearsed(result.execution.txHash) : result.status ? verdict(result.status, false) : kept();
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
      await handle(file, async (batch) => {
        const execution = await rehearseSafeBatch(node, batch, rehearseOptions(options));
        return { safe: execution.safe, execution, removed: false };
      });
    }
    return finish(results);
  }
  if (files.length === 0) return results;
  const service = await serviceFor(await publicClientFor(provider).getChainId(), options);
  const approved = files.some((f) => !ours.includes(f)) ? await approve(hre, service, files, options) : void 0;
  if (approved?.size === 0) return results;
  const signer = options.signer ?? await deployerSigner(hre);
  const stopped = /* @__PURE__ */ new Set();
  for (const file of files) {
    await handle(file, async (batch) => {
      const safe = batchSafe(batch);
      if (stopped.has(safe)) return { safe, removed: false, failure: "skipped: an earlier file for this Safe failed" };
      const refusal = refusalOf(batch, service);
      if (refusal) return { safe, removed: false, failure: refusal };
      if (approved && !approved.has(file)) return { safe, removed: false };
      const status = await proposeSafeBatch(provider, service, signer, batch, {
        ...options.origin === void 0 ? {} : { origin: options.origin },
        ...rehearseOptions(options)
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
function finish(results) {
  const failed = results.filter((r) => r.failure);
  if (failed.length > 0) {
    const reasons = failed.map((r) => `${path2.basename(r.file)}: ${r.failure}`).join("; ");
    throw new Error(`${failed.length} staged file(s) refused or failed: ${reasons}`);
  }
  return results;
}
async function approve(hre, service, files, options) {
  printFolder(stagedDir(hre), files.length);
  const toPropose = /* @__PURE__ */ new Set();
  const toDelete = /* @__PURE__ */ new Set();
  const refusals = [];
  const nextNonce = /* @__PURE__ */ new Map();
  for (const file of files) {
    const batch = await readSafeBatch(file);
    const safe = batchSafe(batch);
    const refusal = refusalOf(batch, service);
    if (refusal) refusals.push(`${path2.basename(file)}: ${refusal}`);
    let status = refusal ? void 0 : await safeBatchStatus(hre.network.provider, service, batch);
    if (status?.status === "fresh") {
      const nonce = nextNonce.get(safe) ?? status.nextNonce;
      nextNonce.set(safe, nonce + 1n);
      status = { ...status, nextNonce: nonce };
      toPropose.add(file);
    } else if (status && shouldDelete(status)) toDelete.add(file);
    printFile(
      { file, safe, calls: batch.transactions.length },
      refusal ? refused(refusal) : status ? verdict(status, true) : []
    );
  }
  const approved = /* @__PURE__ */ new Set([...toPropose, ...toDelete]);
  if (approved.size === 0) {
    if (refusals.length > 0) throw new Error(`${refusals.length} staged file(s) refused: ${refusals.join("; ")}`);
    console.log("Nothing to propose or delete.");
    return approved;
  }
  if (options.yes) return approved;
  const question = `Propose ${toPropose.size} file(s) and delete ${toDelete.size}? [y/N] `;
  return await ask(question, options) ? approved : /* @__PURE__ */ new Set();
}
async function ask(question, options) {
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
function refusalOf(batch, service) {
  if (batch.meta.name.startsWith(FORK_MARKER)) return "fork rehearsal file, never proposed";
  if (!validateSafeBatch(batch)) return "invalid checksum (edited after staging), refused";
  if (batch.chainId !== String(service.chainId)) return `for chain ${batch.chainId}, refused`;
  return void 0;
}
function shouldDelete(result) {
  return !!result.proposal || !!result.match && (result.status === "executed" || !result.contested);
}
async function predict(provider, service, batch) {
  const refusal = refusalOf(batch, service);
  if (refusal) return refused(refusal);
  return safeBatchStatus(provider, service, batch).then(
    (status) => verdict(status, true),
    (error) => refused(describeError(error))
  );
}
async function listStagedSafeBatches(hre, network = hre.network.name) {
  const files = await listStagedFiles(hre, network);
  return Promise.all(files.map(async (file) => ({ file, batch: await readSafeBatch(file) })));
}
async function stagedFilesThisRun(hre) {
  const run = await runs.get(hre)?.catch(() => void 0);
  await run?.steps;
  return run ? [...run.files.values()] : [];
}
async function discardSafeBatch(file) {
  await rm(file);
}
function nodeProvider(hre) {
  const { url, httpHeaders } = hre.network.config ?? {};
  if (!url) return hre.network.provider;
  const transport = http(url, { fetchOptions: { headers: httpHeaders ?? {} }, retryCount: 0, timeout: 12e4 });
  return { request: transport({}).request };
}
function registerSafeTasks(task, options = {}) {
  const serviceOptions = {
    ...options.apiKey ? { apiKey: options.apiKey } : {},
    ...options.txServiceUrl ? { txServiceUrl: options.txServiceUrl } : {}
  };
  task("safe:list", "List staged Safe batches and, on a live network, what safe:propose would do with each").addOptionalParam("from", "Network whose staged files to list (default: --network)").setAction(async (args, hre) => {
    const staged = await listStagedSafeBatches(hre, args.from);
    const live = staged.length > 0 && (args.from ?? hre.network.name) === hre.network.name && !await isLocal(hre);
    const chainId = live ? await publicClientFor(hre.network.provider).getChainId() : void 0;
    const service = chainId === void 0 ? void 0 : await serviceFor(chainId, serviceOptions);
    printFolder(stagedDir(hre, args.from), staged.length);
    for (const { file, batch } of staged) {
      const lines = service ? await predict(hre.network.provider, service, batch) : [];
      printFile({ file, safe: batchSafe(batch), calls: batch.transactions.length }, lines);
    }
  });
  task("safe:rehearse", "Rehearse staged batches of --from on an in-process fork of it (use --network hardhat)").addOptionalParam("from", "Network whose staged files to rehearse, forked from its URL").addOptionalParam("file", "One staged file instead of all").setAction(async (args, hre) => {
    if (!args.from) throw new Error("Pass --from <network>, e.g. --from mainnet");
    if (hre.network.name !== "hardhat") throw new Error("Run safe:rehearse with --network hardhat");
    const { url } = hre.config?.networks?.[args.from] ?? {};
    if (!url) throw new Error(`Network ${args.from} has no URL to fork`);
    const chainId = await publicClientFor({ request: http(url)({}).request }).getChainId();
    await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
    for (const file of args.file ? [args.file] : await listStagedFiles(hre, args.from)) {
      const batch = await readSafeBatch(file);
      if (batch.chainId !== String(chainId))
        throw new Error(`${path2.basename(file)} is for chain ${batch.chainId}, not ${args.from}`);
      const execution = await rehearseSafeBatch(hre.network.provider, batch, { allowChainMismatch: true });
      printFile({ file, safe: execution.safe, calls: batch.transactions.length }, rehearsed(execution.txHash));
    }
  });
  task("safe:propose", "Show the plan for staged Safe batches, then propose them after a yes").addOptionalParam("file", "One staged file instead of all").addFlag("yes", "Skip the confirmation, e.g. in CI").setAction(async (args, hre) => {
    await proposeStagedSafeBatches(hre, {
      files: args.file ? [args.file] : await listStagedFiles(hre),
      ...args.yes ? { yes: true } : {},
      ...options.signer ? { signer: await options.signer(hre) } : {},
      ...serviceOptions
    });
  });
  task("safe:discard", "Delete a staged Safe batch").addOptionalParam("file", "The staged file").setAction(async (args) => {
    if (!args.file) throw new Error("Pass --file <staged file>");
    await discardSafeBatch(args.file);
  });
}
async function deployerSigner(hre) {
  const address = (await hre.getNamedAccounts?.())?.deployer;
  if (!address) throw new Error("No proposer: pass `signer`, or set Hardhat's `deployer` named account");
  return {
    address,
    signMessage: ({ message }) => hre.network.provider.request({ method: "personal_sign", params: [message.raw, address] })
  };
}
function rehearseOptions(options) {
  return options.allowCallsWithoutCode ? { allowCallsWithoutCode: true } : {};
}
function stagedDir(hre, network = hre.network.name) {
  return path2.resolve(hre.config?.paths.root ?? process.cwd(), "safe-batches", network);
}
async function listStagedFiles(hre, network = hre.network.name) {
  const dir = stagedDir(hre, network);
  const names = await readdir(dir).catch(() => []);
  return names.filter((n) => n.endsWith(".json")).sort().map((n) => path2.join(dir, n));
}
async function readSafeBatch(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
function compactStamp(iso) {
  return iso.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}
function safe6(safe) {
  return safe.slice(0, 8).toLowerCase();
}
export {
  discardSafeBatch,
  listStagedSafeBatches,
  nodeProvider,
  proposeStagedSafeBatches,
  registerSafeTasks,
  stageSafeTx,
  stagedFilesThisRun
};
//# sourceMappingURL=index.js.map