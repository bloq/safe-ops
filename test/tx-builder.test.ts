import { describe, expect, it } from "vitest";
import {
  addChecksum,
  batchFileCalls,
  calculateChecksum,
  createBatchFile,
  validateChecksum,
  type BatchFile,
  type SafeCall,
} from "../src/index.js";

// Fixture and expected checksum from safe-wallet-monorepo apps/tx-builder/src/lib/checksum.test.ts
const upstream: BatchFile = {
  version: "1.0",
  chainId: "4",
  createdAt: 1646321521061,
  meta: {
    name: "test batch file",
    txBuilderVersion: "1.4.0",
    checksum: "",
    createdFromSafeAddress: "0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa",
    createdFromOwnerAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
  },
  transactions: [
    {
      to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
      value: "0",
      contractMethod: {
        inputs: [{ internalType: "address", name: "paramAddress", type: "address" }],
        name: "testAddress",
        payable: false,
      },
      contractInputsValues: { paramAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6" },
    },
    {
      to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
      value: "0",
      contractMethod: {
        inputs: [{ internalType: "bool", name: "paramBool", type: "bool" }],
        name: "testBool",
        payable: false,
      },
      contractInputsValues: { paramAddress: "", paramBool: "false" },
    },
    {
      to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
      value: "2000000000000000000",
      data: "0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6",
    },
  ],
};
const UPSTREAM_CHECKSUM = "0x86c81826dbf7e8a37612153294cc85fdf5c81998dd0a44b86d945502a7eace7c";

const SAFE = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";
const TARGET = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";

describe("checksum", () => {
  it("matches the Safe tx-builder's own test vector", () => {
    expect(calculateChecksum(upstream)).toBe(UPSTREAM_CHECKSUM);
  });

  it("ignores key order", () => {
    const reversed = Object.fromEntries(Object.entries(upstream).reverse()) as unknown as BatchFile;
    reversed.meta = Object.fromEntries(Object.entries(upstream.meta).reverse()) as unknown as BatchFile["meta"];
    expect(calculateChecksum(reversed)).toBe(UPSTREAM_CHECKSUM);
  });

  it("changes with transaction order", () => {
    const swapped = { ...upstream, transactions: [...upstream.transactions].reverse() };
    expect(calculateChecksum(swapped)).not.toBe(UPSTREAM_CHECKSUM);
  });

  it("does not depend on meta.name", () => {
    expect(calculateChecksum({ ...upstream, meta: { ...upstream.meta, name: "renamed" } })).toBe(UPSTREAM_CHECKSUM);
  });

  it("validates an added checksum and rejects a tampered file", () => {
    const file = addChecksum(upstream);
    expect(validateChecksum(file)).toBe(true);
    expect(validateChecksum({ ...file, chainId: "1" })).toBe(false);
  });
});

describe("createBatchFile", () => {
  const calls: SafeCall[] = [
    { to: TARGET, data: "0x12345678" },
    { to: TARGET, data: "0xabcdef01", value: 5n },
  ];

  it("writes a checksummed file that names its Safe", () => {
    const file = createBatchFile({ chainId: 1n, safe: SAFE, calls, name: "upgrade", createdAt: 1 });
    expect(file).toMatchObject({ version: "1.0", chainId: "1", createdAt: 1 });
    expect(file.meta.createdFromSafeAddress).toBe(SAFE);
    expect(file.transactions).toEqual([
      { to: TARGET, value: "0", data: "0x12345678" },
      { to: TARGET, value: "5", data: "0xabcdef01" },
    ]);
    expect(validateChecksum(file)).toBe(true);
  });

  it("round-trips its calls", () => {
    const file = createBatchFile({ chainId: 1, safe: SAFE, calls, name: "upgrade" });
    expect(batchFileCalls(file)).toEqual([
      { to: TARGET, data: "0x12345678", value: 0n },
      { to: TARGET, data: "0xabcdef01", value: 5n },
    ]);
  });

  it("refuses contractMethod entries when reading calls", () => {
    expect(() => batchFileCalls(upstream)).toThrow(/Transaction 0 has no raw data/);
  });
});

describe("checksum of written files", () => {
  it("survives a JSON round trip when optional fields are undefined", () => {
    const file = addChecksum({
      ...upstream,
      meta: { ...upstream.meta, description: undefined } as unknown as BatchFile["meta"],
    });
    expect(validateChecksum(JSON.parse(JSON.stringify(file)) as BatchFile)).toBe(true);
  });

  it("rejects values that are not plain decimal integers", () => {
    const file = createBatchFile({ chainId: 1, safe: SAFE, calls: [{ to: TARGET, data: "0x" }], name: "x" });
    for (const value of ["", " 5", "-5", "0x10", "1e3"]) {
      const tx = { ...file.transactions[0], to: TARGET, value };
      expect(() => batchFileCalls({ ...file, transactions: [tx] })).toThrow(/invalid value/);
    }
  });
});

describe("files from the Safe UI", () => {
  it("reads an ETH transfer with null data as empty calldata", () => {
    const file = { ...upstream, transactions: [{ to: TARGET, value: "5", data: null }] };
    expect(batchFileCalls(file)).toEqual([{ to: TARGET, data: "0x", value: 5n }]);
  });
});
