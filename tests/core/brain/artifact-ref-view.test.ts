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
