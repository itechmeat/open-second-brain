/**
 * The orphan-observation check (t_6cc80627).
 *
 * An observation signal carries `session_ref` - the portable session
 * coordinates the capture and import writers stamp - and nothing anywhere
 * resolved it: an observation whose parent session is gone was silently
 * accepted. This check is the strictly read-only half of the answer; the
 * repair verb behind the `fix` field it carries is tested next door.
 *
 * What is pinned here: which signals are orphans, which resolve (through
 * either half of the sessions/continuity store), that the repair command
 * travels ON the issue rather than inside its prose, and that a subtree
 * the walk could not read is uncertainty rather than a clean bill.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import {
  collectKnownSessionIds,
  ORPHAN_SESSION_REF_CODE,
  ORPHAN_SESSION_REPAIR_COMMAND,
  orphanSessionCheck,
  isImportedTranscriptRef,
  parseSessionRef,
} from "../../../../src/core/brain/doctor/orphan-session-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { readAllLogRecords } from "../../../../src/core/brain/doctor/records.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

let tmp: string;
let vault: string;
let locked: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-orphan-session-"));
  vault = join(tmp, "vault");
  bootstrapBrain(vault);
  locked = [];
});

afterEach(() => {
  for (const path of locked) chmodSync(path, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

function writeObservation(sessionRef: string | undefined): string {
  const result = writeSignal(vault, {
    topic: "orphan-lane",
    signal: "positive",
    agent: "tester",
    principle: "observations keep their provenance",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "orphan-lane",
    source_type: "session",
    ...(sessionRef !== undefined ? { session_ref: sessionRef } : {}),
    raw: "the observation body survives any repair",
  });
  return result.path;
}

function issuesFor(logs: LogRecords = readAllLogRecords(vault)): ReadonlyArray<DoctorIssue> {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  orphanSessionCheck.run(
    {
      vault,
      now: new Date("2026-06-02T00:00:00.000Z"),
      // The pre-parsed log snapshot, exactly as the pass's resolveContext
      // builds it: the lifecycle half of the resolution reads from here.
      logs,
    } as unknown as Parameters<typeof orphanSessionCheck.run>[0],
    { issues, uncertain },
  );
  return issues;
}

describe("a session_ref that resolves to nothing is an orphan", () => {
  test("the warning carries the exact repair command as its fix field", () => {
    const path = writeObservation("session:sess-gone#turn-1");
    const issues = issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.path).toBe(path);
    expect(issues[0]!.fix).toBe(ORPHAN_SESSION_REPAIR_COMMAND);
    expect(issues[0]!.message).toContain("session:sess-gone#turn-1");
  });

  test("a bare session id (the extract-signals form) with no raw turns is an orphan", () => {
    writeObservation("raw-sess-gone");
    const issues = issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE);
    expect(issues.length).toBe(1);
  });
});

describe("an imported transcript ref is never judged", () => {
  // `o2b brain sessions import` stamps `<transcript basename>#<turn>`: the
  // parent is a transcript file outside the vault, and the import leaves
  // no record it is guaranteed to keep (the checkpoint is cleared, recall,
  // skill and dedup records are conditional). A missing record proves
  // nothing, and a repair run on such a finding would strip valid
  // provenance.
  test("an imported ref with no vault record raises no finding", () => {
    writeObservation("transcript.jsonl#t-9");
    expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  });

  test("the import form is skipped before resolution, so the same identity in another form is judged", () => {
    // `transcript.jsonl` resolves against nothing. Under the import form the
    // ref is never judged; the same identity spelled in the extract-signals
    // form is, and is flagged - so the silence above is the form's skip,
    // not a resolution.
    writeObservation("transcript.jsonl#t-9");
    const bare = writeObservation("transcript.jsonl");
    const issues = issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE);
    expect(issues.map((i) => i.path)).toEqual([bare]);
    expect(issues[0]!.message).toContain("'transcript.jsonl'");
  });

  test("isImportedTranscriptRef tells the three writer forms apart", () => {
    expect(isImportedTranscriptRef("transcript.jsonl#t-9")).toBe(true);
    expect(isImportedTranscriptRef("session:abc#turn-1")).toBe(false);
    expect(isImportedTranscriptRef("raw-session-id")).toBe(false);
  });
});

describe("a session_ref that resolves emits nothing", () => {
  test("a continuity record carries the session id", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-01T00:00:00Z",
      payload: { session_id: "sess-live" },
    });
    writeObservation("session:sess-live#turn-2");
    expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  });

  test("a session-lifecycle log event carries the session id", () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-01T01:00:00Z",
      eventType: "session-lifecycle",
      agent: "tester",
      body: { event: "end", session_id: "sess-logged" },
    });
    writeObservation("session:sess-logged#end");
    expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  });

  test("the writer's no-session stand-in is not an orphan", () => {
    // `session:unknown` is what the capture writer stamps when the host
    // payload carried no session id: a statement that there was no
    // session, not a pointer to a missing one. Detaching it would erase
    // the honesty rather than repair a dangle.
    writeObservation("session:unknown#turn-1");
    expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  });

  test("a signal with no session_ref at all is none of this check's business", () => {
    writeObservation(undefined);
    expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  });
});

describe("what the walk could not read is uncertainty", () => {
  // Windows chmod only toggles the read-only attribute and cannot deny a
  // read; the rest of this file passes there vacuously, so only this
  // subtree is skipped rather than guarded.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable signals directory reaches the uncertain stream, never silence",
    () => {
      const dirs = brainDirs(vault);
      const path = writeObservation("session:sess-gone#turn-1");
      chmodSync(dirs.inbox, 0o000);
      locked.push(dirs.inbox);
      expect(() => readdirSync(dirs.inbox)).toThrow();
      expect(issuesFor().filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
      expect(uncertainFor().some((u) => u.path === dirs.inbox)).toBe(true);
      chmodSync(dirs.inbox, 0o700);
      locked.pop();
      expect(path).toBeDefined();
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a continuity ledger that cannot be read is uncertainty, not an orphan flood",
    () => {
      const dirs = brainDirs(vault);
      writeObservation("session:sess-live#turn-2");
      appendContinuityRecord(vault, {
        kind: "session_turn",
        createdAt: "2026-06-01T00:00:00Z",
        payload: { session_id: "sess-live" },
      });
      chmodSync(dirs.log, 0o000);
      locked.push(dirs.log);
      // With Brain/log unreadable, the pass's own log read reports the
      // denial and hands the check an empty snapshot - which is the
      // context this assertion runs under. No issue may be raised off a
      // resolution surface the check could not read: the record naming
      // this session live was not seen.
      expect(issuesFor([]).filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
      expect(uncertainFor([]).length).toBeGreaterThan(0);
    },
  );
});

describe("an unreadable log day is uncertainty, not an orphan", () => {
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a session whose lifecycle lives in an unreadable day is never flagged",
    () => {
      const dirs = brainDirs(vault);
      appendLogEvent(vault, {
        timestamp: "2026-06-01T01:00:00Z",
        eventType: "session-lifecycle",
        agent: "tester",
        body: { event: "end", session_id: "sess-logged" },
      });
      writeObservation("session:sess-logged#end");
      const shards = readdirSync(dirs.log, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.includes("2026-06-01"))
        .map((e) => join(e.parentPath, e.name));
      expect(shards.length).toBeGreaterThan(0);
      for (const shard of shards) {
        chmodSync(shard, 0o000);
        locked.push(shard);
      }
      const result = runDoctor(vault);
      expect((result.warnings ?? []).filter((i) => i.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
      expect((result.uncertain ?? []).some((u) => u.message.includes("2026-06-01"))).toBe(true);
      const universe = collectKnownSessionIds(vault);
      expect(universe.complete).toBe(false);
      expect(universe.uncertain.length).toBeGreaterThan(0);
    },
  );
});

function uncertainFor(
  logs: LogRecords = readAllLogRecords(vault),
): ReadonlyArray<DoctorUncertainEntry> {
  const uncertain: DoctorUncertainEntry[] = [];
  orphanSessionCheck.run(
    {
      vault,
      now: new Date("2026-06-02T00:00:00.000Z"),
      logs,
    } as unknown as Parameters<typeof orphanSessionCheck.run>[0],
    { issues: [], uncertain },
  );
  return uncertain;
}

/** The log snapshot type the pass hands the check, as resolveContext builds it. */
type LogRecords = ReturnType<typeof readAllLogRecords>;

