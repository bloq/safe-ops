import {
  concatHex,
  encodeFunctionData,
  hexToNumber,
  keccak256,
  numberToHex,
  recoverMessageAddress,
  sliceHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeAbi } from "../src/abi.js";
import {
  createSafeBatch,
  isProposer,
  proposeSafeBatch,
  readSafeQueue,
  resolveTxService,
  safeBatchStatus,
  type Eip1193Provider,
  type SafeCall,
} from "../src/index.js";
import { proposeCalls } from "../src/propose.js";
import { SAFE_NONCE, safeProvider, serviceTx } from "./safe-mock.js";

const SAFE = "0x6649Ddb5c7e52348b73c8bBdD2A1cbA630b7AaEA";
const X: Address = "0x3aEd4dd0b5ba616156Fa352274670c18D2Ec2A81";
const Y: Address = "0x025a05f1967521806BB4c8a10Ba4b8c00A794F65";
const SERVICE = { url: "https://tx.example/api", chainId: 1, apiKey: "key" };
// Hardhat's well-known account 1; the key is public.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const update = (n: number) => ({ to: X, data: numberToHex(n, { size: 4 }), value: 0n });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  signal?: unknown;
}

// The service's answer to "is the Safe's latest execution indexed?", which every queue read asks first.
const INDEXED = `?nonce=${SAFE_NONCE - 1n}&`;
const latestTx = (executed: boolean) => serviceTx(Number(SAFE_NONCE - 1n), [update(0)], { executed });

/** Stubs fetch with `answer(url)` and records every request. The latest execution is indexed unless `lagging`. */
function service(answer: (url: string) => unknown, status = 200, { lagging = false } = {}): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: unknown }) => {
      sent.push({
        url,
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      const indexed = url.includes(INDEXED) ? { next: null, results: [latestTx(!lagging)] } : undefined;
      const text = JSON.stringify(indexed ?? answer(url) ?? {});
      return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(text) });
    },
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTxService", () => {
  it("looks up the chain's service in Safe's config service and checks the chain it serves", async () => {
    const sent = service(url =>
      url.includes("safe-config")
        ? { transactionService: "https://api.safe.global/tx-service/hemi" }
        : { chain_id: 43111 },
    );
    expect(await resolveTxService(43111, { apiKey: "k" })).toEqual({
      url: "https://api.safe.global/tx-service/hemi/api",
      chainId: 43111,
      apiKey: "k",
    });
    expect(sent[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(sent.map(r => r.url)).toEqual([
      "https://safe-config.safe.global/api/v1/chains/43111/",
      "https://api.safe.global/tx-service/hemi/api/v1/about/ethereum-rpc/",
    ]);
  });

  it("says when Safe has no service for the chain, and asks for a key for api.safe.global", async () => {
    service(() => ({ detail: "Not found." }), 404);
    await expect(resolveTxService(743111)).rejects.toThrow(
      "Safe has no transaction service for chain 743111; pass txServiceUrl",
    );
    const sent = service(() => ({ transactionService: "https://api.safe.global/tx-service/eth" }));
    await expect(resolveTxService(1)).rejects.toThrow("api.safe.global needs an API key");
    expect(sent).toHaveLength(1);
  });

  it("refuses to follow a redirect, which would drop the API key", async () => {
    const redirects: unknown[] = [];
    vi.stubGlobal("fetch", (_url: string, init: { redirect?: string }) => {
      redirects.push(init.redirect);
      return Promise.resolve({
        ok: false,
        status: 308,
        headers: new Headers({ location: "https://api.safe.global/tx-service/hemi/api/v1/about/ethereum-rpc/" }),
        text: () => Promise.resolve(""),
      });
    });
    await expect(
      resolveTxService(43111, { txServiceUrl: "https://safe-transaction-hemi.safe.global/api" }),
    ).rejects.toThrow(
      "redirects to https://api.safe.global/tx-service/hemi/api/v1/about/ethereum-rpc/; use that URL instead",
    );
    // Without `manual`, fetch would follow it and send the request on without the key.
    expect(redirects).toEqual(["manual"]);
  });

  it("uses an explicit URL without a lookup, but refuses one for another chain", async () => {
    service(() => ({ chain_id: 1 }));
    expect((await resolveTxService(1, { txServiceUrl: "https://tx.example/api/" })).url).toBe("https://tx.example/api");
    await expect(resolveTxService(42161, { txServiceUrl: "https://tx.example/api" })).rejects.toThrow(
      /serves chain 1, not 42161/,
    );
  });
});

