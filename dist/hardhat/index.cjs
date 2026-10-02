"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/hardhat/index.ts
var hardhat_exports = {};
__export(hardhat_exports, {
  discardSafeBatch: () => discardSafeBatch,
  listStagedSafeBatches: () => listStagedSafeBatches,
  nodeProvider: () => nodeProvider,
  proposeStagedSafeBatches: () => proposeStagedSafeBatches,
  registerSafeTasks: () => registerSafeTasks,
  stageSafeTx: () => stageSafeTx,
  stagedFilesThisRun: () => stagedFilesThisRun
});
module.exports = __toCommonJS(hardhat_exports);
var import_promises = require("fs/promises");
var import_node_path2 = __toESM(require("path"), 1);
var import_promises2 = require("readline/promises");
var import_viem10 = require("viem");

// src/account.ts
var import_safe_deployments2 = require("@safe-global/safe-deployments");
var import_viem7 = require("viem");

// src/abi.ts
var import_viem = require("viem");
var safeAbi = (0, import_viem.parseAbi)([
  "function VERSION() view returns (string)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)"
]);
var EXECUTION_SUCCESS_TOPIC = (0, import_viem.toEventSelector)("ExecutionSuccess(bytes32,uint256)");
var CALL = 0;
var DELEGATE_CALL = 1;
var multiSendAbi = (0, import_viem.parseAbi)(["function multiSend(bytes transactions) payable"]);

// src/client.ts
var import_viem2 = require("viem");
function publicClientFor(provider) {
  return (0, import_viem2.createPublicClient)({ transport: (0, import_viem2.custom)(provider), pollingInterval: 50 });
}
async function localNodeVersion(provider) {
  try {
    const version = String(await provider.request({ method: "web3_clientVersion" }));
    return /^(HardhatNetwork|anvil)\//i.test(version) ? version : void 0;
  } catch {
    return void 0;
  }
}
function describeError(error) {
  const messages = [];
  for (let e = error; typeof e === "object" && e !== null; e = e.cause) {
    const { shortMessage, details, message } = e;
    const text = [shortMessage, details, message].find((m) => typeof m === "string" && m.length > 0);
    if (text && !messages.includes(text)) messages.push(text);
  }
  const first = messages[0] ?? String(error);
  const deepest = messages.at(-1) ?? first;
  return deepest === first ? first : `${first} (${deepest})`;
}
async function assertCallTargetsHaveCode(client, calls) {
  for (const [i, call] of calls.entries()) {
    if (call.data === "0x") continue;
    const code = await client.getCode({ address: call.to });
    if (!code || code === "0x") {
      throw new Error(
        `Call ${i} sends calldata to ${call.to}, which has no code here; pass allowCallsWithoutCode if that is intended`
      );
    }
  }
}

// src/propose.ts
var import_viem6 = require("viem");

// src/call.ts
var import_viem3 = require("viem");
function normalizeCall(call) {
  if (!(0, import_viem3.isHex)(call.data, { strict: true }) || call.data.length % 2 !== 0) {
    throw new Error(`Call to ${call.to} has malformed data ${call.data}: expected whole bytes of hex`);
  }
  const value = call.value ?? 0n;
  if (typeof value !== "bigint") throw new Error(`Call to ${call.to} has a non-bigint value ${String(value)}`);
  if (value < 0n) throw new Error(`Call to ${call.to} has a negative value ${value}`);
  return { to: (0, import_viem3.getAddress)(call.to), data: call.data, value };
}
function sameCall(a, b) {
  return a.to === b.to && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;
}

