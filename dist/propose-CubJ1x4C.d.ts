import { Address, Hex, Hash } from 'viem';

interface SafeCall {
    to: Address;
    data: Hex;
    value?: bigint;
}
interface Eip1193Provider {
    request(args: {
        method: string;
        params?: unknown;
    }): Promise<unknown>;
}

/** Safe transaction operations. */
declare const CALL = 0;
declare const DELEGATE_CALL = 1;

interface SafeBatchMeta {
    name: string;
    description?: string;
    txBuilderVersion?: string;
    checksum?: string;
    createdFromSafeAddress?: string;
    createdFromOwnerAddress?: string;
}
interface BatchTransaction {
    to: string;
    value: string;
    /** `null` for a plain ETH transfer made in the Safe UI. */
    data?: string | null;
    contractMethod?: unknown;
    contractInputsValues?: Record<string, string>;
}
interface SafeBatch {
    version: string;
    chainId: string;
    createdAt: number;
    meta: SafeBatchMeta;
    transactions: BatchTransaction[];
}
interface CreateSafeBatchOptions {
    chainId: bigint | number;
    safe: Address;
    calls: readonly SafeCall[];
    name: string;
    description?: string;
    createdAt?: number;
}
declare function createSafeBatch(options: CreateSafeBatchOptions): SafeBatch;
declare function validateSafeBatch(file: SafeBatch): boolean;
/** Calls in a batch file. Only raw `data` entries are supported, which is what `createSafeBatch` writes. */
declare function safeBatchCalls(file: SafeBatch): SafeCall[];

interface ForkExecution {
    safe: Address;
    safeTxHash: Hash;
    txHash: Hash;
    nonce: bigint;
    approvers: Address[];
    /** The Safe transaction's target: the single call's `to`, or MultiSendCallOnly for a batch. */
    to: Address;
    operation: typeof CALL | typeof DELEGATE_CALL;
}
interface ForkOptions {
    /** Allow a call with calldata to an address that has no code, which would otherwise silently do nothing. */
    allowCallsWithoutCode?: boolean;
}
/**
 * Executes `calls` as one Safe transaction on a fork (Hardhat or Anvil): the first `threshold` owners are
 * impersonated to `approveHash`, then `execTransaction` runs with pre-validated signatures. Batches go through
 * MultiSendCallOnly exactly as the Safe UI would, so the whole batch reverts if any call reverts. Owners stay
 * impersonated afterwards.
 */
declare function executeOnFork(provider: Eip1193Provider, safe: Address, calls: readonly SafeCall[], options?: ForkOptions): Promise<ForkExecution>;
interface RehearseOptions extends ForkOptions {
    /** Rehearse a batch made for another chain, e.g. a mainnet batch on a Hardhat fork running as 31337. */
    allowChainMismatch?: boolean;
}
/** Executes exactly the batch's calls through its Safe on a fork, after checking its checksum and chain. */
declare function rehearseSafeBatch(provider: Eip1193Provider, batch: SafeBatch, options?: RehearseOptions): Promise<ForkExecution>;

interface TxServiceOptions {
    /** The service's API root, e.g. `https://api.safe.global/tx-service/eth/api`. Defaults to Safe's for the chain. */
    txServiceUrl?: string;
    /** Required by api.safe.global; get one at developer.safe.global. */
    apiKey?: string;
}
interface TxService {
    url: string;
    chainId: number;
    apiKey?: string;
}
/** The Safe Transaction Service for `chainId`, looked up in Safe's config service unless `txServiceUrl` is given. */
declare function resolveTxService(chainId: number, options?: TxServiceOptions): Promise<TxService>;
/** A multisig transaction known to the service, with MultiSend batches flattened into calls. */
interface SafeProposal {
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
interface SafeQueue {
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
/** Reads every proposal that can still execute, i.e. not executed and at or above the on-chain nonce. */
declare function readSafeQueue(provider: Eip1193Provider, service: TxService, safe: Address): Promise<SafeQueue>;
interface SafeBatchStatus {
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
/**
 * Checks a batch against its Safe's pending proposals and those executed since the batch was created (the service
 * indexes every execution, including batches imported in the Safe UI). Module executions are not checked.
 */
declare function safeBatchStatus(provider: Eip1193Provider, service: TxService, batch: SafeBatch): Promise<SafeBatchStatus>;
/**
 * Whether `account` is a proposer for `safe`: a delegate, listed under Proposers in the Safe UI's settings, for this
 * Safe or for all of its delegator's Safes. Owners propose without being one. Counted as the service does: the
 * delegator must still be an owner, and the delegation must not have expired. `safe` is its address, or what
 * `readSafe` returned, to skip reading its owners again.
 */
declare function isProposer(provider: Eip1193Provider, service: TxService, safe: Address | {
    address: Address;
    owners: readonly Address[];
}, account: Address): Promise<boolean>;
/**
 * Signs the safeTxHash as raw bytes (eth_sign). Any viem account fits, whatever its viem version; for ethers, wrap
 * a wallet: `{ address: w.address, signMessage: ({ message }) => w.signMessage(getBytes(message.raw)) }` (ethers v6;
 * v5 uses `arrayify`).
 */
interface ProposalSigner {
    address: string;
    signMessage(args: {
        message: {
            raw: Hash;
        };
    }): Promise<string>;
}
interface Proposal {
    safe: Address;
    safeTxHash: Hash;
    nonce: bigint;
    proposer: Address;
}
interface ProposeSafeBatchOptions {
    /** The app the Safe UI names as the proposal's origin. Defaults to `safe-ops`. */
    origin?: string;
    /** A note the Safe UI shows signers with the proposal. Defaults to the batch's description, or else its name. */
    note?: string;
    /** Allow calls with calldata to addresses without code, which otherwise refuse the proposal. */
    allowCallsWithoutCode?: boolean;
}
interface ProposeSafeBatchResult extends SafeBatchStatus {
    /** Set when the batch was fresh and is now proposed. */
    proposal?: Proposal;
}
/**
 * Proposes exactly the batch's calls as one Safe transaction after the Safe's pending ones, if `safeBatchStatus`
 * finds it fresh; otherwise returns the status without proposing. `signer` must be an owner or a proposer.
 */
declare function proposeSafeBatch(provider: Eip1193Provider, service: TxService, signer: ProposalSigner, batch: SafeBatch, options?: ProposeSafeBatchOptions): Promise<ProposeSafeBatchResult>;

export { type BatchTransaction as B, type CreateSafeBatchOptions as C, type Eip1193Provider as E, type ForkExecution as F, type ProposalSigner as P, type RehearseOptions as R, type SafeBatch as S, type TxService as T, type ProposeSafeBatchResult as a, type SafeCall as b, type ForkOptions as c, type Proposal as d, type ProposeSafeBatchOptions as e, type SafeBatchMeta as f, type SafeBatchStatus as g, type SafeProposal as h, type SafeQueue as i, type TxServiceOptions as j, createSafeBatch as k, executeOnFork as l, isProposer as m, rehearseSafeBatch as n, resolveTxService as o, proposeSafeBatch as p, safeBatchStatus as q, readSafeQueue as r, safeBatchCalls as s, validateSafeBatch as v };
