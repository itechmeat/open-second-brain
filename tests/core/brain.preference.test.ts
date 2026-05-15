import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrainStatusFolderMismatchError,
  moveToRetired,
  parsePreference,
  parseRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../src/core/brain/preference.ts";
import {
  brainDirs,
  preferencePath,
  retiredPath,
} from "../../src/core/brain/paths.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-pref-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function basePrefInput(
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug: "no-internal-abbrev",
    topic: "no-internal-abbrev",
    principle:
      "Do not use internal abbreviations in user-facing copy unless explained first",
    created_at: "2026-05-14T10:42:00Z",
    unconfirmed_until: "2026-05-28T10:42:00Z",
    status: "unconfirmed",
    evidenced_by: [
      "[[sig-2026-05-13-no-internal-abbrev]]",
      "[[sig-2026-05-14-no-internal-abbrev]]",
    ],
    scope: "writing",
    confirmed_at: null,
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: "low",
    pinned: false,
    howToApply:
      "Expand acronyms on first use in any user-facing copy.",
    ...overrides,
  };
}

describe("writePreference + parsePreference", () => {
  test("parses an unconfirmed preference correctly", () => {
    const res = writePreference(tmp, basePrefInput());
    expect(res.id).toBe("pref-no-internal-abbrev");

    const parsed = parsePreference(res.path);
    expect(parsed.kind).toBe("brain-preference");
    expect(parsed.status).toBe("unconfirmed");
    expect(parsed.confirmed_at).toBeNull();
    expect(parsed.unconfirmed_until).toBe("2026-05-28T10:42:00Z");
    expect(parsed.evidenced_by).toEqual([
      "[[sig-2026-05-13-no-internal-abbrev]]",
      "[[sig-2026-05-14-no-internal-abbrev]]",
    ]);
    expect(parsed.applied_count).toBe(0);
    expect(parsed.violated_count).toBe(0);
    expect(parsed.last_evidence_at).toBeNull();
    expect(parsed.confidence).toBe("low");
    expect(parsed.pinned).toBe(false);
    expect(parsed.scope).toBe("writing");
  });

  test("parses a confirmed preference with counters and last_evidence_at", () => {
    const res = writePreference(
      tmp,
      basePrefInput({
        status: "confirmed",
        confirmed_at: "2026-05-15T14:22:00Z",
        applied_count: 4,
        violated_count: 1,
        last_evidence_at: "2026-05-20T09:10:00Z",
        confidence: "medium",
      }),
    );
    const parsed = parsePreference(res.path);
    expect(parsed.status).toBe("confirmed");
    expect(parsed.confirmed_at).toBe("2026-05-15T14:22:00Z");
    expect(parsed.applied_count).toBe(4);
    expect(parsed.violated_count).toBe(1);
    expect(parsed.last_evidence_at).toBe("2026-05-20T09:10:00Z");
    expect(parsed.confidence).toBe("medium");
  });

  test("defaults `pinned` to false when the frontmatter omits the field entirely", () => {
    // Hand-write a frontmatter without the `pinned` line.
    const dirs = brainDirs(tmp);
    mkdirSync(dirs.preferences, { recursive: true });
    const path = preferencePath(tmp, "no-pin-field");
    const content = [
      "---",
      "kind: brain-preference",
      "id: pref-no-pin-field",
      "created_at: 2026-05-14T10:42:00Z",
      "confirmed_at: null",
      "unconfirmed_until: 2026-05-28T10:42:00Z",
      "tags: [brain, brain/preference, brain/topic/no-pin-field]",
      "topic: no-pin-field",
      "status: unconfirmed",
      "principle: Some rule",
      "evidenced_by: []",
      "applied_count: 0",
      "violated_count: 0",
      "last_evidence_at: null",
      "confidence: low",
      "---",
      "",
      "## Principle",
      "",
      "Some rule",
      "",
    ].join("\n");
    writeFileSync(path, content, "utf8");

    const parsed = parsePreference(path);
    expect(parsed.pinned).toBe(false);
  });

  test("respects pinned: true when explicitly set", () => {
    const res = writePreference(tmp, basePrefInput({ pinned: true }));
    const parsed = parsePreference(res.path);
    expect(parsed.pinned).toBe(true);
  });
});

