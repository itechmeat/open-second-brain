/**
 * A parse failure carries its file as a field, not inside its prose
 * (signals-that-survive, task 2).
 *
 * `o2b brain doctor` renders `<code>: <message> (<path>)` — the path is
 * appended by the renderer from the finding's structured `path` field.
 * The preference / retired parsers used to embed the same path inside
 * the message as well, so every parse-error line named the file twice.
 *
 * The fix is a typed error that carries `path` structurally and exposes
 * the location-free prose as `detail`, which is what the doctor reports.
 * The `message` a bare caller reads is still composed through ONE shared
 * formatter ({@link withLocation}), so no surface that prints
 * `(exc as Error).message` loses the location.
 *
 * Every parse-error code the doctor can classify is pinned here — the
 * two `*-missing-field` codes and the two `*-invalid` codes — because
 * the classification is a regex over the message, and shortening the
 * message is exactly the change that could break it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { BrainParseError, withLocation } from "../../../src/core/brain/parse-error.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import {
  BrainStatusFolderMismatchError,
  parsePreference,
  parseRetired,
} from "../../../src/core/brain/preference.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-parse-error-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write `lines` as a Brain artifact at `path` and return the path. */
function seed(path: string, lines: ReadonlyArray<string>): string {
  writeFileSync(path, [...lines, ""].join("\n"), "utf8");
  return path;
}

/** A preference file whose frontmatter omits `created_at`. */
function seedPreferenceMissingField(): string {
  return seed(join(brainDirs(tmp).preferences, "pref-no-created-at.md"), [
    "---",
    "kind: brain-preference",
    "id: pref-no-created-at",
    "_confirmed_at: null",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    "tags: [brain, brain/preference]",
    "topic: broken",
    "_status: unconfirmed",
    "principle: A rule with no birthday",
    "_evidenced_by: []",
    "---",
  ]);
}

/** A preference file whose `_confidence` is outside the enum. */
function seedPreferenceInvalid(): string {
  return seed(join(brainDirs(tmp).preferences, "pref-bad-confidence.md"), [
    "---",
    "kind: brain-preference",
    "id: pref-bad-confidence",
    "created_at: 2026-05-14T10:42:00Z",
    "_confirmed_at: null",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    "tags: [brain, brain/preference]",
    "topic: broken",
    "_status: unconfirmed",
    "principle: A rule with an unknown confidence band",
    "_evidenced_by: []",
    "_confidence: hilarious",
    "---",
  ]);
}

/** A retired file whose frontmatter omits `retired_at`. */
function seedRetiredMissingField(): string {
  return seed(join(brainDirs(tmp).retired, "ret-no-retired-at.md"), [
    "---",
    "kind: brain-retired",
    "id: ret-no-retired-at",
    "created_at: 2026-05-14T10:42:00Z",
    "tags: [brain, brain/retired]",
    "topic: broken",
    "_status: retired",
    "retired_reason: superseded",
    "retired_by: [[Brain/log/2026-05-14]]",
    "principle: A rule with no retirement date",
    "---",
  ]);
}

/** A retired file whose `retired_reason` is outside the enum. */
function seedRetiredInvalid(): string {
  return seed(join(brainDirs(tmp).retired, "ret-bad-reason.md"), [
    "---",
    "kind: brain-retired",
    "id: ret-bad-reason",
    "created_at: 2026-05-14T10:42:00Z",
    "retired_at: 2026-06-14T10:42:00Z",
    "tags: [brain, brain/retired]",
    "topic: broken",
    "_status: retired",
    "retired_reason: hilarious",
    "retired_by: [[Brain/log/2026-06-14]]",
    "principle: A rule retired for an unknown reason",
    "---",
  ]);
}

/** A preference file whose optional `_applied_count` is not a number. */
function seedPreferenceBadAppliedCount(): string {
  return seed(join(brainDirs(tmp).preferences, "pref-bad-applied-count.md"), [
    "---",
    "kind: brain-preference",
    "id: pref-bad-applied-count",
    "created_at: 2026-05-14T10:42:00Z",
    "_confirmed_at: null",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    "tags: [brain, brain/preference]",
    "topic: broken",
    "_status: unconfirmed",
    "principle: A rule with an uncountable apply count",
    "_evidenced_by: []",
    "_applied_count: abc",
    "---",
  ]);
}

/** A preference file filed under `preferences/` with `_status: retired`. */
function seedStatusFolderMismatch(): string {
  return seed(join(brainDirs(tmp).preferences, "pref-mismatch.md"), [
    "---",
    "kind: brain-preference",
    "id: pref-mismatch",
    "created_at: 2026-05-14T10:42:00Z",
    "_confirmed_at: null",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    "tags: [brain, brain/preference]",
    "topic: broken",
    "_status: retired",
    "principle: A rule filed under the wrong folder",
    "_evidenced_by: []",
    "---",
  ]);
}

