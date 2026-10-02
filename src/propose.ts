import {
  concatHex,
  getAddress,
  hexToNumber,
  isAddressEqual,
  isHex,
  numberToHex,
  recoverMessageAddress,
  size,
  sliceHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { CALL, DELEGATE_CALL, safeAbi } from "./abi.js";
import { readSafe } from "./account.js";
import { normalizeCall, sameCall } from "./call.js";
import { assertCallTargetsHaveCode, describeError, localNodeVersion, publicClientFor } from "./client.js";
import { decodeMultiSend, isOfficialMultiSend, safeTxFields } from "./multisend.js";
import { batchSafe, safeBatchCalls, validateSafeBatch, type SafeBatch } from "./tx-builder.js";
import type { Eip1193Provider, SafeCall } from "./types.js";

const CONFIG_SERVICE = "https://safe-config.safe.global/api/v1/chains";
const MULTI_SEND_SELECTOR = toFunctionSelector("multiSend(bytes)");
const REQUEST_TIMEOUT_MS = 30_000;
// The service stores at most this many characters of `origin`, and rejects a longer one.
const ORIGIN_MAX_LENGTH = 200;

export interface TxServiceOptions {
  /** The service's API root, e.g. `https://api.safe.global/tx-service/eth/api`. Defaults to Safe's for the chain. */
  txServiceUrl?: string;
  /** Required by api.safe.global; get one at developer.safe.global. */
  apiKey?: string;
}

export interface TxService {
  url: string;
  chainId: number;
  apiKey?: string;
}

/** The Safe Transaction Service for `chainId`, looked up in Safe's config service unless `txServiceUrl` is given. */
export async function resolveTxService(chainId: number, options: TxServiceOptions = {}): Promise<TxService> {
  let url = options.txServiceUrl;
  if (!url) {
    const chain = await request<{ transactionService?: string }>(`${CONFIG_SERVICE}/${chainId}/`).catch(
      (error: unknown): { transactionService?: string } => {
        if (error instanceof RequestError && error.status === 404) return {};
        throw error;
      },
    );
    if (!chain.transactionService) {
      throw new Error(`Safe has no transaction service for chain ${chainId}; pass txServiceUrl for another one`);
    }
    url = `${chain.transactionService}/api`;
  }
  const service = { url: url.replace(/\/+$/, ""), chainId, ...(options.apiKey ? { apiKey: options.apiKey } : {}) };
  // Safe requires a key there, and answers without one only at a fraction of the rate limit.
  if (new URL(service.url).hostname === "api.safe.global" && !service.apiKey) {
    throw new Error("api.safe.global needs an API key: pass apiKey (get one at developer.safe.global)");
  }
  // A service for another chain would read another queue, where the same Safe address may have the same calls.
  const about = await request<{ chain_id?: number }>(`${service.url}/v1/about/ethereum-rpc/`, service);
  if (about.chain_id !== chainId) throw new Error(`${service.url} serves chain ${about.chain_id}, not ${chainId}`);
  return service;
}

/** A multisig transaction known to the service, with MultiSend batches flattened into calls. */
export interface SafeProposal {
  nonce: bigint;
  safeTxHash: Hash;
  executed: boolean;
  /** For an executed transaction: whether its calls took effect. */
  successful?: boolean;
  calls: Required<SafeCall>[];
  /**
   * Runs its calls the way a proposal of a batch would: a plain CALL, or an official MultiSend of plain CALLs, with
   * no gas refund. Only such a proposal can stand in for a batch.
   */
  plain: boolean;
}

export interface SafeQueue {
  onchainNonce: bigint;
  /** The nonce after every pending proposal. */
  nextNonce: bigint;
  /** Proposals that can still execute, in nonce order. */
  proposals: SafeProposal[];
  /** Nonces with more than one proposal: only one of them can execute. */
  contestedNonces: bigint[];
  /** Nonces below `nextNonce` with no proposal: nothing after them can execute until they are used. */
  missingNonces: bigint[];
}

interface ServiceTx {
  nonce: string | number;
  safeTxHash: Hash;
  to: string;
  value: string;
  data: Hex | null;
  operation: number;
  safeTxGas: string | number;
  baseGas: string | number;
  gasPrice: string | number;
  gasToken: string | null;
  refundReceiver: string | null;
  isExecuted: boolean;
  isSuccessful: boolean | null;
}

/** Reads every proposal that can still execute, i.e. not executed and at or above the on-chain nonce. */
export async function readSafeQueue(provider: Eip1193Provider, service: TxService, safe: Address): Promise<SafeQueue> {
  const onchainNonce = await publicClientFor(provider).readContract({
    address: safe,
    abi: safeAbi,
    functionName: "nonce",
  });
  // Until the service indexes the latest execution, its proposal still reads as pending but sits below the on-chain
  // nonce, so it is in neither list and its calls would look fresh: wait for the service instead.
  if (onchainNonce > 0n) {
    const latest = await readProposals(service, safe, `nonce=${onchainNonce - 1n}`);
    if (latest.length > 0 && !latest.some(p => p.executed)) {
      throw new Error(
        `The Safe service has not indexed nonce ${onchainNonce - 1n} of Safe ${safe} yet; try again in a minute`,
      );
    }
  }
  const proposals = await readProposals(service, safe, `executed=false&nonce__gte=${onchainNonce}`);
  const perNonce = new Map<bigint, number>();
  for (const { nonce } of proposals) perNonce.set(nonce, (perNonce.get(nonce) ?? 0) + 1);
  const nonces = [...perNonce.keys()];
  const nextNonce = nonces.reduce((max, n) => (n >= max ? n + 1n : max), onchainNonce);
  const missingNonces: bigint[] = [];
  for (let n = onchainNonce; n < nextNonce; n++) if (!perNonce.has(n)) missingNonces.push(n);
  return {
    onchainNonce,
    nextNonce,
    proposals,
    contestedNonces: nonces.filter(n => (perNonce.get(n) ?? 0) > 1),
    missingNonces,
  };
}

// Pages through every match: api-kit's getNextNonce reads only the first page. The service lists only trusted
// proposals by default, as the Safe UI does: unsigned ones posted by strangers are left out, and every execution is
// trusted.
async function readProposals(service: TxService, safe: Address, filter: string): Promise<SafeProposal[]> {
  const txs: ServiceTx[] = [];
  let url: string | null =
    `${service.url}/v2/safes/${getAddress(safe)}/multisig-transactions/?${filter}&ordering=nonce&limit=100`;
  while (url) {
    const page: { next: string | null; results: ServiceTx[] } = await request(url, service);
    txs.push(...page.results);
    url = nextPage(page.next, service);
  }
  return txs.map(tx => {
    const data = tx.data ?? "0x";
    const batched = tx.operation === DELEGATE_CALL && data.startsWith(MULTI_SEND_SELECTOR);
    const { calls, onlyCalls } = batched
      ? decodeMultiSend(data)
      : { calls: [normalizeCall({ to: getAddress(tx.to), data, value: BigInt(tx.value) })], onlyCalls: true };
    const noRefund =
      [tx.safeTxGas, tx.baseGas, tx.gasPrice].every(v => BigInt(v) === 0n) &&
      [tx.gasToken, tx.refundReceiver].every(a => a === null || isAddressEqual(getAddress(a), zeroAddress));
    const runsAsCalls = batched ? isOfficialMultiSend(tx.to) && onlyCalls : tx.operation === CALL;
    return {
      nonce: BigInt(tx.nonce),
      safeTxHash: tx.safeTxHash,
      executed: tx.isExecuted,
      ...(tx.isExecuted ? { successful: tx.isSuccessful !== false } : {}),
      calls,
      plain: noRefund && runsAsCalls,
    };
  });
}

export interface SafeBatchStatus {
  /**
   * `fresh`: nothing pending or executed shares its calls. `pending` / `executed`: one proposal makes exactly its
   * calls. `partial`: proposals share some of its calls but none makes exactly them.
   */
  status: "fresh" | "pending" | "executed" | "partial";
  /** The proposal that makes exactly the batch's calls. */
  match?: SafeProposal;
  /** The match is pending on a nonce with competing proposals, so it may never execute. */
  contested: boolean;
  /** Pending or executed proposals sharing some of the batch's calls. */
  overlapping: SafeProposal[];
  /** Executed since the batch was created, calling one of its contracts without sharing its calls. */
  touched: SafeProposal[];
  /** Where a proposal of the batch would go: after every pending one. */
  nextNonce: bigint;
  /** Nonces below `nextNonce` with no proposal, which a proposal at `nextNonce` would wait for. */
  missingNonces: bigint[];
}

// Executions shortly before `createdAt` count too, in case the staging machine's clock runs ahead.
const CLOCK_MARGIN_MS = 10 * 60_000;

/**
 * Checks a batch against its Safe's pending proposals and those executed since the batch was created (the service
 * indexes every execution, including batches imported in the Safe UI). Module executions are not checked.
 */
export async function safeBatchStatus(
  provider: Eip1193Provider,
  service: TxService,
  batch: SafeBatch,
): Promise<SafeBatchStatus> {
  const safe = batchSafe(batch);
  const calls = safeBatchCalls(batch).map(normalizeCall);
  const queue = await readSafeQueue(provider, service, safe);
  const since = new Date(batch.createdAt - CLOCK_MARGIN_MS).toISOString();
  const executed = (await readProposals(service, safe, `executed=true&execution_date__gte=${since}`)).filter(
    p => p.successful,
  );

  const exact = (p: SafeProposal) =>
    p.plain &&
    p.calls.length === calls.length &&
    p.calls.every((c, i) => {
      const ours = calls[i];
      return ours !== undefined && sameCall(c, ours);
    });
  const shares = (p: SafeProposal) => p.calls.some(c => calls.some(k => sameCall(c, k)));
  const targets = new Set(calls.map(c => c.to));

  const done = executed.find(exact);
  const queued = done ? undefined : queue.proposals.find(exact);
  const match = done ?? queued;
  const overlapping = match ? [] : [...queue.proposals, ...executed].filter(shares);
  const status = done ? "executed" : queued ? "pending" : overlapping.length > 0 ? "partial" : "fresh";
  return {
    status,
    ...(match ? { match } : {}),
    contested: queued !== undefined && queue.contestedNonces.includes(queued.nonce),
    overlapping,
    touched: executed.filter(p => p !== match && !shares(p) && p.calls.some(c => targets.has(c.to))),
    nextNonce: queue.nextNonce,
    missingNonces: queue.missingNonces,
  };
}

interface Delegate {
  safe: string | null;
  delegator: string;
  expiryDate: string | null;
}

/**
 * Whether `account` is a proposer for `safe`: a delegate, listed under Proposers in the Safe UI's settings, for this
 * Safe or for all of its delegator's Safes. Owners propose without being one. Counted as the service does: the
 * delegator must still be an owner, and the delegation must not have expired. `safe` is its address, or what
 * `readSafe` returned, to skip reading its owners again.
 */
export async function isProposer(
  provider: Eip1193Provider,
  service: TxService,
  safe: Address | { address: Address; owners: readonly Address[] },
  account: Address,
): Promise<boolean> {
  if (typeof safe === "string") {
    const info = await readSafe(provider, getAddress(safe));
    if (!info) throw new Error(`${safe} is not a Safe`);
    safe = info;
  }
  const now = Date.now();
  const counts = (d: Delegate) =>
    (d.safe === null || isAddressEqual(getAddress(d.safe), safe.address)) &&
    safe.owners.some(o => isAddressEqual(o, getAddress(d.delegator))) &&
    (d.expiryDate === null || Date.parse(d.expiryDate) > now);
  let url: string | null = `${service.url}/v2/delegates/?delegate=${getAddress(account)}&limit=100`;
  while (url) {
    const page: { next: string | null; results: Delegate[] } = await request(url, service);
    if (page.results.some(counts)) return true;
    url = nextPage(page.next, service);
  }
  return false;
}

/**
 * Signs the safeTxHash as raw bytes (eth_sign). Any viem account fits, whatever its viem version; for ethers, wrap
 * a wallet: `{ address: w.address, signMessage: ({ message }) => w.signMessage(getBytes(message.raw)) }` (ethers v6;
 * v5 uses `arrayify`).
 */
export interface ProposalSigner {
  address: string;
  signMessage(args: { message: { raw: Hash } }): Promise<string>;
}

export interface ProposeOptions {
  nonce: bigint;
  /** The app the Safe UI names as the proposal's origin. Defaults to `safe-ops`. */
  origin?: string;
  /** A note the Safe UI shows signers with the proposal, cut to fit the service's 200 characters for both. */
  note?: string;
}

export interface Proposal {
  safe: Address;
  safeTxHash: Hash;
  nonce: bigint;
  proposer: Address;
}

export interface ProposeSafeBatchOptions {
  /** The app the Safe UI names as the proposal's origin. Defaults to `safe-ops`. */
  origin?: string;
  /** A note the Safe UI shows signers with the proposal. Defaults to the batch's description, or else its name. */
  note?: string;
  /** Allow calls with calldata to addresses without code, which otherwise refuse the proposal. */
  allowCallsWithoutCode?: boolean;
}

export interface ProposeSafeBatchResult extends SafeBatchStatus {
  /** Set when the batch was fresh and is now proposed. */
  proposal?: Proposal;
}

/**
 * Proposes exactly the batch's calls as one Safe transaction after the Safe's pending ones, if `safeBatchStatus`
 * finds it fresh; otherwise returns the status without proposing. `signer` must be an owner or a proposer.
 */
export async function proposeSafeBatch(
  provider: Eip1193Provider,
  service: TxService,
  signer: ProposalSigner,
  batch: SafeBatch,
  options: ProposeSafeBatchOptions = {},
): Promise<ProposeSafeBatchResult> {
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
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    note: options.note ?? batch.meta.description ?? batch.meta.name,
  });
  return { ...status, proposal };
}

