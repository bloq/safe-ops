import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { EXECUTION_SUCCESS_TOPIC } from "../src/abi.js";
import { describeError } from "../src/client.js";
import { emittedExecutionSuccess, executeOnFork, sortOwners } from "../src/fork.js";
import type { Eip1193Provider } from "../src/index.js";
import { safeProvider } from "./safe-mock.js";

const SAFE = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";
const TARGET = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";

describe("sortOwners", () => {
  it("sorts by numeric value regardless of locale collation", () => {
    const owners: Address[] = [
      "0xab00000000000000000000000000000000000000",
      "0xAA00000000000000000000000000000000000000",
      "0x0100000000000000000000000000000000000000",
    ];
    // Danish collation puts "aa" after "z", which would break Safe signature ordering.
    expect([...owners].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "da"))[2]).toBe(owners[1]);
    expect(sortOwners(owners)).toEqual([owners[2], owners[1], owners[0]]);
  });
});

describe("emittedExecutionSuccess", () => {
  const HASH = `0x${"ab".repeat(32)}` as const;
  const OTHER_HASH = `0x${"cd".repeat(32)}` as const;
  const payment = "0".repeat(64);
  const indexed = (hash: string, address = SAFE) => ({
    address,
    topics: [EXECUTION_SUCCESS_TOPIC, hash],
    data: `0x${payment}`,
  });
  const inData = (hash: string) => ({ address: SAFE, topics: [EXECUTION_SUCCESS_TOPIC], data: `${hash}${payment}` });

  it("matches the hash in topic1 (1.4.1+) and in the first data word (before 1.4.1)", () => {
    expect(emittedExecutionSuccess([indexed(HASH)], SAFE, HASH)).toBe(true);
    expect(emittedExecutionSuccess([inData(HASH)], SAFE, HASH)).toBe(true);
  });

  it("rejects another transaction's event, another emitter and another event", () => {
    expect(emittedExecutionSuccess([indexed(OTHER_HASH), inData(OTHER_HASH)], SAFE, HASH)).toBe(false);
    expect(emittedExecutionSuccess([indexed(HASH, TARGET)], SAFE, HASH)).toBe(false);
    expect(emittedExecutionSuccess([{ ...indexed(HASH), topics: [`0x${"00".repeat(32)}`, HASH] }], SAFE, HASH)).toBe(
      false,
    );
  });
});

describe("executeOnFork preconditions", () => {
  const anvil = "anvil/v1.8.3";

  it("refuses a node that is not local Hardhat or Anvil", async () => {
    await expect(executeOnFork(safeProvider(), SAFE, [{ to: TARGET, data: "0x01" }])).rejects.toThrow(
      /Refusing to rehearse/,
    );
  });

  it("accepts Hardhat's client version", async () => {
    const provider = safeProvider({ clientVersion: "HardhatNetwork/2.28.0/@nomicfoundation/edr/0.3.8" });
    // It gets past the node check and stops at the missing target code instead.
    await expect(
      executeOnFork(
        {
          request: args =>
            args.method === "eth_getCode" || args.method === "hardhat_mine"
              ? Promise.resolve("0x")
              : provider.request(args),
        },
        SAFE,
        [{ to: TARGET, data: "0x01" }],
      ),
    ).rejects.toThrow(/has no code/);
  });

  it("mines a local block on Hardhat before reading anything from the Safe", async () => {
    const methods: string[] = [];
    const node = safeProvider({ clientVersion: "HardhatNetwork/2.28.0", codeless: [TARGET] });
    const provider: Eip1193Provider = {
      request: args => {
        methods.push(args.method);
        return args.method === "hardhat_mine" ? Promise.resolve(null) : node.request(args);
      },
    };
    await expect(executeOnFork(provider, SAFE, [{ to: TARGET, data: "0x01" }])).rejects.toThrow(/has no code/);
    expect(methods.indexOf("hardhat_mine")).toBeGreaterThan(-1);
    expect(methods.indexOf("hardhat_mine")).toBeLessThan(methods.indexOf("eth_call"));
  });

  it("refuses Safe 1.0.x, which emits no ExecutionSuccess", async () => {
    const provider = safeProvider({ clientVersion: anvil, version: "1.0.0" });
    await expect(executeOnFork(provider, SAFE, [{ to: TARGET, data: "0x01" }])).rejects.toThrow(
      /1\.0\.0; 1\.0\.x is unsupported/,
    );
  });

  it("refuses calldata to an address without code", async () => {
    const provider = safeProvider({ clientVersion: anvil, codeless: [TARGET] });
    await expect(executeOnFork(provider, SAFE, [{ to: TARGET, data: "0x01" }])).rejects.toThrow(
      /Call 0 sends calldata to 0x3aEd.*no code/,
    );
  });
});

describe("describeError", () => {
  it("keeps the node's revert reason that viem hides behind a generic message", () => {
    const node = new Error("VM Exception while processing transaction: reverted with reason string 'GS013'");
    const wrapped = Object.assign(new Error("wrapper"), {
      shortMessage: "An unknown RPC error occurred.",
      cause: node,
    });
    expect(describeError(wrapped)).toBe(
      "An unknown RPC error occurred. (VM Exception while processing transaction: reverted with reason string 'GS013')",
    );
  });
});
