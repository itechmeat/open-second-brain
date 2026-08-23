/**
 * Session-import resume on the ingest checkpoint substrate
 * (nothing-writes-silently, Unit F).
 *
 * Resume is not new in this codebase: `ingest/checkpoint.ts` has shipped
 * plan-scoped, atomic, vault-identity-asserted resume for the source-ingest
 * lane. What was missing is the sessions lane, whose only idempotency was a
 * dedup index rebuilt from scratch on every run - re-do-and-discard, so an
 * interrupted 50k-turn import re-read and re-hashed everything. This suite
 * pins the extension:
 *
 *   1. A boundary written by the checkpoint writer reads back with the turn
 *      count, the session file it belongs to, and the file identity it was
 *      taken against.
 *   2. An unknown `schema_version` and corrupt bytes are refused BY NAME -
 *      never a silent reset, which would masquerade completed turns as
 *      pending and re-hash them all.
 *   3. `OSB_INGEST_NO_CHECKPOINT` makes record and read inert, the same env
 *      var and the same semantics as the ingest lane; two spellings of the
 *      opt-out would be two things to remember.
 *   4. The checkpoint id is scoped to the import's filters, so a run that
 *      asks a different question of the same file never resumes off another
 *      run's boundary.
 *   5. An interrupted import resumes AT the boundary: the turns before it
 *      are not re-extracted, proved by deleting a signal one of those turns
 *      wrote and showing the resumed run does not write it again.
 *   6. A completed applied import clears its checkpoint, exactly as the
 *      ingest lane drops a drained plan's.
 *   7. A dry run records nothing, and a checkpoint taken against a session
 *      file that no longer matches is discarded and SAID so rather than
 *      silently resuming at a turn boundary that has moved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import {
  clearSessionCheckpoint,
  computeSessionHeadHash,
  computeSessionImportId,
  readSessionCheckpoint,
  recordSessionProgress,
  SESSION_CHECKPOINT_TURN_INTERVAL,
  sessionCheckpointPath,
} from "../../../../src/core/brain/sessions/checkpoint.ts";
import { RECONCILIATION_OUTCOME } from "../../../../src/core/reconciliation-report.ts";

let vault: string;

const NOW = new Date("2026-08-15T10:00:00Z");
const AGENT = "@t";
/** Enough turns to cross the boundary interval more than once. */
const TURNS = SESSION_CHECKPOINT_TURN_INTERVAL * 2 + 100;
const EARLY_TURN = Math.floor(SESSION_CHECKPOINT_TURN_INTERVAL / 2);
const LATE_TURN = SESSION_CHECKPOINT_TURN_INTERVAL + 50;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-resume-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "config.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  delete process.env["OSB_INGEST_NO_CHECKPOINT"];
});

function marker(topic: string, principle: string): string {
  return `@osb feedback positive topic=${topic} principle="${principle}"`;
}

/**
 * A Claude-format transcript of `count` ASSISTANT turns. Assistant on
 * purpose: fact extraction runs over user turns only, so the only writes
 * this fixture can produce are the two markers it plants, which is what
 * makes the resume assertions below unambiguous.
 */
function writeTranscript(
  name: string,
  count: number,
  markers: ReadonlyMap<number, string>,
): string {
  const path = join(vault, name);
  const lines: string[] = [];
  for (let turn = 1; turn <= count; turn++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        parentUuid: null,
        entrypoint: "cli",
        uuid: `u${turn}`,
        timestamp: "2026-08-15T09:00:00.000Z",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: markers.get(turn) ?? `turn ${turn}` }],
        },
      }),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function standardTranscript(name = "session.jsonl"): string {
  return writeTranscript(
    name,
    TURNS,
    new Map([
      [EARLY_TURN, marker("resume-early", "The early rule")],
      [LATE_TURN, marker("resume-late", "The late rule")],
    ]),
  );
}

