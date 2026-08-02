/**
 * The status scope applied to vault PAGES (provenance-at-the-boundary).
 *
 * `Brain/entities/**` are ordinary Markdown pages, so the registry's status
 * scope stops at the registry: a link-graph walker reads the same files by
 * path and never calls `buildEntityIndex`. Three walkers did exactly that,
 * and a quarantined record's title, body and links reached the repair
 * proposals, the holdout adjacency and the bridge ambiguity count.
 *
 * Two levels of proof here: the predicate's own answers, and one walker
 * driven end to end. The end-to-end pair runs the SAME vault twice - once
 * with the record active, once quarantined - so a test that stopped
 * producing candidates for an unrelated reason fails the active half
 * instead of passing the quarantined half vacuously.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  ENTITY_STATUS_SCOPE,
  vaultPageInStatusScope,
} from "../../../../src/core/brain/entities/page-scope.ts";
import { BRAIN_ENTITY_KIND } from "../../../../src/core/brain/entities/types.ts";
import {
  IDENTITY_STRENGTH,
  collectRepairCandidates,
} from "../../../../src/core/brain/link-graph/repair-lane.ts";

/** A title long enough to clear the repair lane's explicit-reference floor. */
const ENTITY_TITLE = "Shadowbroker Ledger";

describe("vaultPageInStatusScope", () => {
  test("a page that is not an entity record is admitted unchanged", () => {
    expect(
      vaultPageInStatusScope({ kind: "brain-note", title: "x" }, ENTITY_STATUS_SCOPE.readable),
    ).toBe(true);
    expect(vaultPageInStatusScope({}, ENTITY_STATUS_SCOPE.canonical)).toBe(true);
  });

  test("an active entity page is admitted at both scopes", () => {
    const meta = { kind: BRAIN_ENTITY_KIND, status: "active" };
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.readable)).toBe(true);
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.canonical)).toBe(true);
  });

  test("an archived entity page is readable but cannot hold an identity", () => {
    const meta = { kind: BRAIN_ENTITY_KIND, status: "archived" };
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.readable)).toBe(true);
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.canonical)).toBe(false);
  });

  test("a quarantined entity page is admitted by no scope", () => {
    const meta = { kind: BRAIN_ENTITY_KIND, status: "quarantine" };
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.readable)).toBe(false);
    expect(vaultPageInStatusScope(meta, ENTITY_STATUS_SCOPE.canonical)).toBe(false);
  });

  test("an entity page whose status never parsed is admitted by no scope", () => {
    // Absence of a recognised status is not a reason to show the record, and
    // it is not the same answer as "this is not an entity page" - which is
    // why the kind is checked first and separately.
    for (const status of [undefined, "", "released", 3]) {
      expect(
        vaultPageInStatusScope(
          { kind: BRAIN_ENTITY_KIND, ...(status !== undefined ? { status } : {}) },
          ENTITY_STATUS_SCOPE.readable,
        ),
      ).toBe(false);
    }
  });
});

describe("a quarantined entity page stays out of the link graph", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-page-scope-"));
    bootstrapBrain(vault);
    mkdirSync(join(vault, "Notes"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  /**
   * An entity page carrying an attacker-chosen `title`. The registry
   * preserves frontmatter keys it does not own, and `listVaultPages` titles
   * a page from that key - so the title an untrusted intake wrote is the
   * title the link graph sees.
   */
  function writeEntityPage(status: string): void {
    const dir = join(vault, "Brain", "entities", "concept");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ent-concept-shadowbroker-ledger.md"),
      [
        "---",
        `kind: ${BRAIN_ENTITY_KIND}`,
        "entity_id: ent-concept-shadowbroker-ledger",
        "category: concept",
        `name: ${ENTITY_TITLE}`,
        `title: ${ENTITY_TITLE}`,
        `status: ${status}`,
        "created_at: 2026-01-01T00:00:00Z",
        "updated_at: 2026-01-01T00:00:00Z",
        "---",
        "",
        "Body authored by whatever the intake quarantined.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  function writeNamingNote(): void {
    writeFileSync(
      join(vault, "Notes", "alpha.md"),
      [
        "---",
        "kind: brain-note",
        "title: Alpha",
        "---",
        "",
        `This note discusses the ${ENTITY_TITLE} at length.`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  function candidatesNamingTheEntity(): number {
    return collectRepairCandidates(vault).filter(
      (candidate) =>
        candidate.strength === IDENTITY_STRENGTH.explicitReference &&
        candidate.target.includes("shadowbroker-ledger"),
    ).length;
  }

  test("an ACTIVE entity page does reach the repair lane", () => {
    // The half that proves the assertion below is not vacuous: the same
    // vault, the same walker, the same note naming the same title.
    writeEntityPage("active");
    writeNamingNote();
    expect(candidatesNamingTheEntity()).toBeGreaterThan(0);
  });

  test("a QUARANTINED entity page reaches nothing", () => {
    writeEntityPage("quarantine");
    writeNamingNote();
    expect(candidatesNamingTheEntity()).toBe(0);
  });
});
