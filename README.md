# @bloq/safe-ops

Stage owner transactions for Safe multisigs as Safe Transaction Builder files, rehearse those files on a fork exactly as the Safe will execute them, and propose them to the Safe Transaction Service.

## Usage with hardhat-deploy

```ts
import { proposeStagedSafeBatches, stageSafeTx } from "@bloq/safe-ops/hardhat";

// In a deploy script: runs directly when hardhat-deploy can sign for `owner`, otherwise stages it for the Safe.
await stageSafeTx(hre, () => hre.deployments.execute("Vault", { from: owner }, "setFee", 100));

// Or, if the script already calls catchUnknownSigner itself:
const unsigned = await hre.deployments.catchUnknownSigner(execute(/* ... */));
await stageSafeTx(hre, unsigned);

// In the last deploy script (runAtTheEnd): propose what was staged, or rehearse it on a fork.
const func: DeployFunction = async hre => {
  await proposeStagedSafeBatches(hre);
};
```

**Staging.** Each run stages into one Transaction Builder file per Safe, written after every call, in `safe-batches/<network>/<timestamp>-<safe>.json` (e.g. `20261001T153000Z-0xd1de3f.json`). The timestamp is the run's first staged call, so a long run is still one file. Inspect a file, or import it in the Safe UI (Apps → Transaction Builder), but never both import it and propose it.

**Proposing** (`proposeStagedSafeBatches`) handles this run's files, or every staged file for the network when the run staged nothing (e.g. a later run of just the last script); older files are left for later and named in the log. A file staged on a fork is never proposed. Each file is checked against its Safe first:

| File                                                                      | Result                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Nothing pending or executed shares its calls                              | Proposed exactly as written, after the pending proposals; file deleted                                        |
| One pending proposal makes exactly its calls                              | Not proposed again; file deleted (kept if that nonce has competing proposals)                                 |
| An execution since staging made exactly its calls (including a UI import) | Not proposed; file deleted                                                                                    |
| Proposals share some of its calls                                         | Not proposed; file kept. Wait for those to execute or reject them, then rerun the deploy, or discard the file |

It also warns when something executed since staging changed the file's contracts without sharing its calls, so a rerun can pick that up.

**Confirmation.** Files staged by the same deploy run are proposed without asking: running the deploy is the decision. Anything else (explicit files, or older staged files when the run staged nothing) is first shown as a plan, the same as `safe:list`, followed by `Propose N file(s) and delete M? [y/N]`. Without a terminal (CI, piped output) it refuses unless `yes` is passed (`--yes` for the task). Each file is checked again right before it is proposed, in case the plan went stale. Only the files the plan counted are acted on. A refused or failed file (fork file, edited, wrong chain, service error) doesn't stop other Safes' files, but holds that Safe's later files, which would otherwise take its nonce or jump ahead of it; the run fails at the end, naming each file and why.

**On a local node** (Hardhat or Anvil by `web3_clientVersion`), or a network named `hardhat` or `localhost`, nothing is ever proposed: the files are rehearsed through the real Safe instead, and kept. Local files are named `<safe>.json`, replaced by each run, and marked `FORK REHEARSAL, DO NOT SIGN`; a fork run rehearses only what it staged itself.

