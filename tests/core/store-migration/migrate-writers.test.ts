/**
 * Several writer processes with writes in flight when the migration
 * starts (task 2.3): the freeze stops them, the settle period and the
 * delta pass drain what was in flight, and every write that succeeded is
 * in the store. Three cold child processes, so the test is kept to one.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench("osb-migrate-writers-");
});
afterEach(() => bench.cleanup());

const WRITER = join(import.meta.dir, "fixtures", "signal-writer.ts");
const NAMES = ["wa", "wb", "wc"];

async function waitFor(check: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const poll = async (): Promise<void> => {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the writers");
    await Bun.sleep(50);
    return poll();
  };
  return poll();
}

test("writes in flight when the migration starts are drained and none is lost", async () => {
  const ready = NAMES.map((name) => join(bench.fx.parent, `${name}.ready`));
  const out = NAMES.map((name) => join(bench.fx.parent, `${name}.jsonl`));
  // No pipes: the migration below is synchronous, so nothing would drain
  // them; each child appends its rows to a file instead.
  const children = NAMES.map((name, i) =>
    Bun.spawn([process.execPath, "run", WRITER, bench.vault, name, ready[i]!, out[i]!], {
      env: { ...process.env, ...bench.env },
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  try {
    await waitFor(() => ready.every((path) => existsSync(path)), 60_000);
    const result = runMigration(bench.vault, { settleMs: 500 });
    expect(result.ok).toBe(true);
    const codes = await Promise.all(children.map((c) => c.exited));
    const outputs = out.map((path) => readFileSync(path, "utf8"));
    expect(codes).toEqual([0, 0, 0]);

    const written = outputs
      .flatMap((text) => text.trim().split("\n"))
      .map((line) => JSON.parse(line) as { ok?: string; refused?: boolean })
      .flatMap((row) => (row.ok !== undefined ? [row.ok] : []));
    expect(written.length).toBeGreaterThanOrEqual(NAMES.length);
    for (const text of outputs) expect(text).toContain('"refused":true');

    const byKey = bench.byKey();
    for (const path of written) {
      const key = relative(bench.vault, path).split(sep).join("/");
      expect([key, byKey.get(key)?.[0]?.kind]).toEqual([key, "signal"]);
    }
  } finally {
    for (const child of children) child.kill();
  }
}, 120_000);
