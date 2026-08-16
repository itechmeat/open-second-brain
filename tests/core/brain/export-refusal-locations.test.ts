/**
 * What the preference collector's refusals SAY, and who they refuse
 * (a-label-is-not-a-boundary review, C5 + C6).
 *
 * Two defects, one collector.
 *
 * C6: the refusal interpolated `parsePreference`'s raw message, and
 * `BrainParseError` composes that message as `<detail> (<absolute
 * path>)`. So the export that exists to keep vault content honest handed
 * back the operator's home directory - and `collectExportRows` is
 * reachable from an MCP error path, where `src/mcp/tools.ts` forbids
 * exactly that. The same release rewrote host paths out of the
 * `schema-report`, `backlinks` and `scaffold-stub` messages and left this
 * one. The `cannot list <dir>` branch one line above had no test at all.
 *
 * C5: the refusal is right for an export and wrong for the bank import,
 * which calls the same collector against the DESTINATION vault to learn
 * which topics its existing rules claim. One malformed preference already
 * sitting in the destination aborted the whole import - a write verb,
 * failing wholesale, on a condition unrelated to the data being carried.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  PreferenceParseError,
  collectExportRows,
  collectPreferenceRows,
} from "../../../src/core/brain/export.ts";
import { brainDirs, preferencePath } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { restorePreferences } from "../../../src/core/brain/portability/preference-restore.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let src: string;
let dest: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "o2b-export-loc-src-"));
  dest = mkdtempSync(join(tmpdir(), "o2b-export-loc-dest-"));
  for (const vault of [src, dest]) {
    mkdirSync(brainDirs(vault).preferences, { recursive: true });
    mkdirSync(brainDirs(vault).log, { recursive: true });
  }
});

afterEach(() => {
  for (const vault of [src, dest]) rmSync(vault, { recursive: true, force: true });
});

function seed(vault: string, slug: string, topic = "writing"): void {
  writePreference(vault, {
    slug,
    topic,
    principle: `state the ${slug} rule and name the artifact it governs`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
  });
}

/**
 * A preference file the parser cannot read: frontmatter is present and
 * parses as YAML, but `topic` - which `parsePreference` requires - is not
 * there. The failure is a `BrainParseError`, whose `message` carries the
 * absolute path and whose `detail` does not.
 */
function seedUnparseable(vault: string, slug: string): string {
  const path = preferencePath(vault, slug);
  writeFileSync(
    path,
    [
      "---",
      "kind: brain-preference",
      "_status: confirmed",
      `id: pref-${slug}`,
      "---",
      "",
      "body",
      "",
    ].join("\n"),
  );
  return relative(vault, path);
}

describe("the export refusal names a vault-relative location", () => {
  test("a parse failure carries no host path", () => {
    seed(src, "alpha-rule");
    const rel = seedUnparseable(src, "broken-rule");

    let raised: unknown;
    try {
      collectExportRows(src);
    } catch (exc) {
      raised = exc;
    }

    expect(raised).toBeInstanceOf(PreferenceParseError);
    const err = raised as PreferenceParseError;
    // The path field, the reason, and the composed message the CLI prints
    // are three separate strings and the host path used to be in two of
    // them.
    expect(err.failures.map((f) => f.path)).toEqual([rel]);
    expect(err.failures[0]?.reason ?? "").not.toContain(src);
    expect(err.message).not.toContain(src);
    // Named, not merely scrubbed: the operator has to know which file.
    expect(err.message).toContain(rel);
  });

  test("a directory that cannot be listed raises with the reason", () => {
    // `Brain/preferences` as a FILE: `existsSync` says yes, `readdirSync`
    // fails ENOTDIR. Before this branch existed the collector answered
    // this with `[]` - a permission or filesystem fault reported as an
    // empty Brain. It had no test in the tree at all.
    rmSync(brainDirs(src).preferences, { recursive: true, force: true });
    writeFileSync(brainDirs(src).preferences, "not a directory\n");

    let raised: unknown;
    try {
      collectExportRows(src);
    } catch (exc) {
      raised = exc;
    }

    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    expect(message).toContain("cannot list Brain/preferences");
    // The reason travels, so the operator is not left to guess between a
    // permission fault and a broken mount…
    expect(message).toMatch(/ENOTDIR|not a directory/i);
    // …and the host path does not.
    expect(message).not.toContain(src);
  });
});

describe("the bank import survives an unreadable rule in the destination", () => {
  test("the import lands and names the file the topic scan could not read", () => {
    seed(src, "alpha-rule", "writing");
    const rows = collectExportRows(src);
    // The destination already holds one good rule and one the parser
    // cannot read. Neither is what the bundle carries.
    seed(dest, "existing-rule", "reviewing");
    const brokenRel = seedUnparseable(dest, "legacy-rule");

    const result = restorePreferences(dest, rows, { agent: "bank-import" });

    // The rows the caller actually asked for are on disk.
    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.failed).toEqual([]);
    expect(result.carried).toBe(1);
    // And the incompleteness of the topic-key check is stated rather than
    // left for the reader to infer from an empty collision list.
    expect(result.topicScanUnreadable.map((f) => f.path)).toEqual([brokenRel]);
    expect(result.topicScanUnreadable[0]?.reason ?? "").not.toContain(dest);
  });

  test("a healthy destination reports an empty scan, so nothing changes for it", () => {
    seed(src, "alpha-rule");
    seed(dest, "existing-rule", "reviewing");

    const result = restorePreferences(dest, collectExportRows(src), { agent: "bank-import" });

    expect(result.topicScanUnreadable).toEqual([]);
    expect(result.topicKeyCollisions).toEqual([]);
  });

  test("the collision check still works over the rules it could read", () => {
    // A destination rule claiming the same FOLDED topic key under a
    // different spelling is the finding this scan exists for, and an
    // unreadable neighbour must not suppress it.
    seed(src, "alpha-rule", "code review");
    seed(dest, "existing-rule", "Code Review");
    seedUnparseable(dest, "legacy-rule");

    const result = restorePreferences(dest, collectExportRows(src), { agent: "bank-import" });

    expect(result.restored).toEqual(["pref-alpha-rule"]);
    expect(result.topicKeyCollisions.map((c) => c.key)).toEqual(["code review"]);
    expect(result.topicScanUnreadable.length).toBe(1);
  });
});

describe("the partial collector is the only one that tolerates a failure", () => {
  test("collectPreferenceRows returns the readable rows beside the failures", () => {
    seed(src, "alpha-rule");
    const rel = seedUnparseable(src, "broken-rule");

    const collection = collectPreferenceRows(src);

    expect(collection.rows.map((r) => r.id)).toEqual(["pref-alpha-rule"]);
    expect(collection.failures.map((f) => f.path)).toEqual([rel]);
    // The refusing wrapper is the same walk: a caller that cannot use a
    // partial answer still gets none.
    expect(() => collectExportRows(src)).toThrow(PreferenceParseError);
  });
});