// src/multisend.ts
var import_safe_deployments = require("@safe-global/safe-deployments");
var import_viem4 = require("viem");
function encodeMultiSendCall(calls) {
  const packed = calls.map(normalizeCall).map(
    (c) => (0, import_viem4.encodePacked)(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [CALL, c.to, c.value, BigInt((0, import_viem4.size)(c.data)), c.data]
    )
  );
  return (0, import_viem4.encodeFunctionData)({ abi: multiSendAbi, functionName: "multiSend", args: [(0, import_viem4.concatHex)(packed)] });
}
function decodeMultiSend(data) {
  const { args } = (0, import_viem4.decodeFunctionData)({ abi: multiSendAbi, data });
  const [packed] = args;
  const calls = [];
  let onlyCalls = true;
  for (let i = 0; i < (0, import_viem4.size)(packed); ) {
    const length = Number((0, import_viem4.hexToBigInt)((0, import_viem4.sliceHex)(packed, i + 53, i + 85)));
    if ((0, import_viem4.hexToNumber)((0, import_viem4.sliceHex)(packed, i, i + 1)) !== CALL) onlyCalls = false;
    calls.push({
      to: (0, import_viem4.getAddress)((0, import_viem4.sliceHex)(packed, i + 1, i + 21)),
      value: (0, import_viem4.hexToBigInt)((0, import_viem4.sliceHex)(packed, i + 21, i + 53)),
      data: length === 0 ? "0x" : (0, import_viem4.sliceHex)(packed, i + 85, i + 85 + length, { strict: true })
    });
    i += 85 + length;
  }
  return { calls, onlyCalls };
}
var multiSends;
function isOfficialMultiSend(address) {
  multiSends ??= new Set(
    ["1.1.1", "1.3.0", "1.4.1", "1.5.0"].flatMap((version) => [(0, import_safe_deployments.getMultiSendDeployment)({ version }), (0, import_safe_deployments.getMultiSendCallOnlyDeployment)({ version })]).flatMap(
      (d) => d ? [...Object.values(d.deployments).map((x) => x.address), ...Object.values(d.networkAddresses).flat()] : []
    ).map((a) => a.toLowerCase())
  );
  return multiSends.has(address.toLowerCase());
}
async function safeTxFields(provider, version, calls) {
  const [only] = calls;
  if (calls.length === 1 && only) return [only.to, only.value, only.data, CALL];
  return [await resolveMultiSendCallOnly(provider, version), 0n, encodeMultiSendCall(calls), DELEGATE_CALL];
}
async function resolveMultiSendCallOnly(provider, safeVersion) {
  const client = publicClientFor(provider);
  const deployment = (0, import_safe_deployments.getMultiSendCallOnlyDeployment)({ version: multiSendVersion(safeVersion) });
  if (!deployment) throw new Error(`No MultiSendCallOnly deployment for Safe ${safeVersion}`);
  const chainId = String(await client.getChainId());
  const candidates = /* @__PURE__ */ new Map();
  for (const { address, codeHash } of Object.values(deployment.deployments)) candidates.set(address, codeHash);
  const listed = deployment.networkAddresses[chainId];
  const ordered = [...listed ? [listed] : [], ...candidates.keys()];
  for (const address of new Set(ordered)) {
    const code = await client.getCode({ address: (0, import_viem4.getAddress)(address) });
    if (code && code !== "0x" && (0, import_viem4.keccak256)(code) === candidates.get(address)) return (0, import_viem4.getAddress)(address);
  }
  throw new Error(`MultiSendCallOnly ${deployment.version} is not deployed on chain ${chainId}`);
}
function multiSendVersion(safeVersion) {
  const base = safeVersion.split("+")[0] ?? safeVersion;
  const [major = 0, minor = 0] = base.split(".").map(Number);
  return major === 1 && minor < 3 ? "1.3.0" : base;
}