/**
 * Proposes `calls` as one Safe transaction at `options.nonce`, signed by `signer`, which must be an owner or a
 * proposer of the Safe. The proposer is always `signer`'s own address: the service rejects any other sender.
 */
export async function proposeCalls(
  provider: Eip1193Provider,
  service: TxService,
  signer: ProposalSigner,
  safe: Address,
  calls: readonly SafeCall[],
  options: ProposeOptions,
): Promise<Proposal> {
  if (calls.length === 0) throw new Error("No calls to propose");
  // Fork state would be proposed to the real queue.
  if (await localNodeVersion(provider)) throw new Error("Refusing to propose from a local Hardhat or Anvil node");
  const client = publicClientFor(provider);
  const chainId = await client.getChainId();
  if (chainId !== service.chainId) throw new Error(`Node is on chain ${chainId}, service on ${service.chainId}`);
  const info = await readSafe(provider, getAddress(safe));
  if (!info) throw new Error(`${safe} is not a Safe`);
  // Below 1.3.0, a call that fails without safeTxGas still uses up the nonce, and 1.0.0 can't check eth_sign.
  if (/^1\.[0-2]\./.test(info.version)) {
    throw new Error(`Safe ${info.address} is ${info.version}; proposing needs 1.3.0 or later`);
  }

  const [to, value, data, operation] = await safeTxFields(provider, info.version, calls.map(normalizeCall));
  const { nonce } = options;
  const safeTxHash = await client.readContract({
    address: info.address,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  });
  // An eth_sign signature: the Safe tells it from an EIP-712 one by v + 4.
  const proposer = getAddress(signer.address);
  const signed = await signer.signMessage({ message: { raw: safeTxHash } });
  // The service would reject a signature from another key; failing here says why.
  if (!isHex(signed) || size(signed) !== 65) throw new Error(`Signer for ${proposer} returned a malformed signature`);
  if (!isAddressEqual(await recoverMessageAddress({ message: { raw: safeTxHash }, signature: signed }), proposer)) {
    throw new Error(`Signer's signature does not recover to its address ${proposer}`);
  }
  // Some signers return v as 0/1; Safe reads eth_sign only from 31/32, i.e. 27/28 + 4.
  const v = hexToNumber(sliceHex(signed, 64));
  const signature = concatHex([sliceHex(signed, 0, 64), numberToHex((v < 27 ? v + 27 : v) + 4)]);

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
    origin: originOf(options.origin ?? "safe-ops", options.note),
  });
  return { safe: info.address, safeTxHash, nonce, proposer };
}

