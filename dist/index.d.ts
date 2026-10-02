import { Address, Hex } from 'viem';
import { T as TxService, E as Eip1193Provider, b as SafeCall } from './propose-CubJ1x4C.js';
export { B as BatchTransaction, C as CreateSafeBatchOptions, F as ForkExecution, c as ForkOptions, d as Proposal, P as ProposalSigner, e as ProposeSafeBatchOptions, a as ProposeSafeBatchResult, R as RehearseOptions, S as SafeBatch, f as SafeBatchMeta, g as SafeBatchStatus, h as SafeProposal, i as SafeQueue, j as TxServiceOptions, k as createSafeBatch, l as executeOnFork, m as isProposer, p as proposeSafeBatch, r as readSafeQueue, n as rehearseSafeBatch, o as resolveTxService, s as safeBatchCalls, q as safeBatchStatus, v as validateSafeBatch } from './propose-CubJ1x4C.js';

interface SafeInfo {
    address: Address;
    version: string;
    threshold: bigint;
    owners: Address[];
    singleton: Address;
}
type AccountInfo = {
    kind: "eoa";
    address: Address;
} | {
    kind: "eip7702";
    address: Address;
    delegate: Address;
} | {
    kind: "safe";
    address: Address;
    safe: SafeInfo;
} | {
    kind: "contract";
    address: Address;
};
declare function classifyAccount(provider: Eip1193Provider, account: Address): Promise<AccountInfo>;
/**
 * Reads `address` as a Safe: a proxy whose slot 0 holds an official Safe singleton (safe-deployments, every version,
 * L1 and L2). Anything else is not a Safe, without calling it, so no RPC error can be mistaken for a "no". Once the
 * singleton matches, a failed read throws. An uninitialized proxy (no threshold or owners) is not a Safe.
 */
declare function readSafe(provider: Eip1193Provider, address: Address): Promise<SafeInfo | undefined>;
type OwnerRoute = {
    kind: "direct";
    owner: Address;
} | {
    kind: "safe";
    owner: Address;
    safe: SafeInfo;
} | {
    kind: "skip";
    owner: Address;
    reason: string;
};
interface RouteOptions {
    /** The Safe's transaction service, to also route a caller that is a proposer (delegate) of the Safe. */
    service?: TxService;
}
/** Decides how `caller` can act for `owner`: sign directly, go through the owner's Safe, or not at all. */
declare function resolveOwnerRoute(provider: Eip1193Provider, owner: Address, caller: Address, options?: RouteOptions): Promise<OwnerRoute>;

/** The calls inside `multiSend(bytes)` calldata, whichever MultiSend it was built for. */
declare function decodeMultiSendCall(data: Hex): Required<SafeCall>[];

export { type AccountInfo, Eip1193Provider, type OwnerRoute, type RouteOptions, SafeCall, type SafeInfo, TxService, classifyAccount, decodeMultiSendCall, readSafe, resolveOwnerRoute };
