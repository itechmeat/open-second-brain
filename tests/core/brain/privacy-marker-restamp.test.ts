/**
 * Preview-first restamp of informal privacy markers (write-honesty, F1 unit 3).
 *
 * The read roots already deny a remote read for `access: private` and its
 * siblings, but the reservation lives only in the informal key: tooling
 * that reads `visibility:` directly (derived-page stamping, exports) does
 * not see it. This verb makes the claim formal - additively.
 *
 * The contract is the repair-verb family's, spelled at
 * `authored-at-backfill.ts`:
 *
 *   - dry run by DEFAULT; `apply` is the caller's opt-in;
 *   - the write guard is asserted only when the call will write;
 *   - add-only: the reserved token is unioned into `visibility:`, and no
 *     key or existing token is ever removed;
 *   - idempotent: a re-run over a restamped vault is a byte-identical
 *     no-op;
 *   - a page already carrying `visibility: private` is not a candidate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planPrivacyMarkerRestamp } from "../../../src/core/brain/privacy-marker-restamp.ts";
import {
  VaultIdentityMismatchError,
  assertVaultIdentityForWrite,
  resetVaultIdentityPins,
  vaultIdentityPath,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;

function page(rel: string, frontmatter: string, body = "body text"): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`);
  return abs;
}

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "privacy-marker-restamp-"));
  page("open.md", "title: Open");
  page("access.md", "title: Access\naccess: private");
  page("team-marked.md", "title: Team\nsensitivity: confidential\nvisibility: [team]");
  page("nested/array.md", "title: Array\nconfidentiality: [internal, Secret]");
  page("spelling.md", "title: Spelling\naccess: private\nvisibility: [Owners]");
  page("stamped.md", "title: Stamped\naccess: private\nvisibility: [private]");
  page("formal.md", "title: Formal\nvisibility: [team]");
  page("access.md.bak.md", "title: Backup\naccess: private");
});
afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true });
});

function candidates(): ReadonlyArray<{ path: string; visibilityLine: string }> {
  return planPrivacyMarkerRestamp(vault).candidates.map((c) => ({
    path: c.path,
    visibilityLine: c.visibilityLine,
  }));
}

describe("a dry run writes nothing", () => {
  test("it reports the candidates and their would-be visibility line", () => {
    const result = planPrivacyMarkerRestamp(vault);
    expect(result.applied).toBe(false);
    expect(result.updated).toBe(0);
    expect(result.scanned).toBe(6);
    expect(candidates()).toEqual([
      { path: "access.md", visibilityLine: "visibility: [private]" },
      { path: "access.md.bak.md", visibilityLine: "visibility: [private]" },
      { path: "nested/array.md", visibilityLine: "visibility: [private]" },
      { path: "spelling.md", visibilityLine: "visibility: [Owners, private]" },
      { path: "team-marked.md", visibilityLine: "visibility: [team, private]" },
    ]);
  });

  test("every file is byte-identical after the preview", () => {
    const before = readFileSync(join(vault, "access.md"), "utf8");
    planPrivacyMarkerRestamp(vault);
    expect(readFileSync(join(vault, "access.md"), "utf8")).toBe(before);
  });

  test("a vault with no marker pages is silent and unchanged", () => {
    rmSync(join(vault, "access.md"));
    rmSync(join(vault, "access.md.bak.md"));
    rmSync(join(vault, "nested"), { recursive: true, force: true });
    rmSync(join(vault, "spelling.md"));
    rmSync(join(vault, "team-marked.md"));
    rmSync(join(vault, "stamped.md"));
    const result = planPrivacyMarkerRestamp(vault);
    expect(result.scanned).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.updated).toBe(0);
  });
});

describe("apply unions the reserved token into visibility", () => {
  test("it writes the reserved token and keeps the declared one", () => {
    const result = planPrivacyMarkerRestamp(vault, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.updated).toBe(result.candidates.length);

    const team = readFileSync(join(vault, "team-marked.md"), "utf8");
    expect(team).toContain("visibility: [team, private]");
    expect(team).toContain("sensitivity: confidential");
    expect(team).toContain("body text");

    const access = readFileSync(join(vault, "access.md"), "utf8");
    expect(access).toContain("visibility: [private]");
    expect(access).toContain("access: private");
  });

  test("existing tokens keep their declared spelling", () => {
    const result = planPrivacyMarkerRestamp(vault, { apply: true });
    expect(result.updated).toBe(5);
    const spelling = readFileSync(join(vault, "spelling.md"), "utf8");
    expect(spelling).toContain("visibility: [Owners, private]");
    // A marker-only page gets the reserved token with nothing beside it.
    const array = readFileSync(join(vault, "nested/array.md"), "utf8");
    expect(array).toContain("visibility: [private]");
    expect(array).toContain("confidentiality: [internal, Secret]");
  });

  test("a page already carrying the reserved token is untouched", () => {
    const before = readFileSync(join(vault, "stamped.md"), "utf8");
    planPrivacyMarkerRestamp(vault, { apply: true });
    expect(readFileSync(join(vault, "stamped.md"), "utf8")).toBe(before);
  });

  test("an unmarked page is untouched", () => {
    const formal = readFileSync(join(vault, "formal.md"), "utf8");
    const open = readFileSync(join(vault, "open.md"), "utf8");
    planPrivacyMarkerRestamp(vault, { apply: true });
    expect(readFileSync(join(vault, "formal.md"), "utf8")).toBe(formal);
    expect(readFileSync(join(vault, "open.md"), "utf8")).toBe(open);
  });

  test("a re-run is a byte-identical no-op", () => {
    planPrivacyMarkerRestamp(vault, { apply: true });
    const files = ["access.md", "team-marked.md", "nested/array.md", "spelling.md", "stamped.md"];
    const afterFirst = files.map((f) => readFileSync(join(vault, f), "utf8"));

    const second = planPrivacyMarkerRestamp(vault, { apply: true });
    expect(second.candidates).toEqual([]);
    expect(second.updated).toBe(0);
    expect(files.map((f) => readFileSync(join(vault, f), "utf8"))).toEqual(afterFirst);
  });
});

// --- The write guard: at the entry point, only when the call writes --------

describe("vault identity", () => {
  function makeVaultIdentityMismatch(): void {
    writeVaultIdentity(vault);
    assertVaultIdentityForWrite(vault);
    atomicWriteFileSync(
      vaultIdentityPath(vault),
      `${JSON.stringify(
        { schema_version: 1, vault_id: "f".repeat(32), created_at: "2026-01-01T00:00:00.000Z" },
        null,
        2,
      )}\n`,
    );
  }

  test("a preview still runs against a root the guard would refuse", () => {
    makeVaultIdentityMismatch();
    expect(planPrivacyMarkerRestamp(vault).applied).toBe(false);
  });

  test("an apply refuses before writing anything", () => {
    makeVaultIdentityMismatch();
    const before = readFileSync(join(vault, "access.md"), "utf8");
    expect(() => planPrivacyMarkerRestamp(vault, { apply: true })).toThrow(
      VaultIdentityMismatchError,
    );
    expect(readFileSync(join(vault, "access.md"), "utf8")).toBe(before);
  });
});
