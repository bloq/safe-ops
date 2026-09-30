import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { numberToHex, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeBatchFileOnFork,
  flushSafeBatch,
  nodeProvider,
  queueIfUnknownSigner,
  type HardhatDeployRuntime,
  type UnknownSignerTx,
} from "../src/hardhat/index.js";
import { SafeBatch, type BatchFile, type Eip1193Provider } from "../src/index.js";
import { safeProvider, type MockOptions } from "./safe-mock.js";

const SAFE = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";
const SAFE_B = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
const TARGET = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";
const EOA = "0x000000000000000000000000000000000000dEaD";
const ANVIL = "anvil/v1.8.3";

function runtime(
  root: string,
  mock: MockOptions = {},
  unsigned: UnknownSignerTx | null = null,
  name = "mainnet",
): HardhatDeployRuntime {
  return {
    network: { name, provider: safeProvider(mock) },
    config: { paths: { root } },
    deployments: { catchUnknownSigner: () => Promise.resolve(unsigned) },
  };
}

const call = (data: Hex) => ({ to: TARGET, data }) as const;
const tempRoot = () => mkdtemp(path.join(tmpdir(), "safe-ops-"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queueIfUnknownSigner", () => {
  const action = Promise.resolve();

  it("queues a value-only transfer with empty calldata", async () => {
    const batch = new SafeBatch();
    const hre = runtime(tmpdir(), {}, { from: SAFE, to: TARGET, value: "5" });
    expect(await queueIfUnknownSigner(hre, batch, action)).toBe(true);
    expect(batch.calls(SAFE)).toEqual([{ to: TARGET, data: "0x", value: 5n }]);
  });

  it("refuses a contract deployment", async () => {
    const hre = runtime(tmpdir(), {}, { from: SAFE, data: "0x60" });
    await expect(queueIfUnknownSigner(hre, new SafeBatch(), action)).rejects.toThrow(/deploys a contract/);
  });

  it("warns when it drops a duplicate but still reports the call as left to the Safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batch = new SafeBatch();
    const hre = runtime(tmpdir(), {}, { from: SAFE, to: TARGET, data: "0x01" });
    await queueIfUnknownSigner(hre, batch, action);
    expect(await queueIfUnknownSigner(hre, batch, action)).toBe(true);
    expect(batch.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already queued/));
  });

  it("observes an already-started action at once, so a rejection before hardhat-deploy looks is handled", async () => {
    // hardhat-deploy's execute() rejects with UnknownSignerError after a few RPCs; the runtime here only looks
    // at the promise later. Vitest fails the run on an unhandled rejection.
    const unknownSigner = Object.assign(new Error("unknown signer"), { data: { from: SAFE, to: TARGET } });
    const started = new Promise((_, reject) =>
      setTimeout(() => {
        reject(unknownSigner);
      }, 5),
    );
    const hre: HardhatDeployRuntime = {
      network: { name: "hardhat", provider: safeProvider() },
      deployments: {
        catchUnknownSigner: async pending => {
          await new Promise(resolve => setTimeout(resolve, 30));
          try {
            await (typeof pending === "function" ? pending() : pending);
            return null;
          } catch {
            return { from: SAFE, to: TARGET, data: "0x01" };
          }
        },
      },
    };
    const batch = new SafeBatch();
    expect(await queueIfUnknownSigner(hre, batch, started)).toBe(true);
    expect(batch.size).toBe(1);
  });

  it("warns once when a call ran directly as an impersonated Safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hre = runtime(tmpdir(), { clientVersion: ANVIL }, null, "localhost");
    const receipt = Promise.resolve({ from: SAFE, status: 1 });
    expect(await queueIfUnknownSigner(hre, new SafeBatch(), receipt)).toBe(false);
    await queueIfUnknownSigner(hre, new SafeBatch(), receipt);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Safe 0x6649.*executed a call directly/));
  });

  it("stays quiet when an EOA executed the call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hre = runtime(tmpdir(), { codeless: [EOA] });
    await queueIfUnknownSigner(hre, new SafeBatch(), () => Promise.resolve({ from: EOA }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("flushSafeBatch on a live node", () => {
  it("timestamps file names, so a second run under the same name does not collide", async () => {
    const root = await tempRoot();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 30, 14, 23, 1, 123));
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    const [first] = await flushSafeBatch(runtime(root), batch, { name: "Set fees" });
    expect(first?.file).toBe(path.join(root, "safe-batches", "mainnet", `set-fees-1-${SAFE}-20260930T142301123Z.json`));
    const file = JSON.parse(await readFile(first?.file ?? "", "utf8")) as BatchFile;
    expect(file.meta.name).toBe("Set fees");
    expect(file.createdAt).toBe(Date.UTC(2026, 8, 30, 14, 23, 1, 123));

    now.mockReturnValue(Date.UTC(2026, 8, 30, 15, 0, 0, 0));
    batch.add(SAFE, call("0x02"));
    await flushSafeBatch(runtime(root), batch, { name: "Set fees" });
    expect(await readdir(path.join(root, "safe-batches", "mainnet"))).toHaveLength(2);
  });

  it("never replaces an existing file", async () => {
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(1);
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    await flushSafeBatch(runtime(root), batch, { name: "upgrade" });
    batch.add(SAFE, call("0x02"));
    await expect(flushSafeBatch(runtime(root), batch, { name: "upgrade" })).rejects.toThrow(/EEXIST/);
  });

  it("removes the files it wrote when a later write fails", async () => {
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(1);
    const dir = path.join(root, "safe-batches", "mainnet");
    await mkdir(dir, { recursive: true });
    // A dangling symlink passes the exists check but fails the exclusive write, after the first Safe's file.
    const blocked = `upgrade-1-${SAFE_B}-19700101T000000001Z.json`;
    await symlink(path.join(root, "missing"), path.join(dir, blocked));
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    batch.add(SAFE_B, call("0x02"));
    await expect(flushSafeBatch(runtime(root), batch, { name: "upgrade" })).rejects.toThrow(/EEXIST/);
    expect(await readdir(dir)).toEqual([blocked]);
    expect(batch.size).toBe(2);
  });

  it("removes written files when a requested rehearsal cannot run", async () => {
    const root = await tempRoot();
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    batch.add(SAFE_B, call("0x02"));
    await expect(flushSafeBatch(runtime(root), batch, { name: "upgrade", rehearse: true })).rejects.toThrow(
      /Refusing to rehearse/,
    );
    expect(await readdir(path.join(root, "safe-batches", "mainnet"))).toEqual([]);
  });

  it("refuses calldata to an address without code unless allowed", async () => {
    const root = await tempRoot();
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    const hre = runtime(root, { codeless: [TARGET] });
    await expect(flushSafeBatch(hre, batch, { name: "typo" })).rejects.toThrow(/has no code/);
    expect(await flushSafeBatch(hre, batch, { name: "typo", allowCallsWithoutCode: true })).toHaveLength(1);
  });

  it("rejects a name without letters or digits", async () => {
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    await expect(flushSafeBatch(runtime(await tempRoot()), batch, { name: "!!!" })).rejects.toThrow(
      /needs at least one letter or digit/,
    );
  });
});

describe("flushSafeBatch on a local node", () => {
  it("is decided by the node, not the network name, and marks the file as a fork rehearsal", async () => {
    const root = await tempRoot();
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    const hre = runtime(root, { clientVersion: ANVIL }, null, "mainnet-fork");
    const [entry] = await flushSafeBatch(hre, batch, { name: "upgrade", rehearse: false });
    expect(entry?.file).toBe(path.join(root, "safe-batches", "mainnet-fork", `upgrade-1-${SAFE}.json`));
    const file = JSON.parse(await readFile(entry?.file ?? "", "utf8")) as BatchFile;
    expect(file.meta.name).toBe("FORK REHEARSAL, DO NOT SIGN: upgrade");
  });

  it("does not rehearse on a node named localhost that is not local", async () => {
    const root = await tempRoot();
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    const [entry] = await flushSafeBatch(runtime(root, {}, null, "localhost"), batch, { name: "upgrade" });
    expect(entry?.execution).toBeUndefined();
    expect(entry?.file).toMatch(/-\d{8}T\d{9}Z\.json$/);
  });
});

describe("executeBatchFileOnFork", () => {
  it("refuses a file made for another chain", async () => {
    const batch = new SafeBatch();
    batch.add(SAFE, call("0x01"));
    const [entry] = await flushSafeBatch(runtime(await tempRoot()), batch, { name: "upgrade" });
    await expect(executeBatchFileOnFork(safeProvider({ chainId: 137 }), entry?.file ?? "")).rejects.toThrow(
      /is for chain 1, but the fork runs chain 137/,
    );
  });
});

describe("nodeProvider", () => {
  it("uses the provider itself when the network has no URL", () => {
    const hre = runtime(tmpdir());
    expect(nodeProvider(hre)).toBe(hre.network.provider);
  });

  it("sends to the network URL with its headers", async () => {
    const seen: { auth: string | undefined; method: string }[] = [];
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        seen.push({ auth: req.headers.authorization, method });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: numberToHex(1) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    const localKeys: Eip1193Provider = { request: () => Promise.reject(new Error("HH103")) };
    const hre: HardhatDeployRuntime = {
      network: {
        name: "localhost",
        provider: localKeys,
        config: { url: `http://127.0.0.1:${port}`, httpHeaders: { authorization: "Bearer t" } },
      },
      deployments: { catchUnknownSigner: () => Promise.resolve(null) },
    };
    try {
      expect(await nodeProvider(hre).request({ method: "eth_chainId" })).toBe("0x1");
      expect(seen).toEqual([{ auth: "Bearer t", method: "eth_chainId" }]);
    } finally {
      server.close();
    }
  });
});
