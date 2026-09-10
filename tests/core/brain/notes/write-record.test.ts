/**
 * The note-write record (who-wrote-what, Task A / t_662f4e82).
 *
 * Covers the three artifacts the module owns - the write id, the
 * content-addressed before-image store, and the one `note-write` log
 * event - plus the property the whole design turns on: a log-append
 * failure costs the audit line and NOT the write, and says so by name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NOTE_WRITE_NO_PRIOR,
  NOTE_WRITE_OP,
  WRITE_IMAGE_RETENTION_DAYS,
  isNoteWriteOp,
  noteWriteId,
  pruneWriteImages,
  recordNoteWrite,
  storeBeforeImage,
} from "../../../../src/core/brain/notes/write-record.ts";
import { writeImagePath, writeImagesDir } from "../../../../src/core/brain/paths.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { sha256Hex } from "../../../../src/core/integrity/digest.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";

const AGENT = "agent-a";
const TS = "2026-03-04T05:06:07Z";
const DATE = "2026-03-04";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-record-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("noteWriteId", () => {
  test("carries the timestamp digits and a 16-hex body digest", () => {
    const id = noteWriteId({
      timestamp: TS,
      op: NOTE_WRITE_OP.update,
      target: "Notes/A.md",
      hash_before: sha256Hex("old"),
      hash_after: sha256Hex("new"),
      agent: AGENT,
    });
    expect(id).toMatch(/^nw_\d{14}_[0-9a-f]{16}$/);
    expect(id.slice(3, 17)).toBe("20260304050607");
  });

  test("is a pure function of the body: same facts, same id", () => {
    const body = {
      timestamp: TS,
      op: NOTE_WRITE_OP.create,
      target: "Notes/A.md",
      hash_before: NOTE_WRITE_NO_PRIOR,
      hash_after: sha256Hex("new"),
      agent: AGENT,
    } as const;
    expect(noteWriteId(body)).toBe(noteWriteId(body));
    expect(noteWriteId({ ...body, agent: "agent-b" })).not.toBe(noteWriteId(body));
  });
});

describe("isNoteWriteOp", () => {
  test("admits the four declared operations and nothing else", () => {
    for (const op of Object.values(NOTE_WRITE_OP)) expect(isNoteWriteOp(op)).toBe(true);
    expect(isNoteWriteOp("delete")).toBe(false);
    expect(isNoteWriteOp(null)).toBe(false);
  });
});

describe("storeBeforeImage", () => {
  test("writes the bytes under their sha256 and reports it stored", () => {
    const image = storeBeforeImage(vault, "prior body");
    expect(image.sha256).toBe(sha256Hex("prior body"));
    expect(image.stored).toBe(true);
    expect(image.path).toBe(writeImagePath(vault, image.sha256));
    expect(readFileSync(image.path, "utf8")).toBe("prior body");
  });

  test("a second image of identical content writes nothing", () => {
    const first = storeBeforeImage(vault, "same");
    const second = storeBeforeImage(vault, "same");
    expect(second.stored).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test("distinct content gets distinct files", () => {
    storeBeforeImage(vault, "one");
    storeBeforeImage(vault, "two");
    expect(pruneWriteImages(vault, { olderThanDays: 0, dryRun: true }).removed).toHaveLength(2);
  });
});

describe("recordNoteWrite", () => {
  test("appends exactly one note-write event with the design's fields", () => {
    const receipt = recordNoteWrite(vault, {
      op: NOTE_WRITE_OP.update,
      target: "Notes/A.md",
      before: { bytes: "old" },
      after: { bytes: "newer" },
      timestamp: TS,
      agent: AGENT,
    });
    const writeId = receipt.write_id;
    expect(writeId).toMatch(/^nw_\d{14}_[0-9a-f]{16}$/);

    const day = readLogDay(vault, DATE);
    const events = day.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.noteWrite);
    expect(events).toHaveLength(1);
    const body = events[0]!.body;
    expect(body["write_id"]).toBe(writeId!);
    expect(body["op"]).toBe(NOTE_WRITE_OP.update);
    expect(body["target"]).toBe("Notes/A.md");
    expect(body["hash_before"]).toBe(sha256Hex("old"));
    expect(body["hash_after"]).toBe(sha256Hex("newer"));
    expect(body["bytes_before"]).toBe("3");
    expect(body["bytes_after"]).toBe("5");
    expect(body["agent"]).toBe(AGENT);
    expect(events[0]!.agent).toBe(AGENT);
  });

  test("a null before is recorded as absent, not as the digest of nothing", () => {
    recordNoteWrite(vault, {
      op: NOTE_WRITE_OP.create,
      target: "Notes/A.md",
      before: null,
      after: { bytes: "body" },
      timestamp: TS,
      agent: AGENT,
    });
    const body = readLogDay(vault, DATE).entries[0]!.body;
    expect(body["hash_before"]).toBe(NOTE_WRITE_NO_PRIOR);
    expect(body["hash_before"]).not.toBe(sha256Hex(""));
    expect(body["bytes_before"]).toBe("0");
  });

  test("an absolute target inside the vault is recorded vault-relative", () => {
    recordNoteWrite(vault, {
      op: NOTE_WRITE_OP.append,
      target: join(vault, "Notes", "A.md"),
      before: { bytes: "a" },
      after: { bytes: "ab" },
      timestamp: TS,
      agent: AGENT,
    });
    expect(readLogDay(vault, DATE).entries[0]!.body["target"]).toBe("Notes/A.md");
  });

  test("a log-append failure returns a named audit_reason and never throws", () => {
    // An unwritable log directory is the shape a full disk, a permission
    // flip and a sync-locked tree all present as. The note is already on
    // disk by the time this runs, so a throw here would report a failure
    // for a write that succeeded.
    const logDir = join(vault, "Brain", "log");
    mkdirSync(logDir, { recursive: true });
    chmodSync(logDir, 0o500);
    try {
      const receipt = recordNoteWrite(vault, {
        op: NOTE_WRITE_OP.update,
        target: "Notes/A.md",
        before: { bytes: "old" },
        after: { bytes: "new" },
        timestamp: TS,
        agent: AGENT,
      });
      expect(receipt.write_id).toBeNull();
      expect(receipt.audit_reason).toContain("note-write event not recorded");
    } finally {
      chmodSync(logDir, 0o700);
    }
  });
});

describe("pruneWriteImages", () => {
  test("the default window is the declared retention constant", () => {
    storeBeforeImage(vault, "fresh");
    expect(WRITE_IMAGE_RETENTION_DAYS).toBe(30);
    expect(pruneWriteImages(vault).removed).toEqual([]);
    expect(pruneWriteImages(vault).kept).toBe(1);
  });

  test("--older-than-days 0 removes every image; a dry run removes none", () => {
    const image = storeBeforeImage(vault, "gone");
    const preview = pruneWriteImages(vault, { olderThanDays: 0, dryRun: true });
    expect(preview.removed).toEqual([image.sha256]);
    expect(preview.dry_run).toBe(true);
    expect(existsSync(image.path)).toBe(true);

    const applied = pruneWriteImages(vault, { olderThanDays: 0 });
    expect(applied.removed).toEqual([image.sha256]);
    expect(applied.kept).toBe(0);
    expect(existsSync(image.path)).toBe(false);
  });

  test("an absent store is an empty result, not a fault", () => {
    expect(existsSync(writeImagesDir(vault))).toBe(false);
    expect(pruneWriteImages(vault)).toEqual({ removed: [], kept: 0, dry_run: false });
  });

  test("a negative window is refused by name", () => {
    expect(() => pruneWriteImages(vault, { olderThanDays: -1 })).toThrow(/non-negative integer/);
  });
});
