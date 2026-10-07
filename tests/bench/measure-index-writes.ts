#!/usr/bin/env bun
/**
 * Measure how many bytes an incremental index run writes, per pass.
 *
 *   bun run tests/bench/measure-index-writes.ts <vault> [changed-notes=200 | largest:N]
 *
 * Copies the vault's Markdown (and `Brain/_brain.yaml`) to a temp dir,
 * builds an index there, then runs three incremental passes and prints the
 * bytes each one wrote, split by the store methods that do the writing:
 *   1. no change at all,
 *   2. `changed-notes` notes edited (the catch-up a long-idle index meets),
 *      or with `largest:N` the N largest notes (an append-only daily log that
 *      grows all day is the note a frequent background run meets most),
 *   3. no change again.
 *
 * Linux only: the numbers are `write_bytes` deltas from `/proc/self/io`, the
 * bytes this process caused to be sent to storage. The source vault is only
 * read. Development tool for the index-freshness work; prints, never writes
 * outside its temp dir.
 */
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { Store } from "../../src/core/search/store.ts";

function writeBytes(): number {
  const m = /write_bytes:\s+(\d+)/.exec(readFileSync("/proc/self/io", "utf8"));
  if (m === null) throw new Error("/proc/self/io has no write_bytes (Linux only)");
  return Number(m[1]);
}

const PASSES = [
  "replaceDocumentChunks",
  "replaceLinks",
  "deleteDocument",
  "resolveLinkTargets",
  "resolveAliasTargets",
  "recomputeRelationConstraintFlags",
  "setState",
  "close",
] as const;

const tally = new Map<string, number>();
const proto = Store.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of PASSES) {
  const original = proto[name];
  if (typeof original !== "function") continue;
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const before = writeBytes();
    const result = original.apply(this, args);
    const settle = (): void => {
      tally.set(name, (tally.get(name) ?? 0) + (writeBytes() - before));
    };
    if (result instanceof Promise) return result.finally(settle);
    settle();
    return result;
  };
}

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1).padStart(8);
}

async function measured(label: string, vault: string): Promise<void> {
  tally.clear();
  const before = writeBytes();
  const t0 = performance.now();
  const stats = await indexVault(resolveSearchConfig({ vault }));
  const total = writeBytes() - before;
  const ms = Math.round(performance.now() - t0);
  console.log(
    `\n${label}: ${mb(total)} MB in ${ms} ms ` +
      `(added ${stats.added}, updated ${stats.updated}, deleted ${stats.deleted}, ` +
      `link resolution ${stats.linkResolutionSkipped ? "skipped" : "ran"})`,
  );
  let counted = 0;
  for (const [name, bytes] of [...tally].toSorted((a, b) => b[1] - a[1])) {
    counted += bytes;
    console.log(`  ${name.padEnd(34)}${mb(bytes)} MB`);
  }
  console.log(`  ${"(elsewhere)".padEnd(34)}${mb(total - counted)} MB`);
}

const [source, changedArg] = process.argv.slice(2);
if (source === undefined) {
  console.error(
    "usage: bun run tests/bench/measure-index-writes.ts <vault> [changed-notes=200 | largest:N]",
  );
  process.exit(2);
}
const largest = changedArg?.startsWith("largest:") === true;
const changed = Number(largest ? changedArg!.slice("largest:".length) : (changedArg ?? "200"));

const work = mkdtempSync(join(tmpdir(), "osb-measure-writes-"));
const vault = join(work, "vault");
try {
  cpSync(source, vault, {
    recursive: true,
    filter: (src) =>
      !relative(source, src).startsWith(".") &&
      (!src.includes(".") || src.endsWith(".md") || src.endsWith("_brain.yaml")),
  });
  console.log(`copied ${source} -> ${vault}; building the index...`);
  await indexVault(resolveSearchConfig({ vault }));

  await measured("1. no change", vault);

  const glob = new Bun.Glob("**/*.md");
  const all = [...glob.scanSync({ cwd: vault })].toSorted();
  const notes = largest
    ? all
        .map((n) => ({ n, size: Bun.file(join(vault, n)).size }))
        .toSorted((a, b) => b.size - a.size)
        .slice(0, changed)
        .map((x) => x.n)
    : all.slice(0, changed);
  for (const note of notes) appendFileSync(join(vault, note), "\n<!-- measure -->\n");
  await measured(`2. ${notes.length} ${largest ? "largest " : ""}notes edited`, vault);

  await measured("3. no change again", vault);
} finally {
  rmSync(work, { recursive: true, force: true });
}
