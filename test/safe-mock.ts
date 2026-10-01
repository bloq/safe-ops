import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, pad, type Abi, type Hex } from "viem";
import { encodeMultiSendCall } from "../src/multisend.js";
import { safeAbi } from "../src/abi.js";
import type { Eip1193Provider, SafeCall } from "../src/index.js";

export const OWNER = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
export const SINGLETON_141 = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
export const SAFE_NONCE = 39n;

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
    nonce: SAFE_NONCE,
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
          // A stand-in for the real hash that still changes with every argument.
          if (functionName === "getTransactionHash") return Promise.resolve(keccak256(data));
          const abi: Abi = safeAbi;
          return Promise.resolve(encodeFunctionResult({ abi, functionName, result: results[functionName] }));
        }
        default:
      }
      return Promise.reject(Object.assign(new Error(`Unexpected ${method}`), { code: -32601 }));
    },
  };
}

let txCount = 0;
/** A multisig transaction as the service lists it: one call as is, several through MultiSend. */
export function serviceTx(
  nonce: number,
  calls: SafeCall[],
  opts: { executed?: boolean; successful?: boolean; operation?: number; to?: string; gasPrice?: string } = {},
) {
  const [only] = calls;
  const single = calls.length === 1 && only;
  return {
    nonce: String(nonce),
    safeTxHash: keccak256(numberToHex(1000 + txCount++)),
    to: opts.to ?? (single ? only.to : "0x9641d764fc13c8B624c04430C7356C1C7C8102e2"),
    value: single ? String(only.value ?? 0n) : "0",
    data: single ? only.data : encodeMultiSendCall(calls),
    operation: opts.operation ?? (single ? 0 : 1),
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: opts.gasPrice ?? "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    isExecuted: opts.executed ?? false,
    isSuccessful: opts.executed ? (opts.successful ?? true) : null,
  };
}
