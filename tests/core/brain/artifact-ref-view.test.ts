/**
 * The reference grammar both rules ask through
 * (`src/core/brain/artifact-ref-view.ts`).
 *
 * `visible()` reads a reference that resolves to no artifact on disk as
 * "this row names nothing that could be hidden" and lets the row
 * through. That reading is only true for the spellings the resolver
 * would have FOUND had the artifact existed - so every spelling it
 * cannot resolve is a fail-open, on a rule whose whole posture is
 * fail-closed. These are the spellings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactRefView } from "../../../src/core/brain/artifact-ref-view.ts";
import { logEntryArtifactRefs } from "../../../src/core/brain/log.ts";
import type { BrainLogEntry } from "../../../src/core/brain/log.ts";

const HIDDEN_ID = "pref-hidden";
const HIDDEN_REL = `Brain/preferences/${HIDDEN_ID}.md`;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-artifact-ref-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  writeFileSync(join(vault, HIDDEN_REL), "---\ntopic: hidden\n---\n\nthe rule\n");
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

/** A view that hides exactly the one page above, and nothing else. */
const hidingView = () => artifactRefView(vault, (rel) => rel !== HIDDEN_REL);

describe("reference spellings the rule must resolve", () => {
  const SPELLINGS: ReadonlyArray<{ readonly ref: string; readonly why: string }> = [
    { ref: HIDDEN_ID, why: "the bare id" },
    { ref: `[[${HIDDEN_ID}]]`, why: "the wikilink form" },
    { ref: HIDDEN_REL, why: "the vault-relative path" },
    { ref: `[[${HIDDEN_REL}]]`, why: "the path as a wikilink" },
    { ref: `[[${HIDDEN_ID}|the rule]]`, why: "an ALIASED wikilink" },
    { ref: `[[${HIDDEN_ID}#Raw]]`, why: "an ANCHORED wikilink" },
    { ref: `[[${HIDDEN_REL}|the rule]]`, why: "an aliased PATH wikilink" },
    { ref: `${HIDDEN_ID}|the rule`, why: "decoration with no brackets left on it" },
  ];

  for (const { ref, why } of SPELLINGS) {
    test(`${why} resolves to the hidden page and is withheld`, () => {
      expect(hidingView().visible(ref), why).toBe(false);
    });
  }

  test("a reference that genuinely names nothing still passes", () => {
    const view = hidingView();
    expect(view.visible("pref-never-existed")).toBe(true);
    expect(view.visible("[[pref-never-existed|alias]]")).toBe(true);
    expect(view.visible(null)).toBe(true);
    expect(view.visible(undefined)).toBe(true);
    expect(view.visible("")).toBe(true);
  });

  test("a row survives only when every reference it names survives", () => {
    const view = hidingView();
    expect(view.row("pref-other", HIDDEN_ID)).toBe(false);
    expect(view.row("pref-other", "pref-another")).toBe(true);
  });
});

describe("the vault path as the caller spelled it", () => {
  // A bare id is resolved to a file under the vault and then handed to the
  // rule as a vault-relative path. The vault a surface was configured with
  // is not always canonical; the relative path must not depend on that.
  const SPELLINGS: ReadonlyArray<{ readonly spell: () => string; readonly why: string }> = [
    { spell: () => `${vault}/`, why: "a trailing separator" },
    { spell: () => join(vault, "Brain") + "/..", why: "a `..` segment" },
    { spell: () => `${vault}/./`, why: "a `.` segment" },
  ];

  for (const { spell, why } of SPELLINGS) {
    test(`a bare id under a vault spelled with ${why} is still withheld`, () => {
      const view = artifactRefView(spell(), (rel) => rel !== HIDDEN_REL);
      expect(view.visible(HIDDEN_ID)).toBe(false);
    });
  }
});

describe("what a log entry offers the rule", () => {
  const entry = (body: Record<string, unknown>): BrainLogEntry =>
    ({
      timestamp: "2026-05-04T00:00:00Z",
      eventType: "apply-evidence",
      body,
    }) as unknown as BrainLogEntry;

  test("a key outside the old four-name list is still offered", () => {
    // `target`, `subject_a`, `successor`, `source_path` and the rest are
    // real writer keys in this tree; the enumeration that omitted them
    // made their rows unconditionally visible.
    for (const key of ["target", "subject_a", "successor", "predecessor", "source_path", "note"]) {
      expect(hidingView().keep([entry({ [key]: HIDDEN_ID })], logEntryArtifactRefs)).toEqual([]);
    }
  });

  test("an ARRAY-valued payload is flattened rather than dropped", () => {
    // `parseLogDay` produces an array whenever a key repeats or uses the
    // indented sub-bullet form, and a `typeof === "string"` test answered
    // `undefined` for exactly those.
    const rows = [entry({ path: ["notes/open.md", HIDDEN_ID] })];
    expect(hidingView().keep(rows, logEntryArtifactRefs)).toEqual([]);
  });

  test("a row naming nothing hidden is kept, so the widening is not blanket-denying", () => {
    const rows = [entry({ path: "notes/open.md", detail: "some prose about a rule" })];
    expect(hidingView().keep(rows, logEntryArtifactRefs)).toEqual(rows);
  });
});

