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
 *  15. a bare-name repair derived its reported `to` spelling from a
 *      third-party note without asking whether the caller may read that
 *      note, so a restricted caller's report named a page withheld from
 *      it.
 *  16. the repair rules joined the destination-collapsing rules in one
 *      ordered reduce, so a repair rule whose `from` was the
 *      destination's own bare basename rewrote the spellings the main
 *      pass had JUST written - repointing the renamed note's inbound
 *      links onto an unrelated note.
 *  17. the counting probe matched only the moved note's own spellings,
 *      so the files the repair pass writes were absent from the plan's
 *      `inbound_files` and from `--expect`'s number.
 *  18. the forced post-write refresh spawned no matter how young the
 *      index stamp was, so writes arriving in a steady stream chained
 *      one detached indexer run after another forever.
 *  19. a refused refresh claim recorded nothing on the diagnostic when
 *      the freshen machinery answered with a skip token instead of
 *      throwing, and one transient failure read as broken forever
 *      because a successful claim never cleared the slot.
 *  20. the reason a refused refresh gave lived only in a process-global
 *      that no production surface rendered - and in a multi-vault server
 *      that global could answer one vault's reason for another. The
 *      reason now travels on the report that refused, as
 *      `references.refresh_reason`, read from that call's own decision.
 *  21. the renamed note's own bare `[[Old]]` links were withheld from
 *      the rewrite whenever the DESTINATION basename was contested -
 *      sound when the target was the bare basename, but the rewrite now
 *      aims at the minimal spelling, which is unambiguous by
 *      construction. The withholding broke links that resolved before
 *      the move. The bare pair is now emitted whenever `[[Old]]`
 *      uniquely resolved to the source before it, and is withheld only
 *      for a nested source the bare spelling never uniquely named.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  BASENAME_REWRITE,
  INDEX_EVIDENCE,
  INDEX_REFRESH,
  NOTE_LIFECYCLE_ACTION,
  noteLifecycle,
  NoteLifecycleError,
} from "../../../../src/core/brain/notes/lifecycle.ts";
import { RECOVERABILITY_STATE } from "../../../../src/core/brain/gates/recoverability.ts";
import { CountGuardError } from "../../../../src/core/brain/count-guard.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFreshenState } from "../../../../src/core/search/freshen.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

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
  mock.restore();
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
  // chmod cannot make a directory refuse new files on Windows (or as root).
  test.skipIf(CHMOD_CANNOT_DENY)(
    "returns a result that names the split point instead of throwing",
    async () => {
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
      expect(read("Aaa/Ref.md")).toContain("[[New]]");
      expect(read("Docs/Ref.md")).toContain("[[Projects/Old]]");
    },
  );

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
  test("repairs the third-party bare spelling the rename turns from unique to ambiguous, and rewrites the moved note's own", async () => {
    note("A/Old.md", "x\n");
    note("B/New.md", "a different note that already owns the name\n");
    note("Notes/Ref.md", "bare [[Old]] and bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
    });

    // `[[New]]` named exactly one note (B/New.md) before the rename and
    // two nested carriers after it: the repair re-points it to the
    // shortest spelling of its pre-rename target that still resolves.
    // `[[Old]]` named the moved note - the only carrier there was - so
    // it is rewritten TOO, aimed at the minimal spelling of the
    // destination, which is unambiguous by construction: with B/New.md
    // standing, that spelling is `A/New`, and the link resolves to the
    // same note it named before the move (21).
    expect(res.references.basename).toBe(BASENAME_REWRITE.applied);
    const ref = read("Notes/Ref.md");
    expect(ref).toBe("bare [[A/New]] and bare [[B/New]]\n");
    expect(res.references.rewrittenSpellings).toContainEqual({ from: "Old", to: "A/New" });
    expect(res.references.rewrittenSpellings).toContainEqual({ from: "New", to: "B/New" });
  });

  test("the review's scenario: a contested destination basename no longer strands the moved note's own bare links", async () => {
    // A/Old.md, B/Foo.md, and X.md holding `[[Old]] [[Foo]]`. Renaming
    // A/Old.md to A/Foo.md used to leave `[[Old]]` dangling: the old
    // rule withheld the bare rewrite because `Foo` was contested, even
    // though the rewrite target is the minimal spelling `A/Foo`, which
    // is unambiguous by construction. `[[Old]]` named exactly one note
    // before the move; after it, both of X's links resolve.
    note("A/Old.md", "x\n");
    note("B/Foo.md", "a different note that already owns the name\n");
    note("X.md", "[[Old]] [[Foo]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/Foo.md",
      apply: true,
    });

    expect(read("X.md")).toBe("[[A/Foo]] [[B/Foo]]\n");
    // Both rewrites are on the report: the third-party repair first,
    // then the moved note's own bare spelling onto the minimal form.
    expect(res.references.rewrittenSpellings).toContainEqual({ from: "Foo", to: "B/Foo" });
    expect(res.references.rewrittenSpellings).toContainEqual({ from: "Old", to: "A/Foo" });
  });

  test("an already-ambiguous bare spelling stays untouched, and a dangling one is not adopted", async () => {
    note("A/Old.md", "x\n");
    note("C/Old.md", "a second carrier of the old name\n");
    note("Notes/Ref.md", "bare [[Old]] and bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
    });

    // `[[Old]]` named one of TWO notes before the move - unprovable
    // which, so nothing may rewrite it. `[[New]]` had no carrier before
    // the move; that it resolves NOW is luck, and adopting a link that
    // never resolved here would be a guess dressed as a repair.
    expect(res.references.basename).toBe(BASENAME_REWRITE.ambiguous);
    expect(read("Notes/Ref.md")).toBe("bare [[Old]] and bare [[New]]\n");
  });

  test("a single TOP-LEVEL carrier keeps owning the bare spelling, so no repair fires", async () => {
    note("A/Old.md", "x\n");
    note("New.md", "the top-level owner of the name\n");
    note("Notes/Ref.md", "bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
    });

    // The ladder's exact-path rung hands `New` to the top-level note
    // before any carrier counting starts, whatever the nested count
    // becomes - the resolution did not change, so the link must not.
    expect(read("Notes/Ref.md")).toBe("bare [[New]]\n");
    expect(res.references.rewrittenSpellings.some((pair) => pair.from === "New")).toBe(false);
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

describe("the refresh claim beside the index evidence (7)", () => {
  test("a claimed refresh does not pretend the index has already caught up", async () => {
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const store = await Store.open(resolveSearchConfig({ vault }), { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();
    // Freshen ON, the stamp far older than any interval: this write
    // claims the detached refresh.
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "60";
    let res;
    try {
      res = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        refreshSpawn: () => {},
      });
    } finally {
      process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = saved ?? "0";
    }
    expect(res.references.refresh).toBe(INDEX_REFRESH.claimed);
    // The claim says a run is IN FLIGHT, nothing more: the evidence
    // still reports the pre-refresh stamp and the stale state, and the
    // next command stays on the report.
    expect(res.references.index.state).toBe(INDEX_EVIDENCE.stale);
    expect(res.references.index.lastIndexedAt).toBe("2026-08-15T00:00:00.000Z");
    expect(res.references.index.nextCommand.length).toBeGreaterThan(0);
  });
});

describe("the refresh claim decision on the injected clock", () => {
  test("a backoff ahead of input.now is honoured even though the wall clock has passed it", async () => {
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const config = resolveSearchConfig({ vault });
    const store = await Store.open(config, { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();
    // A failed run left a backoff that ended in 2021: long behind the
    // wall clock this suite runs at, and still ahead of the instant the
    // caller injects below. The claim decision has to be made on THAT
    // instant - a deterministic run may not have its behaviour moved by
    // whichever wall clock happens to execute it.
    writeFreshenState(dirname(config.dbPath), {
      failures: 1,
      backoffUntil: "2021-01-01T00:00:00.000Z",
      lastOutcome: "failed",
      lastRunAt: "2020-12-01T00:00:00.000Z",
      lastDurationMs: 5,
      lastError: "injected failure",
      lastChanged: null,
    });
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "60";
    let res;
    try {
      res = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        now: new Date("2020-06-01T00:00:00.000Z"),
        refreshSpawn: () => {},
      });
    } finally {
      process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = saved ?? "0";
    }
    // Under the injected instant the failure backoff is still active, so
    // the forced refresh refuses: force skips the freshness interval
    // gate only, and the backoff stands. Deciding on the wall clock
    // instead would spawn right past a refusal the caller's own timeline
    // says is active.
    expect(res.references.refresh).toBe(INDEX_REFRESH.notClaimed);
  });
});

describe("a refresh claim whose machinery raises", () => {
  // This runner's mock registration outlives mock.restore() across test
  // FILES, so the teardown re-registers the REAL module object instead:
  // whatever leaks past this file is freshen.ts itself, byte for byte.
  const FRESHEN_MODULE = "../../../../src/core/search/freshen.ts";
  let realFreshen: Record<string, unknown> | null = null;

  afterEach(() => {
    if (realFreshen !== null) mock.module(FRESHEN_MODULE, () => realFreshen);
    mock.restore();
    realFreshen = null;
  });

  test("still answers not_claimed, and the report names the failure (20)", async () => {
    // Force the freshen machinery to raise when the claim invokes it -
    // the shape of a permanently broken freshen path, as opposed to one
    // deliberately configured off. The token stays `not_claimed` either
    // way (the public vocabulary does not grow for this), but the old
    // bare catch swallowed the distinction entirely: a broken spawn was
    // indistinguishable from a disabled one. The reason now lands on the
    // result itself, read from THIS call's decision - never from a
    // process-global another vault could have written.
    realFreshen = { ...(await import(FRESHEN_MODULE)) };
    mock.module(FRESHEN_MODULE, () => ({
      maybeFreshenIndex: () => {
        throw new Error("freshen machinery exploded");
      },
    }));
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const store = await Store.open(resolveSearchConfig({ vault }), { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
      refreshSpawn: () => {},
    });

    expect(res.references.refresh).toBe(INDEX_REFRESH.notClaimed);
    expect(res.applied).toBe(true);
    expect(res.references.refreshReason).toBe("freshen machinery exploded");
  });

  test("a refusal that answers instead of throwing names its skip token, and a later success clears it (19)", async () => {
    // The freshen machinery refuses INSIDE itself - a spawn that failed
    // there answers with a skip token and does not throw - so the bare
    // catch above never ran for it: the diagnostic stayed empty and a
    // broken freshen path was indistinguishable from a silent one.
    realFreshen = { ...(await import(FRESHEN_MODULE)) };
    mock.module(FRESHEN_MODULE, () => ({
      maybeFreshenIndex: () => "spawn_failed",
    }));
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const stampIndex = async (): Promise<void> => {
      const store = await Store.open(resolveSearchConfig({ vault }), { mode: "write" });
      store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
      await store.close();
    };
    await stampIndex();

    const refused = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
      refreshSpawn: () => {},
    });

    expect(refused.references.refresh).toBe(INDEX_REFRESH.notClaimed);
    // The skip token IS the reason: it lands on the report verbatim.
    expect(refused.references.refreshReason).toBe("spawn_failed");

    // And a claim that succeeds carries no reason, so one transient
    // refusal is not misread later as a permanently broken freshen path.
    mock.module(FRESHEN_MODULE, () => realFreshen!);
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "60";
    try {
      await stampIndex();
      const claimed = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/New.md",
        to: "Projects/Newer.md",
        apply: true,
        refreshSpawn: () => {},
      });
      expect(claimed.references.refresh).toBe(INDEX_REFRESH.claimed);
      expect(claimed.references.refreshReason).toBeNull();
    } finally {
      process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = saved ?? "0";
    }
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

describe("a repair derived from a page the caller may not read (15)", () => {
  test("is applied for the readers who can see it, but names no pair in the report", async () => {
    note("A/Old.md", "x\n");
    note("B/New.md", "a different note that already owns the name\n");
    note("Notes/Ref.md", "bare [[Old]] and bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
      readable: (rel) => rel !== "B/New.md",
    });

    // The REPAIR pair was derived from the carrier of the contested
    // basename. That carrier is withheld here, so the report answers as
    // a vault without the page would: no `to` naming it.
    expect(res.references.rewrittenSpellings).not.toContainEqual({ from: "New", to: "B/New" });
    // The moved note's OWN bare rewrite is different: its pair derives
    // from the paths the caller itself supplied, so it is applied AND
    // reported (21) - and the file on disk carries both rewrites.
    expect(res.references.rewrittenSpellings).toContainEqual({ from: "Old", to: "A/New" });
    // The repair itself still ran - the readers who CAN see the carrier
    // are not left with a spelling that resolves to neither note.
    expect(read("Notes/Ref.md")).toBe("bare [[A/New]] and bare [[B/New]]\n");
  });

  test("a caller who may read the carrier keeps the pair", async () => {
    note("A/Old.md", "x\n");
    note("B/New.md", "a different note that already owns the name\n");
    note("Notes/Ref.md", "bare [[Old]] and bare [[New]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
      readable: () => true,
    });

    expect(res.references.rewrittenSpellings).toContainEqual({ from: "New", to: "B/New" });
  });
});

