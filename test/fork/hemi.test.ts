import { encodeFunctionData, parseAbi, type PublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAccount, executeOnFork, publicClientFor, type SafeCall } from "../../src/index.js";
import { startAnvil, type Anvil } from "./anvil.js";

const HEMI_FORK_URL = process.env.HEMI_FORK_URL;

const SAFE = "0x694fA0816999Da16E8783C0f5cDE68c13a33C4e6";
const VAULT = "0xC95873B97E28FFfC9230A335cE193D8D7f09e523"; // sHemiBTC, owned by SAFE
const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function minimumDepositLimit() view returns (uint256)",
  "function updateMinimumDepositLimit(uint256)",
]);

describe.skipIf(!HEMI_FORK_URL)("hemi fork", () => {
  let anvil: Anvil;
  let client: PublicClient;

  beforeAll(async () => {
    anvil = await startAnvil(HEMI_FORK_URL ?? "");
    client = publicClientFor(anvil.provider);
  });
  afterAll(() => {
    anvil.stop();
  });

  it("executes a batch through MultiSendCallOnly on Hemi", async () => {
    expect(await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "owner" })).toBe(SAFE);
    expect((await classifyAccount(client, SAFE)).kind).toBe("safe");

    const call = (limit: bigint): SafeCall => ({
      to: VAULT,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "updateMinimumDepositLimit", args: [limit] }),
    });
    const result = await executeOnFork(anvil.provider, SAFE, [call(11n), call(12n)]);

    expect(result.operation).toBe(1);
    expect(await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "minimumDepositLimit" })).toBe(12n);
  });
});
