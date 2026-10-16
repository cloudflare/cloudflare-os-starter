// Running several commands at once without interleaving their output, for `cfos check` / `cfos
// deploy` (commands/deploy.ts).
//
// The patterns are upstream's release build (cloudflare-os/scripts/release/build-release.ts):
// a bounded pool that awaits every task it started, and each command's output captured and printed
// as one labelled block once it finishes, because a handful of wrangler and vp logs interleaved line
// by line would be unreadable.

import { spawn } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { killProcessTreeEscalating } from "@gadgets/scripts/kill-process-tree";

/**
 * How many builds to run at once: one per CPU, at ~2 GiB of memory each, and never fewer than two.
 * The budget is upstream's `vp run` concurrency (cloudflare-os/scripts/vp/concurrency.ts), which is
 * not exported: single-threaded `tsc` and a `vite build` each want about that much.
 */
export function concurrencyLimit(): number {
  return Math.max(2, Math.min(availableParallelism(), Math.floor(totalmem() / 2 ** 31)));
}

/**
 * Applies `task` to every item, with at most `limit` running at a time, and returns the results in
 * the input's order.
 *
 * Every task runs even if an earlier one rejects. If any did, this rejects once they have all
 * settled: with that error if there was exactly one, or an `AggregateError` over them otherwise.
 * An aborted `signal` stops further items from starting; tasks already running are still awaited,
 * and with no task failure this rejects with `signal.reason`.
 *
 * Copied from upstream's `mapConcurrent` (cloudflare-os/scripts/map-concurrent.ts), which is not
 * among `@gadgets/scripts`' exports.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = Array.from({ length: items.length });
  const failures: unknown[] = [];
  // A bare `next++` is a safe claim: JS runs it to completion before any other runner resumes.
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      if (signal?.aborted) break;
      try {
        results[i] = await task(items[i], i);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(runners);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} of ${items.length} tasks failed`);
  }
  if (signal?.aborted) throw signal.reason;
  return results;
}

/** Thrown by {@link runCaptured} for a command it cancelled, so callers can leave it out of a summary. */
export class CancelledError extends Error {}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the command's whole process tree when aborted. */
  signal?: AbortSignal;
  /** Where the finished block goes. */
  log: (text: string) => void;
}

/**
 * Runs a command to completion with its stdout and stderr captured, then logs them as one block
 * under `----- <label> (<seconds>s) -----`. Rejects with an error naming the label when it exits
 * non-zero, and with a {@link CancelledError} when `signal` killed it.
 *
 * With its output piped the command sees no terminal, so nothing it runs can prompt.
 */
export function runCaptured(label: string, command: string, argv: string[], options: RunOptions): Promise<void> {
  const { signal, log } = options;
  if (signal?.aborted) return Promise.reject(new CancelledError(`cancelled: ${label}`));
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    // Whether the abort below signalled this command, as opposed to it failing by itself first.
    let killedByUs = false;
    // `signal` is not handed to spawn: Node's own kills only the direct child -- `pnpm`, a wrapper,
    // here -- and leaves the `vp`/`wrangler`/esbuild processes doing the work running.
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

    const onAbort = () => {
      killedByUs = true;
      if (child.pid === undefined) return;
      // Escalating, because `pnpm` ignores SIGTERM while a child of its own is still alive. The
      // streams are let go afterwards so a descendant the tree walk missed, still holding the pipe,
      // cannot keep this promise pending.
      void killProcessTreeEscalating(child.pid).catch(() => {}).then(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (killedByUs) {
        log(`cancelled: ${label} (${elapsed}s)`);
        reject(new CancelledError(`cancelled: ${label}`));
        return;
      }
      const text = Buffer.concat(output).toString("utf8").trimEnd();
      log(`\n----- ${label} (${elapsed}s) -----${text ? `\n${text}` : ""}`);
      if (error) reject(error);
      else resolve();
    };
    // `error` instead of `close` when the command cannot be spawned at all.
    child.on("error", (error) => finish(error));
    child.on("close", (code, killSignal) => {
      finish(code === 0 ? undefined : new Error(`${label} failed (exit ${killSignal ?? code}). Its output is above.`));
    });
  });
}
