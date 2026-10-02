// src/client.ts
import { createPublicClient, custom } from "viem";
function publicClientFor(provider) {
  return createPublicClient({ transport: custom(provider), pollingInterval: 50 });
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

// src/call.ts
import { getAddress, isHex } from "viem";
function normalizeCall(call) {
  if (!isHex(call.data, { strict: true }) || call.data.length % 2 !== 0) {
    throw new Error(`Call to ${call.to} has malformed data ${call.data}: expected whole bytes of hex`);
  }
  const value = call.value ?? 0n;
  if (typeof value !== "bigint") throw new Error(`Call to ${call.to} has a non-bigint value ${String(value)}`);
  if (value < 0n) throw new Error(`Call to ${call.to} has a negative value ${value}`);
  return { to: getAddress(call.to), data: call.data, value };
}
function sameCall(a, b) {
  return a.to === b.to && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;
}

// src/multisend.ts
import { getMultiSendCallOnlyDeployment, getMultiSendDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress as getAddress2,
  hexToBigInt,
  hexToNumber,
  keccak256,
  size,
  sliceHex
} from "viem";

// src/abi.ts
import { parseAbi, toEventSelector } from "viem";
var safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)"
]);
var EXECUTION_SUCCESS_TOPIC = toEventSelector("ExecutionSuccess(bytes32,uint256)");
var CALL = 0;
var DELEGATE_CALL = 1;
var multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

