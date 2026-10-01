import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nodeProvider,
  proposeStagedSafeBatches,
  registerSafeTasks,
  stageSafeTx,
  type HardhatDeployRuntime,
  type TaskDefinition,
  type UnknownSignerTx,
} from "../src/hardhat/index.js";
import {
  createSafeBatch,
  rehearseSafeBatch,
  safeBatchCalls,
  validateSafeBatch,
  type Eip1193Provider,
  type SafeBatch,
} from "../src/index.js";
import { safeProvider, serviceTx, type MockOptions } from "./safe-mock.js";

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
const unsignedCall = (data: Hex, from: string = SAFE): UnknownSignerTx => ({ from, to: TARGET, data });
const tempRoot = () => mkdtemp(path.join(tmpdir(), "safe-ops-"));
const STAGED_AT = Date.UTC(2026, 9, 1, 15, 30, 0, 123);
const liveDir = (root: string) => path.join(root, "safe-batches", "mainnet");
const readBatch = async (file: string) => JSON.parse(await readFile(file, "utf8")) as SafeBatch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A mainnet service with these pending and executed transactions; returns what was posted. */
function liveService(pending: unknown[] = [], executed: unknown[] = []) {
  const posted: Record<string, unknown>[] = [];
  const fetch = vi.fn((url: string, init: { body?: string }) => {
    if (init.body) posted.push(JSON.parse(init.body) as Record<string, unknown>);
    const results = url.includes("executed=true") ? executed : pending;
    const answer = init.body ? {} : url.includes("/about/") ? { chain_id: 1 } : { next: null, results };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(answer)) });
  });
  vi.stubGlobal("fetch", fetch);
  return { posted, fetch };
}

