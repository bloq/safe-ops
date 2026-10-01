import { createPublicClient, custom, type PublicClient } from "viem";
import type { Eip1193Provider, SafeCall } from "./types.js";

export function publicClientFor(provider: Eip1193Provider): PublicClient {
  return createPublicClient({ transport: custom(provider), pollingInterval: 50 });
}

/**
 * The client version when `provider` is a local Hardhat or Anvil node, else undefined. Impersonation on a live RPC
 * that happens to support it (e.g. a hosted fork) must never be mistaken for a rehearsal.
 */
export async function localNodeVersion(provider: Eip1193Provider): Promise<string | undefined> {
  try {
    const version = String(await provider.request({ method: "web3_clientVersion" }));
    return /^(HardhatNetwork|anvil)\//i.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The first and the deepest message in an error's cause chain; the deepest is the node's, with the revert reason. */
export function describeError(error: unknown): string {
  const messages: string[] = [];
  for (let e: unknown = error; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
    const { shortMessage, details, message } = e as Record<string, unknown>;
    const text = [shortMessage, details, message].find(m => typeof m === "string" && m.length > 0) as
      string | undefined;
    if (text && !messages.includes(text)) messages.push(text);
  }
  const first = messages[0] ?? String(error);
  const deepest = messages.at(-1) ?? first;
  return deepest === first ? first : `${first} (${deepest})`;
}

/** Rejects calldata sent to an address without code: the EVM treats it as a successful no-op. */
export async function assertCallTargetsHaveCode(client: PublicClient, calls: readonly SafeCall[]): Promise<void> {
  for (const [i, call] of calls.entries()) {
    if (call.data === "0x") continue;
    const code = await client.getCode({ address: call.to });
    if (!code || code === "0x") {
      throw new Error(
        `Call ${i} sends calldata to ${call.to}, which has no code here; pass allowCallsWithoutCode if that is intended`,
      );
    }
  }
}