/** The single doctor finding carrying `code`. */
function finding(issues: ReadonlyArray<DoctorIssue>, code: string): DoctorIssue {
  const hits = issues.filter((i) => i.code === code);
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

describe("the typed parse error carries the path as a field", () => {
  test("a missing required field throws BrainParseError with path and detail as fields", () => {
    const path = seedPreferenceMissingField();
    expect(() => parsePreference(path)).toThrow(BrainParseError);
    try {
      parsePreference(path);
      throw new Error("parsePreference did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainParseError);
      const e = err as BrainParseError;
      expect(e.path).toBe(path);
      expect(e.detail).toBe("preference missing field: created_at");
      expect(e.detail).not.toContain(path);
    }
  });

  test("a caller that surfaces the message directly still receives the path", () => {
    const path = seedPreferenceInvalid();
    let surfaced = "";
    try {
      parsePreference(path);
    } catch (exc) {
      // Exactly what `o2b brain reject`, `brain merge` and the pin path do.
      surfaced = (exc as Error).message;
    }
    expect(surfaced).toContain(path);
    expect(surfaced).toBe(
      withLocation(
        "preference field 'confidence' must be one of low, medium, high; got \"hilarious\"",
        path,
      ),
    );
  });

  test("the located message is composed by the one shared formatter", () => {
    const path = seedRetiredInvalid();
    try {
      parseRetired(path);
      throw new Error("parseRetired did not throw");
    } catch (err) {
      const e = err as BrainParseError;
      expect(e.message).toBe(withLocation(e.detail, e.path));
    }
  });

  test("the status-folder mismatch keeps its own fields and its bare detail", () => {
    const path = seedStatusFolderMismatch();
    try {
      parsePreference(path);
      throw new Error("parsePreference did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainStatusFolderMismatchError);
      expect(err).toBeInstanceOf(BrainParseError);
      const e = err as BrainStatusFolderMismatchError;
      expect(e.path).toBe(path);
      expect(e.status).toBe("retired");
      expect(e.folder).toBe("preferences");
      expect(e.detail).not.toContain(path);
      expect(e.message).toContain(path);
    }
  });
});

describe("what the composed sentence promises, precisely", () => {
  test("the status-folder mismatch sentence keeps its historical byte layout", () => {
    const path = seedStatusFolderMismatch();
    let surfaced = "";
    try {
      parsePreference(path);
    } catch (exc) {
      // `o2b brain reject` prints this string bare; an operator may match on it.
      surfaced = (exc as Error).message;
    }
    expect(surfaced).toBe(
      "preference file frontmatter status does not match preferences/ folder " +
        `(path=${path}, status=retired, folder=preferences)`,
    );
  });

  test("an optional-field failure that carried no location now carries one", () => {
    const path = seedPreferenceBadAppliedCount();
    try {
      parsePreference(path);
      throw new Error("parsePreference did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainParseError);
      const e = err as BrainParseError;
      expect(e.detail).toBe(
        "preference field 'applied_count' must be a finite number; got \"abc\"",
      );
      expect(e.path).toBe(path);
      expect(e.message).toBe(withLocation(e.detail, path));
    }
  });
});

describe("the doctor reports the path once, as a field", () => {
  test("preference-missing-field names the file in `path` and not in `message`", () => {
    const path = seedPreferenceMissingField();
    const issue = finding(runDoctor(tmp).errors, "preference-missing-field");
    expect(issue.path).toBe(path);
    expect(issue.message).toBe("preference missing field: created_at");
    expect(issue.message).not.toContain(path);
  });

  test("preference-invalid names the file in `path` and not in `message`", () => {
    const path = seedPreferenceInvalid();
    const issue = finding(runDoctor(tmp).errors, "preference-invalid");
    expect(issue.path).toBe(path);
    expect(issue.message).not.toContain(path);
  });

  test("retired-missing-field names the file in `path` and not in `message`", () => {
    const path = seedRetiredMissingField();
    const issue = finding(runDoctor(tmp).errors, "retired-missing-field");
    expect(issue.path).toBe(path);
    expect(issue.message).toBe("preference missing field: retired_at");
    expect(issue.message).not.toContain(path);
  });

  test("retired-invalid names the file in `path` and not in `message`", () => {
    const path = seedRetiredInvalid();
    const issue = finding(runDoctor(tmp).errors, "retired-invalid");
    expect(issue.path).toBe(path);
    expect(issue.message).not.toContain(path);
  });

  test("status-folder-mismatch names the file in `path` and not in `message`", () => {
    const path = seedStatusFolderMismatch();
    const issue = finding(runDoctor(tmp).warnings, "status-folder-mismatch");
    expect(issue.path).toBe(path);
    expect(issue.message).not.toContain(path);
    // The structural facts the class carries stay in the sentence: they
    // have no field of their own on a `DoctorIssue`.
    expect(issue.message).toContain("status=retired");
    expect(issue.message).toContain("folder=preferences");
  });

  test("all four parse-error codes still classify from the shortened message", () => {
    seedPreferenceMissingField();
    seedPreferenceInvalid();
    seedRetiredMissingField();
    seedRetiredInvalid();
    const codes = runDoctor(tmp)
      .errors.map((e) => e.code)
      .toSorted();
    expect(codes).toEqual([
      "preference-invalid",
      "preference-missing-field",
      "retired-invalid",
      "retired-missing-field",
    ]);
  });
});
