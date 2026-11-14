/**
 * `Brain/pinned.md` under concurrent writers.
 *
 * Every pinned operation is a read-modify-write of one file. The atomic
 * rename guarantees no reader sees a torn file, and nothing about a
 * second writer that read the same "before" state: without a lock two
 * agents appending at once lose one append. These tests spawn real
 * `bun` children, the same discipline as
 * `tests/core/brain/ingest/concurrent-shared-writes.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainPinnedPath } from "../../../src/core/brain/paths.ts";
import { readPinnedContext } from "../../../src/core/brain/pinned.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const WRITERS = 4;
const PER_WRITER = 15;
const SPAWN_TIMEOUT_MS = 60_000;
/** Children spin until a shared instant so their writes really overlap. */
const BARRIER_LEAD_MS = 1_500;

let root: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-pinned-race-"));
  vault = join(root, "vault");
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function srcModule(rel: string): string {
  return join(import.meta.dir, "../../../src", rel);
}

async function runWriters(lines: readonly string[]): Promise<void> {
  const script = join(root, "pinned-writer.ts");
  writeFileSync(
    script,
    [
      "const [vault, tag, count, startAt] = process.argv.slice(2);",
      "while (Date.now() < Number(startAt)) Bun.sleepSync(1);",
      ...lines,
    ].join("\n"),
    "utf8",
  );
  const startAt = String(Date.now() + BARRIER_LEAD_MS);
  const procs = Array.from({ length: WRITERS }, (_, index) =>
    Bun.spawn([process.execPath, script, vault, `w${index}`, String(PER_WRITER), startAt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    }),
  );
  const failures: string[] = [];
  await Promise.all(
    procs.map(async (proc) => {
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) failures.push(`exit ${code}: ${err.trim()}`);
    }),
  );
  expect(failures).toEqual([]);
}

function expectedTokens(): string[] {
  const out: string[] = [];
  for (let w = 0; w < WRITERS; w++) {
    for (let i = 0; i < PER_WRITER; i++) out.push(`note-w${w}-${i}`);
  }
  return out;
}

describe("pinned context concurrent writers", () => {
  test(
    "every append from concurrent processes lands",
    async () => {
      await runWriters([
        `import { appendPinnedContext } from ${JSON.stringify(srcModule("core/brain/pinned.ts"))};`,
        "for (let i = 0; i < Number(count); i++) appendPinnedContext(vault, `note-${tag}-${i}`);",
      ]);

      const content = readPinnedContext(vault).content;
      const missing = expectedTokens().filter((token) => !content.includes(token));
      expect(missing).toEqual([]);
      expect(existsSync(`${brainPinnedPath(vault)}.lock`)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "every batch append from concurrent processes lands",
    async () => {
      await runWriters([
        `import { applyPinnedOperations } from ${JSON.stringify(srcModule("core/brain/pinned.ts"))};`,
        "for (let i = 0; i < Number(count); i++) {",
        "  applyPinnedOperations(vault, [{ op: 'append', content: `note-${tag}-${i}` }]);",
        "}",
      ]);

      const content = readPinnedContext(vault).content;
      const missing = expectedTokens().filter((token) => !content.includes(token));
      expect(missing).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