function inboxFiles(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter((n) => n.endsWith(".md"));
}

function headHashOf(path: string): string {
  return computeSessionHeadHash(readFileSync(path, "utf8").split("\n")[0] ?? "");
}

/** The checkpoint an interrupted run would have left at `turnsCompleted`. */
function seedCheckpoint(path: string, importId: string, turnsCompleted: number): boolean {
  return recordSessionProgress(
    vault,
    importId,
    {
      sessionFile: path,
      headHash: headHashOf(path),
      bytes: statSync(path).size,
      turnsCompleted,
    },
    NOW,
  );
}

describe("the session-import checkpoint substrate", () => {
  test("a recorded boundary reads back with its turn count and file identity", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    expect(seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL)).toBe(true);

    const cp = readSessionCheckpoint(vault, importId);
    expect(cp?.turns_completed).toBe(SESSION_CHECKPOINT_TURN_INTERVAL);
    expect(cp?.session_file).toBe(path);
    expect(cp?.head_hash).toBe(headHashOf(path));
    expect(cp?.bytes).toBe(statSync(path).size);
  });

  test("re-recording the same boundary is a no-op rather than a rewrite", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    expect(seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL)).toBe(true);
    expect(seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL)).toBe(false);
  });

  test("an unknown schema_version is refused by name, never silently reset", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);
    const file = sessionCheckpointPath(vault, importId);
    writeFileSync(file, JSON.stringify({ schema_version: 99, turns_completed: 1 }), "utf8");
    expect(() => readSessionCheckpoint(vault, importId)).toThrow(/schema_version/);
  });

  test("corrupt bytes are refused by name", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);
    writeFileSync(sessionCheckpointPath(vault, importId), "{ not json", "utf8");
    expect(() => readSessionCheckpoint(vault, importId)).toThrow(/corrupt/i);
  });

  test("a negative or fractional turn count is refused rather than recorded", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    expect(() => seedCheckpoint(path, importId, -1)).toThrow(/turns_completed/);
    expect(() => seedCheckpoint(path, importId, 1.5)).toThrow(/turns_completed/);
  });

  test("OSB_INGEST_NO_CHECKPOINT makes record and read inert, as it does for ingest", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    process.env["OSB_INGEST_NO_CHECKPOINT"] = "1";
    expect(seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL)).toBe(false);
    expect(existsSync(sessionCheckpointPath(vault, importId))).toBe(false);
    expect(readSessionCheckpoint(vault, importId)).toBeNull();
  });

  test("clearing reports whether there was anything to clear", () => {
    const path = standardTranscript();
    const importId = computeSessionImportId(path, { agent: AGENT });
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);
    expect(clearSessionCheckpoint(vault, importId)).toBe(true);
    expect(clearSessionCheckpoint(vault, importId)).toBe(false);
  });

  test("the id is scoped to the import's question, not just the file", () => {
    const path = standardTranscript();
    const base = computeSessionImportId(path, { agent: AGENT });
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(computeSessionImportId(path, { agent: AGENT, filterRoles: ["user"] })).not.toBe(base);
    expect(computeSessionImportId(path, { agent: AGENT, filterTextIncludes: "x" })).not.toBe(base);
    expect(
      computeSessionImportId(path, { agent: AGENT, since: new Date("2026-01-01T00:00:00Z") }),
    ).not.toBe(base);
    expect(computeSessionImportId(path, { agent: AGENT, recall: true })).not.toBe(base);
    // Same question, same id - otherwise no run could ever resume.
    expect(computeSessionImportId(path, { agent: AGENT })).toBe(base);
  });
});

