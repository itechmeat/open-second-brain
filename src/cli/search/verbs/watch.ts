/**
 * `o2b search watch` — long-running file-watcher (Unit 3): watch the vault
 * for `.md` edits and incrementally re-index after a quiet window. Reuses
 * the existing incremental `indexVault` (mtime/hash fastpath skips
 * unchanged files), so a debounced flush only does work for the files that
 * actually changed. A single-flight guard prevents overlapping passes; the
 * command runs until SIGINT/SIGTERM and shuts the watcher down cleanly.
 */

import { watch, type FSWatcher } from "node:fs";

import { SafeguardAbortError } from "../../../core/brain/safeguard.ts";
import { indexVault } from "../../../core/search/index.ts";
import { IndexWatchPlanner } from "../../../core/search/index-watch.ts";
import { IndexWatchRunner } from "../../../core/search/watch-runner.ts";
import { canonicalNotePath } from "../../../core/path-safety.ts";
import { CliError, flagBoolean, parseFlags, resolveConfig, VAULT_FLAGS } from "../helpers.ts";

/** Floor on the flush timer so a zero debounce still yields to the loop. */
const MIN_FLUSH_INTERVAL_MS = 50;

export async function cmdSearchWatch(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    embeddings: { type: "boolean" },
    "debounce-ms": { type: "string", default: "800" },
  });
  const cfg = resolveConfig(flags);
  const debounceMs = Number(flags["debounce-ms"]);
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new CliError(`--debounce-ms must be a non-negative number, got ${flags["debounce-ms"]}`);
  }
  const planner = new IndexWatchPlanner({ debounceMs });

  let watcher: FSWatcher;
  try {
    watcher = watch(cfg.vault, { recursive: true, persistent: true });
  } catch (e) {
    // Fail loudly, not as a silent no-op: recursive fs.watch is not
    // available on every platform/filesystem.
    throw new CliError(
      `cannot start a recursive watch on ${cfg.vault}: ${e instanceof Error ? e.message : String(e)}. ` +
        "Recursive fs.watch is unsupported here; schedule `o2b search index` on a timer instead.",
    );
  }

  // Single-flight + graceful-shutdown coordinator (Indexer Durability
  // suite). A SIGINT/SIGTERM aborts the in-flight pass at its next file
  // boundary and waits for it to settle (bounded by the configured
  // grace window) before exiting, so a signal never kills a run
  // mid-write. indexInto closes its store in a finally, so the aborted
  // pass still consolidates the WAL and releases the writer lock.
  const runner = new IndexWatchRunner({
    graceMs: cfg.shutdownGraceMs,
    index: async (signal): Promise<void> => {
      const due = planner.take(Date.now());
      if (due.length === 0) return;
      try {
        const stats = await indexVault(cfg, {
          embeddings: flagBoolean(flags, "embeddings"),
          signal,
        });
        process.stderr.write(
          `synced ${due.length} change(s): +${stats.added} ~${stats.updated} =${stats.unchanged}` +
            (stats.errors.length > 0 ? ` (${stats.errors.length} error(s))` : "") +
            "\n",
        );
      } catch (e) {
        // An abort is the expected stop on shutdown - let the runner
        // observe it. Any other failure must not kill the watcher.
        if (e instanceof SafeguardAbortError) throw e;
        process.stderr.write(`index sync failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  });

  watcher.on("error", (e) => {
    process.stderr.write(`watch error: ${e instanceof Error ? e.message : String(e)}\n`);
  });
  watcher.on("change", (_eventType, filename) => {
    if (typeof filename !== "string") return;
    if (!filename.toLowerCase().endsWith(".md")) return;
    planner.record(canonicalNotePath(filename), Date.now());
  });

  const timer = setInterval(
    () => {
      void runner.flush();
    },
    Math.max(MIN_FLUSH_INTERVAL_MS, debounceMs),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = async (): Promise<void> => {
      if (runner.isStopped) return;
      clearInterval(timer);
      watcher.close();
      // Drain the in-flight pass (aborted) within the grace window.
      // A second SIGINT/SIGTERM bypasses this (process.once consumed
      // the first), falling back to the default terminate = force exit.
      await runner.shutdown();
      process.stderr.write("watch stopped\n");
      resolve(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.stderr.write(
      `watching ${cfg.vault} for .md changes (debounce ${debounceMs}ms); Ctrl-C to stop\n`,
    );
  });
}