describe("moveToRetired", () => {
  test("creates a retired file, removes the preference, and stamps retire metadata", () => {
    const written = writePreference(tmp, basePrefInput());
    expect(existsSync(written.path)).toBe(true);

    const now = new Date("2026-08-12T05:00:00Z");
    const result = moveToRetired(tmp, written.path, "stale-no-evidence", {
      now,
      retired_by: "[[Brain/log/2026-08-12]]",
    });

    expect(result.id).toBe("ret-no-internal-abbrev");
    expect(result.path).toBe(retiredPath(tmp, "no-internal-abbrev"));
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(written.path)).toBe(false);

    const parsed = parseRetired(result.path);
    expect(parsed.kind).toBe("brain-retired");
    expect(parsed.id).toBe("ret-no-internal-abbrev");
    expect(parsed.status).toBe("retired");
    expect(parsed.retired_at).toBe("2026-08-12T05:00:00.000Z");
    expect(parsed.retired_reason).toBe("stale-no-evidence");
    expect(parsed.retired_by).toBe("[[Brain/log/2026-08-12]]");
    // Inherited fields preserved.
    expect(parsed.topic).toBe("no-internal-abbrev");
    expect(parsed.principle).toContain("internal abbreviations");
    expect(parsed.evidenced_by).toEqual([
      "[[sig-2026-05-13-no-internal-abbrev]]",
      "[[sig-2026-05-14-no-internal-abbrev]]",
    ]);
    // The tag set rotates `brain/preference` → `brain/retired`.
    expect(parsed.tags).toContain("brain/retired");
    expect(parsed.tags).not.toContain("brain/preference");
  });

  test("optional superseded_by is captured in the retired frontmatter", () => {
    const written = writePreference(tmp, basePrefInput());
    const now = new Date("2026-08-12T05:00:00Z");
    const result = moveToRetired(tmp, written.path, "rebutted", {
      now,
      retired_by: "[[Brain/log/2026-08-12]]",
      superseded_by: "[[pref-newer-rule]]",
    });
    const parsed = parseRetired(result.path);
    expect(parsed.superseded_by).toBe("[[pref-newer-rule]]");
  });

  test("adds the prior pref-<slug> id as an alias so historical [[pref-X]] wikilinks resolve", () => {
    const written = writePreference(tmp, basePrefInput());
    const now = new Date("2026-08-12T05:00:00Z");
    const result = moveToRetired(tmp, written.path, "stale-no-evidence", {
      now,
      retired_by: "[[Brain/log/2026-08-12]]",
    });
    const parsed = parseRetired(result.path);
    expect(parsed.aliases).toBeDefined();
    expect(parsed.aliases).toContain("pref-no-internal-abbrev");
  });

  test("preserves any pre-existing aliases when adding the pref-<slug> alias on retire", () => {
    const written = writePreference(tmp, {
      ...basePrefInput(),
      aliases: ["my-friendly-name", "abbrev-rule"],
    });
    const now = new Date("2026-08-12T05:00:00Z");
    const result = moveToRetired(tmp, written.path, "stale-no-evidence", {
      now,
      retired_by: "[[Brain/log/2026-08-12]]",
    });
    const parsed = parseRetired(result.path);
    expect(parsed.aliases).toEqual([
      "pref-no-internal-abbrev",
      "my-friendly-name",
      "abbrev-rule",
    ]);
  });
});

describe("status-vs-folder mismatch", () => {
  test("file in preferences/ with status=retired triggers BrainStatusFolderMismatchError", () => {
    // Write a hand-crafted file directly to `preferences/` with the
    // wrong status — simulates a half-completed move.
    const dirs = brainDirs(tmp);
    mkdirSync(dirs.preferences, { recursive: true });
    const path = preferencePath(tmp, "broken");
    const content = [
      "---",
      "kind: brain-preference",
      "id: pref-broken",
      "created_at: 2026-05-14T10:42:00Z",
      "confirmed_at: null",
      "unconfirmed_until: 2026-05-28T10:42:00Z",
      "tags: [brain, brain/preference]",
      "topic: broken",
      "status: retired",
      "principle: Hand-crafted mismatch",
      "evidenced_by: []",
      "applied_count: 0",
      "violated_count: 0",
      "last_evidence_at: null",
      "confidence: low",
      "pinned: false",
      "---",
      "",
      "## Principle",
      "",
      "Mismatch",
      "",
    ].join("\n");
    writeFileSync(path, content, "utf8");

    expect(() => parsePreference(path)).toThrow(BrainStatusFolderMismatchError);
    try {
      parsePreference(path);
    } catch (err) {
      expect(err).toBeInstanceOf(BrainStatusFolderMismatchError);
      const e = err as BrainStatusFolderMismatchError;
      expect(e.path).toBe(path);
      expect(e.status).toBe("retired");
      expect(e.folder).toBe("preferences");
    }
  });

  test("file in retired/ with kind=brain-preference (not brain-retired) is rejected by parseRetired", () => {
    // parseRetired requires kind=brain-retired; a stale `pref-` file
    // hand-moved into retired/ should fail early.
    const dirs = brainDirs(tmp);
    mkdirSync(dirs.retired, { recursive: true });
    const path = retiredPath(tmp, "broken");
    const content = [
      "---",
      "kind: brain-preference",
      "id: pref-broken",
      "created_at: 2026-05-14T10:42:00Z",
      "tags: [brain, brain/preference]",
      "topic: broken",
      "status: retired",
      "principle: Hand-crafted mismatch",
      "---",
      "",
    ].join("\n");
    writeFileSync(path, content, "utf8");

    expect(() => parseRetired(path)).toThrow(/kind must be 'brain-retired'/);
  });
});

describe("status enum validation", () => {
  test("parsePreference rejects an unknown status value", () => {
    // A typo / hand-edit should never coerce into BrainPreferenceStatus
    // (`unconfirmed | confirmed`). "retired" remains tolerated because
    // it triggers the dedicated status-folder-mismatch error path.
    const dirs = brainDirs(tmp);
    mkdirSync(dirs.preferences, { recursive: true });
    const path = preferencePath(tmp, "invalid-status");
    const content = [
      "---",
      "kind: brain-preference",
      "id: pref-invalid-status",
      "created_at: 2026-05-14T10:42:00Z",
      "confirmed_at: null",
      "unconfirmed_until: 2026-05-28T10:42:00Z",
      "tags: [brain, brain/preference]",
      "topic: invalid-status",
      "status: hilarious",
      "principle: Hand-crafted invalid status",
      "evidenced_by: []",
      "applied_count: 0",
      "violated_count: 0",
      "last_evidence_at: null",
      "confidence: low",
      "pinned: false",
      "---",
      "",
      "## Principle",
      "",
      "Invalid",
      "",
    ].join("\n");
    writeFileSync(path, content, "utf8");

    expect(() => parsePreference(path)).toThrow(
      /preference status must be one of/,
    );
  });
});
