import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFrontmatter } from "../../../../src/core/vault.ts";
import { regenerateActive } from "../../../../src/core/brain/active.ts";
import { brainActivePath } from "../../../../src/core/brain/paths.ts";
import { tombstone } from "../../../../src/core/brain/lifecycle/tombstone.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lifecycle-excl-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfirmedPref(slug: string): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `always ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      _confirmed_at: "2026-01-02T00:00:00Z",
      unconfirmed_until: "2026-02-01T00:00:00Z",
      _confidence: "high",
    },
    "Prose.",
  );
  return rel;
}

test("a tombstoned preference is excluded from active.md but stays on disk for audit", () => {
  const rel = writeConfirmedPref("keep-this");
  writeConfirmedPref("also-keep");

  regenerateActive(vault);
  let active = readFileSync(brainActivePath(vault), "utf8");
  expect(active).toContain("always keep-this");

  tombstone({ vault, path: rel, reason: "belief reversed", now: new Date("2026-07-18T00:00:00Z") });

  regenerateActive(vault);
  active = readFileSync(brainActivePath(vault), "utf8");
  expect(active).not.toContain("always keep-this");
  expect(active).toContain("always also-keep");

  // Audit: the tombstoned file is not deleted.
  expect(existsSync(join(vault, rel))).toBe(true);
});
