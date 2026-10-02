import { Address } from 'viem';
import { E as Eip1193Provider, P as ProposalSigner, a as ProposeSafeBatchResult, F as ForkExecution, S as SafeBatch } from '../propose-CubJ1x4C.cjs';

interface AddOptions {
    /** Queue the call even if it repeats the latest call to the same contract, e.g. a deliberate second mint. */
    allowDuplicate?: boolean;
}

interface UnknownSignerTx {
    from: string;
    to?: string;
    value?: string;
    data?: string;
}
interface HardhatDeployRuntime {
    network: {
        name: string;
        provider: Eip1193Provider;
        config?: object;
    };
    config?: {
        paths: {
            root: string;
        };
        networks?: Record<string, object>;
    };
    deployments: {
        catchUnknownSigner(action: Promise<unknown> | (() => Promise<unknown>), options?: {
            log?: boolean;
        }): Promise<UnknownSignerTx | null>;
    };
    getNamedAccounts?(): Promise<Record<string, string>>;
}
/** Which Safe Transaction Service to use, for staging, proposing and the tasks. */
interface SafeServiceOptions {
    /** Defaults to the `SAFE_API_KEY` environment variable; api.safe.global requires one. */
    apiKey?: string;
    /** A service instead of Safe's own for the chain: one URL, or URLs by chain id (e.g. for chains Safe doesn't serve). */
    txServiceUrl?: string | Record<number, string>;
}
interface StageOptions extends AddOptions, SafeServiceOptions {
}
/**
 * Stages an owner transaction for its Safe. Pass a hardhat-deploy action (`() => execute(...)`): it runs directly
 * when hardhat-deploy can sign for `from`, and is staged when it can't. Or pass what `catchUnknownSigner` returned
 * (`null` stages nothing). Each run stages into one file per Safe, written after every call:
 * `safe-batches/<network>/<timestamp>-<safe>.json` (on a local node, `<safe>.json`, marked as a fork rehearsal).
 * On a live network, a call already pending for the Safe is skipped, so the file holds only what is left to propose.
 * Returns true when the transaction is left to the Safe, including when the same call is already staged or pending.
 * The service options are read on the first call for each Safe.
 */
declare function stageSafeTx(hre: HardhatDeployRuntime, txOrAction: UnknownSignerTx | null | Promise<unknown> | (() => Promise<unknown>), options?: StageOptions): Promise<boolean>;
interface ProposeStagedOptions extends SafeServiceOptions {
    /** An owner or proposer of the Safes. Defaults to Hardhat's `deployer` account, signing with `personal_sign`. */
    signer?: ProposalSigner;
    /** Staged files to handle. Defaults to this run's files, or every staged file for the network if none. */
    files?: string[];
    /** The app the Safe UI names as each proposal's origin. Defaults to `safe-ops`. */
    origin?: string;
    allowCallsWithoutCode?: boolean;
    /**
     * Skip the confirmation for files this run did not stage (explicit `files`, or older staged files). Without it,
     * those are only proposed after a yes on a terminal, and refused without one (e.g. in CI).
     */
    yes?: boolean;
    /** Asks the question; defaults to a [y/N] prompt on the terminal. */
    confirm?: (question: string) => Promise<boolean>;
}
interface StagedResult {
    file: string;
    safe: Address;
    /** Set on a live network: what the Safe service said, and the proposal if one was made. */
    status?: ProposeSafeBatchResult;
    /** Set on a local node: the rehearsal through the Safe. */
    execution?: ForkExecution;
    /** Whether the file was deleted: once proposed, pending or executed, it must not be imported again. */
    removed: boolean;
    /** Why the file was not handled: refused (fork file, edited, wrong chain) or failed (e.g. the service said no). */
    failure?: string;
}
/**
 * Handles staged files at the end of a deploy, or later. On a live network each file is checked against its Safe
 * (see `safeBatchStatus`) and proposed exactly as written when fresh, then deleted; a file whose calls are already
 * pending or executed is deleted without proposing; a file that partly overlaps them is kept and reported. Files this
 * run did not stage are first shown as a plan and need a yes (or `yes`). On a local node, or a network named `hardhat`
 * or `localhost`, files are rehearsed through the Safe instead and kept. A file that is refused or fails doesn't stop
 * the others; the call throws at the end if any did.
 */
declare function proposeStagedSafeBatches(hre: HardhatDeployRuntime, options?: ProposeStagedOptions): Promise<StagedResult[]>;
interface StagedSafeBatch {
    file: string;
    batch: SafeBatch;
}
/** Staged files for a network (default: the current one), oldest first. */
declare function listStagedSafeBatches(hre: HardhatDeployRuntime, network?: string): Promise<StagedSafeBatch[]>;
/**
 * The files this run has staged so far, e.g. to record them or to stop the deploy once something is left to the Safe.
 * Empty once `proposeStagedSafeBatches` has handled them.
 */
declare function stagedFilesThisRun(hre: HardhatDeployRuntime): Promise<string[]>;
/** Deletes a staged file, e.g. one that should never be proposed. */
declare function discardSafeBatch(file: string): Promise<void>;
/**
 * The node itself for an HTTP network such as `localhost`. Hardhat's own provider for a network with `accounts`
 * (e.g. keys from .env) signs every `eth_sendTransaction` locally and rejects impersonated senders (HH103).
 */
declare function nodeProvider(hre: HardhatDeployRuntime): Eip1193Provider;
interface TaskArgs {
    from?: string;
    file?: string;
    yes?: boolean;
}
/** The part of Hardhat's `task()` builder the Safe tasks use, so this package doesn't import Hardhat. */
interface TaskDefinition {
    addOptionalParam(name: string, description?: string): TaskDefinition;
    addFlag(name: string, description?: string): TaskDefinition;
    setAction(action: (args: TaskArgs, hre: HardhatDeployRuntime) => Promise<unknown>): TaskDefinition;
}
interface SafeTasksOptions extends SafeServiceOptions {
    /** The proposer for `safe:propose`. Defaults to Hardhat's `deployer` account. */
    signer?: (hre: HardhatDeployRuntime) => ProposalSigner | Promise<ProposalSigner>;
}
/**
 * Registers `safe:list`, `safe:rehearse`, `safe:propose` and `safe:discard`. In hardhat.config, pass Hardhat's
 * `task`: `registerSafeTasks(task)`.
 */
declare function registerSafeTasks(task: (name: string, description?: string) => TaskDefinition, options?: SafeTasksOptions): void;

export { type HardhatDeployRuntime, type ProposeStagedOptions, type SafeServiceOptions, type SafeTasksOptions, type StageOptions, type StagedResult, type StagedSafeBatch, type TaskDefinition, type UnknownSignerTx, discardSafeBatch, listStagedSafeBatches, nodeProvider, proposeStagedSafeBatches, registerSafeTasks, stageSafeTx, stagedFilesThisRun };
