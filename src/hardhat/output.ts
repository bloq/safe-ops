import path from "node:path";
import type { ProposeSafeBatchResult } from "../propose.js";

// Colors only on a terminal, and never with NO_COLOR (no-color.org); the markers carry the meaning without them.
const colors = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (colors ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const cyan = paint(36);
const dim = paint(2);
const bold = paint(1);

/** `0x6649Ddb5…7AaEA` -> `0x6649…AaEA`, the form the Safe UI shows. */
export function short(hex: string): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

const at = (p: { nonce: bigint; safeTxHash: string }) => `nonce ${p.nonce} (${short(p.safeTxHash)})`;

export interface FileLine {
  file: string;
  safe: string;
  calls: number;
}

/** A file's heading: its name, Safe and call count. */
export function heading({ file, safe, calls }: FileLine): string {
  return `${bold(path.basename(file))}   Safe ${short(safe)}   ${calls} call${calls === 1 ? "" : "s"}`;
}

/**
 * The verdict for a checked file and the notes under it. `planned` says what safe:propose would do; otherwise what
 * it did.
 */
export function verdict(result: ProposeSafeBatchResult, planned: boolean): string[] {
  const { match } = result;
  const lines = result.proposal
    ? [green(`→ proposed at ${at(result.proposal)}`)]
    : result.status === "fresh"
      ? [cyan(`→ propose at nonce ${result.nextNonce}`)]
      : match && result.status === "executed"
        ? [green(`✓ already executed at ${at(match)}`) + dim(planned ? " → delete" : ", deleted")]
        : match && !result.contested
          ? [green(`✓ already pending at ${at(match)}`) + dim(planned ? " → delete" : ", deleted")]
          : match
            ? [yellow(`✗ pending at ${at(match)}, but that nonce has competing proposals`) + dim(" → keep")]
            : [
                red(`✗ partial: shares calls with ${result.overlapping.map(at).join(", ")}`) + dim(" → keep"),
                dim(
                  result.overlapping.every(p => p.executed)
                    ? "  part of it already ran: rerun the deploy to stage what is still needed, or discard this file"
                    : "  wait for those to execute or reject them, then rerun the deploy, or discard this file",
                ),
              ];
  for (const p of result.touched) lines.push(yellow(`! ${at(p)} changed these contracts since staging`));
  return lines;
}

/** A file that is refused before any check, e.g. a fork rehearsal file on a live network. */
export function refused(reason: string): string[] {
  return [red(`✗ ${reason}`)];
}

/** A file the plan showed as kept, left alone. */
export function kept(): string[] {
  return [dim("→ kept, as planned")];
}

/** A rehearsal on a fork. */
export function rehearsed(txHash: string): string[] {
  return [green(`✓ rehearsed through the Safe in tx ${short(txHash)}`)];
}

/** Prints a file's heading and its indented lines, followed by a blank line. */
export function printFile(line: FileLine, lines: string[]): void {
  console.log([heading(line), ...lines.map(l => `  ${l}`), ""].join("\n"));
}

/** A folder heading, e.g. `safe-batches/mainnet  (3 staged)`. */
export function printFolder(dir: string, count: number): void {
  console.log(`${dim(`safe-batches/${path.basename(dir)}`)}  (${count} staged)\n`);
}
