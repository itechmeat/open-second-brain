/**
 * `--delete-linked`: a note delete that may also remove the files whose
 * whole reason to exist was that note (unit 3a / t_5e338af1).
 *
 * The defect this closes. A note delete removes one file and reports the
 * inbound references it strands. When the note was an imported source,
 * those references are not navigation aids - they are a summary page, a
 * signal and a preference that say nothing except what that note said, and
 * an operator removing the note had to hand-chase every one of them. The
 * remedy already exists for the ingest side (`deleteBySource`) and is
 * deliberately narrow, and that narrowness is the whole design: only a
 * single-purpose derived file tracing SOLELY to the subject is ever
 * deleted; anything else that merely references it is REPORTED.
 *
 * Claims pinned here:
 *
 *  1. Without the flag, delete is byte-identical to before: no cascade is
 *     computed and no derived file is touched.
 *  2. A dry run with the flag lists the deletion set (the note plus its
 *     solely-derived files) and the report-only references SEPARATELY, and
 *     writes nothing.
 *  3. The derived-set fold walks `Brain/` and SAYS SO on the response, so a
 *     caller can tell a scope boundary from an empty result - user notes
 *     are outside the fold by construction and are reported, never deleted.
 *  4. A Brain page citing a SECOND source is reported and preserved, even
 *     under confirm. The module header's commitment - a delete rewrites
 *     nothing and reports what it strands - stands for everything outside
 *     the solely-derived set.
 *  5. Confirm removes exactly the listed set, behind ONE recovery point
 *     covering the Brain half of it, with the verdict saying that the note
 *     itself is outside every archive.
 *  6. The count guard asserts the DELETION SET size under the flag (not the
 *     inbound-reference count), and a mismatch aborts before any unlink.
 *  7. The flag belongs to delete alone; on any other action it is refused
 *     by name rather than ignored.
 *  8. A Brain page that only MENTIONS the note - a `[[wikilink]]` in prose
 *     and no `source:` array - is reported and never deleted, however
 *     derived-looking the directory it sits in. The solely-derived test is
 *     vacuously true for a page declaring no provenance at all, so the
 *     cascade demands declared provenance on top of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  DERIVED_SET_SCOPE,
  NOTE_LIFECYCLE_ACTION,
  noteLifecycle,
  NoteLifecycleError,
} from "../../../../src/core/brain/notes/lifecycle.ts";
import { CountGuardError } from "../../../../src/core/brain/count-guard.ts";
import { RECOVERABILITY_STATE } from "../../../../src/core/brain/gates/recoverability.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

const TARGET = "Imports/Benchmark.md";
const OTHER = "Imports/Legit.md";
const NOW = new Date("2026-06-01T00:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-delete-linked-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-delete-linked-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A vault where the note under test has one solely-derived signal, one
 * preference folded from it, one signal that also cites a second note, and
 * one ordinary user note that merely links to it.
 */
function seed(): { solelyDerived: string; shared: string } {
  note(TARGET, "---\ntitle: Benchmark\n---\n\nrows\n");
  note(OTHER, "---\ntitle: Legit\n---\n\nprose\n");
  note("Projects/Reader.md", `See [[${"Imports/Benchmark"}]] for the numbers.\n`);

  const solely = writeSignal(vault, {
    topic: "bench",
    signal: "positive",
    agent: "tester",
    principle: "Only the benchmark note says this.",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "bench-only",
    source: ["[[Imports/Benchmark]]"],
  });
  const shared = writeSignal(vault, {
    topic: "bench",
    signal: "positive",
    agent: "tester",
    principle: "Two notes say this.",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "bench-shared",
    source: ["[[Imports/Benchmark]]", "[[Imports/Legit]]"],
  });
  writePreference(vault, {
    slug: "bench-pref",
    topic: "bench",
    principle: "Folded from the benchmark signal alone.",
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-06-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [`[[${solely.id}]]`],
  });
  return { solelyDerived: solely.path, shared: shared.path };
}

/** `Brain/inbox/sig-x.md` from an absolute path. */
function vaultRel(abs: string): string {
  return abs
    .slice(vault.length + 1)
    .split("\\")
    .join("/");
}

describe("the flag is opt-in", () => {
  test("a delete without it computes no cascade and touches no derived file", async () => {
    const { solelyDerived } = seed();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      apply: true,
      confirm: true,
      now: NOW,
    });
    expect(res.cascade).toBeNull();
    expect(existsSync(solelyDerived)).toBe(true);
  });

  test("it is refused by name on an action that is not a delete", async () => {
    seed();
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: TARGET,
        to: "Imports/Renamed.md",
        deleteLinked: true,
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(existsSync(join(vault, TARGET))).toBe(true);
  });
});