describe("an interrupted session import resumes at the turn boundary", () => {
  test("turns before the boundary are not re-extracted", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const first = await importSession(vault, path, opts);
    expect(first.signals_created).toBe(2);

    // The early marker's signal is removed, so a resumed run that re-read
    // those turns would write it again - and the dedup index could not stop
    // it, because the hash is no longer on disk. Its continued absence is
    // the proof that the completed turns were never re-hashed.
    const early = inboxFiles().find((n) => n.includes("resume-early"));
    expect(early).toBeDefined();
    unlinkSync(join(brainDirs(vault).inbox, early!));

    const importId = computeSessionImportId(path, opts);
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);

    const resumed = await importSession(vault, path, opts);
    expect(resumed.turns_resumed).toBe(SESSION_CHECKPOINT_TURN_INTERVAL);
    expect(resumed.resume_discarded).toBeNull();
    expect(resumed.signals_created).toBe(0);
    // The late marker sits past the boundary, so it IS re-seen - and deduped
    // against the signal the first run wrote.
    expect(resumed.signals_deduped).toBe(1);
    expect(inboxFiles().some((n) => n.includes("resume-early"))).toBe(false);
  });

  test("turns_scanned still counts every turn the adapter yielded", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const importId = computeSessionImportId(path, opts);
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);

    const resumed = await importSession(vault, path, opts);
    expect(resumed.turns_scanned).toBe(TURNS);
    expect(resumed.turns_resumed).toBe(SESSION_CHECKPOINT_TURN_INTERVAL);
    expect(resumed.census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("a completed applied import clears its checkpoint", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const importId = computeSessionImportId(path, opts);
    await importSession(vault, path, opts);
    expect(existsSync(sessionCheckpointPath(vault, importId))).toBe(false);
    expect(readSessionCheckpoint(vault, importId)).toBeNull();
  });

  test("a dry run records no checkpoint at all", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW, dryRun: true };
    const importId = computeSessionImportId(path, opts);
    const result = await importSession(vault, path, opts);
    expect(result.turns_resumed).toBe(0);
    expect(existsSync(sessionCheckpointPath(vault, importId))).toBe(false);
  });

  test("a checkpoint taken against a different file is discarded and said so", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const importId = computeSessionImportId(path, opts);
    recordSessionProgress(
      vault,
      importId,
      {
        sessionFile: path,
        // The head line of some OTHER transcript: the log this boundary was
        // taken against is not the log on disk now.
        headHash: computeSessionHeadHash("a completely different first line"),
        bytes: statSync(path).size,
        turnsCompleted: SESSION_CHECKPOINT_TURN_INTERVAL,
      },
      NOW,
    );

    const result = await importSession(vault, path, opts);
    expect(result.turns_resumed).toBe(0);
    expect(result.resume_discarded).toBe("head_changed");
    // Nothing was skipped, so both markers are seen and written.
    expect(result.signals_created).toBe(2);
  });

  test("a session file that shrank since the boundary is not resumed from", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const importId = computeSessionImportId(path, opts);
    recordSessionProgress(
      vault,
      importId,
      {
        sessionFile: path,
        headHash: headHashOf(path),
        bytes: statSync(path).size + 1_000,
        turnsCompleted: SESSION_CHECKPOINT_TURN_INTERVAL,
      },
      NOW,
    );

    const result = await importSession(vault, path, opts);
    expect(result.turns_resumed).toBe(0);
    expect(result.resume_discarded).toBe("file_shrank");
  });

  test("with checkpointing opted out the import neither resumes nor records", async () => {
    const path = standardTranscript();
    const opts = { agent: AGENT, now: NOW };
    const importId = computeSessionImportId(path, opts);
    seedCheckpoint(path, importId, SESSION_CHECKPOINT_TURN_INTERVAL);
    process.env["OSB_INGEST_NO_CHECKPOINT"] = "1";

    const result = await importSession(vault, path, opts);
    expect(result.turns_resumed).toBe(0);
    expect(result.resume_discarded).toBeNull();
    expect(result.signals_created).toBe(2);
    // The opt-out suppresses writes; it must not delete a checkpoint either.
    expect(existsSync(sessionCheckpointPath(vault, importId))).toBe(true);
  });
});