describe("a destination-collapsing pass that chained into the repair rules (16)", () => {
  test("a repair rule never rewrites a link the main pass just produced", async () => {
    note("Projects/Widget.md", "x\n");
    note("Docs/Old.md", "the sole carrier of the contested bare name\n");
    note("Notes/Ref.md", "[[Projects/Widget]] and [[Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.move,
      path: "Projects/Widget.md",
      to: "Old.md",
      apply: true,
    });

    // The first link names the moved note, now at Old.md; the second
    // names the note that always lived at Docs/Old.md. Chained rules
    // collapsed both onto Docs/Old - every inbound reference to the
    // renamed note repointed at a note it never named.
    expect(read("Notes/Ref.md")).toBe("[[Old]] and [[Docs/Old]]\n");
    expect(res.references.filesRewritten).toBe(1);
  });
});

describe("the plan's blast radius covers the repair pass (17)", () => {
  test("a file mentioning only the contested basename is listed on the plan", async () => {
    note("A/Old.md", "x\n");
    note("B/New.md", "a different note that already owns the name\n");
    note("Notes/Ref.md", "pathed [[A/Old]]\n");
    note("Notes/Casualty.md", "See [[New]].\n");

    const planned = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
    });

    expect(planned.applied).toBe(false);
    expect(planned.references.inboundFiles).toContain("Notes/Casualty.md");
    expect(planned.references.inboundFiles).toContain("Notes/Ref.md");
    expect(existsSync(join(vault, "Notes/Casualty.md"))).toBe(true);

    // And the apply does exactly what the plan listed: both files are
    // rewritten, so the plan's number is the number `--expect` guards.
    const applied = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "A/Old.md",
      to: "A/New.md",
      apply: true,
      expect: 2,
    });
    expect(applied.references.filesRewritten).toBe(2);
    expect(read("Notes/Casualty.md")).toBe("See [[B/New]].\n");
  });
});

