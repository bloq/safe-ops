import { getSafeL2SingletonDeployments, getSafeSingletonDeployments } from "@safe-global/safe-deployments";
import { getAddress, isAddressEqual, size, sliceHex, type Address } from "viem";
import { safeAbi } from "./abi.js";
import { publicClientFor } from "./client.js";
import { isProposer, type TxService } from "./propose.js";
import type { Eip1193Provider } from "./types.js";

const EIP7702_PREFIX = "0xef0100";

export interface SafeInfo {
  address: Address;
  version: string;
  threshold: bigint;
  owners: Address[];
  singleton: Address;
}

export type AccountInfo =
  | { kind: "eoa"; address: Address }
  | { kind: "eip7702"; address: Address; delegate: Address }
  | { kind: "safe"; address: Address; safe: SafeInfo }
  | { kind: "contract"; address: Address };

export async function classifyAccount(provider: Eip1193Provider, account: Address): Promise<AccountInfo> {
  const address = getAddress(account);
  const code = await publicClientFor(provider).getCode({ address });
  if (!code || code === "0x") return { kind: "eoa", address };
  if (code.startsWith(EIP7702_PREFIX) && code.length === 48) {
    return { kind: "eip7702", address, delegate: getAddress(sliceHex(code, 3)) };
  }
  const safe = await readSafe(provider, address);
  return safe ? { kind: "safe", address, safe } : { kind: "contract", address };
}

/**
 * Reads `address` as a Safe: a proxy whose slot 0 holds an official Safe singleton (safe-deployments, every version,
 * L1 and L2). Anything else is not a Safe, without calling it, so no RPC error can be mistaken for a "no". Once the
 * singleton matches, a failed read throws. An uninitialized proxy (no threshold or owners) is not a Safe.
 */
export async function readSafe(provider: Eip1193Provider, address: Address): Promise<SafeInfo | undefined> {
  const client = publicClientFor(provider);
  const slot0 = await client.getStorageAt({ address, slot: "0x0" });
  if (!slot0 || size(slot0) !== 32) return undefined;
  const singleton = getAddress(sliceHex(slot0, 12));
  if (!officialSingletons().has(singleton.toLowerCase())) return undefined;

  // Threshold first: on an uninitialized proxy getOwners reverts.
  const threshold = await client.readContract({ address, abi: safeAbi, functionName: "getThreshold" });
  if (threshold === 0n) return undefined;
  const [version, owners] = await Promise.all([
    client.readContract({ address, abi: safeAbi, functionName: "VERSION" }),
    client.readContract({ address, abi: safeAbi, functionName: "getOwners" }),
  ]);
  return { address, version, threshold, owners: [...owners], singleton };
}

let singletons: Set<string> | undefined;

function officialSingletons(): Set<string> {
  singletons ??= new Set(
    ["1.0.0", "1.1.1", "1.2.0", "1.3.0", "1.4.1", "1.5.0"]
      .flatMap(version => [getSafeSingletonDeployments({ version }), getSafeL2SingletonDeployments({ version })])
      .flatMap(d =>
        d ? [...Object.values(d.deployments).map(x => x.address), ...Object.values(d.networkAddresses).flat()] : [],
      )
      .map(a => a.toLowerCase()),
  );
  return singletons;
}

export type OwnerRoute =
  | { kind: "direct"; owner: Address }
  | { kind: "safe"; owner: Address; safe: SafeInfo }
  | { kind: "skip"; owner: Address; reason: string };

export interface RouteOptions {
  /** The Safe's transaction service, to also route a caller that is a proposer (delegate) of the Safe. */
  service?: TxService;
}

/** Decides how `caller` can act for `owner`: sign directly, go through the owner's Safe, or not at all. */
export async function resolveOwnerRoute(
  provider: Eip1193Provider,
  owner: Address,
  caller: Address,
  options: RouteOptions = {},
): Promise<OwnerRoute> {
  const account = await classifyAccount(provider, owner);
  const { address } = account;
  const isCaller = isAddressEqual(address, caller);

  switch (account.kind) {
    case "safe": {
      // A Safe has no key: even as the caller it can only act through its owners or delegates.
      const { safe } = account;
      if (isCaller) return { kind: "skip", owner: address, reason: `Safe ${address} can't sign for itself` };
      if (safe.owners.some(o => isAddressEqual(o, caller))) return { kind: "safe", owner: address, safe };
      if (!options.service) {
        return {
          kind: "skip",
          owner: address,
          reason: `${caller} is not an owner of Safe ${address} (pass service to check its proposers)`,
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
