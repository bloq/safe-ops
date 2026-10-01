import { getAddress, isHex, keccak256, stringToHex, type Address, type Hex } from "viem";
import { normalizeCall } from "./call.js";
import type { SafeCall } from "./types.js";

// Schema and checksum follow safe-wallet-monorepo apps/tx-builder (typings/models.ts, lib/checksum.ts).
export const TX_BUILDER_VERSION = "2.1.0";

export interface SafeBatchMeta {
  name: string;
  description?: string;
  txBuilderVersion?: string;
  checksum?: string;
  createdFromSafeAddress?: string;
  createdFromOwnerAddress?: string;
}

export interface BatchTransaction {
  to: string;
  value: string;
  /** `null` for a plain ETH transfer made in the Safe UI. */
  data?: string | null;
  contractMethod?: unknown;
  contractInputsValues?: Record<string, string>;
}

export interface SafeBatch {
  version: string;
  chainId: string;
  createdAt: number;
  meta: SafeBatchMeta;
  transactions: BatchTransaction[];
}

export interface CreateSafeBatchOptions {
  chainId: bigint | number;
  safe: Address;
  calls: readonly SafeCall[];
  name: string;
  description?: string;
  createdAt?: number;
}

export function createSafeBatch(options: CreateSafeBatchOptions): SafeBatch {
  const meta: SafeBatchMeta = {
    name: options.name,
    txBuilderVersion: TX_BUILDER_VERSION,
    createdFromSafeAddress: getAddress(options.safe),
  };
  if (options.description !== undefined) meta.description = options.description;

  return addChecksum({
    version: "1.0",
    chainId: options.chainId.toString(),
    createdAt: options.createdAt ?? Date.now(),
    meta,
    transactions: options.calls.map(normalizeCall).map(c => ({ to: c.to, value: c.value.toString(), data: c.data })),
  });
}

export function addChecksum(file: SafeBatch): SafeBatch {
  return { ...file, meta: { ...file.meta, checksum: calculateChecksum(file) } };
}

export function validateSafeBatch(file: SafeBatch): boolean {
  return file.meta.checksum === calculateChecksum(file);
}

export function calculateChecksum(file: SafeBatch): Hex {
  // Hash the file as it will be written: JSON drops `undefined` keys, which `serialize` would hash as null.
  const written = JSON.parse(JSON.stringify(file)) as SafeBatch;
  const { checksum: _checksum, ...meta } = written.meta;
  return keccak256(stringToHex(serialize({ ...written, meta: { ...meta, name: null } })));
}

/** Calls in a batch file. Only raw `data` entries are supported, which is what `createSafeBatch` writes. */
export function safeBatchCalls(file: SafeBatch): SafeCall[] {
  return file.transactions.map((tx, i) => {
    const data = tx.data ?? (tx.contractMethod === undefined || tx.contractMethod === null ? "0x" : undefined);
    if (!data || !isHex(data))
      throw new Error(`Transaction ${i} has no raw data; contractMethod entries are unsupported`);
    if (!/^\d+$/.test(tx.value)) throw new Error(`Transaction ${i} has an invalid value ${JSON.stringify(tx.value)}`);
    return normalizeCall({ to: getAddress(tx.to), data, value: BigInt(tx.value) });
  });
}

const replacer = (_: string, value: unknown): unknown => (value === undefined ? null : value);

function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${JSON.stringify(keys, replacer)}${keys.map(k => `${serialize(record[k])},`).join("")}}`;
  }
  return JSON.stringify(value, replacer);
}

/** The Safe a batch was made for. */
export function batchSafe(batch: SafeBatch): Address {
  const safe = batch.meta.createdFromSafeAddress;
  if (!safe) throw new Error("Batch does not name its Safe (meta.createdFromSafeAddress)");
  return getAddress(safe);
}