// src/multisend.ts
function encodeMultiSendCall(calls) {
  const packed = calls.map(normalizeCall).map(
    (c) => encodePacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [CALL, c.to, c.value, BigInt(size(c.data)), c.data]
    )
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concatHex(packed)] });
}
function decodeMultiSendCall(data) {
  return decodeMultiSend(data).calls;
}
function decodeMultiSend(data) {
  const { args } = decodeFunctionData({ abi: multiSendAbi, data });
  const [packed] = args;
  const calls = [];
  let onlyCalls = true;
  for (let i = 0; i < size(packed); ) {
    const length = Number(hexToBigInt(sliceHex(packed, i + 53, i + 85)));
    if (hexToNumber(sliceHex(packed, i, i + 1)) !== CALL) onlyCalls = false;
    calls.push({
      to: getAddress2(sliceHex(packed, i + 1, i + 21)),
      value: hexToBigInt(sliceHex(packed, i + 21, i + 53)),
      data: length === 0 ? "0x" : sliceHex(packed, i + 85, i + 85 + length, { strict: true })
    });
    i += 85 + length;
  }
  return { calls, onlyCalls };
}
var multiSends;
function isOfficialMultiSend(address) {
  multiSends ??= new Set(
    ["1.1.1", "1.3.0", "1.4.1", "1.5.0"].flatMap((version) => [getMultiSendDeployment({ version }), getMultiSendCallOnlyDeployment({ version })]).flatMap(
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
  const deployment = getMultiSendCallOnlyDeployment({ version: multiSendVersion(safeVersion) });
  if (!deployment) throw new Error(`No MultiSendCallOnly deployment for Safe ${safeVersion}`);
  const chainId = String(await client.getChainId());
  const candidates = /* @__PURE__ */ new Map();
  for (const { address, codeHash } of Object.values(deployment.deployments)) candidates.set(address, codeHash);
  const listed = deployment.networkAddresses[chainId];
  const ordered = [...listed ? [listed] : [], ...candidates.keys()];
  for (const address of new Set(ordered)) {
    const code = await client.getCode({ address: getAddress2(address) });
    if (code && code !== "0x" && keccak256(code) === candidates.get(address)) return getAddress2(address);
  }
  throw new Error(`MultiSendCallOnly ${deployment.version} is not deployed on chain ${chainId}`);
}
function multiSendVersion(safeVersion) {
  const base = safeVersion.split("+")[0] ?? safeVersion;
  const [major = 0, minor = 0] = base.split(".").map(Number);
  return major === 1 && minor < 3 ? "1.3.0" : base;
}

// src/tx-builder.ts
import { getAddress as getAddress3, isHex as isHex2, keccak256 as keccak2562, stringToHex } from "viem";
var TX_BUILDER_VERSION = "2.1.0";
function createSafeBatch(options) {
  const meta = {
    name: options.name,
    txBuilderVersion: TX_BUILDER_VERSION,
    createdFromSafeAddress: getAddress3(options.safe)
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
  return keccak2562(stringToHex(serialize({ ...written, meta: { ...meta, name: null } })));
}
function safeBatchCalls(file) {
  return file.transactions.map((tx, i) => {
    const data = tx.data ?? (tx.contractMethod === void 0 || tx.contractMethod === null ? "0x" : void 0);
    if (!data || !isHex2(data))
      throw new Error(`Transaction ${i} has no raw data; contractMethod entries are unsupported`);
    if (!/^\d+$/.test(tx.value)) throw new Error(`Transaction ${i} has an invalid value ${JSON.stringify(tx.value)}`);
    return normalizeCall({ to: getAddress3(tx.to), data, value: BigInt(tx.value) });
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
  return getAddress3(safe);
}

// src/propose.ts
import {
  concatHex as concatHex2,
  getAddress as getAddress5,
  hexToNumber as hexToNumber2,
  isAddressEqual as isAddressEqual2,
  isHex as isHex3,
  numberToHex,
  recoverMessageAddress,
  size as size3,
  sliceHex as sliceHex3,
  toFunctionSelector,
  zeroAddress
} from "viem";

// src/account.ts
import { getSafeL2SingletonDeployments, getSafeSingletonDeployments } from "@safe-global/safe-deployments";
import { getAddress as getAddress4, isAddressEqual, size as size2, sliceHex as sliceHex2 } from "viem";
var EIP7702_PREFIX = "0xef0100";
async function classifyAccount(provider, account) {
  const address = getAddress4(account);
  const code = await publicClientFor(provider).getCode({ address });
  if (!code || code === "0x") return { kind: "eoa", address };
  if (code.startsWith(EIP7702_PREFIX) && code.length === 48) {
    return { kind: "eip7702", address, delegate: getAddress4(sliceHex2(code, 3)) };
  }
  const safe = await readSafe(provider, address);
  return safe ? { kind: "safe", address, safe } : { kind: "contract", address };
}
async function readSafe(provider, address) {
  const client = publicClientFor(provider);
  const slot0 = await client.getStorageAt({ address, slot: "0x0" });
  if (!slot0 || size2(slot0) !== 32) return void 0;
  const singleton = getAddress4(sliceHex2(slot0, 12));
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
    ["1.0.0", "1.1.1", "1.2.0", "1.3.0", "1.4.1", "1.5.0"].flatMap((version) => [getSafeSingletonDeployments({ version }), getSafeL2SingletonDeployments({ version })]).flatMap(
      (d) => d ? [...Object.values(d.deployments).map((x) => x.address), ...Object.values(d.networkAddresses).flat()] : []
    ).map((a) => a.toLowerCase())
  );
  return singletons;
}
async function resolveOwnerRoute(provider, owner, caller, options = {}) {
  const account = await classifyAccount(provider, owner);
  const { address } = account;
  const isCaller = isAddressEqual(address, caller);
  switch (account.kind) {
    case "safe": {
      const { safe } = account;
      if (isCaller) return { kind: "skip", owner: address, reason: `Safe ${address} can't sign for itself` };
      if (safe.owners.some((o) => isAddressEqual(o, caller))) return { kind: "safe", owner: address, safe };
      if (!options.service) {
        return {
          kind: "skip",
          owner: address,
          reason: `${caller} is not an owner of Safe ${address} (pass service to check its proposers)`
        };
      }
      if (await isProposer(provider, options.service, safe, caller)) return { kind: "safe", owner: address, safe };
      return { kind: "skip", owner: address, reason: `${caller} is not an owner or proposer of Safe ${address}` };
    }
    case "eoa":
      if (isCaller) return { kind: "direct", owner: address };
      return { kind: "skip", owner: address, reason: `owner ${address} is an EOA other than the caller` };
    case "eip7702":
      if (isCaller) return { kind: "direct", owner: address };
      return { kind: "skip", owner: address, reason: `owner ${address} is an EIP-7702 account other than the caller` };
    case "contract":
      return { kind: "skip", owner: address, reason: `owner ${address} is a contract but not a Safe` };
  }
}

// src/propose.ts
var CONFIG_SERVICE = "https://safe-config.safe.global/api/v1/chains";
var MULTI_SEND_SELECTOR = toFunctionSelector("multiSend(bytes)");
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
  let url = `${service.url}/v2/safes/${getAddress5(safe)}/multisig-transactions/?${filter}&ordering=nonce&limit=100`;
  while (url) {
    const page = await request(url, service);
    txs.push(...page.results);
    url = nextPage(page.next, service);
  }
  return txs.map((tx) => {
    const data = tx.data ?? "0x";
    const batched = tx.operation === DELEGATE_CALL && data.startsWith(MULTI_SEND_SELECTOR);
    const { calls, onlyCalls } = batched ? decodeMultiSend(data) : { calls: [normalizeCall({ to: getAddress5(tx.to), data, value: BigInt(tx.value) })], onlyCalls: true };
    const noRefund = [tx.safeTxGas, tx.baseGas, tx.gasPrice].every((v) => BigInt(v) === 0n) && [tx.gasToken, tx.refundReceiver].every((a) => a === null || isAddressEqual2(getAddress5(a), zeroAddress));
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
async function isProposer(provider, service, safe, account) {
  if (typeof safe === "string") {
    const info = await readSafe(provider, getAddress5(safe));
    if (!info) throw new Error(`${safe} is not a Safe`);
    safe = info;
  }
  const now = Date.now();
  const counts = (d) => (d.safe === null || isAddressEqual2(getAddress5(d.safe), safe.address)) && safe.owners.some((o) => isAddressEqual2(o, getAddress5(d.delegator))) && (d.expiryDate === null || Date.parse(d.expiryDate) > now);
  let url = `${service.url}/v2/delegates/?delegate=${getAddress5(account)}&limit=100`;
  while (url) {
    const page = await request(url, service);
    if (page.results.some(counts)) return true;
    url = nextPage(page.next, service);
  }
  return false;
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
  const info = await readSafe(provider, getAddress5(safe));
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
    args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]
  });
  const proposer = getAddress5(signer.address);
  const signed = await signer.signMessage({ message: { raw: safeTxHash } });
  if (!isHex3(signed) || size3(signed) !== 65) throw new Error(`Signer for ${proposer} returned a malformed signature`);
  if (!isAddressEqual2(await recoverMessageAddress({ message: { raw: safeTxHash }, signature: signed }), proposer)) {
    throw new Error(`Signer's signature does not recover to its address ${proposer}`);
  }
  const v = hexToNumber2(sliceHex3(signed, 64));
  const signature = concatHex2([sliceHex3(signed, 0, 64), numberToHex((v < 27 ? v + 27 : v) + 4)]);
  await request(`${service.url}/v2/safes/${info.address}/multisig-transactions/`, service, {
    to,
    value: value.toString(),
    data,
    operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
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

// src/fork.ts
import {
  concatHex as concatHex3,
  encodeFunctionData as encodeFunctionData2,
  getAddress as getAddress6,
  isAddressEqual as isAddressEqual3,
  numberToHex as numberToHex2,
  pad,
  parseEther,
  zeroAddress as zeroAddress2
} from "viem";
async function executeOnFork(provider, safe, calls, options = {}) {
  if (calls.length === 0) throw new Error("No calls to execute");
  const node = await localNodeVersion(provider);
  if (!node) throw new Error("Refusing to rehearse: expected a local Hardhat or Anvil node");
  if (/^HardhatNetwork\//i.test(node)) await provider.request({ method: "hardhat_mine", params: ["0x1"] });
  const client = publicClientFor(provider);
  const info = await readSafe(provider, getAddress6(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  if (/^1\.0\./.test(info.version)) throw new Error(`Safe ${info.address} is ${info.version}; 1.0.x is unsupported`);
  const normalized = calls.map(normalizeCall);
  if (!options.allowCallsWithoutCode) await assertCallTargetsHaveCode(client, normalized);
  const [to, value, data, operation] = await safeTxFields(provider, info.version, normalized);
  const nonce = await client.readContract({ address: info.address, abi: safeAbi, functionName: "nonce" });
  const txArgs = [to, value, data, operation, 0n, 0n, 0n, zeroAddress2, zeroAddress2];
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
    const approve = encodeFunctionData2({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] });
    await send(provider, client, owner, info.address, approve);
  }
  const signatures = concatHex3(approvers.map((o) => concatHex3([pad(o), pad("0x0"), "0x01"])));
  const exec = encodeFunctionData2({ abi: safeAbi, functionName: "execTransaction", args: [...txArgs, signatures] });
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
    (l) => isAddressEqual3(getAddress6(l.address), safe) && l.topics[0] === EXECUTION_SUCCESS_TOPIC && (l.topics[1]?.toLowerCase() === hash || l.data.slice(0, 66).toLowerCase() === hash)
  );
}
function sortOwners(owners) {
  return [...owners].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
}
var MIN_BALANCE = parseEther("1");
async function impersonate(provider, client, account) {
  await provider.request({ method: "hardhat_impersonateAccount", params: [account] });
  if (await client.getBalance({ address: account }) < MIN_BALANCE) {
    await provider.request({ method: "hardhat_setBalance", params: [account, numberToHex2(MIN_BALANCE)] });
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

export {
  publicClientFor,
  localNodeVersion,
  describeError,
  normalizeCall,
  sameCall,
  decodeMultiSendCall,
  createSafeBatch,
  validateSafeBatch,
  safeBatchCalls,
  batchSafe,
  resolveTxService,
  readSafeQueue,
  safeBatchStatus,
  isProposer,
  proposeSafeBatch,
  classifyAccount,
  readSafe,
  resolveOwnerRoute,
  executeOnFork,
  rehearseSafeBatch
};
//# sourceMappingURL=chunk-XSEYUO2X.js.map