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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planPrivacyMarkerRestamp } from "../../../src/core/brain/privacy-marker-restamp.ts";
import * as vaultModule from "../../../src/core/vault.ts";
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

describe("apply refuses pages the scanner cannot round-trip", () => {
  test("a candidate carrying a dropped frontmatter line is skipped by name and left byte-identical", () => {
    // The stray dash item (no open key to land in) is a line the
    // line-based scanner drops with a notice: a rewrite through the
    // writer would silently lose it, breaking the no-key-removed promise.
    page("notice.md", "title: Notice\naccess: private\n- a stray dash item with no key");
    // The fixture is honest: the scanner really does report the line.
    const [, , notices] = vaultModule.parseFrontmatterWithNotices(join(vault, "notice.md"));
    expect(notices.length).toBe(1);
    const before = readFileSync(join(vault, "notice.md"), "utf8");
    const result = planPrivacyMarkerRestamp(vault, { apply: true });
    // The scan still nominates the page - the marker is real - but the
    // apply pass refuses it, names it, and says why.
    expect(result.candidates.map((c) => c.path)).toContain("notice.md");
    const skip = result.skipped.find((s) => s.path === "notice.md");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("dropped");
    // Every other candidate is stamped; only the notice page is refused.
    expect(result.updated).toBe(5);
    expect(result.skipped).toHaveLength(1);
    // The bytes are untouched: the informal marker still denies remote
    // reads, and no line was lost to a rewrite.
    expect(readFileSync(join(vault, "notice.md"), "utf8")).toBe(before);
  });

  test("a dry run reports no skips and touches nothing", () => {
    page("notice.md", "title: Notice\naccess: private\n- a stray dash item with no key");
    const result = planPrivacyMarkerRestamp(vault);
    expect(result.applied).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.updated).toBe(0);
  });

  test("a candidate whose frontmatter carries a comment is skipped by name and left byte-identical", () => {
    // A `#` line inside the block is skipped by the scanner WITHOUT a
    // notice (the format documents comments as content it discards), so
    // the refuse-on-notice guard above cannot see it - and a rewrite
    // through the writer would still delete it. The apply pass must
    // refuse the page the same way, by name.
    page("commented.md", "title: Commented\n# review before sharing\naccess: private");
    const before = readFileSync(join(vault, "commented.md"), "utf8");
    const result = planPrivacyMarkerRestamp(vault, { apply: true });
    expect(result.candidates.map((c) => c.path)).toContain("commented.md");
    const skip = result.skipped.find((s) => s.path === "commented.md");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("comment");
    expect(result.updated).toBe(5);
    expect(readFileSync(join(vault, "commented.md"), "utf8")).toBe(before);
  });

  test("a candidate whose frontmatter carries an indented mapping is skipped by name and left byte-identical", () => {
    // The scanner trims each line before matching key/value, so an
    // indented nested mapping is flattened into top-level keys with no
    // notice; re-serialising the parsed map would write the flattening.
    page("nested-map.md", "title: Nested\naccess: private\nowner:\n  team: core");
    const before = readFileSync(join(vault, "nested-map.md"), "utf8");
    const result = planPrivacyMarkerRestamp(vault, { apply: true });
    expect(result.candidates.map((c) => c.path)).toContain("nested-map.md");
    const skip = result.skipped.find((s) => s.path === "nested-map.md");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("indented");
    expect(result.updated).toBe(5);
    expect(readFileSync(join(vault, "nested-map.md"), "utf8")).toBe(before);
  });

  test("a candidate that cannot be re-read is skipped as unreadable, not as a dropped line", () => {
    // A file that disappears (or becomes unreadable) between the scan and
    // the write surfaces as one `frontmatter-unreadable` notice; the
    // refusal must name the read failure, not point the operator at a
    // YAML problem the page does not have.
    withUnreadableAtWriteTime("access.md", () => {
      const result = planPrivacyMarkerRestamp(vault, { apply: true });
      const skip = result.skipped.find((s) => s.path === "access.md");
      expect(skip).toBeDefined();
      expect(skip!.reason).toContain("could not be re-read");
      expect(result.updated).toBe(4);
    });
  });
});

