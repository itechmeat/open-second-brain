/**
 * Per-agent / per-session revert (who-wrote-what, Task D / t_924129c5).
 *
 * The plan half is a report an operator READS: every target the selected
 * writes touched resolves to `restore`, `delete` or a named refusal, and
 * nothing is ever skipped silently. The apply half is sealed by the
 * plan's digest, runs behind `withDestructiveSnapshot`, and records each
 * restored or deleted target as a `note-write` of operation `revert` - so
 * a revert is attributable and itself revertible, which the last test in
 * this file proves by reverting the reverter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { freezeVault } from "../../../../src/core/brain/freeze.ts";
import {
  VaultFrozenError,
  resetFreezeMarkerCache,
} from "../../../../src/core/brain/freeze-marker.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { listNoteWrites } from "../../../../src/core/brain/notes/write-log.ts";
import {
  NOTE_WRITE_NO_PRIOR,
  NOTE_WRITE_OP,
  noteWriteId,
  recordNoteWrite,
  storeBeforeImage,
  type NoteWriteOp,
} from "../../../../src/core/brain/notes/write-record.ts";
import {
  NOTE_REVERT_ACTION,
  NOTE_REVERT_ERROR,
  NOTE_REVERT_REFUSAL,
  NoteRevertError,
  applyNoteRevert,
  planNoteRevert,
} from "../../../../src/core/brain/notes/revert.ts";
import { writeImagePath } from "../../../../src/core/brain/paths.ts";
import { listSnapshots } from "../../../../src/core/brain/snapshot.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../../src/core/integrity/digest.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "../../../../src/core/brain/types.ts";

const SEED = "agent-seed";
const A = "agent-a";
const B = "agent-b";
const REVERTER = "agent-reverter";
const TARGET = "notes/A.md";

/** One hour apart, so no two seeded writes share a second. */
const at = (hour: number): string => `2026-03-04T${String(hour).padStart(2, "0")}:00:00Z`;

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-revert-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-note-revert-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${REVERTER}\n`);
  bootstrapBrain(vault, { configPath });
  resetFreezeMarkerCache();
});

afterEach(() => {
  resetFreezeMarkerCache();
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Do to a note exactly what the write seams do - keep the bytes it
 * replaces, write, record - so the plan reads a history it could have
 * read off a real vault rather than one this file invented.
 */
function seedWrite(opts: {
  readonly target?: string;
  readonly bytes: string;
  readonly agent: string;
  readonly at: string;
  readonly op?: NoteWriteOp;
  /**
   * Device shard the event lands on. Absent means whatever the appender
   * resolves, which is the single-device case every other test wants;
   * naming it is how the same-second tests put two writes on the same
   * shard or on two, which is the whole difference between a known order
   * and a guess.
   */
  readonly device?: string;
}): string {
  const target = opts.target ?? TARGET;
  const abs = join(vault, target);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  mkdirSync(dirname(abs), { recursive: true });
  if (before !== null) storeBeforeImage(vault, before);
  atomicWriteFileSync(abs, opts.bytes);
  const op = opts.op ?? (before === null ? NOTE_WRITE_OP.create : NOTE_WRITE_OP.update);
  if (opts.device === undefined) {
    const receipt = recordNoteWrite(vault, {
      op,
      target,
      before: before === null ? null : { bytes: before },
      after: { bytes: opts.bytes },
      timestamp: opts.at,
      agent: opts.agent,
    });
    expect(receipt.write_id).not.toBeNull();
    return receipt.write_id!;
  }
  // `recordNoteWrite` does not thread a shard - the appender resolves it
  // from config - so a test that needs two shards in one vault builds the
  // same event body and hands the appender the device directly.
  const body = {
    timestamp: opts.at,
    op,
    target,
    hash_before: before === null ? NOTE_WRITE_NO_PRIOR : sha256Hex(before),
    hash_after: sha256Hex(opts.bytes),
    agent: opts.agent,
  } as const;
  const writeId = noteWriteId(body);
  appendLogEvent(
    vault,
    {
      timestamp: opts.at,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent: opts.agent,
      body: {
        write_id: writeId,
        op: body.op,
        target: body.target,
        hash_before: body.hash_before,
        hash_after: body.hash_after,
        bytes_before: String(before === null ? 0 : Buffer.byteLength(before, "utf8")),
        bytes_after: String(Buffer.byteLength(opts.bytes, "utf8")),
        agent: opts.agent,
      },
    },
    { deviceId: opts.device },
  );
  return writeId;
}

/** `seed` created it, then A edited it twice and nobody else touched it. */
function seedTwoUpdatesByA(): void {
  seedWrite({ bytes: "v0", agent: SEED, at: at(1) });
  seedWrite({ bytes: "v1", agent: A, at: at(2) });
  seedWrite({ bytes: "v2", agent: A, at: at(3) });
}

const noteBytes = (target = TARGET): string => readFileSync(join(vault, target), "utf8");

describe("planNoteRevert selector", () => {
  test("an unbounded selector is refused by name before any log is read", () => {
    let thrown: unknown;
    try {
      planNoteRevert(vault, {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NoteRevertError);
    expect((thrown as NoteRevertError).code).toBe(NOTE_REVERT_ERROR.unboundedSelector);
  });

  test("a window with no agent, device or path is still unbounded", () => {
    expect(() => planNoteRevert(vault, { since: "2026-03-04", until: "2026-03-05" })).toThrow(
      NoteRevertError,
    );
  });

  test("a path alone bounds it", () => {
    seedTwoUpdatesByA();
    expect(planNoteRevert(vault, { path: TARGET }).entries).toHaveLength(1);
  });
});

describe("planNoteRevert restore", () => {
  test("two updates by one agent plan one restore to the pre-agent bytes", () => {
    seedTwoUpdatesByA();
    const plan = planNoteRevert(vault, { agent: A });

    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0]!;
    expect(entry.target).toBe(TARGET);
    expect(entry.action).toBe(NOTE_REVERT_ACTION.restore);
    expect(entry.reason).toBeUndefined();
    expect(entry.writes).toHaveLength(2);
    expect(entry.hash_now).toBe(sha256Hex("v2"));
    expect(entry.hash_to).toBe(sha256Hex("v0"));
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the write ids are oldest first, so an operator reads the order they landed", () => {
    seedWrite({ bytes: "v0", agent: SEED, at: at(1) });
    const first = seedWrite({ bytes: "v1", agent: A, at: at(2) });
    const second = seedWrite({ bytes: "v2", agent: A, at: at(3) });
    expect(planNoteRevert(vault, { agent: A }).entries[0]!.writes).toEqual([first, second]);
  });

  test("the digest covers the selector and the entries, and not the planning instant", () => {
    seedTwoUpdatesByA();
    const first = planNoteRevert(vault, { agent: A }, { now: new Date("2026-03-05T00:00:00Z") });
    const second = planNoteRevert(vault, { agent: A }, { now: new Date("2026-03-06T00:00:00Z") });
    expect(second.digest).toBe(first.digest);
    expect(second.planned_at).not.toBe(first.planned_at);
    // A different selector over the same vault is a different plan.
    expect(planNoteRevert(vault, { path: TARGET }).digest).not.toBe(first.digest);
  });
});

describe("planNoteRevert refusals", () => {
  test("an unselected write inside the window refuses interleaved", () => {
    seedWrite({ bytes: "v0", agent: SEED, at: at(1) });
    seedWrite({ bytes: "v1", agent: A, at: at(2) });
    seedWrite({ bytes: "vB", agent: B, at: at(3) });
    seedWrite({ bytes: "v3", agent: A, at: at(4) });

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.interleaved);
  });

  test("a same-second write on the SAME shard is ordered by line, not refused", () => {
    // One shard, one second, two writes. Line order inside a shard IS
    // append order and `readLogDay` merges on (timestamp, shard id,
    // line), so B's create is PROVABLY before A's update and there is
    // nothing ambiguous to refuse over.
    const target = "notes/two.md";
    const ts = at(2);
    seedWrite({ target, bytes: "b0", agent: B, at: ts, device: "deva" });
    seedWrite({ target, bytes: "a1", agent: A, at: ts, device: "deva" });

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.restore);
    expect(entry.hash_to).toBe(sha256Hex("b0"));
  });

  test("a same-second write on a DIFFERENT shard is still interleaved", () => {
    // Two devices, one second. Nothing orders them: the merge falls back
    // to the shard id, which is a name, not a clock. Refuse on doubt.
    const target = "notes/two.md";
    const ts = at(2);
    seedWrite({ target, bytes: "b0", agent: B, at: ts, device: "devb" });
    seedWrite({ target, bytes: "a1", agent: A, at: ts, device: "deva" });

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.interleaved);
  });

  test("bytes changed after the newest selected write refuse drift", () => {
    seedTwoUpdatesByA();
    writeFileSync(join(vault, TARGET), "somebody else, unrecorded");

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.drift);
    expect(entry.hash_now).toBe(sha256Hex("somebody else, unrecorded"));
  });

  test("a target that should exist and does not refuses drift", () => {
    seedTwoUpdatesByA();
    unlinkSync(join(vault, TARGET));
    expect(planNoteRevert(vault, { agent: A }).entries[0]!.reason).toBe(NOTE_REVERT_REFUSAL.drift);
  });

  test("a target whose current bytes cannot be read refuses unrecorded", () => {
    seedTwoUpdatesByA();
    // A directory where the note was: the bytes are neither present nor
    // absent, and "I could not tell" must never resolve to "revert it".
    unlinkSync(join(vault, TARGET));
    mkdirSync(join(vault, TARGET));

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.unrecorded);
  });

  test("a missing before-image refuses image-missing", () => {
    seedTwoUpdatesByA();
    unlinkSync(writeImagePath(vault, sha256Hex("v0")));

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.imageMissing);
    expect(entry.hash_to).toBe(sha256Hex("v0"));
  });

  test("a target already at the state the plan would produce refuses already-reverted", () => {
    seedWrite({ bytes: "v0", agent: SEED, at: at(1) });
    seedWrite({ bytes: "v1", agent: A, at: at(2) });
    // A put it back itself: the newest selected write leaves the bytes
    // the oldest one replaced, so there is nothing left to take back.
    seedWrite({ bytes: "v0", agent: A, at: at(3) });

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.refuse);
    expect(entry.reason).toBe(NOTE_REVERT_REFUSAL.alreadyReverted);
  });

  test("every touched target is reported, refused ones beside applicable ones", () => {
    seedTwoUpdatesByA();
    seedWrite({ target: "notes/B.md", bytes: "b1", agent: A, at: at(4) });
    writeFileSync(join(vault, "notes/B.md"), "drifted");

    const plan = planNoteRevert(vault, { agent: A });
    expect(plan.entries.map((e) => `${e.target}:${e.action}`)).toEqual([
      `${TARGET}:${NOTE_REVERT_ACTION.restore}`,
      `notes/B.md:${NOTE_REVERT_ACTION.refuse}`,
    ]);
  });
});

describe("planNoteRevert delete", () => {
  test("a note the selected writes created plans a delete", () => {
    seedWrite({ target: "notes/New.md", bytes: "brand new", agent: A, at: at(2) });

    const entry = planNoteRevert(vault, { agent: A }).entries[0]!;
    expect(entry.action).toBe(NOTE_REVERT_ACTION.delete);
    expect(entry.hash_to).toBe(NOTE_WRITE_NO_PRIOR);
    expect(entry.hash_now).toBe(sha256Hex("brand new"));
  });

  test("a note created by somebody else is never deleted", () => {
    seedWrite({ target: "notes/New.md", bytes: "v0", agent: SEED, at: at(1) });
    seedWrite({ target: "notes/New.md", bytes: "v1", agent: A, at: at(2) });
    expect(planNoteRevert(vault, { agent: A }).entries[0]!.action).toBe(NOTE_REVERT_ACTION.restore);
  });
});

describe("applyNoteRevert", () => {
  test("restores the pre-agent bytes behind a note-revert snapshot and records the write", () => {
    seedTwoUpdatesByA();
    const plan = planNoteRevert(vault, { agent: A });

    const result = applyNoteRevert(vault, { agent: A }, plan.digest, {
      now: new Date(at(9)),
      agent: REVERTER,
      configPath,
    });

    expect(noteBytes()).toBe("v0");
    expect(result.applied).toHaveLength(1);
    expect(result.refused).toHaveLength(0);
    expect(result.snapshot.run_id).toStartWith(`${BRAIN_SNAPSHOT_REASON.noteRevert}-`);
    expect(existsSync(result.snapshot.path)).toBe(true);
    expect(listSnapshots(vault).snapshots.some((s) => s.run_id === result.snapshot.run_id)).toBe(
      true,
    );

    const reverts = listNoteWrites(vault, { op: NOTE_WRITE_OP.revert }).writes;
    expect(reverts).toHaveLength(1);
    expect(reverts[0]!.target).toBe(TARGET);
    expect(reverts[0]!.agent).toBe(REVERTER);
    expect(reverts[0]!.hash_before).toBe(sha256Hex("v2"));
    expect(reverts[0]!.hash_after).toBe(sha256Hex("v0"));
    expect(result.recorded).toEqual([{ target: TARGET, write_id: reverts[0]!.write_id }]);
  });

  test("a delete unlinks the note and records an absent after side", () => {
    seedWrite({ target: "notes/New.md", bytes: "brand new", agent: A, at: at(2) });
    const plan = planNoteRevert(vault, { agent: A });

    applyNoteRevert(vault, { agent: A }, plan.digest, {
      now: new Date(at(9)),
      agent: REVERTER,
      configPath,
    });

    expect(existsSync(join(vault, "notes/New.md"))).toBe(false);
    const revert = listNoteWrites(vault, { op: NOTE_WRITE_OP.revert }).writes[0]!;
    expect(revert.hash_after).toBe(NOTE_WRITE_NO_PRIOR);
    expect(revert.bytes_after).toBe(0);
    // The bytes it removed are kept, so the delete is itself revertible.
    expect(existsSync(writeImagePath(vault, sha256Hex("brand new")))).toBe(true);
  });

  test("a stale digest is refused before any byte moves", () => {
    seedTwoUpdatesByA();
    const stale = planNoteRevert(vault, { agent: A }).digest;
    seedWrite({ bytes: "v3", agent: A, at: at(4) });

    let thrown: unknown;
    try {
      applyNoteRevert(vault, { agent: A }, stale, { now: new Date(at(9)), configPath });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NoteRevertError);
    expect((thrown as NoteRevertError).code).toBe(NOTE_REVERT_ERROR.digestMismatch);
    expect(noteBytes()).toBe("v3");
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
    expect(listNoteWrites(vault, { op: NOTE_WRITE_OP.revert }).writes).toHaveLength(0);
  });

  test("a plan whose every entry is refused cannot be applied", () => {
    seedTwoUpdatesByA();
    writeFileSync(join(vault, TARGET), "drifted");
    const plan = planNoteRevert(vault, { agent: A });

    let thrown: unknown;
    try {
      applyNoteRevert(vault, { agent: A }, plan.digest, { now: new Date(at(9)), configPath });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NoteRevertError);
    expect((thrown as NoteRevertError).code).toBe(NOTE_REVERT_ERROR.nothingToApply);
    expect(noteBytes()).toBe("drifted");
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
  });

  test("an image that no longer matches its digest refuses that target instead of writing it", () => {
    seedTwoUpdatesByA();
    const plan = planNoteRevert(vault, { agent: A });
    // The plan saw the image; it is corrupt by the time the apply reads
    // it. Restoring bytes that are not the ones recorded would be the
    // one failure a revert must never have.
    writeFileSync(writeImagePath(vault, sha256Hex("v0")), "not v0 any more");

    const result = applyNoteRevert(vault, { agent: A }, plan.digest, {
      now: new Date(at(9)),
      configPath,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.refused[0]!.reason).toBe(NOTE_REVERT_REFUSAL.imageMissing);
    expect(noteBytes()).toBe("v2");
  });

  test("a frozen vault refuses the revert by name, before the snapshot", () => {
    seedTwoUpdatesByA();
    const plan = planNoteRevert(vault, { agent: A });
    freezeVault(vault, { agent: "operator", reason: "audit", now: new Date(at(8)) });
    resetFreezeMarkerCache();

    expect(() =>
      applyNoteRevert(vault, { agent: A }, plan.digest, { now: new Date(at(9)), configPath }),
    ).toThrow(VaultFrozenError);
    expect(noteBytes()).toBe("v2");
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
  });

  test("a revert is itself revertible: reverting the reverter puts the bytes back", () => {
    seedTwoUpdatesByA();
    const first = planNoteRevert(vault, { agent: A });
    applyNoteRevert(vault, { agent: A }, first.digest, {
      now: new Date(at(9)),
      agent: REVERTER,
      configPath,
    });
    expect(noteBytes()).toBe("v0");

    const second = planNoteRevert(vault, { agent: REVERTER });
    expect(second.entries[0]!.action).toBe(NOTE_REVERT_ACTION.restore);
    expect(second.entries[0]!.hash_to).toBe(sha256Hex("v2"));

    applyNoteRevert(vault, { agent: REVERTER }, second.digest, {
      now: new Date(at(10)),
      agent: "agent-second-reverter",
      configPath,
    });
    expect(noteBytes()).toBe("v2");
  });
});