describe("the ref grammar, as the repair shares it", () => {
  test("the identity half drops the session prefix; the turn half is named", () => {
    expect(parseSessionRef("session:abc#turn-1")).toEqual({ identity: "abc", turn: "turn-1" });
    expect(parseSessionRef("transcript.jsonl#t-9")).toEqual({
      identity: "transcript.jsonl",
      turn: "t-9",
    });
    expect(parseSessionRef("session:abc")).toEqual({ identity: "abc", turn: null });
  });

  test("collectKnownSessionIds reads both halves of the store", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-01T00:00:00Z",
      payload: { session_id: "sess-cont" },
    });
    appendLogEvent(vault, {
      timestamp: "2026-06-01T01:00:00Z",
      eventType: "session-lifecycle",
      agent: "tester",
      body: { event: "end", session_id: "sess-logged" },
    });
    const universe = collectKnownSessionIds(vault);
    expect(universe.ids.has("sess-cont")).toBe(true);
    expect(universe.ids.has("sess-logged")).toBe(true);
    expect(universe.complete).toBe(true);
  });
});

describe("the check is wired honestly", () => {
  test("runDoctor carries the orphan warning with its fix, and repairs nothing", () => {
    const path = writeObservation("session:sess-gone#turn-1");
    const before = issuesFor();
    expect(before.length).toBe(1);
    const result = runDoctor(vault);
    const orphan = (result.warnings ?? []).filter((i) => i.code === ORPHAN_SESSION_REF_CODE);
    expect(orphan.length).toBe(1);
    expect(orphan[0]!.fix).toBe(ORPHAN_SESSION_REPAIR_COMMAND);
    // Read-only: the doctor pass leaves the dangling reference exactly
    // where it was - the repair is the verb's to make, never the pass's.
    expect(issuesFor().length).toBe(1);
    expect(path).toContain("sig-");
  });
});