// --- The write reads the page it is about to rewrite ------------------------

/**
 * The scan and the write happen in one call, so the window between them is
 * simulated at the seam both passes read through: `parseFrontmatterWithNotices`.
 * The vault walk parses the page first (the scan), the apply loop re-parses
 * it second (the write-time recompute), so the mock below lands the
 * operator edit on disk the instant the page is parsed for the SECOND time -
 * the scan has seen the old bytes, the apply loop sees the new ones.
 */
// Captured at module load, before any `mock.module` call can replace the
// namespace's function: a capture inside the helper would pick up the
// previous test's mock and chain the mocks instead of restoring.
const realParseFrontmatterWithNotices = vaultModule.parseFrontmatterWithNotices;

function withEditAtWriteTime(rel: string, nextFrontmatter: string, run: () => void): void {
  const realParse = realParseFrontmatterWithNotices;
  const target = join(vault, rel);
  let parses = 0;
  mock.module("../../../src/core/vault.ts", () => ({
    ...vaultModule,
    parseFrontmatterWithNotices(path: string) {
      if (path === target) {
        parses += 1;
        if (parses === 2) {
          writeFileSync(target, `---\n${nextFrontmatter}\n---\n\nbody text\n`);
        }
      }
      return realParse(path);
    },
  }));
  try {
    run();
  } finally {
    mock.module("../../../src/core/vault.ts", () => vaultModule);
  }
}

/**
 * Same seam, the read-failure arm: the apply loop's re-parse reports the
 * page as unreadable, the way a file deleted (or moved to a failing
 * mount) between the scan and the write answers. The notice is built in
 * the shape `parseFrontmatterWithNotices` emits for a failed read, so the
 * core module's reason selection runs against real data.
 */
function withUnreadableAtWriteTime(rel: string, run: () => void): void {
  const realParse = realParseFrontmatterWithNotices;
  const target = join(vault, rel);
  let parses = 0;
  mock.module("../../../src/core/vault.ts", () => ({
    ...vaultModule,
    parseFrontmatterWithNotices(path: string) {
      if (path === target) {
        parses += 1;
        if (parses === 2) {
          return [
            {},
            "",
            [
              {
                code: "frontmatter-unreadable",
                site: "vault.parseFrontmatter",
                path,
                detail: "frontmatter read failed: ENOENT simulated by the test",
              },
            ],
          ];
        }
      }
      return realParse(path);
    },
  }));
  try {
    run();
  } finally {
    mock.module("../../../src/core/vault.ts", () => vaultModule);
  }
}

describe("apply recomputes the tokens from the page as it stands now", () => {
  test("a candidate edited between the scan and the write keeps its new declared token", () => {
    withEditAtWriteTime("access.md", "title: Access\naccess: private\nvisibility: [team]", () => {
      const result = planPrivacyMarkerRestamp(vault, { apply: true });
      // The page was rewritten, from the tokens the edit declared.
      expect(result.updated).toBe(5);
      const md = readFileSync(join(vault, "access.md"), "utf8");
      expect(md).toContain("visibility: [team, private]");
      expect(md).toContain("access: private");
    });
  });

  test("a candidate whose marker vanished between the scan and the write is skipped", () => {
    withEditAtWriteTime("access.md", "title: Access\nvisibility: [team]", () => {
      const result = planPrivacyMarkerRestamp(vault, { apply: true });
      expect(result.updated).toBe(4);
      // The reported list still shows what the scan found; the write did
      // not touch the page the scan can no longer nominate.
      expect(result.candidates.map((c) => c.path)).toContain("access.md");
      const md = readFileSync(join(vault, "access.md"), "utf8");
      // The operator's edit stands and no reservation was stamped.
      expect(md).toContain("visibility: [team]");
      expect(md).not.toContain("visibility: [private]");
    });
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