describe("readSafeQueue", () => {
  it("pages through every executable proposal and flattens MultiSend batches", async () => {
    const pages: Record<string, unknown> = {
      first: { next: "https://tx.example/api/page2", results: [serviceTx(39, [update(1), { to: Y, data: "0x01" }])] },
      "https://tx.example/api/page2": {
        next: null,
        results: [serviceTx(41, [{ to: X, data: "0x", value: 5n }]), serviceTx(41, [update(2)])],
      },
    };
    const sent = service(url => pages[url] ?? pages.first);
    const queue = await readSafeQueue(safeProvider(), SERVICE, SAFE);

    expect(sent.map(r => r.url).slice(0, 2)).toEqual([
      `https://tx.example/api/v2/safes/${SAFE}/multisig-transactions/` +
        `?nonce=${SAFE_NONCE - 1n}&ordering=nonce&limit=100`,
      `https://tx.example/api/v2/safes/${SAFE}/multisig-transactions/` +
        `?executed=false&nonce__gte=${SAFE_NONCE}&ordering=nonce&limit=100`,
    ]);
    expect(sent[0]?.headers.Authorization).toBe("Bearer key");
    expect(queue).toMatchObject({
      onchainNonce: SAFE_NONCE,
      nextNonce: 42n,
      contestedNonces: [41n],
      missingNonces: [40n],
    });
    expect(queue.proposals.map(p => [p.nonce, p.calls])).toEqual([
      [39n, [update(1), { to: Y, data: "0x01", value: 0n }]],
      [41n, [{ to: X, data: "0x", value: 5n }]],
      [41n, [update(2)]],
    ]);
  });

  it("refuses a next page on another origin, which would carry the API key off the service", async () => {
    service(url =>
      url.includes("executed=false")
        ? { next: "http://tx.example/api/page2", results: [] }
        : { next: null, results: [] },
    );
    await expect(readSafeQueue(safeProvider(), SERVICE, SAFE)).rejects.toThrow(
      "links its next page to another origin: http://tx.example/api/page2",
    );
  });

  it("proposes at the on-chain nonce when nothing is queued", async () => {
    service(() => ({ next: null, results: [] }));
    expect((await readSafeQueue(safeProvider(), SERVICE, SAFE)).nextNonce).toBe(SAFE_NONCE);
  });

  it("waits for the service to index the Safe's latest execution, which would otherwise look fresh", async () => {
    // Just executed on chain: the nonce moved past the proposal, which the service still lists as pending.
    const sent = service(() => ({ next: null, results: [] }), 200, { lagging: true });
    await expect(readSafeQueue(safeProvider(), SERVICE, SAFE)).rejects.toThrow(
      `has not indexed nonce ${SAFE_NONCE - 1n} of Safe ${SAFE} yet`,
    );
    expect(sent).toHaveLength(1);
    // A Safe that never executed anything has nothing to wait for.
    const fresh = service(() => ({ next: null, results: [] }), 200, { lagging: true });
    const queue = await readSafeQueue(safeProvider({ nonce: 0n }), SERVICE, SAFE);
    expect(queue.nextNonce).toBe(0n);
    expect(fresh.map(r => r.url).join()).not.toContain("?nonce=");
    // Nor does a service that never recorded that nonce (e.g. indexing started later): it would wait forever.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"next":null,"results":[]}') }),
    );
    expect((await readSafeQueue(safeProvider(), SERVICE, SAFE)).nextNonce).toBe(SAFE_NONCE);
  });
});