- **Proposer:** defaults to Hardhat's `deployer` account, signing through Hardhat's provider. Pass `signer` for another one: any object with `address` and `signMessage({ message: { raw } })`, such as a viem account of any version, or an ethers wallet wrapped as `{ address: w.address, signMessage: ({ message }) => w.signMessage(getBytes(message.raw)) }` (ethers v6; v5 uses `utils.arrayify`). It must be an owner or a proposer of the Safe (owners add proposers in the Safe UI settings). The signature is checked against that address before anything is posted.
- **Service:** looked up per chain from Safe's config service; pass `txServiceUrl` for another one. Either way it must report the node's chain. api.safe.global needs an `apiKey` (developer.safe.global). Requests time out after 30 seconds; a proposal that timed out may still have landed, and the next run finds it pending.
- **Duplicates while staging:** a call identical to the latest call staged for the same contract is dropped with a warning, since deploy scripts check executed state and can't see staged calls. `x.update(1), x.update(2), x.update(1)` keeps all three. A deliberate repeat, such as a second `harvest()`, needs `{ allowDuplicate: true }`.
- **Targets must have code:** calldata to an address without code does nothing on chain, so proposals and rehearsals refuse it unless `allowCallsWithoutCode` is set.
- **Impersonated Safes:** when the node impersonates a Safe (hardhat-deploy's `autoImpersonate`, or an impersonation on the node), its calls run directly and nothing is staged; `stageSafeTx` warns. Set `HARDHAT_DEPLOY_NO_IMPERSONATION=1` (or `autoImpersonate: false`).
- **Calls that depend on each other:** hardhat-deploy estimates gas for each call from the Safe first, so a call that only works after an earlier staged call (a setter after an upgrade) fails there. Stage those as `stageSafeTx(hre, { from: safe, to, data })`.

### Tasks (optional)

```ts
// hardhat.config.ts
import { registerSafeTasks } from "@bloq/safe-ops/hardhat";
registerSafeTasks(task);
```

```sh
npx hardhat safe:list --network mainnet                      # and what safe:propose would do with each
npx hardhat safe:rehearse --network hardhat --from mainnet   # forks mainnet in-process, runs the exact files
npx hardhat safe:propose --network mainnet [--file …] [--yes]   # shows the plan, asks before acting
npx hardhat safe:discard --network mainnet --file …
```

`safe:list` on a live network runs the same status check as `safe:propose` and says what would happen to each file (proposed at which nonce, deleted as pending or executed, or kept as partial), without doing it. `registerSafeTasks(task, { apiKey, txServiceUrl, signer })` sets the service and proposer for the tasks (`apiKey` defaults to `SAFE_API_KEY`). `safe:rehearse` resets the in-process Hardhat network (it refuses any other) to a fork of `--from`'s URL, and checks each file is for that chain. Hardhat can't fork every chain (Hemi, for one); use Anvil and `rehearseSafeBatch` there. The rehearsal runs at the Safe's current nonce without the proposals already pending, so execute or reject those first if the batch depends on them.

`nodeProvider(hre)` is the node itself for an HTTP network: on a network with `accounts` (keys from `.env`), Hardhat's own provider signs locally and rejects impersonated owners (HH103). Rehearsals use it.

## Core, without Hardhat

Everything takes an EIP-1193 provider and plain data; nothing reads files.

- `createSafeBatch`, `validateSafeBatch`, `safeBatchCalls`: Transaction Builder files with the Safe UI's checksum.
- `rehearseSafeBatch(provider, batch)`: runs a batch through its Safe on a local Hardhat or Anvil fork. `executeOnFork(provider, safe, calls)` does the same for raw calls: `threshold` impersonated owners approve, then `execTransaction`; batches go through the verified MultiSendCallOnly for the Safe's version (1.3.0 for older Safes), so they are atomic.
- `resolveTxService`, `readSafeQueue`, `safeBatchStatus`, `proposeSafeBatch(provider, service, signer, batch)`: the checks and proposal described above.
- `decodeMultiSendCall`: the calls inside a `multiSend(bytes)` payload, e.g. a batch's data copied from the Safe UI.
- `classifyAccount`, `readSafe`, `routeOwner`: EOA, EIP-7702 account, Safe or other contract, and whether a caller can act for an owner. A Safe is a proxy whose slot 0 holds an official Safe singleton (from safe-deployments); other contracts are never called. `isProposer` plugs into `routeOwner`: `routeOwner(provider, owner, caller, { isProposer: (safe, a) => isProposer(service, safe, a) })`.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
FORK_URL=<ethereum rpc> HEMI_FORK_URL=<hemi rpc> pnpm test:fork   # needs anvil
pnpm build
```