// src/tx-builder.ts
var import_viem5 = require("viem");
var TX_BUILDER_VERSION = "2.1.0";
function createSafeBatch(options) {
  const meta = {
    name: options.name,
    txBuilderVersion: TX_BUILDER_VERSION,
    createdFromSafeAddress: (0, import_viem5.getAddress)(options.safe)
  };
  if (options.description !== void 0) meta.description = options.description;
  return addChecksum({
    version: "1.0",
    chainId: options.chainId.toString(),
    createdAt: options.createdAt ?? Date.now(),
    meta,
    transactions: options.calls.map(normalizeCall).map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }))
  });
}
function addChecksum(file) {
  return { ...file, meta: { ...file.meta, checksum: calculateChecksum(file) } };
}
function validateSafeBatch(file) {
  return file.meta.checksum === calculateChecksum(file);
}
function calculateChecksum(file) {
  const written = JSON.parse(JSON.stringify(file));
  const { checksum: _checksum, ...meta } = written.meta;
  return (0, import_viem5.keccak256)((0, import_viem5.stringToHex)(serialize({ ...written, meta: { ...meta, name: null } })));
}
function safeBatchCalls(file) {
  return file.transactions.map((tx, i) => {
    const data = tx.data ?? (tx.contractMethod === void 0 || tx.contractMethod === null ? "0x" : void 0);
    if (!data || !(0, import_viem5.isHex)(data))
      throw new Error(`Transaction ${i} has no raw data; contractMethod entries are unsupported`);
    if (!/^\d+$/.test(tx.value)) throw new Error(`Transaction ${i} has an invalid value ${JSON.stringify(tx.value)}`);
    return normalizeCall({ to: (0, import_viem5.getAddress)(tx.to), data, value: BigInt(tx.value) });
  });
}
var replacer = (_, value) => value === void 0 ? null : value;
function serialize(value) {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${JSON.stringify(keys, replacer)}${keys.map((k) => `${serialize(record[k])},`).join("")}}`;
  }
  return JSON.stringify(value, replacer);
}
function batchSafe(batch) {
  const safe = batch.meta.createdFromSafeAddress;
  if (!safe) throw new Error("Batch does not name its Safe (meta.createdFromSafeAddress)");
  return (0, import_viem5.getAddress)(safe);
}

// src/propose.ts
var CONFIG_SERVICE = "https://safe-config.safe.global/api/v1/chains";
var MULTI_SEND_SELECTOR = (0, import_viem6.toFunctionSelector)("multiSend(bytes)");
var REQUEST_TIMEOUT_MS = 3e4;
var ORIGIN_MAX_LENGTH = 200;
async function resolveTxService(chainId, options = {}) {
  let url = options.txServiceUrl;
  if (!url) {
    const chain = await request(`${CONFIG_SERVICE}/${chainId}/`).catch(
      (error) => {
        if (error instanceof RequestError && error.status === 404) return {};
        throw error;
      }
    );
    if (!chain.transactionService) {
      throw new Error(`Safe has no transaction service for chain ${chainId}; pass txServiceUrl for another one`);
    }
    url = `${chain.transactionService}/api`;
  }
  const service = { url: url.replace(/\/+$/, ""), chainId, ...options.apiKey ? { apiKey: options.apiKey } : {} };
  if (new URL(service.url).hostname === "api.safe.global" && !service.apiKey) {
    throw new Error("api.safe.global needs an API key: pass apiKey (get one at developer.safe.global)");
  }
  const about = await request(`${service.url}/v1/about/ethereum-rpc/`, service);
  if (about.chain_id !== chainId) throw new Error(`${service.url} serves chain ${about.chain_id}, not ${chainId}`);
  return service;
}
async function readSafeQueue(provider, service, safe) {
  const onchainNonce = await publicClientFor(provider).readContract({
    address: safe,
    abi: safeAbi,
    functionName: "nonce"
  });
  if (onchainNonce > 0n) {
    const latest = await readProposals(service, safe, `nonce=${onchainNonce - 1n}`);
    if (latest.length > 0 && !latest.some((p) => p.executed)) {
      throw new Error(
        `The Safe service has not indexed nonce ${onchainNonce - 1n} of Safe ${safe} yet; try again in a minute`
      );
    }
  }
  const proposals = await readProposals(service, safe, `executed=false&nonce__gte=${onchainNonce}`);
  const perNonce = /* @__PURE__ */ new Map();
  for (const { nonce } of proposals) perNonce.set(nonce, (perNonce.get(nonce) ?? 0) + 1);
  const nonces = [...perNonce.keys()];
  const nextNonce = nonces.reduce((max, n) => n >= max ? n + 1n : max, onchainNonce);
  const missingNonces = [];
  for (let n = onchainNonce; n < nextNonce; n++) if (!perNonce.has(n)) missingNonces.push(n);
  return {
    onchainNonce,
    nextNonce,
    proposals,
    contestedNonces: nonces.filter((n) => (perNonce.get(n) ?? 0) > 1),
    missingNonces
  };
}
async function readProposals(service, safe, filter) {
  const txs = [];
  let url = `${service.url}/v2/safes/${(0, import_viem6.getAddress)(safe)}/multisig-transactions/?${filter}&ordering=nonce&limit=100`;
  while (url) {
    const page = await request(url, service);
    txs.push(...page.results);
    url = nextPage(page.next, service);
  }
  return txs.map((tx) => {
    const data = tx.data ?? "0x";
    const batched = tx.operation === DELEGATE_CALL && data.startsWith(MULTI_SEND_SELECTOR);
    const { calls, onlyCalls } = batched ? decodeMultiSend(data) : { calls: [normalizeCall({ to: (0, import_viem6.getAddress)(tx.to), data, value: BigInt(tx.value) })], onlyCalls: true };
    const noRefund = [tx.safeTxGas, tx.baseGas, tx.gasPrice].every((v) => BigInt(v) === 0n) && [tx.gasToken, tx.refundReceiver].every((a) => a === null || (0, import_viem6.isAddressEqual)((0, import_viem6.getAddress)(a), import_viem6.zeroAddress));
    const runsAsCalls = batched ? isOfficialMultiSend(tx.to) && onlyCalls : tx.operation === CALL;
    return {
      nonce: BigInt(tx.nonce),
      safeTxHash: tx.safeTxHash,
      executed: tx.isExecuted,
      ...tx.isExecuted ? { successful: tx.isSuccessful !== false } : {},
      calls,
      plain: noRefund && runsAsCalls
    };
  });
}
var CLOCK_MARGIN_MS = 10 * 6e4;
async function safeBatchStatus(provider, service, batch) {
  const safe = batchSafe(batch);
  const calls = safeBatchCalls(batch).map(normalizeCall);
  const queue = await readSafeQueue(provider, service, safe);
  const since = new Date(batch.createdAt - CLOCK_MARGIN_MS).toISOString();
  const executed = (await readProposals(service, safe, `executed=true&execution_date__gte=${since}`)).filter(
    (p) => p.successful
  );
  const exact = (p) => p.plain && p.calls.length === calls.length && p.calls.every((c, i) => {
    const ours = calls[i];
    return ours !== void 0 && sameCall(c, ours);
  });
  const shares = (p) => p.calls.some((c) => calls.some((k) => sameCall(c, k)));
  const targets = new Set(calls.map((c) => c.to));
  const done = executed.find(exact);
  const queued = done ? void 0 : queue.proposals.find(exact);
  const match = done ?? queued;
  const overlapping = match ? [] : [...queue.proposals, ...executed].filter(shares);
  const status = done ? "executed" : queued ? "pending" : overlapping.length > 0 ? "partial" : "fresh";
  return {
    status,
    ...match ? { match } : {},
    contested: queued !== void 0 && queue.contestedNonces.includes(queued.nonce),
    overlapping,
    touched: executed.filter((p) => p !== match && !shares(p) && p.calls.some((c) => targets.has(c.to))),
    nextNonce: queue.nextNonce,
    missingNonces: queue.missingNonces
  };
}
async function proposeSafeBatch(provider, service, signer, batch, options = {}) {
  if (!validateSafeBatch(batch)) throw new Error("Batch has an invalid checksum; it was edited after it was written");
  if (batch.chainId !== String(service.chainId)) {
    throw new Error(`Batch is for chain ${batch.chainId}, the service for chain ${service.chainId}`);
  }
  const status = await safeBatchStatus(provider, service, batch);
  if (status.status !== "fresh") return status;
  const calls = safeBatchCalls(batch);
  if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(publicClientFor(provider), calls);
  const proposal = await proposeCalls(provider, service, signer, batchSafe(batch), calls, {
    nonce: status.nextNonce,
    ...options.origin === void 0 ? {} : { origin: options.origin },
    note: options.note ?? batch.meta.description ?? batch.meta.name
  });
  return { ...status, proposal };
}
async function proposeCalls(provider, service, signer, safe, calls, options) {
  if (calls.length === 0) throw new Error("No calls to propose");
  if (await localNodeVersion(provider)) throw new Error("Refusing to propose from a local Hardhat or Anvil node");
  const client = publicClientFor(provider);
  const chainId = await client.getChainId();
  if (chainId !== service.chainId) throw new Error(`Node is on chain ${chainId}, service on ${service.chainId}`);
  const info = await readSafe(provider, (0, import_viem6.getAddress)(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  if (/^1\.[0-2]\./.test(info.version)) {
    throw new Error(`Safe ${info.address} is ${info.version}; proposing needs 1.3.0 or later`);
  }
  const [to, value, data, operation] = await safeTxFields(provider, info.version, calls.map(normalizeCall));
  const { nonce } = options;
  const safeTxHash = await client.readContract({
    address: info.address,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [to, value, data, operation, 0n, 0n, 0n, import_viem6.zeroAddress, import_viem6.zeroAddress, nonce]
  });
  const proposer = (0, import_viem6.getAddress)(signer.address);
  const signed = await signer.signMessage({ message: { raw: safeTxHash } });
  if (!(0, import_viem6.isHex)(signed) || (0, import_viem6.size)(signed) !== 65) throw new Error(`Signer for ${proposer} returned a malformed signature`);
  if (!(0, import_viem6.isAddressEqual)(await (0, import_viem6.recoverMessageAddress)({ message: { raw: safeTxHash }, signature: signed }), proposer)) {
    throw new Error(`Signer's signature does not recover to its address ${proposer}`);
  }
  const v = (0, import_viem6.hexToNumber)((0, import_viem6.sliceHex)(signed, 64));
  const signature = (0, import_viem6.concatHex)([(0, import_viem6.sliceHex)(signed, 0, 64), (0, import_viem6.numberToHex)((v < 27 ? v + 27 : v) + 4)]);
  await request(`${service.url}/v2/safes/${info.address}/multisig-transactions/`, service, {
    to,
    value: value.toString(),
    data,
    operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: import_viem6.zeroAddress,
    refundReceiver: import_viem6.zeroAddress,
    nonce: nonce.toString(),
    contractTransactionHash: safeTxHash,
    sender: proposer,
    signature,
    origin: originOf(options.origin ?? "safe-ops", options.note)
  });
  return { safe: info.address, safeTxHash, nonce, proposer };
}
function nextPage(next, service) {
  if (next !== null && new URL(next).origin !== new URL(service.url).origin) {
    throw new Error(`${service.url} links its next page to another origin: ${next}`);
  }
  return next;
}
function originOf(name, note) {
  const head = (text, n) => Array.from(text).slice(0, n).join("");
  const json = (text) => JSON.stringify({ name: head(name, 50), ...text ? { note: text } : {} });
  if (!note || json(note).length <= ORIGIN_MAX_LENGTH) return json(note);
  let length = Array.from(note).length;
  while (length > 0 && json(`${head(note, length)}\u2026`).length > ORIGIN_MAX_LENGTH) length--;
  return json(length > 0 ? `${head(note, length)}\u2026` : void 0);
}
var RequestError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
};
async function request(url, service, body) {
  const method = body === void 0 ? "GET" : "POST";
  const mayHaveLanded = method === "POST" ? "; it may still have landed, and a rerun skips what is already queued" : "";
  let ok, status, text, location;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...service?.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {}
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      // A redirect to another host drops the Authorization header, so the key would silently stop counting.
      redirect: "manual",
      // A hung service must not hang the deploy. Covers reading the body too.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    ({ ok, status } = response);
    if (status >= 300 && status < 400) location = response.headers.get("location");
    text = await response.text();
  } catch (error) {
    throw new Error(`${method} ${url} failed: ${describeError(error)}${mayHaveLanded}`, { cause: error });
  }
  if (status >= 300 && status < 400) {
    throw new RequestError(`${method} ${url} redirects to ${location ?? "another URL"}; use that URL instead`, status);
  }
  if (!ok) {
    const hint = status >= 500 ? mayHaveLanded : "";
    throw new RequestError(`${method} ${url} answered ${status}: ${text.slice(0, 500)}${hint}`, status);
  }
  return text ? JSON.parse(text) : void 0;
}