describe("the forced refresh against the write's own instant (18)", () => {
  test("an index stamped after the write began still claims this write's run", async () => {
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const store = await Store.open(resolveSearchConfig({ vault }), { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();
    // Freshen ON, and the write's own clock is BEFORE the stamp. The
    // stamp still claims nothing about this write: it marks when a run
    // FINISHED, and a run that finished after the write began may have
    // scanned before the write landed - so a stamp cannot prove the
    // index has seen the write, and a floor that skipped on one would
    // silently leave this write unindexed until the next interval or
    // the next write. The claim therefore spawns.
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "60";
    const spawned: string[][] = [];
    try {
      const res = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        now: new Date("2026-08-01T00:00:00.000Z"),
        refreshSpawn: (argv: string[]) => spawned.push(argv),
      });
      expect(res.references.refresh).toBe(INDEX_REFRESH.claimed);
    } finally {
      // Restore whatever the environment ACTUALLY held, including its
      // absence - writing "0" back when the variable was unset leaks a
      // freshen setting onto every follower test file in the process.
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
      else process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = saved;
    }
    expect(spawned).toHaveLength(1);
  });

  test("a write that began after the last stamp still claims its refresh", async () => {
    note("Projects/Old.md", "x\n");
    const { resolveSearchConfig } = await import("../../../../src/core/search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } =
      await import("../../../../src/core/search/store.ts");
    const store = await Store.open(resolveSearchConfig({ vault }), { mode: "write" });
    store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
    await store.close();
    // The ordinary post-write shape: the stamp predates the write, so
    // the index has not seen the write and the claim must spawn.
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "60";
    const spawned: string[][] = [];
    try {
      const res = await noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        now: new Date("2026-09-01T00:00:00.000Z"),
        refreshSpawn: (argv: string[]) => spawned.push(argv),
      });
      expect(res.references.refresh).toBe(INDEX_REFRESH.claimed);
    } finally {
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"];
      else process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = saved;
    }
    expect(spawned).toHaveLength(1);
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
    expect(read("Notes/Ref.md")).toContain("[[New]]");
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
    expect(read("Projects/New.md")).toContain("[[New]]");
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
    expect(read("Notes/Handwritten.md")).toContain("[[New]]");
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
