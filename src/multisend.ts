import { getMultiSendCallOnlyDeployment } from "@safe-global/safe-deployments";
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  size,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { CALL, multiSendAbi } from "./abi.js";
import { normalizeCall } from "./call.js";
import type { SafeCall } from "./types.js";

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

/**
 * Finds the MultiSendCallOnly for `safeVersion` on the connected chain and checks its code hash against
 * safe-deployments, so a fork with a different chain id still resolves to verified bytecode.
 */
export async function resolveMultiSendCallOnly(client: PublicClient, safeVersion: string): Promise<Address> {
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
