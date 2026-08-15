/**
 * The note-file lifecycle's own correctness and honesty defects.
 *
 * Nine, and the thread running through them is that a surface whose
 * headline claim is "what this call did, and on what evidence" was
 * reporting several things that were not so.
 *
 *   2. a move read the note with `readFileSync(..., "utf8")` and wrote
 *      the string back, so a note that is not valid UTF-8 came out with
 *      every unpaired byte replaced by U+FFFD - and the source was then
 *      unlinked, with relocations deliberately not snapshotted, so the
 *      original bytes were gone. The module header claimed the move
 *      "copies rather than re-renders" so formatting survives it; that
 *      was false for bytes.
 *   3. bytes moved first and the rewrite pass ran second, so a file that
 *      could not be written threw the raw error and the caller got NO
 *      result - no `from`, no `to`, no evidence - leaving a
 *      half-applied rename indistinguishable from one that never
 *      started.
 *   5. the bare-basename guard counted carriers of the SOURCE basename
 *      only, so renaming `A/Old.md` to `A/New.md` while `B/New.md`
 *      existed reported `applied` and produced two `[[New]]` links -
 *      which, by this project's own resolution ladder, then resolved to
 *      neither note.
 *   7. a plan-only run reported `index: stale`. Nothing happened, so the
 *      premise of the staleness claim failed.
 *   8. a user-note rename edited `Brain/log/`, the append-only record of
 *      what an agent said at an instant.
 *  10. `--expect` excluded the note itself while the rewrite pass
 *      rewrote it, so `expect: 0` passed and then `filesRewritten: 1`.
 *  11. a DIRECTORY named `*.md` reached `readFileSync` and produced a
 *      raw `EISDIR` where `source_missing` belongs.
 *  12. a destination that names the same filesystem entry as the source
 *      - the shape a case-only rename has on macOS and Windows - was
 *      refused as `destination_occupied`.
 *  14. a vault-wide in-place rewrite of hand-authored notes reported
 *      `nothing_at_risk`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  BASENAME_REWRITE,
  INDEX_EVIDENCE,
  NOTE_LIFECYCLE_ACTION,
  noteLifecycle,
  NoteLifecycleError,
} from "../../../../src/core/brain/notes/lifecycle.ts";
import { RECOVERABILITY_STATE } from "../../../../src/core/brain/gates/recoverability.ts";
import { CountGuardError } from "../../../../src/core/brain/count-guard.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-defect-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-defect-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Write a note verbatim, creating its parents. */
function note(rel: string, body: string | Uint8Array): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function read(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

function bytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(vault, rel)));
}

describe("bytes that are not valid UTF-8 (2)", () => {
  test("survive a move exactly, byte for byte", async () => {
    // `ff fe` is not a valid UTF-8 sequence. Decoding and re-encoding
    // replaces each byte with U+FFFD (`ef bf bd`), which is the
    // corruption - and the source is unlinked immediately afterwards.
    const original = Uint8Array.from([0x68, 0x69, 0x20, 0xff, 0xfe, 0x0a]);
    note("Inbox/Binary.md", original);

    await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.move,
      path: "Inbox/Binary.md",
      to: "Projects/Binary.md",
      apply: true,
    });

    expect([...bytes("Projects/Binary.md")]).toEqual([...original]);
    expect(existsSync(join(vault, "Inbox/Binary.md"))).toBe(false);
  });

  test("survive a rename and an archive the same way", async () => {
    const original = Uint8Array.from([0xc0, 0x80, 0x0a]);
    note("Projects/Odd.md", original);

    await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Odd.md",
      to: "Projects/Even.md",
      apply: true,
    });
    expect([...bytes("Projects/Even.md")]).toEqual([...original]);

    await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.archive,
      path: "Projects/Even.md",
      apply: true,
    });
    expect([...bytes("Archive/Projects/Even.md")]).toEqual([...original]);
  });
});

