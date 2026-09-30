import { getAddress, isHex } from "viem";
import type { SafeCall } from "./types.js";

/** Checksums `to`, defaults `value` to 0 and rejects calldata or values the Safe would misread. */
export function normalizeCall(call: SafeCall): Required<SafeCall> {
  if (!isHex(call.data, { strict: true }) || call.data.length % 2 !== 0) {
    throw new Error(`Call to ${call.to} has malformed data ${call.data}: expected whole bytes of hex`);
  }
  const value: unknown = call.value ?? 0n;
  // Plain-JS and JSON callers can pass numbers or strings, which would be written into the file as-is.
  if (typeof value !== "bigint") throw new Error(`Call to ${call.to} has a non-bigint value ${String(value)}`);
  if (value < 0n) throw new Error(`Call to ${call.to} has a negative value ${value}`);
  return { to: getAddress(call.to), data: call.data, value };
}