// src/account.ts
async function readSafe(provider, address) {
  const client = publicClientFor(provider);
  const slot0 = await client.getStorageAt({ address, slot: "0x0" });
  if (!slot0 || (0, import_viem7.size)(slot0) !== 32) return void 0;
  const singleton = (0, import_viem7.getAddress)((0, import_viem7.sliceHex)(slot0, 12));
  if (!officialSingletons().has(singleton.toLowerCase())) return void 0;
  const threshold = await client.readContract({ address, abi: safeAbi, functionName: "getThreshold" });
  if (threshold === 0n) return void 0;
  const [version, owners] = await Promise.all([
    client.readContract({ address, abi: safeAbi, functionName: "VERSION" }),
    client.readContract({ address, abi: safeAbi, functionName: "getOwners" })
  ]);
  return { address, version, threshold, owners: [...owners], singleton };
}
var singletons;
function officialSingletons() {
  singletons ??= new Set(
    ["1.0.0", "1.1.1", "1.2.0", "1.3.0", "1.4.1", "1.5.0"].flatMap((version) => [(0, import_safe_deployments2.getSafeSingletonDeployments)({ version }), (0, import_safe_deployments2.getSafeL2SingletonDeployments)({ version })]).flatMap(
      (d) => d ? [...Object.values(d.deployments).map((x) => x.address), ...Object.values(d.networkAddresses).flat()] : []
    ).map((a) => a.toLowerCase())
  );
  return singletons;
}