describe("a rewrite that cannot be written (3)", () => {
  test("returns a result that names the split point instead of throwing", async () => {
    note("Projects/Old.md", "x\n");
    note("Aaa/Ref.md", "see [[Projects/Old]]\n");
    note("Docs/Ref.md", "see [[Projects/Old]]\n");
    chmodSync(join(vault, "Docs"), 0o500);

    let res;
    try {
      res = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
      });
    } finally {
      chmodSync(join(vault, "Docs"), 0o700);
    }

    // The whole of the previous failure was that none of this existed.
    expect(res.applied).toBe(true);
    expect(res.from).toBe("Projects/Old.md");
    expect(res.to).toBe("Projects/New.md");
    expect(res.references.filesRewritten).toBe(1);
    expect(res.references.rewriteFailures.map((f) => f.path)).toEqual(["Docs/Ref.md"]);
    expect(res.references.rewriteFailures[0]!.reason.length).toBeGreaterThan(0);
    expect(res.references.rewrittenSpellings.length).toBeGreaterThan(0);
    expect(res.references.index.state).toBe(INDEX_EVIDENCE.absent);

    // And the vault is in exactly the state the result describes.
    expect(existsSync(join(vault, "Projects/New.md"))).toBe(true);
    expect(read("Aaa/Ref.md")).toContain("[[Projects/New]]");
    expect(read("Docs/Ref.md")).toContain("[[Projects/Old]]");
  });

  test("a clean run reports no failures at all", async () => {
    note("Projects/Old.md", "x\n");
    note("Notes/Ref.md", "see [[Projects/Old]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });
    expect(res.references.rewriteFailures).toEqual([]);
  });
});

describe("the bare-basename guard (5)", () => {
  test("withholds when another note already carries the DESTINATION basename", async () => {
    note("A/Old.md", "x\n");
    note("B/New.md", "a different note that already owns the name\n");
    note("Notes/Ref.md", "bare [[Old]] and bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
    });

    expect(res.references.basename).toBe(BASENAME_REWRITE.ambiguous);
    const ref = read("Notes/Ref.md");
    // Rewriting would have produced two `[[New]]` links, and by
    // `store/links.ts`'s ladder a basename with two carriers resolves to
    // neither. Leaving `[[Old]]` alone leaves one working link working.
    expect(ref).toBe("bare [[Old]] and bare [[New]]\n");
  });

  test("still applies when neither basename is contested", async () => {
    note("A/Old.md", "x\n");
    note("Notes/Ref.md", "bare [[Old]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
    });
    expect(res.references.basename).toBe(BASENAME_REWRITE.applied);
    expect(read("Notes/Ref.md")).toContain("[[New]]");
  });
});

describe("index evidence on a plan-only run (7)", () => {
  test("an existing index is reported unchanged, not stale", async () => {
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const config = resolveSearchConfig({ vault });
    const store = await Store.open(config, { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();

    const planned = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
    });
    expect(planned.applied).toBe(false);
    expect(planned.references.index.state).toBe(INDEX_EVIDENCE.unchanged);
    expect(planned.references.index.lastIndexedAt).toBe("2026-08-15T00:00:00.000Z");

    // The very same vault, applied: now something DID happen to it.
    const applied = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });
    expect(applied.references.index.state).toBe(INDEX_EVIDENCE.stale);
  });
});

