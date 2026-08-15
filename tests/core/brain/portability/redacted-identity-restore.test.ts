/**
 * The defect: the import path writes whatever a bank bundle says straight
 * into the vault, including a value that is the redactor's placeholder.
 *
 * The export side now refuses to emit a bundle whose IDENTIFIER is
 * secret-shaped, because redacting an identifier merges or renames the
 * thing it names. That closes the case going forward and closes nothing
 * for a bundle an earlier build - or any tool that scrubbed the payload
 * before handing it over - already produced. Such a bundle carries
 * `***REDACTED***` in a field that IS an identity: a preference id, a
 * preference topic, an Obsidian alias, a page path, a page title.
 *
 * Restoring one of those is not a lossy restore, it is a wrong one. The
 * id names the file the rule is written to; the topic is the key the dream
 * pass consolidates on; the path is the page. And the placeholder is a
 * CONSTANT, so two records that lost their identity land on the same one:
 * a second redacted row does not merely arrive nameless, it overwrites the
 * first. So the record is refused, per record, with a named reason.
 *
 * The line this file draws and pins on both sides: a placeholder in
 * PAYLOAD text - a principle, a body, a note's prose - still restores.
 * That is an honest redaction an operator chose, and refusing it would
 * discard recoverable material on a backup-recovery path.
 *
 * Deliberately NOT covered here:
 *   - The export-side refusal (`refused_secret_identifier`), which has its
 *     own coverage in `tests/cli/export-identifier-integrity.test.ts`.
 *   - A graph node's `links` / `relations` targets. Those name OTHER pages;
 *     a dangling reference is the vault's ordinary state and the scaffold
 *     verb exists for it, so a redacted target loses a reference rather
 *     than an identity.
 *   - The redactor's own decision about what looks secret. This file feeds
 *     the placeholder in directly; whether a given token would have been
 *     redacted in the first place is `tests/core/redactor-*.test.ts`.
 *   - Any whole-bundle refusal. Every assertion below checks that the
 *     records which kept their identity still land.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs, preferencePath } from "../../../../src/core/brain/paths.ts";
import {
  isPreferenceRestoreFailure,
  PREFERENCE_RESTORE_FAILURE,
  PREFERENCE_RESTORE_FAILURES,
  restorePreferences,
} from "../../../../src/core/brain/portability/preference-restore.ts";
import { importVaultGraph } from "../../../../src/core/brain/portability/graph.ts";
import { importBankBundle } from "../../../../src/core/brain/portability/bundle.ts";
import { REDACTION_PLACEHOLDER } from "../../../../src/core/redactor.ts";

let dest: string;

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), "o2b-redacted-identity-"));
  mkdirSync(brainDirs(dest).preferences, { recursive: true });
  mkdirSync(brainDirs(dest).log, { recursive: true });
});

afterEach(() => rmSync(dest, { recursive: true, force: true }));

/** One complete exported preference row, as `bank-export` emits it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pref-carried-rule",
    topic: "writing",
    scope: null,
    status: "confirmed",
    principle: "name the artifact the rule governs",
    applied_count: 2,
    violated_count: 0,
    confidence: "medium",
    confidence_value: 0.5,
    pinned: false,
    last_evidence_at: "2026-05-03T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    confirmed_at: "2026-05-02T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    revision: 2,
    aliases: null,
    tags: ["brain", "brain/preference", "brain/topic/writing"],
    evidenced_by: [],
    body: "",
    ...overrides,
  };
}

describe("a preference row that lost an identity is refused, not written", () => {
  test("a redacted id is refused with the reason that names the cause", () => {
    const result = restorePreferences(dest, [row({ id: `pref-${REDACTION_PLACEHOLDER}` })]);

    expect(result.restored).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.redactedIdentifier);
    expect(result.failed[0]!.detail).toContain("id");
    expect(result.failed[0]!.index).toBe(0);
    expect(readdirSync(brainDirs(dest).preferences)).toEqual([]);
  });

  test("a redacted topic is refused - the topic is the dream pass's key", () => {
    const result = restorePreferences(dest, [row({ topic: REDACTION_PLACEHOLDER })]);

    expect(result.restored).toEqual([]);
    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.redactedIdentifier);
    expect(result.failed[0]!.detail).toContain("topic");
    expect(result.failed[0]!.id).toBe("pref-carried-rule");
    expect(existsSync(preferencePath(dest, "carried-rule"))).toBe(false);
  });

  test("a redacted alias is refused - an alias is an inbound wikilink target", () => {
    const result = restorePreferences(dest, [row({ aliases: ["keep-me", REDACTION_PLACEHOLDER] })]);

    expect(result.restored).toEqual([]);
    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.redactedIdentifier);
    expect(result.failed[0]!.detail).toContain("aliases");
  });

  test("a placeholder EMBEDDED in an identifier is refused too", () => {
    // Half an identity is still a lost identity, and two rows redacted at
    // the same position collide exactly as two bare placeholders do.
    const result = restorePreferences(dest, [row({ topic: `api-${REDACTION_PLACEHOLDER}-key` })]);

    expect(result.failed[0]!.reason).toBe(PREFERENCE_RESTORE_FAILURE.redactedIdentifier);
  });
});

describe("a placeholder in payload text is an honest redaction and still restores", () => {
  test("a redacted principle restores verbatim", () => {
    const principle = `paste ${REDACTION_PLACEHOLDER} into the deploy step`;
    const result = restorePreferences(dest, [row({ principle })]);

    expect(result.restored).toEqual(["pref-carried-rule"]);
    expect(result.failed).toEqual([]);
    expect(existsSync(preferencePath(dest, "carried-rule"))).toBe(true);
  });

  test("a redacted body carries no refusal - the body is not restored at all", () => {
    const result = restorePreferences(dest, [row({ body: REDACTION_PLACEHOLDER })]);

    expect(result.restored).toEqual(["pref-carried-rule"]);
    expect(result.failed).toEqual([]);
  });
});

describe("the refusal is per record, and the rest of the bundle lands", () => {
  test("two rows that lost their id are BOTH refused instead of colliding", () => {
    // The placeholder is a constant: restoring both would write one file
    // twice and report two restored rules.
    const result = restorePreferences(dest, [
      row({ id: `pref-${REDACTION_PLACEHOLDER}`, topic: "writing" }),
      row({ id: `pref-${REDACTION_PLACEHOLDER}`, topic: "coding" }),
      row({ id: "pref-intact-rule" }),
    ]);

    expect(result.restored).toEqual(["pref-intact-rule"]);
    expect(result.failed.length).toBe(2);
    expect(result.failed.map((f) => f.reason)).toEqual([
      PREFERENCE_RESTORE_FAILURE.redactedIdentifier,
      PREFERENCE_RESTORE_FAILURE.redactedIdentifier,
    ]);
    expect(result.failed.map((f) => f.index)).toEqual([0, 1]);
    expect(result.carried).toBe(result.restored.length + result.failed.length);
    expect(existsSync(preferencePath(dest, "intact-rule"))).toBe(true);
  });

  test("the bundle importer reports it through the same preferences channel", () => {
    const result = importBankBundle(dest, {
      schema: "1",
      graph: { nodes: [] },
      preferences: [row({ topic: REDACTION_PLACEHOLDER }), row({ id: "pref-intact-rule" })],
    });

    expect(result.preferences.restored).toEqual(["pref-intact-rule"]);
    expect(result.preferences.failed.length).toBe(1);
    expect(result.preferences.failed[0]!.reason).toBe(
      PREFERENCE_RESTORE_FAILURE.redactedIdentifier,
    );
  });
});

describe("the reason is a member of the closed vocabulary", () => {
  test("the guard accepts it and the membership list carries it", () => {
    expect(isPreferenceRestoreFailure(PREFERENCE_RESTORE_FAILURE.redactedIdentifier)).toBe(true);
    expect(PREFERENCE_RESTORE_FAILURES).toContain(PREFERENCE_RESTORE_FAILURE.redactedIdentifier);
  });

  test("the reason is not the redactor's placeholder spelled a second time", () => {
    // The value an operator reads is a reason code, never the token that
    // provoked it - the drift this release spent its census budget on.
    expect(PREFERENCE_RESTORE_FAILURE.redactedIdentifier).not.toContain(REDACTION_PLACEHOLDER);
  });
});

describe("the page-graph half answers the same question", () => {
  test("a node whose path is the placeholder is rejected, not written", () => {
    const result = importVaultGraph(dest, {
      nodes: [{ id: "X", path: `${REDACTION_PLACEHOLDER}.md`, title: "X", links: [] }],
    });

    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([`${REDACTION_PLACEHOLDER}.md`]);
    expect(existsSync(join(dest, `${REDACTION_PLACEHOLDER}.md`))).toBe(false);
  });

  test("a node whose title is the placeholder is rejected too", () => {
    const result = importVaultGraph(dest, {
      nodes: [{ id: "X", path: "Notes/Alpha.md", title: REDACTION_PLACEHOLDER, links: [] }],
    });

    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual(["Notes/Alpha.md"]);
    expect(existsSync(join(dest, "Notes", "Alpha.md"))).toBe(false);
  });

  test("two nodes that lost their path are both rejected instead of colliding", () => {
    const result = importVaultGraph(dest, {
      nodes: [
        { id: "A", path: `Notes/${REDACTION_PLACEHOLDER}.md`, title: "A", links: [] },
        { id: "B", path: `Notes/${REDACTION_PLACEHOLDER}.md`, title: "B", links: [] },
        { id: "C", path: "Notes/Intact.md", title: "Intact", links: [] },
      ],
    });

    expect(result.created).toEqual(["Notes/Intact.md"]);
    expect(result.rejected.length).toBe(2);
    expect(existsSync(join(dest, "Notes", "Intact.md"))).toBe(true);
  });

  test("a node that kept its identity still imports", () => {
    const result = importVaultGraph(dest, {
      nodes: [{ id: "A", path: "Notes/Alpha.md", title: "Alpha", links: ["Beta"] }],
    });

    expect(result.created).toEqual(["Notes/Alpha.md"]);
    expect(result.rejected).toEqual([]);
  });
});
