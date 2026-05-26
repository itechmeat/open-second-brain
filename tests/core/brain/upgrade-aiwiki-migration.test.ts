/**
 * v0.11.0 legacy-AI-Wiki migration. Verifies that a vault laid out
 * under the v0.10.x conventions (`AI Wiki/payments/...`, scaffolding
 * files at `AI Wiki/<root>.md`) gets reshaped into the v0.11.0
 * Brain-centric layout by the migration helper without losing data
 * or clobbering pre-existing target files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
} from "../../../src/core/pay-memory/paths.ts";
import {
  LEGACY_AIWIKI_REL,
  migrateLegacyAiwiki,
} from "../../../src/core/brain/upgrade-migrations/legacy-aiwiki.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-aiwiki-mig-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function legacy(...parts: string[]): string {
  return [LEGACY_AIWIKI_REL, ...parts].join("/");
}

describe("migrateLegacyAiwiki", () => {
  test("no AI Wiki/ at all -> empty result, no work", () => {
    const r = migrateLegacyAiwiki(vault);
    expect(r.moved).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.dryRun).toBe(false);
  });

  test("moves receipts from AI Wiki/payments/<date>/ into Brain/payments/<date>/", () => {
    write(legacy("payments", "2026-05-10", "fal-x.md"), "# receipt fal-x\n");
    write(legacy("payments", "2026-05-10", "alpha-y.md"), "# receipt alpha-y\n");
    write(legacy("payments", "_pending", "req-1.md"), "# pending\n");

    const r = migrateLegacyAiwiki(vault);
    // Each leaf file shows up as a moved pair.
    expect(r.moved.length).toBe(3);
    expect(
      existsSync(join(vault, PAY_MEMORY_ROOT_REL, "2026-05-10", "fal-x.md")),
    ).toBe(true);
    expect(
      existsSync(join(vault, PAY_MEMORY_ROOT_REL, "2026-05-10", "alpha-y.md")),
    ).toBe(true);
    expect(
      existsSync(join(vault, PAY_MEMORY_ROOT_REL, "_pending", "req-1.md")),
    ).toBe(true);
    // Source files are gone.
    expect(
      existsSync(join(vault, LEGACY_AIWIKI_REL, "payments", "2026-05-10", "fal-x.md")),
    ).toBe(false);
  });

  test("moves AI Wiki/{policies,assets,drafts,reports}/ to Brain/payments/<sub>/", () => {
    write(legacy("policies", "spending.md"), "# policy\n");
    write(legacy("policies", "spending.json"), "{}\n");
    write(legacy("assets", "hero.md"), "# hero asset\n");
    write(legacy("drafts", "post.md"), "# draft\n");
    write(legacy("reports", "payment-report-2026-05-10.md"), "# report\n");

    migrateLegacyAiwiki(vault);

    expect(
      readFileSync(join(vault, PAY_MEMORY_POLICIES_REL, "spending.md"), "utf8"),
    ).toBe("# policy\n");
    expect(
      readFileSync(join(vault, PAY_MEMORY_POLICIES_REL, "spending.json"), "utf8"),
    ).toBe("{}\n");
    expect(
      readFileSync(join(vault, PAY_MEMORY_ASSETS_REL, "hero.md"), "utf8"),
    ).toBe("# hero asset\n");
    expect(
      readFileSync(join(vault, PAY_MEMORY_DRAFTS_REL, "post.md"), "utf8"),
    ).toBe("# draft\n");
    expect(
      readFileSync(
        join(vault, PAY_MEMORY_REPORTS_REL, "payment-report-2026-05-10.md"),
        "utf8",
      ),
    ).toBe("# report\n");
  });

  test("removes the seven OSB-managed scaffolding files from AI Wiki/", () => {
    write(legacy("_OPEN_SECOND_BRAIN.md"), "# legacy operating manual\n");
    write(legacy("_open-second-brain.yaml"), "version: 1\n");
    write(legacy("index.md"), "# index\n");
    write(legacy("hot.md"), "# hot\n");
    write(legacy("log.md"), "# log\n");
    write(legacy("identity", "user.md"), "# user\n");
    write(legacy("identity", "agents.md"), "# agents\n");

    const r = migrateLegacyAiwiki(vault);

    expect(r.removed.length).toBe(7);
    expect(existsSync(join(vault, LEGACY_AIWIKI_REL, "_OPEN_SECOND_BRAIN.md"))).toBe(false);
    expect(existsSync(join(vault, LEGACY_AIWIKI_REL, "identity", "user.md"))).toBe(false);
  });

  test("preserves user-authored content under AI Wiki/", () => {
    write(legacy("personal", "ideas.md"), "# personal notes\n");
    write(legacy("_OPEN_SECOND_BRAIN.md"), "# legacy\n");

    migrateLegacyAiwiki(vault);

    // Scaffolding gone, user content stays.
    expect(existsSync(join(vault, LEGACY_AIWIKI_REL, "_OPEN_SECOND_BRAIN.md"))).toBe(false);
    expect(
      readFileSync(join(vault, LEGACY_AIWIKI_REL, "personal", "ideas.md"), "utf8"),
    ).toBe("# personal notes\n");
  });

  test("merge semantics: never clobber an existing target file", () => {
    write(legacy("policies", "spending.md"), "# legacy version\n");
    // Pre-existing v0.11.0 file at the target path.
    write(`${PAY_MEMORY_POLICIES_REL}/spending.md`, "# v0.11.0 version\n");

    const r = migrateLegacyAiwiki(vault);
    // Move did not happen — the target was already there.
    expect(r.moved).toEqual([]);
    expect(
      readFileSync(join(vault, PAY_MEMORY_POLICIES_REL, "spending.md"), "utf8"),
    ).toBe("# v0.11.0 version\n");
    // The legacy file stays put when we cannot clobber.
    expect(
      readFileSync(join(vault, LEGACY_AIWIKI_REL, "policies", "spending.md"), "utf8"),
    ).toBe("# legacy version\n");
  });

  test("idempotent: re-running on a migrated vault is a no-op", () => {
    write(legacy("payments", "2026-05-10", "fal-x.md"), "# receipt\n");
    write(legacy("_OPEN_SECOND_BRAIN.md"), "# legacy\n");

    const first = migrateLegacyAiwiki(vault);
    expect(first.moved.length).toBe(1);
    expect(first.removed.length).toBe(1);

    const second = migrateLegacyAiwiki(vault);
    expect(second.moved).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  test("dry-run reports the planned operations without touching disk", () => {
    write(legacy("payments", "2026-05-10", "fal-x.md"), "# receipt\n");
    write(legacy("_OPEN_SECOND_BRAIN.md"), "# legacy\n");

    const r = migrateLegacyAiwiki(vault, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.moved.length).toBe(1);
    expect(r.removed.length).toBe(1);
    // Files still present at the legacy paths.
    expect(
      existsSync(join(vault, LEGACY_AIWIKI_REL, "payments", "2026-05-10", "fal-x.md")),
    ).toBe(true);
    expect(
      existsSync(join(vault, LEGACY_AIWIKI_REL, "_OPEN_SECOND_BRAIN.md")),
    ).toBe(true);
    // No target written either.
    expect(
      existsSync(join(vault, PAY_MEMORY_ROOT_REL, "2026-05-10", "fal-x.md")),
    ).toBe(false);
  });
});