describe("stageSafeTx", () => {
  it("stages a run's calls into one timestamped file per Safe, written after every call", async () => {
    const root = await tempRoot();
    const now = vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    const hre = runtime(root);
    expect(await stageSafeTx(hre, { from: SAFE, to: TARGET, value: "5" })).toBe(true);
    const file = path.join(liveDir(root), "20261001T153000Z-0x6649dd.json");
    expect(safeBatchCalls(await readBatch(file))).toEqual([{ to: TARGET, data: "0x", value: 5n }]);

    // A long run still stages into the file its first call started.
    now.mockReturnValue(STAGED_AT + 15 * 60_000);
    await stageSafeTx(hre, unsignedCall("0x02"));
    await stageSafeTx(hre, unsignedCall("0x03", SAFE_B));
    expect(await readdir(liveDir(root))).toEqual(["20261001T153000Z-0x6649dd.json", "20261001T153000Z-0x9520b4.json"]);
    const batch = await readBatch(file);
    expect(validateSafeBatch(batch)).toBe(true);
    expect(batch.meta.name).toBe("Deploy 2026-10-01 15:30 UTC");
    expect(batch.transactions).toHaveLength(2);
  });

  it("stages what an action leaves unsigned, and nothing when it ran", async () => {
    const root = await tempRoot();
    expect(await stageSafeTx(runtime(root, {}, unsignedCall("0x01")), () => Promise.resolve())).toBe(true);
    expect(await stageSafeTx(runtime(root), () => Promise.resolve())).toBe(false);
    expect(await stageSafeTx(runtime(root), null)).toBe(false);
    expect(await readdir(liveDir(root))).toHaveLength(1);
  });

  it("refuses a contract deployment and an owner that is not a Safe", async () => {
    const hre = runtime(await tempRoot(), { slot0: EOA });
    await expect(stageSafeTx(hre, { from: SAFE, data: "0x60" })).rejects.toThrow(/deploys a contract/);
    await expect(stageSafeTx(hre, unsignedCall("0x01"))).rejects.toThrow(/is not a Safe/);
  });

  it("warns and keeps one copy of a call repeated in a row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await tempRoot();
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x01"));
    expect(await stageSafeTx(hre, unsignedCall("0x01"))).toBe(true);
    const [name] = await readdir(liveDir(root));
    expect((await readBatch(path.join(liveDir(root), name ?? ""))).transactions).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already staged/));
  });

  it("never replaces a live file another run started in the same second", async () => {
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    await expect(stageSafeTx(runtime(root), unsignedCall("0x02"))).rejects.toThrow(/EEXIST/);
  });

  it("names a local node's file after the Safe alone, marks it, and replaces the previous rehearsal", async () => {
    const root = await tempRoot();
    const dir = path.join(root, "safe-batches", "mainnet-fork");
    for (const data of ["0x01", "0x02"] as const) {
      await stageSafeTx(runtime(root, { clientVersion: ANVIL }, null, "mainnet-fork"), unsignedCall(data));
    }
    expect(await readdir(dir)).toEqual(["0x6649dd.json"]);
    const batch = await readBatch(path.join(dir, "0x6649dd.json"));
    expect(batch.meta.name).toMatch(/^FORK REHEARSAL, DO NOT SIGN: Deploy /);
    expect(safeBatchCalls(batch)).toEqual([{ ...call("0x02"), value: 0n }]);
  });

  it("stages calls made in parallel without losing one", async () => {
    const root = await tempRoot();
    const hre = runtime(root);
    await Promise.all(["0x01", "0x02", "0x03"].map(d => stageSafeTx(hre, unsignedCall(d as Hex))));
    const [name] = await readdir(liveDir(root));
    expect((await readBatch(path.join(liveDir(root), name ?? ""))).transactions).toHaveLength(3);
  });

  it("retries starting a run that failed, e.g. on an RPC blip", async () => {
    const root = await tempRoot();
    const node = safeProvider();
    let down = true;
    const hre: HardhatDeployRuntime = {
      ...runtime(root),
      network: {
        name: "mainnet",
        provider: {
          request: args => {
            if (args.method === "eth_chainId" && down) return Promise.reject(new Error("blip"));
            return node.request(args);
          },
        },
      },
    };
    await expect(stageSafeTx(hre, unsignedCall("0x01"))).rejects.toThrow(/blip/);
    down = false;
    expect(await stageSafeTx(hre, unsignedCall("0x01"))).toBe(true);
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
      network: { name: "mainnet", provider: safeProvider() },
      config: { paths: { root: await tempRoot() } },
      deployments: {
        catchUnknownSigner: async pending => {
          await new Promise(resolve => setTimeout(resolve, 30));
          try {
            await (typeof pending === "function" ? pending() : pending);
            return null;
          } catch {
            return unsignedCall("0x01");
          }
        },
      },
    };
    expect(await stageSafeTx(hre, started)).toBe(true);
  });

  it("warns once when a call ran directly as an impersonated Safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hre = runtime(tmpdir(), { clientVersion: ANVIL }, null, "localhost");
    const receipt = Promise.resolve({ from: SAFE, status: 1 });
    expect(await stageSafeTx(hre, receipt)).toBe(false);
    await stageSafeTx(hre, receipt);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Safe 0x6649.*executed a call directly/));
  });

  it("stays quiet when an EOA executed the call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await stageSafeTx(runtime(tmpdir(), { codeless: [EOA] }), () => Promise.resolve({ from: EOA }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("proposeStagedSafeBatches", () => {
  // Hardhat's well-known account 1; the key is public.
  const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const options = { signer, txServiceUrl: "https://tx.example/api" };

  const quiet = () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return vi.spyOn(console, "log").mockImplementation(() => undefined);
  };

  it("proposes this run's fresh file exactly as staged, after the queue, and deletes it", async () => {
    quiet();
    const root = await tempRoot();
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x01"));
    const { posted } = liveService([serviceTx(39, [call("0x99")])]);
    const [result] = await proposeStagedSafeBatches(hre, options);
    expect(posted).toMatchObject([{ to: TARGET, data: "0x01", nonce: "40", sender: signer.address }]);
    expect(result).toMatchObject({ safe: SAFE, removed: true, status: { status: "fresh", proposal: { nonce: 40n } } });
    expect(await readdir(liveDir(root))).toEqual([]);
  });

  it("deletes a file already pending or executed without proposing, but keeps one on a contested nonce", async () => {
    quiet();
    for (const [pending, executed, removed] of [
      [[serviceTx(39, [call("0x01")])], [], true],
      [[], [serviceTx(38, [call("0x01")], { executed: true })], true],
      [[serviceTx(39, [call("0x01")]), serviceTx(39, [call("0x02")])], [], false],
    ] as const) {
      const root = await tempRoot();
      const hre = runtime(root);
      await stageSafeTx(hre, unsignedCall("0x01"));
      const { posted } = liveService([...pending], [...executed]);
      const [result] = await proposeStagedSafeBatches(hre, options);
      expect(posted).toEqual([]);
      expect(result?.removed).toBe(removed);
      expect(await readdir(liveDir(root))).toHaveLength(removed ? 0 : 1);
    }
  });

  it("keeps a file that partly overlaps pending proposals and says what to do", async () => {
    const log = quiet();
    const root = await tempRoot();
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x01"));
    await stageSafeTx(hre, unsignedCall("0x02"));
    const { posted } = liveService([serviceTx(39, [call("0x01")])]);
    const [result] = await proposeStagedSafeBatches(hre, options);
    expect(posted).toEqual([]);
    expect(result).toMatchObject({ removed: false, status: { status: "partial" } });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^20\d{6}T\d{6}Z-0x6649dd\.json .*\n {2}✗ partial: shares calls with nonce 39 \(0x\w{4}…\w{4}\) → keep\n.*rerun the deploy/,
      ),
    );
  });
  it("says to rerun the deploy when part of a file already executed", async () => {
    const log = quiet();
    const hre = runtime(await tempRoot());
    await stageSafeTx(hre, unsignedCall("0x01"));
    await stageSafeTx(hre, unsignedCall("0x02"));
    liveService([], [serviceTx(38, [call("0x01")], { executed: true })]);
    await proposeStagedSafeBatches(hre, options);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/part of it already ran: rerun the deploy/));
  });

  it("handles every staged file for the network when this run staged nothing", async () => {
    quiet();
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT + 60_000);
    await stageSafeTx(runtime(root), unsignedCall("0x02"));
    const { posted } = liveService();
    const results = await proposeStagedSafeBatches(runtime(root), { ...options, yes: true });
    expect(results.map(r => path.basename(r.file))).toEqual([
      "20261001T153000Z-0x6649dd.json",
      "20261001T153100Z-0x6649dd.json",
    ]);
    expect(posted).toHaveLength(2);
  });

  it("signs as Hardhat's deployer account by default, and needs one", async () => {
    quiet();
    const root = await tempRoot();
    const node = safeProvider();
    const hre: HardhatDeployRuntime = {
      ...runtime(root),
      network: {
        name: "mainnet",
        // Hardhat answers personal_sign for its configured accounts.
        provider: {
          request: args =>
            args.method === "personal_sign"
              ? signer.signMessage({ message: { raw: (args.params as [Hex])[0] } })
              : node.request(args),
        },
      },
      getNamedAccounts: () => Promise.resolve({ deployer: signer.address }),
    };
    await stageSafeTx(hre, unsignedCall("0x01"));
    const { posted } = liveService();
    await proposeStagedSafeBatches(hre, { txServiceUrl: options.txServiceUrl });
    expect(posted).toMatchObject([{ sender: signer.address }]);

    const withoutDeployer = runtime(root);
    await stageSafeTx(withoutDeployer, unsignedCall("0x02"));
    await expect(proposeStagedSafeBatches(withoutDeployer, { txServiceUrl: options.txServiceUrl })).rejects.toThrow(
      /No proposer/,
    );
  });

  it("shows a plan and proposes files this run didn't stage only after a yes", async () => {
    const log = quiet();
    const root = await tempRoot();
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    const { posted } = liveService();
    const asked: string[] = [];
    const answer = (yes: boolean) => (question: string) => {
      asked.push(question);
      return Promise.resolve(yes);
    };
    expect(await proposeStagedSafeBatches(runtime(root), { ...options, confirm: answer(false) })).toEqual([]);
    expect(posted).toEqual([]);
    expect(await readdir(liveDir(root))).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/→ propose at nonce 39/));

    await proposeStagedSafeBatches(runtime(root), { ...options, confirm: answer(true) });
    expect(asked).toEqual(["Propose 1 file(s) and delete 0? [y/N] ", "Propose 1 file(s) and delete 0? [y/N] "]);
    expect(posted).toHaveLength(1);
  });

  it("refuses to act on files this run didn't stage without a terminal or yes", async () => {
    quiet();
    const root = await tempRoot();
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    const { posted } = liveService();
    await expect(proposeStagedSafeBatches(runtime(root), options)).rejects.toThrow(/without a confirmation/);
    expect(posted).toEqual([]);
  });

  it("carries on with other Safes past a refused file, holds that Safe's later files, then fails with reasons", async () => {
    const log = quiet();
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    await stageSafeTx(runtime(root, { clientVersion: ANVIL }, null, "mainnet-fork"), unsignedCall("0x01"));
    const forkFile = path.join(root, "safe-batches", "mainnet-fork", "0x6649dd.json");
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x02"));
    await stageSafeTx(hre, unsignedCall("0x03", SAFE_B));
    const [sameSafe, otherSafe] = (await readdir(liveDir(root))).map(n => path.join(liveDir(root), n));
    const { posted } = liveService();
    await expect(
      proposeStagedSafeBatches(runtime(root), {
        ...options,
        yes: true,
        files: [forkFile, sameSafe ?? "", otherSafe ?? ""],
      }),
    ).rejects.toThrow(
      /2 staged file\(s\) refused or failed: 0x6649dd\.json: fork rehearsal file.*skipped: an earlier file/,
    );
    // Only the other Safe's file went out; the same Safe's later file waits for the refused one.
    expect(posted).toMatchObject([{ data: "0x03" }]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/✗ skipped: an earlier file for this Safe failed/));
  });

  it("plans consecutive nonces for one Safe's fresh files and leaves files the plan kept", async () => {
    const log = quiet();
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT + 60_000);
    await stageSafeTx(runtime(root), unsignedCall("0x02"));
    liveService();
    await proposeStagedSafeBatches(runtime(root), { ...options, confirm: () => Promise.resolve(false) });
    const plan = log.mock.calls.map(c => String(c[0])).join("\n");
    expect(plan).toMatch(/→ propose at nonce 39[\s\S]*→ propose at nonce 40/);
  });

  it("never proposes a file the plan showed as kept, even if it became fresh before the yes", async () => {
    quiet();
    const root = await tempRoot();
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x01"));
    await stageSafeTx(hre, unsignedCall("0x02"));
    await stageSafeTx(hre, unsignedCall("0x09", SAFE_B));
    const pending = [serviceTx(39, [call("0x01")])];
    const { posted } = liveService(pending);
    // The plan sees SAFE's file as a partial overlap; the overlapping proposal is gone by the time of the yes.
    const confirm = () => {
      pending.length = 0;
      return Promise.resolve(true);
    };
    await proposeStagedSafeBatches(runtime(root), { ...options, confirm });
    expect(posted).toMatchObject([{ data: "0x09" }]);
  });

  it("refuses to propose a fork rehearsal file on a live network", async () => {
    quiet();
    const root = await tempRoot();
    await stageSafeTx(runtime(root, { clientVersion: ANVIL }, null, "mainnet-fork"), unsignedCall("0x01"));
    const forkFile = path.join(root, "safe-batches", "mainnet-fork", "0x6649dd.json");
    const { posted } = liveService();
    await expect(proposeStagedSafeBatches(runtime(root), { ...options, files: [forkFile] })).rejects.toThrow(
      /fork rehearsal file/,
    );
    expect(posted).toEqual([]);
  });

  it("names older staged files it leaves for later", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await tempRoot();
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT);
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    vi.spyOn(Date, "now").mockReturnValue(STAGED_AT + 60_000);
    const hre = runtime(root);
    await stageSafeTx(hre, unsignedCall("0x02"));
    liveService();
    expect(await proposeStagedSafeBatches(hre, options)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Left for later: 20261001T153000Z-0x6649dd.json\n");
  });

  it("on a fork, rehearses only what this run staged", async () => {
    const root = await tempRoot();
    await stageSafeTx(runtime(root, { clientVersion: ANVIL }), unsignedCall("0x01"));
    // A later fork run (e.g. a test deploy) that staged nothing leaves the previous run's file alone.
    expect(await proposeStagedSafeBatches(runtime(root, { clientVersion: ANVIL }), options)).toEqual([]);
  });

  it("never proposes from a local node or a network named like one: it rehearses instead", async () => {
    const { fetch } = liveService();
    const local = runtime(await tempRoot(), { clientVersion: ANVIL });
    await stageSafeTx(local, unsignedCall("0x01"));
    // The mock node can't impersonate, so reaching that step shows the rehearsal ran.
    await expect(proposeStagedSafeBatches(local, options)).rejects.toThrow(/hardhat_impersonateAccount/);
    const named = runtime(await tempRoot(), {}, null, "localhost");
    await stageSafeTx(named, unsignedCall("0x01"));
    await expect(proposeStagedSafeBatches(named, options)).rejects.toThrow(/Refusing to rehearse/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("rehearseSafeBatch", () => {
  it("refuses a batch made for another chain, or edited after it was written", async () => {
    const batch = createSafeBatch({ chainId: 1, safe: SAFE, calls: [call("0x01")], name: "Deploy" });
    const provider = safeProvider({ chainId: 137, clientVersion: ANVIL });
    await expect(rehearseSafeBatch(provider, batch)).rejects.toThrow(/is for chain 1, but the fork runs chain 137/);
    const edited = { ...batch, meta: { ...batch.meta, createdFromSafeAddress: SAFE_B } };
    await expect(rehearseSafeBatch(provider, edited)).rejects.toThrow(/invalid checksum/);
  });
});

type TaskAction = (args: Record<string, string | undefined>, hre: HardhatDeployRuntime) => Promise<unknown>;

/** The actions registerSafeTasks registers, by task name. */
function registeredTasks(): Map<string, TaskAction> {
  const actions = new Map<string, TaskAction>();
  const task = (name: string): TaskDefinition => {
    const definition: TaskDefinition = {
      addOptionalParam: () => definition,
      addFlag: () => definition,
      setAction: action => {
        actions.set(name, action);
        return definition;
      },
    };
    return definition;
  };
  registerSafeTasks(task, { apiKey: "key", txServiceUrl: "https://tx.example/api" });
  return actions;
}

describe("safe:list", () => {
  it("says what safe:propose would do with each file on a live network, without doing it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await tempRoot();
    const stageAt = async (at: number, ...data: Hex[]) => {
      vi.spyOn(Date, "now").mockReturnValue(at);
      const hre = runtime(root);
      for (const d of data) await stageSafeTx(hre, unsignedCall(d));
    };
    await stageAt(STAGED_AT, "0x01");
    await stageAt(STAGED_AT + 60_000, "0x02");
    await stageAt(STAGED_AT + 120_000, "0x03", "0x04");
    const { posted, fetch } = liveService(
      [serviceTx(40, [call("0x03")])],
      [serviceTx(39, [call("0x02")], { executed: true })],
    );
    const tasks = registeredTasks();
    await tasks.get("safe:list")?.({}, runtime(root));

    // One block per file: name, Safe and calls, then the verdict and any warning (no colors off a terminal).
    expect(log.mock.calls.map(c => String(c[0]))).toEqual([
      "safe-batches/mainnet  (3 staged)\n",
      expect.stringMatching(
        /^20261001T153000Z-0x6649dd\.json {3}Safe 0x6649…AaEA {3}1 call\n {2}→ propose at nonce 41\n {2}! nonce 39 \(0x\w{4}…\w{4}\) changed these contracts since staging\n$/,
      ),
      expect.stringMatching(
        /^20261001T153100Z-0x6649dd\.json {3}Safe 0x6649…AaEA {3}1 call\n {2}✓ already executed at nonce 39 \(0x\w{4}…\w{4}\) → delete\n$/,
      ),
      expect.stringMatching(
        /^20261001T153200Z-0x6649dd\.json {3}Safe 0x6649…AaEA {3}2 calls\n {2}✗ partial: shares calls with nonce 40 \(0x\w{4}…\w{4}\) → keep\n/,
      ),
    ]);
    expect(posted).toEqual([]);
    expect(fetch).toHaveBeenCalled();
    expect(await readdir(liveDir(root))).toHaveLength(3);
  });

  it("only lists on a fork, without asking the Safe service", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = await tempRoot();
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    const { fetch } = liveService();
    await registeredTasks().get("safe:list")?.(
      { from: "mainnet" },
      runtime(root, { clientVersion: ANVIL }, null, "hardhat"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("registerSafeTasks", () => {
  it("registers the Safe tasks, and safe:discard deletes the file", async () => {
    const actions = new Map<
      string,
      (args: Record<string, string | undefined>, hre: HardhatDeployRuntime) => Promise<unknown>
    >();
    const task = (name: string): TaskDefinition => {
      const definition: TaskDefinition = {
        addOptionalParam: () => definition,
        addFlag: () => definition,
        setAction: action => {
          actions.set(name, action);
          return definition;
        },
      };
      return definition;
    };
    registerSafeTasks(task);
    expect([...actions.keys()]).toEqual(["safe:list", "safe:rehearse", "safe:propose", "safe:discard"]);
    // A reset anywhere but the in-process network would wipe a running node.
    await expect(
      actions.get("safe:rehearse")?.({ from: "mainnet" }, runtime(tmpdir(), {}, null, "localhost")),
    ).rejects.toThrow(/--network hardhat/);

    const root = await tempRoot();
    await stageSafeTx(runtime(root), unsignedCall("0x01"));
    const [name] = await readdir(liveDir(root));
    await actions.get("safe:discard")?.({ file: path.join(liveDir(root), name ?? "") }, runtime(root));
    expect(await readdir(liveDir(root))).toEqual([]);
  });
});

describe("safe:rehearse", () => {
  it("refuses a staged file made for another chain than the network it forks", async () => {
    const { createServer } = await import("node:http");
    // The forked network's node reports Polygon.
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: numberToHex(137) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    try {
      const root = await tempRoot();
      await stageSafeTx(runtime(root), unsignedCall("0x01"));
      const node = safeProvider();
      const hre: HardhatDeployRuntime = {
        ...runtime(root, {}, null, "hardhat"),
        network: {
          name: "hardhat",
          provider: { request: args => (args.method === "hardhat_reset" ? Promise.resolve(true) : node.request(args)) },
        },
        config: { paths: { root }, networks: { mainnet: { url: `http://127.0.0.1:${port}` } } },
      };
      let rehearse:
        ((args: Record<string, string | undefined>, hre: HardhatDeployRuntime) => Promise<unknown>) | undefined;
      const task = (name: string): TaskDefinition => {
        const definition: TaskDefinition = {
          addOptionalParam: () => definition,
          addFlag: () => definition,
          setAction: action => {
            if (name === "safe:rehearse") rehearse = action;
            return definition;
          },
        };
        return definition;
      };
      registerSafeTasks(task);
      await expect(rehearse?.({ from: "mainnet" }, hre)).rejects.toThrow(/is for chain 1, not mainnet/);
    } finally {
      server.close();
    }
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