// A page link elsewhere (e.g. http behind a proxy) would carry the API key off the service.
function nextPage(next: string | null, service: TxService): string | null {
  if (next !== null && new URL(next).origin !== new URL(service.url).origin) {
    throw new Error(`${service.url} links its next page to another origin: ${next}`);
  }
  return next;
}

// The Safe UI reads `origin` only as JSON with string `name`, `url` and `note`; a plain string shows nothing.
function originOf(name: string, note: string | undefined): string {
  // Cut by code point: half an emoji is not valid text.
  const head = (text: string, n: number) => Array.from(text).slice(0, n).join("");
  const json = (text?: string) => JSON.stringify({ name: head(name, 50), ...(text ? { note: text } : {}) });
  if (!note || json(note).length <= ORIGIN_MAX_LENGTH) return json(note);
  let length = Array.from(note).length;
  while (length > 0 && json(`${head(note, length)}…`).length > ORIGIN_MAX_LENGTH) length--;
  return json(length > 0 ? `${head(note, length)}…` : undefined);
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, service?: { apiKey?: string }, body?: unknown): Promise<T> {
  const method = body === undefined ? "GET" : "POST";
  // A POST that failed in transit or at a gateway may have been stored; a 4xx means the service refused it.
  const mayHaveLanded = method === "POST" ? "; it may still have landed, and a rerun skips what is already queued" : "";
  let ok: boolean, status: number, text: string, location: string | null | undefined;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(service?.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A redirect to another host drops the Authorization header, so the key would silently stop counting.
      redirect: "manual",
      // A hung service must not hang the deploy. Covers reading the body too.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  return (text ? JSON.parse(text) : undefined) as T;
}
