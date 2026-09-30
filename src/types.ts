import type { Address, Hex } from "viem";

export interface SafeCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}