describe("the append-only observation log (8)", () => {
  test("is reported as an inbound reference and never rewritten", async () => {
    note("Projects/Old.md", "x\n");
    note("Brain/log/2026-08-15.md", "- agent said [[Projects/Old]] at 10:00\n");
    note("Notes/Ref.md", "see [[Projects/Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    // The disclosure stands...
    expect(res.references.inboundFiles).toContain("Brain/log/2026-08-15.md");
    // ...and the record does not change.
    expect(read("Brain/log/2026-08-15.md")).toBe("- agent said [[Projects/Old]] at 10:00\n");
    expect(res.references.filesRewritten).toBe(1);
    expect(read("Notes/Ref.md")).toContain("[[Projects/New]]");
  });
});

describe("the count guard and the note's own self-reference (10)", () => {
  test("counts the file the rewrite pass will write, so expect:0 is refused", async () => {
    note("Projects/Old.md", "this note links to itself: [[Projects/Old]]\n");

    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        expect: 0,
      }),
    ).rejects.toThrow(CountGuardError);
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
      expect: 1,
    });
    expect(res.references.filesRewritten).toBe(1);
    expect(read("Projects/New.md")).toContain("[[Projects/New]]");
  });

  test("a delete still excludes its own file, which strands nothing", async () => {
    note("Projects/Gone.md", "self [[Projects/Gone]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
      expect: 0,
    });
    expect(res.references.inboundFiles).toEqual([]);
  });
});

describe("a directory named like a note (11)", () => {
  test("is a typed source_missing, not a raw EISDIR", async () => {
    mkdirSync(join(vault, "Projects", "Folder.md"), { recursive: true });

    const attempt = noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Folder.md",
      to: "Projects/Other.md",
      apply: true,
    });
    await expect(attempt).rejects.toThrow(NoteLifecycleError);
    await expect(attempt).rejects.toMatchObject({ code: "source_missing" });
    expect(existsSync(join(vault, "Projects/Folder.md"))).toBe(true);
  });

  test("holds for a delete as well", async () => {
    mkdirSync(join(vault, "Projects", "Folder.md"), { recursive: true });
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: "Projects/Folder.md",
        apply: true,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "source_missing" });
  });
});

describe("a destination naming the same entry as the source (12)", () => {
  test("is renamed rather than refused as occupied", async () => {
    // On a case-insensitive filesystem `Old.md` and `OLD.md` ARE one
    // entry, which is what makes a capitalisation fix impossible there.
    // A hard link is the same shape on Linux: two names, one inode, so
    // `existsSync(destination)` is true and nothing is occupying it.
    note("Projects/Old.md", "the only copy\n");
    linkSync(join(vault, "Projects/Old.md"), join(vault, "Projects/Alias.md"));

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/Alias.md",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.to).toBe("Projects/Alias.md");
    expect(read("Projects/Alias.md")).toBe("the only copy\n");
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(false);
  });

  test("a genuinely different file at the destination is still refused", async () => {
    note("Projects/Old.md", "old\n");
    note("Projects/New.md", "occupied\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "destination_occupied" });
    expect(read("Projects/New.md")).toBe("occupied\n");
  });
});

describe("the recoverability verdict of a relocation (14)", () => {
  test("an in-place rewrite of a user note is not nothing_at_risk", async () => {
    note("Projects/Old.md", "x\n");
    note("Notes/Handwritten.md", "Handwritten log. See [[Projects/Old]] for details.\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    // The file was overwritten and nothing regenerates a user's prose.
    expect(read("Notes/Handwritten.md")).toContain("[[Projects/New]]");
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(res.recoverability.blockers).toContain("no_recovery_point");
    expect(res.recoverability.blockers).toContain("outside_brain_root");
    expect(res.recoverability.coverage).toEqual([]);
  });

  test("a rewrite confined to Brain/ names that region and not the other", async () => {
    note("Projects/Old.md", "x\n");
    note("Brain/reports/weekly.md", "see [[Projects/Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(res.recoverability.blockers).toContain("no_recovery_point");
    expect(res.recoverability.blockers).not.toContain("outside_brain_root");
  });

  test("a relocation that rewrites nothing destroys nothing, and says so", async () => {
    note("Projects/Old.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
  });

  test("a plan-only run wrote nothing, so nothing was at risk", async () => {
    note("Projects/Old.md", "x\n");
    note("Notes/Handwritten.md", "see [[Projects/Old]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
    });
    expect(res.applied).toBe(false);
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
    // The warning a caller needs before applying is the file list, and
    // it is there.
    expect(res.references.inboundFiles).toEqual(["Notes/Handwritten.md"]);
  });
});
