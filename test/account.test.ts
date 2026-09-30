import { pad, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { publicClientFor, readSafe, routeOwner, type Eip1193Provider } from "../src/index.js";
import { OWNER, safeProvider, SINGLETON_141, type MockOptions } from "./safe-mock.js";

const SAFE = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";

/** The mock node, recording every eth_call. */
function recording(options: MockOptions = {}) {
  const calls: string[] = [];
  const node = safeProvider(options);
  const provider: Eip1193Provider = {
    request: args => {
      if (args.method === "eth_call") calls.push(args.method);
      return node.request(args);
    },
  };
  return { client: publicClientFor(provider), calls };
}

describe("readSafe", () => {
  it("reads a proxy for an official Safe singleton", async () => {
    const { client } = recording();
    expect(await readSafe(client, SAFE)).toEqual({
      address: SAFE,
      version: "1.4.1",
      threshold: 1n,
      owners: [OWNER],
      singleton: SINGLETON_141,
    });
  });

  it("calls nothing on a contract whose slot 0 is not an official singleton", async () => {
    const { client, calls } = recording({ slot0: OWNER });
    expect(await readSafe(client, SAFE)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("throws, rather than answering no, when a read on a real Safe fails", async () => {
    const revert = Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    await expect(readSafe(recording({ raw: { getThreshold: revert } }).client, SAFE)).rejects.toThrow();
    await expect(readSafe(recording({ raw: { getOwners: "0x" } }).client, SAFE)).rejects.toThrow();
  });

  it("reads an uninitialized proxy (threshold 0) as not a Safe", async () => {
    // The real contract's getOwners reverts (panic) on an uninitialized proxy.
    const panic = Object.assign(new Error("execution reverted"), { code: 3, data: "0x4e487b71" });
    const raw = { getThreshold: pad("0x0"), getOwners: panic };
    expect(await readSafe(recording({ raw }).client, SAFE)).toBeUndefined();
  });
});

describe("routeOwner", () => {
  /** `code` decides the account kind; a contract is a 1-of-1 Safe owned by OWNER unless `slot0` says otherwise. */
  const route = (code: Hex, caller: Address, slot0?: string) => {
    const node = safeProvider(slot0 ? { slot0 } : {});
    const provider: Eip1193Provider = {
      request: args => (args.method === "eth_getCode" ? Promise.resolve(code) : node.request(args)),
    };
    return routeOwner(publicClientFor(provider), SAFE, caller);
  };

  it("never lets a Safe act directly, even as the caller", async () => {
    expect(await route("0x6080", SAFE)).toMatchObject({ kind: "skip", reason: /can't sign for itself/ });
    expect((await route("0x6080", OWNER)).kind).toBe("safe");
  });

  it("never lets a plain contract act directly", async () => {
    expect((await route("0x6080", SAFE, OWNER)).kind).toBe("skip");
  });

  it("lets an EOA or EIP-7702 account act for itself", async () => {
    expect((await route("0x", SAFE)).kind).toBe("direct");
    const delegated = `0xef0100${OWNER.slice(2)}` as Hex;
    expect((await route(delegated, SAFE)).kind).toBe("direct");
    expect((await route(delegated, OWNER)).kind).toBe("skip");
  });
});
