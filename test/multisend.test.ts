import { decodeMultiSendData, encodeMultiSendData } from "@safe-global/protocol-kit";
import { OperationType } from "@safe-global/types-kit";
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { multiSendAbi } from "../src/abi.js";
import { decodeMultiSendCall, type SafeCall } from "../src/index.js";
import { encodeMultiSendCall } from "../src/multisend.js";

const calls: SafeCall[] = [
  { to: "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81", data: "0x3659cfe6", value: 0n },
  { to: "0x025a05f1967521806BB4c8a10Ba4b8c00A794F65", data: "0xabcdef0102", value: 7n },
  { to: "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A", data: "0x" },
];

describe("decodeMultiSendCall", () => {
  it("reads the calls of a batch protocol-kit packed", () => {
    const packed = encodeMultiSendData(
      calls.map(c => ({ to: c.to, value: (c.value ?? 0n).toString(), data: c.data, operation: OperationType.Call })),
    );
    const data = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed as Hex] });
    expect(decodeMultiSendCall(data)).toEqual(calls.map(c => ({ ...c, value: c.value ?? 0n })));
  });
});

describe("encodeMultiSendCall", () => {
  it("packs calls the same way as protocol-kit", () => {
    const { args } = decodeFunctionData({ abi: multiSendAbi, data: encodeMultiSendCall(calls) });
    const expected = encodeMultiSendData(
      calls.map(c => ({ to: c.to, value: (c.value ?? 0n).toString(), data: c.data, operation: OperationType.Call })),
    );
    expect(args[0]).toBe(expected);
  });

  it("decodes back to the same calls with protocol-kit", () => {
    const decoded = decodeMultiSendData(encodeMultiSendCall(calls));
    expect(decoded).toEqual(
      calls.map(c => ({ operation: OperationType.Call, to: c.to, value: (c.value ?? 0n).toString(), data: c.data })),
    );
  });
});
