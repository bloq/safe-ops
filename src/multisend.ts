import { getMultiSendCallOnlyDeployment, getMultiSendDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBigInt,
  hexToNumber,
  keccak256,
  size,
  sliceHex,
  type Address,
  type Hex,
} from "viem";
import { CALL, DELEGATE_CALL, multiSendAbi } from "./abi.js";
import { normalizeCall } from "./call.js";
import { publicClientFor } from "./client.js";
import type { Eip1193Provider, SafeCall } from "./types.js";

/** Full `multiSend(bytes)` calldata. protocol-kit's `encodeMultiSendData` returns only the packed bytes. */
export function encodeMultiSendCall(calls: readonly SafeCall[]): Hex {
  const packed = calls
    .map(normalizeCall)
    .map(c =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [CALL, c.to, c.value, BigInt(size(c.data)), c.data],
      ),
    );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concatHex(packed)] });
}

/** The calls inside `multiSend(bytes)` calldata, whichever MultiSend it was built for. */
export function decodeMultiSendCall(data: Hex): Required<SafeCall>[] {
  return decodeMultiSend(data).calls;
}

/** The calls inside `multiSend(bytes)` calldata, and whether every one of them is a plain CALL. */
export function decodeMultiSend(data: Hex): { calls: Required<SafeCall>[]; onlyCalls: boolean } {
  const { args } = decodeFunctionData({ abi: multiSendAbi, data });
  const [packed] = args;
  const calls: Required<SafeCall>[] = [];
  let onlyCalls = true;
  // Each call is packed as operation (1 byte), to (20), value (32), data length (32), data.
  for (let i = 0; i < size(packed);) {
    const length = Number(hexToBigInt(sliceHex(packed, i + 53, i + 85)));
    if (hexToNumber(sliceHex(packed, i, i + 1)) !== CALL) onlyCalls = false;
    calls.push({
      to: getAddress(sliceHex(packed, i + 1, i + 21)),
      value: hexToBigInt(sliceHex(packed, i + 21, i + 53)),
      data: length === 0 ? "0x" : sliceHex(packed, i + 85, i + 85 + length, { strict: true }),
    });
    i += 85 + length;
  }
  return { calls, onlyCalls };
}

let multiSends: Set<string> | undefined;

/** Whether `address` is an official MultiSend or MultiSendCallOnly deployment (safe-deployments, any chain). */
export function isOfficialMultiSend(address: string): boolean {
  multiSends ??= new Set(
    ["1.1.1", "1.3.0", "1.4.1", "1.5.0"]
      .flatMap(version => [getMultiSendDeployment({ version }), getMultiSendCallOnlyDeployment({ version })])
      .flatMap(d =>
        d ? [...Object.values(d.deployments).map(x => x.address), ...Object.values(d.networkAddresses).flat()] : [],
      )
      .map(a => a.toLowerCase()),
  );
  return multiSends.has(address.toLowerCase());
}

/** The Safe transaction for `calls`: a single call as is, several through MultiSendCallOnly. */
export async function safeTxFields(
  provider: Eip1193Provider,
  version: string,
  calls: readonly Required<SafeCall>[],
): Promise<readonly [Address, bigint, Hex, typeof CALL | typeof DELEGATE_CALL]> {
  const [only] = calls;
  if (calls.length === 1 && only) return [only.to, only.value, only.data, CALL];
  return [await resolveMultiSendCallOnly(provider, version), 0n, encodeMultiSendCall(calls), DELEGATE_CALL];
}

/**
 * Finds the MultiSendCallOnly for `safeVersion` on the connected chain and checks its code hash against
 * safe-deployments, so a fork with a different chain id still resolves to verified bytecode.
 */
export async function resolveMultiSendCallOnly(provider: Eip1193Provider, safeVersion: string): Promise<Address> {
  const client = publicClientFor(provider);
  const deployment = getMultiSendCallOnlyDeployment({ version: multiSendVersion(safeVersion) });
  if (!deployment) throw new Error(`No MultiSendCallOnly deployment for Safe ${safeVersion}`);

  const chainId = String(await client.getChainId());
  const candidates = new Map<string, string>();
  for (const { address, codeHash } of Object.values(deployment.deployments)) candidates.set(address, codeHash);
  const listed = deployment.networkAddresses[chainId];
  const ordered = [...(listed ? [listed] : []), ...candidates.keys()];

  for (const address of new Set(ordered)) {
    const code = await client.getCode({ address: getAddress(address) });
    if (code && code !== "0x" && keccak256(code) === candidates.get(address)) return getAddress(address);
  }
  throw new Error(`MultiSendCallOnly ${deployment.version} is not deployed on chain ${chainId}`);
}

// MultiSendCallOnly first shipped with 1.3.0 and doesn't depend on the Safe, so older Safes use 1.3.0
// (as protocol-kit does).
function multiSendVersion(safeVersion: string): string {
  const base = safeVersion.split("+")[0] ?? safeVersion;
  const [major = 0, minor = 0] = base.split(".").map(Number);
  return major === 1 && minor < 3 ? "1.3.0" : base;
}
