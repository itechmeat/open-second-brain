/**
 * The doctor's informal-privacy-marker finding (write-honesty, F1 unit 4).
 *
 * An informal marker (`access: private`, `confidentiality: secret`,
 * `sensitivity: confidential`) already withholds a page from a remote
 * read, but the reservation is invisible to every consumer that reads
 * `visibility:` directly. The doctor's job is to make that gap
 * discoverable: ONE warning naming how many pages are in that state and
 * which ones, silent when there are none.
 *
 * The count is the restamp's own candidate list, so the finding and the
 * preview-first verb can never disagree about the population.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { PRIVACY_MARKER_UNSTAMPED_CODE } from "../../../src/core/brain/doctor/privacy-marker-check.ts";
import { planPrivacyMarkerRestamp } from "../../../src/core/brain/privacy-marker-restamp.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";

let tmp: string;
let vault: string;

function page(rel: string, frontmatter: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\nbody\n`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-privacy-marker-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  resetVaultIdentityPins();
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

async function findings() {
  const report = await runDoctor(vault);
  return report.warnings.filter((i) => i.code === PRIVACY_MARKER_UNSTAMPED_CODE);
}

describe("the privacy-marker check", () => {
  test("is silent on a vault with no marker pages", async () => {
    page("open.md", "title: Open");
    page("formal.md", "title: Formal\nvisibility: [private]");
    expect(await findings()).toEqual([]);
  });

  test("one warning counts every unstamped marker page and names the paths", async () => {
    page("open.md", "title: Open");
    page("access.md", "title: Access\naccess: private");
    page("nested/confidential.md", "title: Confidential\nconfidentiality: secret");
    page("team.md", "title: Team\nsensitivity: confidential\nvisibility: [team]");

    const found = await findings();
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.path).toBe(vault);
    expect(found[0]!.message).toContain("3 page(s)");
    expect(found[0]!.message).toContain("access.md");
    expect(found[0]!.message).toContain("nested/confidential.md");
    expect(found[0]!.message).toContain("team.md");
  });

  test("a marker page already carrying the reserved token is not counted", async () => {
    page("already.md", "title: Already\naccess: private\nvisibility: [private]");
    page("pending.md", "title: Pending\naccess: private");

    const found = await findings();
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("1 page(s)");
    expect(found[0]!.message).toContain("pending.md");
    expect(found[0]!.message).not.toContain("already.md");
  });

  test("the finding clears once the restamp has run", async () => {
    page("access.md", "title: Access\naccess: private");
    expect(await findings()).toHaveLength(1);

    planPrivacyMarkerRestamp(vault, { apply: true });
    expect(await findings()).toEqual([]);
  });
});
