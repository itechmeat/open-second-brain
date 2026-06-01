import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-procedural-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "skills", "release"), { recursive: true });
  writeFileSync(
    join(vault, "skills", "release", "SKILL.md"),
    [
      "---",
      "triggers: [release]",
      "tags: [ops]",
      "permissions: [read]",
      "source: cli-test",
      "version: 1",
      "---",
      "# Release skill",
    ].join("\n") + "\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain procedural learning verbs wire end-to-end", async () => {
  seedContinuity(vault);

  const learned = await runCli([
    "brain",
    "skill-proposals",
    "learn",
    "--vault",
    vault,
    "--json",
    "--min-support",
    "3",
  ]);
  expect(learned.returncode).toBe(0);
  const learnedJson = JSON.parse(learned.stdout);
  expect(learnedJson.created.length).toBeGreaterThanOrEqual(1);

  const listed = await runCli(["brain", "skill-proposals", "list", "--vault", vault, "--json"]);
  expect(listed.returncode).toBe(0);
  const listJson = JSON.parse(listed.stdout);
  expect(listJson.total).toBeGreaterThanOrEqual(1);
  const slug = listJson.proposals[0]?.slug;
  expect(typeof slug).toBe("string");

  const accepted = await runCli([
    "brain",
    "skill-proposals",
    "accept",
    slug,
    "--vault",
    vault,
    "--json",
  ]);
  expect(accepted.returncode).toBe(0);

  const rec = await runCli(["brain", "procedural-memory", "reconcile", "--vault", vault, "--json"]);
  expect(rec.returncode).toBe(0);
  const recJson = JSON.parse(rec.stdout);
  expect(recJson.total).toBeGreaterThanOrEqual(1);

  const mem = await runCli(["brain", "procedural-memory", "list", "--vault", vault, "--json"]);
  expect(mem.returncode).toBe(0);
  const memJson = JSON.parse(mem.stdout);
  expect(memJson.total).toBeGreaterThanOrEqual(1);

  const id = memJson.entries[0]?.id;
  expect(typeof id).toBe("string");
  const mark = await runCli([
    "brain",
    "procedural-memory",
    "mark-used",
    id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(mark.returncode).toBe(0);

  const learnRecurrence = await runCli([
    "brain",
    "recurrence",
    "learn",
    "--hash",
    "abc123",
    "--scope",
    "project-a",
    "--source",
    "src-1",
    "--vault",
    vault,
    "--json",
  ]);
  expect(learnRecurrence.returncode).toBe(0);

  const showRecurrence = await runCli([
    "brain",
    "recurrence",
    "show",
    "abc123",
    "--vault",
    vault,
    "--json",
  ]);
  expect(showRecurrence.returncode).toBe(0);
  const recShowJson = JSON.parse(showRecurrence.stdout);
  expect(recShowJson.supportCount).toBe(1);
});

function seedContinuity(vaultPath: string): void {
  for (const row of [
    ["2026-06-01T08:00:00Z", "triage_inbox"],
    ["2026-06-02T08:00:00Z", "triage_inbox"],
    ["2026-06-03T08:00:00Z", "triage_inbox"],
    ["2026-06-01T08:05:00Z", "prepare_release_notes"],
    ["2026-06-02T08:05:00Z", "prepare_release_notes"],
    ["2026-06-03T08:05:00Z", "prepare_release_notes"],
  ] as const) {
    appendContinuityRecord(vaultPath, {
      kind: "session_turn",
      createdAt: row[0],
      sourceRefs: [{ id: `src-${row[0]}` }],
      payload: {
        action: row[1],
        summary: `Investigate issue ${row[0]}`,
      },
    });
  }
}
