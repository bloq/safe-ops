import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { proposeStagedSafeBatches, stageSafeTx, type HardhatDeployRuntime } from "../../src/hardhat/index.js";
import {
  classifyAccount,
  createSafeBatch,
  executeOnFork,
  rehearseSafeBatch,
  routeOwner,
  validateSafeBatch,
  type SafeBatch,
  type Eip1193Provider,
  type SafeCall,
} from "../../src/index.js";
import { publicClientFor } from "../../src/client.js";
import { sortOwners } from "../../src/fork.js";
import { startAnvil, type Anvil } from "./anvil.js";

const FORK_URL = process.env.FORK_URL;

// Live Ethereum state: two YieldVault owner Safes on different Safe versions.
const SAFE_141 = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA"; // owns the two vaults below
const VAULT_A = "0xe3DA4B83C9dd4c4D185ecE42077462b3F35c454a";
const VAULT_B = "0x6d134cAAD0CA29Cd6ea145f6C0DC766076690547";
const SAFE_130 = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A"; // owns VAULT_C
const VAULT_C = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";
const EIP7702_ACCOUNT = "0xdf826ff6518e609E4cEE86299d40611C148099d5";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const MULTI_SEND_CALL_ONLY_141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const MULTI_SEND_CALL_ONLY_130 = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";

const vaultAbi = parseAbi([
  "function minimumDepositLimit() view returns (uint256)",
  "function updateMinimumDepositLimit(uint256)",
  "function updatePerformanceFee(uint256)",
]);
const setLimit = (vault: Address, limit: bigint): SafeCall => ({
  to: vault,
  data: encodeFunctionData({ abi: vaultAbi, functionName: "updateMinimumDepositLimit", args: [limit] }),
});
const nonceAbi = parseAbi(["function nonce() view returns (uint256)"]);