describe("safeBatchStatus", () => {
  const STAGED_AT = Date.UTC(2026, 9, 1, 15, 30);
  const batchOf = (...calls: SafeCall[]) =>
    createSafeBatch({ chainId: 1, safe: SAFE, calls, name: "Deploy", createdAt: STAGED_AT });
  const status = async (pending: unknown[], executed: unknown[], ...calls: SafeCall[]) => {
    const sent = service(url => ({ next: null, results: url.includes("executed=true") ? executed : pending }));
    return { result: await safeBatchStatus(safeProvider(), SERVICE, batchOf(...calls)), sent };
  };

  it("is fresh when nothing pending or executed shares its calls, and reads executions since staging", async () => {
    const { result, sent } = await status([], [], update(1));
    expect(result).toEqual({
      status: "fresh",
      contested: false,
      overlapping: [],
      touched: [],
      nextNonce: SAFE_NONCE,
      missingNonces: [],
    });
    // Ten minutes before staging, in case the staging machine's clock runs ahead.
    expect(sent.map(r => r.url).join()).toContain("executed=true&execution_date__gte=2026-10-01T15:20:00.000Z");
  });

  it("is pending when one proposal makes exactly its calls, and flags a contested nonce", async () => {
    const mine = serviceTx(40, [update(1), update(2)]);
    expect((await status([mine], [], update(1), update(2))).result).toMatchObject({
      status: "pending",
      match: { nonce: 40n },
      contested: false,
    });
    const rival = serviceTx(40, [update(9)]);
    expect((await status([mine, rival], [], update(1), update(2))).result).toMatchObject({ contested: true });
  });

  it("is executed when an execution since staging made exactly its calls, ignoring failed ones", async () => {
    const done = serviceTx(38, [update(1)], { executed: true });
    expect((await status([], [done], update(1))).result).toMatchObject({ status: "executed", match: { nonce: 38n } });
    const failed = serviceTx(38, [update(1)], { executed: true, successful: false });
    expect((await status([], [failed], update(1))).result.status).toBe("fresh");
  });

  it("is partial when proposals share some calls but none makes exactly them", async () => {
    const overlap = serviceTx(40, [update(1)]);
    expect((await status([overlap], [], update(1), update(2))).result).toMatchObject({
      status: "partial",
      overlapping: [{ nonce: 40n }],
    });
    // Same calls in another order is a different transaction.
    const reordered = serviceTx(40, [update(2), update(1)]);
    expect((await status([reordered], [], update(1), update(2))).result.status).toBe("partial");
  });

  it("only lets a proposal that runs the same way stand in for the batch", async () => {
    // Same calls, but as a delegatecall, through a MultiSend that isn't Safe's, or paying a gas refund.
    for (const lookalike of [
      serviceTx(40, [update(1)], { operation: 1 }),
      serviceTx(40, [update(1), update(2)], { to: Y }),
      serviceTx(40, [update(1)], { gasPrice: "1" }),
    ]) {
      const calls = lookalike.operation === 1 && lookalike.to === Y ? [update(1), update(2)] : [update(1)];
      expect((await status([lookalike], [], ...calls)).result.status).toBe("partial");
    }
  });

  it("reports executions that changed its contracts without sharing its calls", async () => {
    const other = serviceTx(38, [update(7)], { executed: true });
    const unrelated = serviceTx(37, [{ to: Y, data: "0x01" }], { executed: true });
    const { result } = await status([], [other, unrelated], update(1));
    expect(result).toMatchObject({ status: "fresh", touched: [{ nonce: 38n }] });
    expect(result.touched).toHaveLength(1);
  });
});

