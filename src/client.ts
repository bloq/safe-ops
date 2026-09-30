import { createPublicClient, custom, type PublicClient } from "viem";
import type { Eip1193Provider } from "./types.js";

export function publicClientFor(provider: Eip1193Provider): PublicClient {
  return createPublicClient({ transport: custom(provider), pollingInterval: 50 });
}