describe("the dry run", () => {
  test("lists the deletion set and the report-only references separately", async () => {
    const { solelyDerived, shared } = seed();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      now: NOW,
    });

    expect(res.applied).toBe(false);
    expect(res.cascade).not.toBeNull();
    const cascade = res.cascade!;
    // The note itself is first; the derived files follow, sorted.
    expect(cascade.deletionSet[0]).toBe(TARGET);
    expect(cascade.deletionSet).toContain(vaultRel(solelyDerived));
    // The preference folded solely from that signal rides along.
    expect(cascade.deletionSet.some((p) => p.includes("pref-bench-pref"))).toBe(true);
    // The shared signal and the user note are reported, never in the set.
    expect(cascade.deletionSet).not.toContain(vaultRel(shared));
    expect(cascade.reportedFiles).toContain(vaultRel(shared));
    expect(cascade.reportedFiles).toContain("Projects/Reader.md");
    // Nothing overlaps: a path is either deleted or reported, never both.
    for (const path of cascade.reportedFiles) {
      expect(cascade.deletionSet).not.toContain(path);
    }
    // And nothing was written.
    expect(existsSync(join(vault, TARGET))).toBe(true);
    expect(existsSync(solelyDerived)).toBe(true);
    expect(res.snapshot).toBeNull();
  });

  test("names the scope the derived-set fold actually walked", async () => {
    seed();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      now: NOW,
    });
    expect(res.cascade!.scannedScope).toBe(DERIVED_SET_SCOPE);
    // A user note outside that scope is reported rather than folded in.
    expect(res.cascade!.reportedFiles).toContain("Projects/Reader.md");
  });
});

describe("a prose mention is not a derivation", () => {
  /**
   * A Brain page inside a derivation directory whose only tie to the note
   * is a `[[wikilink]]` in its body: no `source:` array, no `source_path`,
   * nothing declaring where it came from.
   */
  const PROSE_ONLY = "Brain/inbox/sig-2026-06-01-prose-mention.md";

  function seedProseMention(): void {
    note(
      PROSE_ONLY,
      [
        "---",
        "id: sig-2026-06-01-prose-mention",
        "topic: bench",
        "signal: positive",
        "---",
        "",
        "The operator compared this against [[Imports/Benchmark]] once.",
        "",
      ].join("\n"),
    );
  }

  test("the dry run reports it and leaves it out of the deletion set", async () => {
    seed();
    seedProseMention();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      now: NOW,
    });
    expect(res.cascade!.deletionSet).not.toContain(PROSE_ONLY);
    expect(res.cascade!.reportedFiles).toContain(PROSE_ONLY);
  });

  test("confirm leaves it on disk", async () => {
    const { solelyDerived } = seed();
    seedProseMention();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      apply: true,
      confirm: true,
      now: NOW,
    });
    expect(res.applied).toBe(true);
    // The page that DECLARED the note as its source is gone; the one that
    // only wrote its name in a sentence is not.
    expect(existsSync(solelyDerived)).toBe(false);
    expect(existsSync(join(vault, PROSE_ONLY))).toBe(true);
  });
});

describe("confirm", () => {
  test("removes exactly the listed set and preserves every shared reference", async () => {
    const { solelyDerived, shared } = seed();
    const plan = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      now: NOW,
    });
    const planned = [...plan.cascade!.deletionSet];

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      apply: true,
      confirm: true,
      now: NOW,
    });
    expect(res.applied).toBe(true);
    expect([...res.cascade!.deletionSet]).toEqual(planned);
    for (const path of planned) expect(existsSync(join(vault, path))).toBe(false);
    // The shared signal and the user note survive, unrewritten.
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(join(vault, "Projects/Reader.md"))).toBe(true);
    expect(res.references.filesRewritten).toBe(0);
    expect(existsSync(solelyDerived)).toBe(false);
  });

  test("takes ONE recovery point and says what it does not cover", async () => {
    seed();
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      apply: true,
      confirm: true,
      now: NOW,
    });
    expect(res.snapshot).not.toBeNull();
    expect(existsSync(res.snapshot!.path)).toBe(true);
    // The Brain half of the set is inside the archive; the note is not.
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.partial);
    expect(res.recoverability.blockers).toContain("outside_brain_root");
  });
});

describe("the count guard", () => {
  test("asserts the deletion-set size and aborts before any unlink", async () => {
    const { solelyDerived } = seed();
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: TARGET,
        deleteLinked: true,
        apply: true,
        confirm: true,
        expect: 1,
        now: NOW,
      }),
    ).rejects.toThrow(CountGuardError);
    expect(existsSync(join(vault, TARGET))).toBe(true);
    expect(existsSync(solelyDerived)).toBe(true);

    const plan = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      now: NOW,
    });
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: TARGET,
      deleteLinked: true,
      apply: true,
      confirm: true,
      expect: plan.cascade!.deletionSet.length,
      now: NOW,
    });
    expect(res.applied).toBe(true);
  });
});