describe.skipIf(!FORK_URL)("ethereum fork", () => {
  let anvil: Anvil;
  let client: PublicClient;
  let snapshot: string;

  const limit = (vault: Address) =>
    client.readContract({ address: vault, abi: vaultAbi, functionName: "minimumDepositLimit" });
  const nonce = (safe: Address) => client.readContract({ address: safe, abi: nonceAbi, functionName: "nonce" });

  beforeAll(async () => {
    anvil = await startAnvil(FORK_URL ?? "");
    client = publicClientFor(anvil.provider);
  });
  afterAll(() => {
    anvil.stop();
  });
  beforeEach(async () => {
    snapshot = await anvil.snapshot();
  });
  afterEach(async () => {
    await anvil.revert(snapshot);
  });

  describe("classifyAccount", () => {
    it("reads a Safe's version, threshold, owners and singleton", async () => {
      const info = await classifyAccount(anvil.provider, SAFE_141);
      expect(info.kind).toBe("safe");
      if (info.kind !== "safe") return;
      expect(info.safe.version).toBe("1.4.1");
      expect(info.safe.threshold).toBe(3n);
      expect(info.safe.owners).toHaveLength(6);
      expect(info.safe.singleton).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("detects an EIP-7702 account and its delegate", async () => {
      expect(await classifyAccount(anvil.provider, EIP7702_ACCOUNT)).toEqual({
        kind: "eip7702",
        address: EIP7702_ACCOUNT,
        delegate: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
      });
    });

    it("tells EOAs and non-Safe contracts apart", async () => {
      expect((await classifyAccount(anvil.provider, STRANGER)).kind).toBe("eoa");
      expect((await classifyAccount(anvil.provider, USDC)).kind).toBe("contract");
    });
  });

  describe("routeOwner", () => {
    it("routes owners through the Safe, never lets a Safe or contract act directly, and skips strangers", async () => {
      const info = await classifyAccount(anvil.provider, SAFE_141);
      if (info.kind !== "safe") throw new Error("expected a Safe");
      const signer = info.safe.owners[0] ?? STRANGER;

      expect((await routeOwner(anvil.provider, SAFE_141, signer)).kind).toBe("safe");
      expect(await routeOwner(anvil.provider, SAFE_141, SAFE_141)).toMatchObject({ kind: "skip" });
      expect(await routeOwner(anvil.provider, USDC, USDC)).toMatchObject({ kind: "skip" });
      expect((await routeOwner(anvil.provider, EIP7702_ACCOUNT, EIP7702_ACCOUNT)).kind).toBe("direct");
      expect(await routeOwner(anvil.provider, SAFE_141, STRANGER)).toMatchObject({ kind: "skip" });
      expect(await routeOwner(anvil.provider, EIP7702_ACCOUNT, STRANGER)).toMatchObject({ kind: "skip" });
    });

    it("accepts a delegate through the isProposer hook", async () => {
      const route = await routeOwner(anvil.provider, SAFE_141, STRANGER, { isProposer: () => Promise.resolve(true) });
      expect(route.kind).toBe("safe");
    });
  });

  describe("executeOnFork", () => {
    it("executes a batch atomically through MultiSendCallOnly on Safe 1.4.1", async () => {
      const before = await nonce(SAFE_141);
      const result = await executeOnFork(anvil.provider, SAFE_141, [setLimit(VAULT_A, 111n), setLimit(VAULT_B, 222n)]);

      expect(await limit(VAULT_A)).toBe(111n);
      expect(await limit(VAULT_B)).toBe(222n);
      expect(await nonce(SAFE_141)).toBe(before + 1n);
      expect(result.nonce).toBe(before);
      expect(result.approvers).toHaveLength(3);
      expect(result).toMatchObject({ to: MULTI_SEND_CALL_ONLY_141, operation: 1 });
    });

    it("executes on Safe 1.3.0 with its own MultiSendCallOnly", async () => {
      const result = await executeOnFork(anvil.provider, SAFE_130, [setLimit(VAULT_C, 333n), setLimit(VAULT_C, 444n)]);
      expect(await limit(VAULT_C)).toBe(444n);
      expect(result).toMatchObject({ to: MULTI_SEND_CALL_ONLY_130, operation: 1 });
    });

    it("sends a single call without MultiSend", async () => {
      const result = await executeOnFork(anvil.provider, SAFE_141, [setLimit(VAULT_A, 555n)]);
      expect(await limit(VAULT_A)).toBe(555n);
      expect(result).toMatchObject({ to: VAULT_A, operation: 0 });
    });

    it("reverts the whole batch when one call fails", async () => {
      const [limitBefore, nonceBefore] = await Promise.all([limit(VAULT_A), nonce(SAFE_141)]);
      const failing: SafeCall = {
        to: VAULT_B,
        data: encodeFunctionData({ abi: vaultAbi, functionName: "updatePerformanceFee", args: [10_001n] }),
      };

      await expect(executeOnFork(anvil.provider, SAFE_141, [setLimit(VAULT_A, 999n), failing])).rejects.toThrow(
        /GS013/,
      );
      expect(await limit(VAULT_A)).toBe(limitBefore);
      expect(await nonce(SAFE_141)).toBe(nonceBefore);
    });

    it("batches on a Safe older than 1.3.0 through MultiSendCallOnly 1.3.0", async () => {
      const safe = await deploySafe111();
      const noop: SafeCall = { to: STRANGER, data: "0x" };
      const result = await executeOnFork(anvil.provider, safe, [noop, noop]);
      expect(result).toMatchObject({ to: MULTI_SEND_CALL_ONLY_130, operation: 1 });
    });

    it("leaves an approver the caller impersonated usable", async () => {
      const info = await classifyAccount(anvil.provider, SAFE_141);
      if (info.kind !== "safe") throw new Error("expected a Safe");
      const approvers = sortOwners(info.safe.owners.slice(0, Number(info.safe.threshold)));
      const owner = approvers[0] ?? STRANGER;
      await anvil.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });

      const result = await executeOnFork(anvil.provider, SAFE_141, [setLimit(VAULT_A, 1n)]);
      expect(result.approvers).toContain(owner);
      await expect(
        anvil.provider.request({ method: "eth_sendTransaction", params: [{ from: owner, to: owner, value: "0x0" }] }),
      ).resolves.toBeDefined();
    });

    it("refuses calldata to an address without code", async () => {
      await expect(executeOnFork(anvil.provider, SAFE_141, [setLimit(STRANGER, 1n)])).rejects.toThrow(/has no code/);
    });

    it("refuses an address that is not a Safe", async () => {
      await expect(executeOnFork(anvil.provider, USDC, [setLimit(VAULT_A, 1n)])).rejects.toThrow(/is not a Safe/);
    });
  });

  // Safe 1.1.1 ProxyFactory and singleton on Ethereum, set up as a 1-of-1 Safe.
  async function deploySafe111(): Promise<Address> {
    const factory = "0x76E2cFc1F5Fa8F6a5b3fC4c8F4788F0116861F9B";
    const singleton = "0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F";
    const setup = encodeFunctionData({
      abi: parseAbi(["function setup(address[],uint256,address,bytes,address,address,uint256,address)"]),
      functionName: "setup",
      args: [[STRANGER], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
    });
    const data = encodeFunctionData({
      abi: parseAbi(["function createProxy(address,bytes) returns (address)"]),
      functionName: "createProxy",
      args: [singleton, setup],
    });
    const funder = "0x2222222222222222222222222222222222222222";
    await anvil.provider.request({ method: "hardhat_impersonateAccount", params: [funder] });
    await anvil.provider.request({ method: "hardhat_setBalance", params: [funder, "0xde0b6b3a7640000"] });
    const hash = (await anvil.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: funder, to: factory, data }],
    })) as Hash;
    const receipt = await client.waitForTransactionReceipt({ hash });
    const log = receipt.logs[0];
    if (!log) throw new Error("ProxyCreation not emitted");
    return getAddress(`0x${log.data.slice(26, 66)}`);
  }

  describe("hardhat flow", () => {
    const runtimeAt = async (provider: Eip1193Provider, config?: object): Promise<HardhatDeployRuntime> => ({
      network: { name: "localhost", provider, ...(config ? { config } : {}) },
      config: { paths: { root: await mkdtemp(path.join(tmpdir(), "safe-ops-")) } },
      deployments: { catchUnknownSigner: () => Promise.resolve(null) },
    });
    const unsigned = (from: Address, call: SafeCall) => ({ from, to: call.to, data: call.data });

    it("stages one Tx Builder file per Safe and rehearses exactly those files", async () => {
      const hre = await runtimeAt(anvil.provider);
      await stageSafeTx(hre, unsigned(SAFE_141, setLimit(VAULT_A, 7n)));
      await stageSafeTx(hre, unsigned(SAFE_141, setLimit(VAULT_B, 8n)));
      await stageSafeTx(hre, unsigned(SAFE_130, setLimit(VAULT_C, 9n)));

      const results = await proposeStagedSafeBatches(hre);
      expect(results.map(r => [r.safe, r.execution?.safe, r.removed])).toEqual([
        [SAFE_141, SAFE_141, false],
        [SAFE_130, SAFE_130, false],
      ]);
      for (const { file, safe } of results) {
        const batch = JSON.parse(await readFile(file, "utf8")) as SafeBatch;
        expect(validateSafeBatch(batch)).toBe(true);
        expect(batch.meta.createdFromSafeAddress).toBe(safe);
      }
      expect([await limit(VAULT_A), await limit(VAULT_B), await limit(VAULT_C)]).toEqual([7n, 8n, 9n]);
    });

    it("rehearses through the node when Hardhat signs with local keys", async () => {
      // Hardhat's LocalAccountsProvider (network `accounts`, e.g. from .env) rejects impersonated senders.
      const localKeys: Eip1193Provider = {
        request: args =>
          args.method === "eth_sendTransaction"
            ? Promise.reject(new Error("HH103: Account is not managed by the node you are connected to."))
            : anvil.provider.request(args),
      };
      await expect(executeOnFork(localKeys, SAFE_141, [setLimit(VAULT_A, 3n)])).rejects.toThrow(/local keys/);

      const hre = await runtimeAt(localKeys, { url: anvil.url });
      await stageSafeTx(hre, unsigned(SAFE_141, setLimit(VAULT_A, 4n)));
      const [result] = await proposeStagedSafeBatches(hre);
      expect(result?.execution).toBeDefined();
      expect(await limit(VAULT_A)).toBe(4n);
    });

    it("fails on a staged call the Safe would revert, keeping the file to inspect", async () => {
      const hre = await runtimeAt(anvil.provider);
      await stageSafeTx(hre, {
        from: SAFE_130,
        to: VAULT_C,
        data: encodeFunctionData({ abi: vaultAbi, functionName: "updatePerformanceFee", args: [10_001n] }),
      });
      await expect(proposeStagedSafeBatches(hre)).rejects.toThrow(/would revert/);
      expect(await readdir(path.join(hre.config?.paths.root ?? "", "safe-batches", "localhost"))).toHaveLength(1);
    });

    it("refuses to rehearse a batch made for another chain", async () => {
      const batch = createSafeBatch({ chainId: 137, safe: SAFE_141, calls: [setLimit(VAULT_A, 1n)], name: "x" });
      await expect(rehearseSafeBatch(anvil.provider, batch)).rejects.toThrow(/is for chain 137/);
    });

    it("refuses to stage calls for an account that is not a Safe", async () => {
      const hre = await runtimeAt(anvil.provider);
      await expect(stageSafeTx(hre, unsigned(EIP7702_ACCOUNT, setLimit(VAULT_A, 1n)))).rejects.toThrow(/is not a Safe/);
    });
  });
});
