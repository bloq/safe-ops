import { describe, expect, it } from "vitest";
import { SafeBatch, type SafeCall } from "../src/index.js";

const SAFE_A = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";
const SAFE_B = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
const TARGET = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";
const OTHER = "0xe3DA4B83C9dd4c4D185ecE42077462b3F35c454a";

describe("SafeBatch", () => {
  it("groups calls per Safe in insertion order", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    batch.add(SAFE_B, { to: TARGET, data: "0x02" });
    batch.add(SAFE_A, { to: TARGET, data: "0x03" });

    expect(batch.safes).toEqual([SAFE_A, SAFE_B]);
    expect(batch.calls(SAFE_A).map(c => c.data)).toEqual(["0x01", "0x03"]);
    expect(batch.size).toBe(3);
  });

  it("treats address case as the same Safe and drops exact duplicates", () => {
    const batch = new SafeBatch();
    expect(batch.add(SAFE_A.toLowerCase() as `0x${string}`, { to: TARGET, data: "0xAB" })).toBe(true);
    expect(batch.add(SAFE_A, { to: TARGET.toLowerCase() as `0x${string}`, data: "0xab", value: 0n })).toBe(false);
    expect(batch.size).toBe(1);
  });

  it("keeps calls that differ only in value", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    expect(batch.add(SAFE_A, { to: TARGET, data: "0x01", value: 1n })).toBe(true);
  });

  it("drops a repeat when calls in between go to other contracts", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    batch.add(SAFE_A, { to: OTHER, data: "0x02" });
    expect(batch.add(SAFE_A, { to: TARGET, data: "0x01" })).toBe(false);
    expect(batch.calls(SAFE_A).map(c => c.data)).toEqual(["0x01", "0x02"]);
  });

  it("keeps a repeat that restores an earlier value: x.update(1), x.update(2), x.update(1)", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    batch.add(SAFE_A, { to: TARGET, data: "0x02" });
    expect(batch.add(SAFE_A, { to: TARGET, data: "0x01" })).toBe(true);
    expect(batch.calls(SAFE_A).map(c => c.data)).toEqual(["0x01", "0x02", "0x01"]);
  });

  it("treats the same call to different contracts as different", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    expect(batch.add(SAFE_A, { to: OTHER, data: "0x01" })).toBe(true);
  });

  it("does not compare calls across Safes", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    expect(batch.add(SAFE_B, { to: TARGET, data: "0x01" })).toBe(true);
  });

  it("queues a deliberate repeat with allowDuplicate", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    expect(batch.add(SAFE_A, { to: TARGET, data: "0x01" }, { allowDuplicate: true })).toBe(true);
    expect(batch.size).toBe(2);
  });
});

describe("SafeBatch validation", () => {
  it("rejects calldata that is not whole bytes and negative values", () => {
    const batch = new SafeBatch();
    expect(() => batch.add(SAFE_A, { to: TARGET, data: "0x123" })).toThrow(/malformed data/);
    expect(() => batch.add(SAFE_A, { to: TARGET, data: "0x", value: -1n })).toThrow(/negative value/);
  });

  it("hands out a copy of its calls", () => {
    const batch = new SafeBatch();
    batch.add(SAFE_A, { to: TARGET, data: "0x01" });
    (batch.calls(SAFE_A) as SafeCall[]).push({ to: TARGET, data: "0x02" });
    expect(batch.size).toBe(1);
  });
});

describe("SafeBatch values from plain JS", () => {
  it.each([1.5, "0x10", Number.NaN, true])("rejects a non-bigint value %s", value => {
    const call = { to: TARGET, data: "0x", value } as unknown as SafeCall;
    expect(() => new SafeBatch().add(SAFE_A, call)).toThrow(/non-bigint value/);
  });
});
