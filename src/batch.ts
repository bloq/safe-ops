import { getAddress, type Address } from "viem";
import { normalizeCall } from "./call.js";
import type { SafeCall } from "./types.js";

export interface AddOptions {
  /** Queue the call even if it repeats the latest call to the same contract, e.g. a deliberate second mint. */
  allowDuplicate?: boolean;
}

/**
 * Calls queued per Safe, in insertion order. A call identical to the latest call already queued for the same
 * contract is dropped: deploy scripts guard on executed state, which queued calls don't change yet, so two
 * scripts can queue the same call. `x.update(1), x.update(2), x.update(1)` keeps all three.
 */
export class SafeBatch {
  readonly #groups = new Map<Address, Required<SafeCall>[]>();

  /** Returns false when the call was dropped as a duplicate. */
  add(safe: Address, call: SafeCall, options: AddOptions = {}): boolean {
    const key = getAddress(safe);
    const normalized = normalizeCall(call);
    const calls = this.#groups.get(key) ?? [];
    const latest = latestCallTo(calls, normalized.to);
    if (!options.allowDuplicate && latest && sameCall(latest, normalized)) return false;
    calls.push(normalized);
    this.#groups.set(key, calls);
    return true;
  }

  get safes(): Address[] {
    return [...this.#groups.keys()];
  }

  calls(safe: Address): readonly SafeCall[] {
    return [...(this.#groups.get(getAddress(safe)) ?? [])];
  }

  get size(): number {
    let total = 0;
    for (const calls of this.#groups.values()) total += calls.length;
    return total;
  }

  clear(): void {
    this.#groups.clear();
  }
}

function latestCallTo(calls: readonly Required<SafeCall>[], to: Address): Required<SafeCall> | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call?.to === to) return call;
  }
  return undefined;
}

function sameCall(a: Required<SafeCall>, b: Required<SafeCall>): boolean {
  return a.to === b.to && a.data.toLowerCase() === b.data.toLowerCase() && a.value === b.value;
}
