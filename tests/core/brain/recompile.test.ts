/**
 * Targeted recompile of stale derived pages
 * (continuity-hygiene-freshness suite, Task 12; kanban t_fe490119).
 *
 * The planner walks freshness findings and produces a typed plan:
 * stale handoff notes re-derive from their recorded transcript onto
 * the SAME page path, orphaned pages stage an archive cleanup,
 * anything without a known derivation pipeline is `manual`. Dry-run
 * previews the full plan with zero writes. Unrelated pages are never
 * touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkPageFreshness } from "../../../src/core/brain/freshness.ts";
import { writeHandoffNote } from "../../../src/core/brain/handoff.ts";
import { executeRecompile, planRecompile } from "../../../src/core/brain/recompile.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

/** A minimal Claude-format transcript the session adapters can read. */
function writeTranscript(path: string, text: string): void {
  writeFileSync(
    path,
    [
      '{"type":"queue-operation","timestamp":"2026-06-10T10:00:00.000Z","sessionId":"recompile-sess"}',
      `{"parentUuid":null,"sessionId":"recompile-sess","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":${JSON.stringify(text)}},"uuid":"u1","timestamp":"2026-06-10T10:00:01.000Z"}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recompile-"));
  mkdirSync(join(vault, "Brain", "handoffs"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedStaleHandoff(): { page: string; transcript: string } {
  const transcript = join(vault, "session.jsonl");
  writeTranscript(transcript, "implemented the original feature");
  const note = writeHandoffNote(vault, {
    sessionId: "recompile-sess",
    agent: "tester",
    now: new Date("2026-06-09T12:00:00Z"),
    turns: [
      {
        turnId: "t1",
        role: "user",
        text: "implemented the original feature",
        timestamp: "2026-06-10T10:00:01Z",
      },
    ],
    sourcePaths: [transcript],
  });
  // The transcript changes after derivation -> the note goes stale.
  writeTranscript(transcript, "implemented the UPDATED feature with new scope");
  return { page: note.path, transcript };
}

describe("planRecompile", () => {
  test("maps stale handoff notes to rederive and orphans to cleanup", () => {
    const { page } = seedStaleHandoff();
    const orphan = join(vault, "Brain", "orphan.md");
    writeFileSync(
      orphan,
      '---\nsource_paths: ["gone.md"]\nsource_hashes: ["deadbeef"]\n---\nbody',
      "utf8",
    );
    const plan = planRecompile(vault);
    const byKind = new Map(plan.entries.map((entry) => [entry.kind, entry]));
    expect(byKind.get("rederive-handoff")?.page).toBe(page);
    expect(byKind.get("cleanup")?.page).toBe(orphan);
    expect(plan.entries).toHaveLength(2);
  });

  test("a stale page without a known pipeline plans as manual", () => {
    const source = join(vault, "data.txt");
    writeFileSync(source, "v1", "utf8");
    const page = join(vault, "Brain", "derived.md");
    const { computeSourceStamp, formatSourceStampFrontmatter } =
      require("../../../src/core/brain/freshness.ts") as typeof import("../../../src/core/brain/freshness.ts");
    writeFileSync(
      page,
      `---\n${formatSourceStampFrontmatter(computeSourceStamp(vault, ["data.txt"]))}\n---\nbody`,
      "utf8",
    );
    writeFileSync(source, "v2", "utf8");
    const plan = planRecompile(vault);
    expect(plan.entries[0]?.kind).toBe("manual");
  });
});

describe("executeRecompile", () => {
  test("dry-run previews and writes nothing", async () => {
    const { page } = seedStaleHandoff();
    const before = readFileSync(page, "utf8");
    const plan = planRecompile(vault);
    const result = await executeRecompile(vault, plan, { dryRun: true, agent: "tester", now: NOW });
    expect(result.dry_run).toBe(true);
    expect(result.rederived).toHaveLength(0);
    expect(readFileSync(page, "utf8")).toBe(before);
  });

  test("re-derives a stale handoff note in place and makes it fresh again", async () => {
    const { page } = seedStaleHandoff();
    const plan = planRecompile(vault);
    const result = await executeRecompile(vault, plan, { agent: "tester", now: NOW });
    expect(result.rederived).toEqual([page]);
    expect(readFileSync(page, "utf8")).toContain("UPDATED feature");
    expect(checkPageFreshness(vault, page)?.status).toBe("fresh");
  });

  test("cleanup archives the orphaned page out of its live location", async () => {
    const orphan = join(vault, "Brain", "orphan.md");
    writeFileSync(
      orphan,
      '---\nsource_paths: ["gone.md"]\nsource_hashes: ["deadbeef"]\n---\nbody',
      "utf8",
    );
    const plan = planRecompile(vault);
    const result = await executeRecompile(vault, plan, { agent: "tester", now: NOW });
    expect(result.archived).toHaveLength(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(result.archived[0]!)).toBe(true);
    expect(result.archived[0]).toContain(".snapshots");
  });
});