// src/batch.ts
var import_viem8 = require("viem");
var CallQueue = class {
  #groups = /* @__PURE__ */ new Map();
  /** Returns false when the call was dropped as a duplicate. */
  add(safe, call, options = {}) {
    const key = (0, import_viem8.getAddress)(safe);
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
    return [...this.#groups.get((0, import_viem8.getAddress)(safe)) ?? []];
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

// src/fork.ts
var import_viem9 = require("viem");
async function executeOnFork(provider, safe, calls, options = {}) {
  if (calls.length === 0) throw new Error("No calls to execute");
  const node = await localNodeVersion(provider);
  if (!node) throw new Error("Refusing to rehearse: expected a local Hardhat or Anvil node");
  if (/^HardhatNetwork\//i.test(node)) await provider.request({ method: "hardhat_mine", params: ["0x1"] });
  const client = publicClientFor(provider);
  const info = await readSafe(provider, (0, import_viem9.getAddress)(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  if (/^1\.0\./.test(info.version)) throw new Error(`Safe ${info.address} is ${info.version}; 1.0.x is unsupported`);
  const normalized = calls.map(normalizeCall);
  if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(client, normalized);
  const [to, value, data, operation] = await safeTxFields(provider, info.version, normalized);
  const nonce = await client.readContract({ address: info.address, abi: safeAbi, functionName: "nonce" });
  const txArgs = [to, value, data, operation, 0n, 0n, 0n, import_viem9.zeroAddress, import_viem9.zeroAddress];
  const safeTxHash = await client.readContract({
    address: info.address,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [...txArgs, nonce]
  });
  const approvers = sortOwners(info.owners.slice(0, Number(info.threshold)));
  const executor = approvers[0];
  if (!executor) throw new Error(`Safe ${info.address} has no owners`);
  for (const owner of approvers) {
    await impersonate(provider, client, owner);
    const approve2 = (0, import_viem9.encodeFunctionData)({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] });
    await send(provider, client, owner, info.address, approve2);
  }
  const signatures = (0, import_viem9.concatHex)(approvers.map((o) => (0, import_viem9.concatHex)([(0, import_viem9.pad)(o), (0, import_viem9.pad)("0x0"), "0x01"])));
  const exec = (0, import_viem9.encodeFunctionData)({ abi: safeAbi, functionName: "execTransaction", args: [...txArgs, signatures] });
  const receipt = await send(provider, client, executor, info.address, exec);
  if (!emittedExecutionSuccess(receipt.logs, info.address, safeTxHash)) {
    throw new Error(`Safe ${info.address} did not emit ExecutionSuccess for ${safeTxHash}`);
  }
  return { safe: info.address, safeTxHash, txHash: receipt.transactionHash, nonce, approvers, to, operation };
}
async function rehearseSafeBatch(provider, batch, options = {}) {
  if (!validateSafeBatch(batch)) throw new Error("Batch has an invalid checksum; it was edited after it was written");
  const chainId = await publicClientFor(provider).getChainId();
  if (!options.allowChainMismatch && batch.chainId !== String(chainId)) {
    throw new Error(`Batch is for chain ${batch.chainId}, but the fork runs chain ${chainId}`);
  }
  return executeOnFork(provider, batchSafe(batch), safeBatchCalls(batch), options);
}
function emittedExecutionSuccess(logs, safe, safeTxHash) {
  const hash = safeTxHash.toLowerCase();
  return logs.some(
    (l) => (0, import_viem9.isAddressEqual)((0, import_viem9.getAddress)(l.address), safe) && l.topics[0] === EXECUTION_SUCCESS_TOPIC && (l.topics[1]?.toLowerCase() === hash || l.data.slice(0, 66).toLowerCase() === hash)
  );
}
function sortOwners(owners) {
  return [...owners].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
}
var MIN_BALANCE = (0, import_viem9.parseEther)("1");
async function impersonate(provider, client, account) {
  await provider.request({ method: "hardhat_impersonateAccount", params: [account] });
  if (await client.getBalance({ address: account }) < MIN_BALANCE) {
    await provider.request({ method: "hardhat_setBalance", params: [account, (0, import_viem9.numberToHex)(MIN_BALANCE)] });
  }
}
async function send(provider, client, from, to, data) {
  try {
    await client.call({ account: from, to, data });
  } catch (error) {
    throw new Error(`Call from ${from} to ${to} would revert: ${describeError(error)}`, { cause: error });
  }
  let hash;
  try {
    hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
  } catch (error) {
    if (!/HH103|not managed by the node/.test(String(error))) throw error;
    throw new Error(
      `Can't send from impersonated ${from}: this provider signs with local keys (Hardhat \`accounts\`, e.g. from .env). Rehearse through the node itself, e.g. nodeProvider(hre) from @bloq/safe-ops/hardhat.`,
      { cause: error }
    );
  }
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} from ${from} reverted`);
  return receipt;
}

// src/hardhat/output.ts
var import_node_path = __toESM(require("path"), 1);
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
  return `${bold(import_node_path.default.basename(file))}   Safe ${short(safe)}   ${calls} call${calls === 1 ? "" : "s"}`;
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
  console.log(`${dim(`safe-batches/${import_node_path.default.basename(dir)}`)}  (${count} staged)
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
  if (!(0, import_viem10.isHex)(data)) throw new Error(`Unsigned tx from ${tx.from} has non-hex data`);
  const safe = (0, import_viem10.getAddress)(tx.from);
  const call = { to: (0, import_viem10.getAddress)(tx.to), data, value: BigInt(tx.value ?? 0) };
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
  const file = import_node_path2.default.join(dir, `${local ? "" : `${compactStamp(stamp)}-`}${safe6(safe)}.json`);
  files.set(safe, file);
  const title = `Deploy ${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
  const batch = createSafeBatch({
    chainId,
    safe,
    calls: queue.calls(safe),
    name: local ? `${FORK_MARKER}${title}` : title,
    createdAt
  });
  await (0, import_promises.writeFile)(file, `${JSON.stringify(batch, null, 2)}
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
  await (0, import_promises.mkdir)(dir, { recursive: true });
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
  if (typeof from !== "string" || !(0, import_viem10.isAddress)(from, { strict: false })) return;
  const checked = checkedSenders.get(hre) ?? /* @__PURE__ */ new Set();
  checkedSenders.set(hre, checked);
  if (checked.has(from.toLowerCase())) return;
  checked.add(from.toLowerCase());
  try {
    if (!await readSafe(hre.network.provider, (0, import_viem10.getAddress)(from))) return;
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
    if (older.length > 0) console.log(`Left for later: ${older.map((f) => import_node_path2.default.basename(f)).join(", ")}
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
      if (removed) await (0, import_promises.rm)(file, { force: true });
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
    const reasons = failed.map((r) => `${import_node_path2.default.basename(r.file)}: ${r.failure}`).join("; ");
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
    if (refusal) refusals.push(`${import_node_path2.default.basename(file)}: ${refusal}`);
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
  const prompt = (0, import_promises2.createInterface)({ input: process.stdin, output: process.stdout });
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
  await (0, import_promises.rm)(file);
}
function nodeProvider(hre) {
  const { url, httpHeaders } = hre.network.config ?? {};
  if (!url) return hre.network.provider;
  const transport = (0, import_viem10.http)(url, { fetchOptions: { headers: httpHeaders ?? {} }, retryCount: 0, timeout: 12e4 });
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
    const chainId = await publicClientFor({ request: (0, import_viem10.http)(url)({}).request }).getChainId();
    await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
    for (const file of args.file ? [args.file] : await listStagedFiles(hre, args.from)) {
      const batch = await readSafeBatch(file);
      if (batch.chainId !== String(chainId))
        throw new Error(`${import_node_path2.default.basename(file)} is for chain ${batch.chainId}, not ${args.from}`);
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
  return import_node_path2.default.resolve(hre.config?.paths.root ?? process.cwd(), "safe-batches", network);
}
async function listStagedFiles(hre, network = hre.network.name) {
  const dir = stagedDir(hre, network);
  const names = await (0, import_promises.readdir)(dir).catch(() => []);
  return names.filter((n) => n.endsWith(".json")).sort().map((n) => import_node_path2.default.join(dir, n));
}
async function readSafeBatch(file) {
  return JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
}
function compactStamp(iso) {
  return iso.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}
function safe6(safe) {
  return safe.slice(0, 8).toLowerCase();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discardSafeBatch,
  listStagedSafeBatches,
  nodeProvider,
  proposeStagedSafeBatches,
  registerSafeTasks,
  stageSafeTx,
  stagedFilesThisRun
});
//# sourceMappingURL=index.cjs.map