describe("proposeSafeBatch", () => {
  const batch = createSafeBatch({ chainId: 1, safe: SAFE, calls: [update(1)], name: "Deploy", createdAt: 1 });

  it("notes the batch's description, or else its name, for signers", async () => {
    const sent = service(() => ({ next: null, results: [] }));
    await proposeSafeBatch(safeProvider(), SERVICE, signer, batch);
    const described = createSafeBatch({ chainId: 1, safe: SAFE, calls: [update(2)], name: "N", description: "D" });
    await proposeSafeBatch(safeProvider(), SERVICE, signer, described, { origin: "app" });
    const origins = sent.filter(r => r.method === "POST").map(r => JSON.parse(r.body?.origin as string) as unknown);
    expect(origins).toEqual([
      { name: "safe-ops", note: "Deploy" },
      { name: "app", note: "D" },
    ]);
  });

  it("proposes a fresh batch exactly as written, after the pending proposals", async () => {
    const sent = service(url => ({
      next: null,
      results: url.includes("executed=false") ? [serviceTx(40, [update(5)])] : [],
    }));
    const result = await proposeSafeBatch(safeProvider(), SERVICE, signer, batch);
    expect(result).toMatchObject({ status: "fresh", proposal: { nonce: 41n, proposer: signer.address } });
    const post = sent.find(r => r.method === "POST");
    expect(post?.body).toMatchObject({ to: X, data: update(1).data, value: "0", operation: 0, nonce: "41" });
  });

  it("returns the status without proposing when the batch is not fresh", async () => {
    const sent = service(url => ({
      next: null,
      results: url.includes("executed=false") ? [serviceTx(40, [update(1)])] : [],
    }));
    const result = await proposeSafeBatch(safeProvider(), SERVICE, signer, batch);
    expect(result).toMatchObject({ status: "pending", match: { nonce: 40n } });
    expect(result.proposal).toBeUndefined();
    expect(sent.filter(r => r.method === "POST")).toEqual([]);
  });

  it("refuses an edited batch, one for another chain, and calldata to an address without code", async () => {
    const sent = service(() => ({ next: null, results: [] }));
    const edited = { ...batch, transactions: [{ ...batch.transactions[0], to: Y, value: "0" }] };
    await expect(proposeSafeBatch(safeProvider(), SERVICE, signer, edited)).rejects.toThrow(/invalid checksum/);
    const hemi = createSafeBatch({ chainId: 43111, safe: SAFE, calls: [update(1)], name: "Deploy" });
    await expect(proposeSafeBatch(safeProvider(), SERVICE, signer, hemi)).rejects.toThrow(/for chain 43111/);
    await expect(proposeSafeBatch(safeProvider({ codeless: [X] }), SERVICE, signer, batch)).rejects.toThrow(
      /has no code/,
    );
    expect(sent.filter(r => r.method === "POST")).toEqual([]);
  });
});

