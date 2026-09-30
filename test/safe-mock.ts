import { decodeFunctionData, encodeFunctionResult, numberToHex, pad, type Abi, type Hex } from "viem";
import { safeAbi } from "../src/abi.js";
import type { Eip1193Provider } from "../src/index.js";

export const OWNER = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
export const SINGLETON_141 = "0x41675C099F32341bf84BFc5382aF534df5C7461a";

export interface MockOptions {
  clientVersion?: string;
  chainId?: number;
  version?: string;
  /** Addresses that have no code. Every other address answers as a 1-of-1 Safe owned by OWNER. */
  codeless?: readonly string[];
  /** Slot 0 of every contract, i.e. the Safe singleton. Defaults to the official Safe 1.4.1 singleton. */
  slot0?: string;
  /** Raw eth_call results by function name, overriding the 1-of-1 Safe answers. */
  raw?: Partial<Record<"getThreshold" | "getOwners" | "VERSION", unknown>>;
}

/** A node where every address with code reads as a Safe; enough for reads, not for sending. */
export function safeProvider(options: MockOptions = {}): Eip1193Provider {
  const results: Record<string, unknown> = {
    VERSION: options.version ?? "1.4.1",
    getThreshold: 1n,
    getOwners: [OWNER],
  };
  const codeless = new Set((options.codeless ?? []).map(a => a.toLowerCase()));
  return {
    request({ method, params }) {
      const [first] = (params ?? []) as [unknown];
      switch (method) {
        case "eth_chainId":
          return Promise.resolve(numberToHex(options.chainId ?? 1));
        case "web3_clientVersion":
          return Promise.resolve(options.clientVersion ?? "Geth/v1.16.0");
        case "eth_getCode":
          return Promise.resolve(codeless.has(String(first).toLowerCase()) ? "0x" : "0x6080");
        case "eth_getStorageAt":
          // Accounts without code have empty storage, like a real EOA.
          if (codeless.has(String(first).toLowerCase())) return Promise.resolve(pad("0x0"));
          return Promise.resolve(pad((options.slot0 ?? SINGLETON_141) as Hex));
        case "eth_call": {
          const { data } = first as { data: Hex };
          const { functionName } = decodeFunctionData({ abi: safeAbi, data });
          const raw = options.raw as Record<string, unknown> | undefined;
          if (raw && functionName in raw) {
            const answer = raw[functionName];
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
          }
          const abi: Abi = safeAbi;
          return Promise.resolve(encodeFunctionResult({ abi, functionName, result: results[functionName] }));
        }
        default:
      }
      return Promise.reject(Object.assign(new Error(`Unexpected ${method}`), { code: -32601 }));
    },
  };
}