describe("an extensionless vault-page spelling", () => {
  const HIDDEN_PAGE_REL = "Brain/notes/private";
  const OPEN_PAGE_REL = "Brain/notes/open";

  beforeEach(() => {
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    writeFileSync(join(vault, `${HIDDEN_PAGE_REL}.md`), "---\ntopic: hidden\n---\n\nhidden\n");
    writeFileSync(join(vault, `${OPEN_PAGE_REL}.md`), "open page\n");
  });

  /** A view that hides exactly the hidden notes page above. */
  const hidingNotesPage = () => artifactRefView(vault, (rel) => rel !== `${HIDDEN_PAGE_REL}.md`);

  test("resolves to the same target as its .md form and is withheld", () => {
    // A gate that resolved only the .md form failed OPEN for the bare
    // wikilink shape - the conventional Obsidian spelling.
    const view = hidingNotesPage();
    expect(view.visible("[[Brain/notes/private]]")).toBe(false);
    expect(view.visible("Brain/notes/private")).toBe(false);
    expect(view.visible(`[[${HIDDEN_PAGE_REL}.md]]`)).toBe(false);
  });

  test("a readable page stays visible under the extensionless spelling", () => {
    expect(hidingNotesPage().visible("[[Brain/notes/open]]")).toBe(true);
  });

  test("the bare spelling wins when that file exists, as the write side resolves it", () => {
    // One extensionless file beside its .md twin: the bare candidate is
    // the page the reference names - the same first-existing rule the
    // ingest window resolver applies - so hiding one does not hide the
    // other.
    writeFileSync(join(vault, "Brain", "notes", "dual"), "bare twin\n");
    const view = artifactRefView(vault, (rel) => rel !== "Brain/notes/dual");
    expect(view.visible("[[Brain/notes/dual]]")).toBe(false);
    expect(view.visible("[[Brain/notes/dual.md]]")).toBe(true);
  });

  test("a spelling naming no page names nothing here, and stays visible", () => {
    // A convention like `Notes/<slug>-applied` in a log payload is not a
    // page: with neither candidate on disk the reference resolves to
    // nothing and the row keeps today's visibility, instead of inheriting
    // the verdict of the missing `.md` page it used to resolve to. The
    // rule therefore hides that twin too - the verdict the reference must
    // NOT inherit now that it names nothing.
    const view = artifactRefView(
      vault,
      (rel) => rel !== `${HIDDEN_PAGE_REL}.md` && rel !== "Brain/notes/never-written.md",
    );
    expect(view.visible("[[Brain/notes/never-written]]")).toBe(true);
    expect(view.visible("Brain/notes/never-written")).toBe(true);
  });

  test("a bare spelling naming a directory is never judged as a page", () => {
    // The bare candidate must be a regular file: a directory the rule
    // withholds (Brain/inbox, a convention folder) is not a page, and a
    // reference to it keeps today's visibility instead of dropping the
    // rows that carry it.
    mkdirSync(join(vault, "Brain", "notes", "shaped"), { recursive: true });
    const view = artifactRefView(
      vault,
      (rel) => rel !== `${HIDDEN_PAGE_REL}.md` && rel !== "Brain/notes/shaped",
    );
    expect(view.visible("[[Brain/notes/shaped]]")).toBe(true);
    expect(view.visible("Brain/notes/shaped")).toBe(true);
  });

  test("a bare id spelling is never read as a path", () => {
    // Ids keep the artifact-directory resolution: an extensionless id
    // that resolves to no artifact still names nothing.
    expect(hidingView().visible("pref-never-existed")).toBe(true);
  });
});

describe("a reference that leaves the vault", () => {
  test("is hidden without asking the rule, so nothing beside the vault is read", () => {
    const asked: string[] = [];
    const view = artifactRefView(vault, (rel) => {
      asked.push(rel);
      return true;
    });
    expect(view.visible("../outside.md")).toBe(false);
    expect(view.visible("[[../../outside.md]]")).toBe(false);
    expect(view.visible("Notes/../../outside.md")).toBe(false);
    expect(asked).toEqual([]);
    expect(view.visible("notes/inside.md")).toBe(true);
    expect(asked).toEqual(["notes/inside.md"]);
  });
});