describe("isProposer", () => {
  const OWNER: Address = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
  const safe = { address: SAFE, owners: [OWNER] } as const;
  // Given what readSafe returned, it never reads the chain again.
  const noNode: Eip1193Provider = { request: () => Promise.reject(new Error("unexpected node request")) };
  const delegate = (d: { safe?: string | null; delegator?: string; expiryDate?: string | null }) => ({
    safe: SAFE,
    delegator: OWNER,
    expiryDate: null,
    ...d,
  });

  it("accepts a delegate for this Safe or for all of its delegator's Safes, and nothing else", async () => {
    service(() => ({ next: null, results: [delegate({ safe: Y })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(false);
    service(() => ({ next: null, results: [delegate({ safe: Y }), delegate({ safe: SAFE.toLowerCase() })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(true);
    const sent = service(() => ({ next: null, results: [delegate({ safe: null })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(true);
    expect(sent[0]?.url).toBe(`https://tx.example/api/v2/delegates/?delegate=${X}&limit=100`);
  });

  it("ignores delegations the service would refuse: by a former owner, or expired", async () => {
    service(() => ({ next: null, results: [delegate({ delegator: Y })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(false);
    service(() => ({ next: null, results: [delegate({ expiryDate: "2020-01-01T00:00:00Z" })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(false);
    service(() => ({ next: null, results: [delegate({ expiryDate: "2999-01-01T00:00:00Z" })] }));
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(true);
  });

  it("reads every page of delegations", async () => {
    const sent = service(url =>
      url.includes("page2")
        ? { next: null, results: [delegate({})] }
        : { next: "https://tx.example/api/page2", results: [delegate({ safe: Y })] },
    );
    expect(await isProposer(noNode, SERVICE, safe, X)).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

describe("isProposer by address", () => {
  it("reads the Safe's owners from the chain, and refuses an address that is not a Safe", async () => {
    // The mock Safe is owned by OWNER, who delegated to X.
    const OWNER = "0x9520b477Aa81180E6DdC006Fc09Fb6d3eb4e807A";
    service(() => ({ next: null, results: [{ safe: SAFE, delegator: OWNER, expiryDate: null }] }));
    expect(await isProposer(safeProvider(), SERVICE, SAFE, X)).toBe(true);
    await expect(isProposer(safeProvider({ slot0: X }), SERVICE, SAFE, X)).rejects.toThrow(`${SAFE} is not a Safe`);
  });
});

describe("proposeCalls", () => {
  const hashFor = (to: Address, value: bigint, data: Hex, operation: number, nonce: bigint): Hash =>
    // The mock Safe hashes the getTransactionHash calldata.
    keccak256(
      encodeFunctionData({
        abi: safeAbi,
        functionName: "getTransactionHash",
        args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
      }),
    );

  it("posts the Safe transaction at the given nonce, signed by the proposer with eth_sign", async () => {
    const sent = service(() => ({}));
    const proposal = await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], {
      nonce: 42n,
      origin: "deploy",
    });

    const safeTxHash = hashFor(X, 0n, update(1).data, 0, 42n);
    expect(proposal).toEqual({ safe: SAFE, safeTxHash, nonce: 42n, proposer: signer.address });
    const [post] = sent;
    expect(post?.method).toBe("POST");
    expect(post?.url).toBe(`https://tx.example/api/v2/safes/${SAFE}/multisig-transactions/`);
    expect(post?.body).toMatchObject({
      to: X,
      value: "0",
      data: update(1).data,
      operation: 0,
      nonce: "42",
      contractTransactionHash: safeTxHash,
      sender: signer.address,
      origin: JSON.stringify({ name: "deploy" }),
    });

    const signature = post?.body?.signature as Hex;
    const v = hexToNumber(sliceHex(signature, 64));
    expect([31, 32]).toContain(v);
    const plain = concatHex([sliceHex(signature, 0, 64), numberToHex(v - 4)]);
    expect(await recoverMessageAddress({ message: { raw: safeTxHash }, signature: plain })).toBe(signer.address);
  });

  it("takes any signer with an address and signMessage, and refuses one whose signature is from another key", async () => {
    const sent = service(() => ({}));
    // e.g. an ethers wallet wrapped by hand, with a lowercase address.
    const plain = { address: signer.address.toLowerCase(), signMessage: signer.signMessage.bind(signer) };
    const proposal = await proposeCalls(safeProvider(), SERVICE, plain, SAFE, [update(1)], { nonce: 1n });
    expect(proposal.proposer).toBe(signer.address);
    expect(sent[0]?.body?.sender).toBe(signer.address);

    // A signer returning v as 0/1 (e.g. a KMS) still yields a Safe eth_sign signature, v 31/32.
    const yParity = {
      address: signer.address,
      signMessage: async (args: { message: { raw: Hash } }) => {
        const sig = await signer.signMessage(args);
        return concatHex([sliceHex(sig, 0, 64), numberToHex(hexToNumber(sliceHex(sig, 64)) - 27)]);
      },
    };
    await proposeCalls(safeProvider(), SERVICE, yParity, SAFE, [update(1)], { nonce: 1n });
    expect([31, 32]).toContain(hexToNumber(sliceHex(sent[1]?.body?.signature as Hex, 64)));

    const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const impostor = { address: signer.address, signMessage: other.signMessage.bind(other) };
    await expect(proposeCalls(safeProvider(), SERVICE, impostor, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /does not recover to its address/,
    );
    expect(sent).toHaveLength(2);
  });

  it("posts origin as the JSON the Safe UI reads, with a note cut to the service's 200 characters", async () => {
    const sent = service(() => ({}));
    await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n });
    expect(sent[0]?.body?.origin).toBe(JSON.stringify({ name: "safe-ops" }));
    await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n, note: 'Deploy "x"' });
    expect(JSON.parse(sent[1]?.body?.origin as string)).toEqual({ name: "safe-ops", note: 'Deploy "x"' });
    await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n, note: '"'.repeat(300) });
    const origin = sent[2]?.body?.origin as string;
    expect(origin.length).toBeLessThanOrEqual(200);
    expect(origin.length).toBeGreaterThan(190);
    expect((JSON.parse(origin) as { note: string }).note).toMatch(/^"+…$/);
    // Cut between characters, never inside one: half an emoji is not valid text.
    await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n, note: "😀".repeat(200) });
    const emoji = sent[3]?.body?.origin as string;
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect((JSON.parse(emoji) as { note: string }).note).toMatch(/^(😀)+…$/u);
    // The app name is cut to 50 characters, also between characters, so it always leaves room within 200.
    await proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], {
      nonce: 1n,
      origin: `a${"😀".repeat(60)}`,
    });
    expect((JSON.parse(sent[4]?.body?.origin as string) as { name: string }).name).toBe(`a${"😀".repeat(49)}`);
  });

  it("refuses Safes before 1.3.0, where a failing call still uses up the nonce", async () => {
    const sent = service(() => ({}));
    for (const version of ["1.1.1", "1.2.0", "1.0.0"]) {
      await expect(
        proposeCalls(safeProvider({ version }), SERVICE, signer, SAFE, [update(1)], { nonce: 1n }),
      ).rejects.toThrow(`is ${version}; proposing needs 1.3.0 or later`);
    }
    expect(sent).toEqual([]);
  });

  it("refuses a local node, whose state would be proposed to the real queue", async () => {
    const sent = service(() => ({}));
    const provider = safeProvider({ clientVersion: "anvil/v1.8.3" });
    await expect(proposeCalls(provider, SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /Refusing to propose/,
    );
    expect(sent).toEqual([]);
  });

  it("refuses a service for another chain", async () => {
    service(() => ({}));
    const provider = safeProvider({ chainId: 43111 });
    await expect(proposeCalls(provider, SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /chain 43111, service on 1/,
    );
  });

  it("names the request and says a proposal may have landed when the service doesn't answer", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    );
    await expect(proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /POST https:\/\/tx\.example\/api\/v2\/safes\/.* failed: .*timeout; it may still have landed/,
    );
    // The timeout can also fire after the headers, while the body is read.
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, status: 201, text: () => Promise.reject(timeout) }));
    await expect(proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /POST .* failed: .*timeout; it may still have landed/,
    );
  });

  it("says a proposal may have landed on a gateway error, but not when the service refused it", async () => {
    service(() => ({}), 502);
    await expect(proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /POST .* answered 502.*may still have landed/,
    );
    service(() => ({}), 422);
    const refused = proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n });
    await expect(refused).rejects.toThrow(/answered 422/);
    await expect(refused).rejects.not.toThrow(/may still have landed/);
  });

  it("surfaces the service's reason when it rejects the proposal", async () => {
    service(() => ({ nonFieldErrors: ["Sender is not an owner or delegate"] }), 422);
    await expect(proposeCalls(safeProvider(), SERVICE, signer, SAFE, [update(1)], { nonce: 1n })).rejects.toThrow(
      /422.*not an owner or delegate/,
    );
  });
});
