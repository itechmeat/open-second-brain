/**
 * The standing-rules write guard covers the scoped directory.
 *
 * `Brain/standing-rules/` holds operator-authored scoped rules, so every
 * write path that already refuses the constitution file refuses any path
 * inside the directory too, lexically and then canonically: a file that
 * does not exist yet, reached through a symlinked folder, is the same
 * target.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { brainScopedRulesDir, brainStandingRulesPath } from "../../../src/core/brain/paths.ts";
import {
  assertStandingRulesNotTargeted,
  StandingRulesWriteRefusedError,
} from "../../../src/core/brain/standing-rules.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

function vault(): string {
  const dir = mkTemp("o2b-scoped-guard-");
  mkdirSync(join(dir, "Brain"), { recursive: true });
  return dir;
}

function refusal(run: () => void): StandingRulesWriteRefusedError | null {
  try {
    run();
    return null;
  } catch (err) {
    if (err instanceof StandingRulesWriteRefusedError) return err;
    throw err;
  }
}

/** Symlinks need a privilege Windows CI does not grant; probe once. */
function canSymlink(): boolean {
  const dir = mkTemp("o2b-symlink-probe-");
  try {
    symlinkSync(join(dir, "missing"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  }
}

describe("assertStandingRulesNotTargeted and the scoped directory", () => {
  test("a file inside the directory is refused with its own path", () => {
    const v = vault();
    const err = refusal(() =>
      assertStandingRulesNotTargeted(v, "Brain/standing-rules/project/x.md", "test"),
    );
    expect(err).not.toBeNull();
    expect(err?.name).toBe("StandingRulesWriteRefusedError");
    expect(err?.surface).toBe("test");
    expect(basename(err?.path ?? "")).toBe("x.md");
    expect(err?.message).toContain("test refused: ");
  });

  test("the directory itself and a dot-dot spelling are refused", () => {
    const v = vault();
    expect(
      refusal(() => assertStandingRulesNotTargeted(v, "Brain/standing-rules", "t")),
    ).not.toBeNull();
    expect(
      refusal(() =>
        assertStandingRulesNotTargeted(v, "Brain/sources/../standing-rules/host/a.md", "t"),
      ),
    ).not.toBeNull();
  });

  test("a not-yet-existing file reached through a symlinked folder is refused", () => {
    if (!canSymlink()) return;
    const v = vault();
    mkdirSync(brainScopedRulesDir(v), { recursive: true });
    mkdirSync(join(v, "Notes"), { recursive: true });
    symlinkSync(brainScopedRulesDir(v), join(v, "Notes", "alias"), "dir");
    expect(
      refusal(() => assertStandingRulesNotTargeted(v, "Notes/alias/project/new.md", "t")),
    ).not.toBeNull();
  });

  test("a symlinked vault root does not make one path look like two", () => {
    if (!canSymlink()) return;
    const real = vault();
    const link = join(mkTemp("o2b-scoped-guard-link-"), "vault");
    symlinkSync(real, link, "dir");
    expect(
      refusal(() =>
        assertStandingRulesNotTargeted(real, join(link, "Brain/standing-rules/host/a.md"), "t"),
      ),
    ).not.toBeNull();
  });

  test("neighbours of the directory are not refused", () => {
    const v = vault();
    expect(
      refusal(() => assertStandingRulesNotTargeted(v, "Brain/standing-rules-notes.md", "t")),
    ).toBeNull();
    expect(
      refusal(() => assertStandingRulesNotTargeted(v, "Notes/standing-rules/x.md", "t")),
    ).toBeNull();
    expect(refusal(() => assertStandingRulesNotTargeted(v, "Brain/sources/x.md", "t"))).toBeNull();
  });

  test("the constitution file is still refused with the unchanged message", () => {
    const v = vault();
    const err = refusal(() =>
      assertStandingRulesNotTargeted(v, "Brain/standing-rules.md", "labels"),
    );
    expect(err?.path).toBe(brainStandingRulesPath(v));
    expect(err?.message).toBe(
      `labels refused: ${brainStandingRulesPath(v)} is the operator's standing-rules file, which this ` +
        "surface does not rewrite",
    );
  });
});
