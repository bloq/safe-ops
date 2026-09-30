# @bloq/safe-ops

Queue owner transactions for Safe multisigs, export them as Safe Transaction Builder files, and rehearse them on a fork exactly as the Safe will execute them.

## Usage

```ts
import { SafeBatch } from "@bloq/safe-ops";
import { flushSafeBatch, queueIfUnknownSigner } from "@bloq/safe-ops/hardhat";

const batch = new SafeBatch();

// Runs directly when hardhat-deploy can sign for `owner`; otherwise queues the call under `owner`.
await queueIfUnknownSigner(hre, batch, () => hre.deployments.execute("Vault", { from: owner }, "setFee", 100));

// One Transaction Builder file per Safe in <project root>/safe-batches/<network>/.
// On a local Hardhat or anvil node the files are read back and executed through the Safe.
await flushSafeBatch(hre, batch, { name: "Set fees" });
```

Import the files in the Safe UI with the Transaction Builder app (Apps → Transaction Builder → drag the file in).

- **Duplicates:** `SafeBatch.add` drops a call identical to the latest call already queued for the same contract and returns `false` (`queueIfUnknownSigner` also logs a warning). Deploy scripts that check on-chain state can't see calls that are only queued, so two scripts can queue the same call. `x.update(1), x.update(2), x.update(1)` keeps all three. A deliberate repeat of a call that isn't idempotent, such as a second `harvest()`, needs `{ allowDuplicate: true }`. A duplicate with another call to the same contract in between is kept, and reverts if the contract rejects repeats; the rehearsal catches that.
- **Local or live** is decided by the node (`web3_clientVersion` reports Hardhat or anvil), not the network name.
  - **Live:** file names get a timestamp, so repeated runs under the same batch name don't collide. An existing file is never replaced, and a flush that fails partway removes what it wrote.
  - **Local:** files are marked `FORK REHEARSAL, DO NOT SIGN` in their name (the Safe UI shows it; the Transaction Builder ignores a file's chain and Safe on import). If a rehearsal fails, the flush removes every file it wrote.
- **Targets must have code:** a call with calldata to an address without code does nothing on chain, so a wrong-chain address or a typo would pass silently. The flush and the rehearsal refuse it unless `allowCallsWithoutCode` is set.
- **Impersonated Safes:** when the node impersonates a Safe (hardhat-deploy's `autoImpersonate`, on by default on `hardhat` and often set on `localhost`, or an impersonation you made on the node), its calls run directly and nothing is queued. `queueIfUnknownSigner` warns when that happens. Set `HARDHAT_DEPLOY_NO_IMPERSONATION=1` (or `autoImpersonate: false`), and don't impersonate the Safe itself.
- **Calls that depend on each other:** hardhat-deploy estimates gas for each call from the Safe before handing it over, so a call that only works after an earlier queued call (such as a setter after an upgrade) fails there. Queue those with `batch.add(safe, call)` instead.
- **Hardhat forks:** in-process forks answer calls at the fork block with the remote chain id; `executeOnFork` mines one local block first, so the Safe's hash matches execution.

### Rehearse the exact file you hand to signers

A rehearsal on a local node runs the fork's own file. To check the file written on the live network, run it on a fresh anvil fork of that chain (anvil keeps the chain id, so the file's `chainId` check passes):

```ts
import { executeBatchFileOnFork } from "@bloq/safe-ops/hardhat";

// anvil --fork-url <rpc of the file's chain>
await executeBatchFileOnFork(provider, "safe-batches/mainnet/set-fees-1-0x….json");
```

From a Hardhat script, pass `nodeProvider(hre)` as the provider. On a network with `accounts` (for example keys from `.env`), Hardhat's own provider signs every transaction locally and rejects impersonated owners (HH103). `nodeProvider` talks to the node's URL directly, and `flushSafeBatch` uses it for its own rehearsals.

The rehearsal runs at the Safe's current nonce and does not apply transactions already queued in the Safe Transaction Service, so execute or reject those first if the batch depends on them.

Core helpers work with any EIP-1193 provider:

- `classifyAccount` / `routeOwner`: EOA, EIP-7702 account, Safe or other contract, and whether a caller can act for an owner. A Safe is a proxy whose slot 0 holds an official Safe singleton (from safe-deployments); other contracts are never called, and a failed read on a real Safe throws.
- `createBatchFile` / `validateChecksum`: Transaction Builder files with the Safe UI's checksum.
- `executeOnFork`: approve with `threshold` impersonated owners, then `execTransaction`; batches go through the verified MultiSendCallOnly for the Safe's version (1.3.0 for older Safes), so they are atomic. It only runs on a local Hardhat or anvil node, and it leaves the owners impersonated.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
FORK_URL=<ethereum rpc> HEMI_FORK_URL=<hemi rpc> pnpm test:fork   # needs anvil
pnpm build
```
