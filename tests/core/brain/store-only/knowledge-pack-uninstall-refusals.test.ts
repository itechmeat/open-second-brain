/**
 * A confirmed knowledge-pack uninstall deletes only what it can account
 * for. Two ways it reported or did more than it could:
 *
 * - On a vault whose `Brain/` cannot be examined, the preference listing
 *   failed with the store-only "cannot tell" error, the scan swallowed it,
 *   and the staged pages under `OKF Review/` were deleted anyway, with the
 *   pack's rules left behind and the reason only in the verdict.
 * - A stamped preference the removal refused (a symlink leaving the vault)
 *   was still listed as deleted and counted in the audit record.
 */
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { brainDirs } from "../../../../src/core/brain/paths.ts";
import {
  installKnowledgePack,
  listInstalledKnowledgePacks,
  readKnowledgePack,
  sealKnowledgePack,
  selectKnowledgePack,
  uninstallKnowledgePack,
} from "../../../../src/core/brain/portability/knowledge-pack.ts";
import { writeOkfBundle } from "../../../../src/core/brain/portability/okf.ts";
import { loadPreference, writePreference } from "../../../../src/core/brain/preference.ts";
import { StoreOnlyUndeterminedError } from "../../../../src/core/store/store-only.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/** A pack of one rule and one note, built on an unswitched vault next to `env`. */
function teamPack(parent: string): string {
  const src = mkdtempSync(join(parent, "src-"));
  mkdirSync(brainDirs(src).preferences, { recursive: true });
  mkdirSync(brainDirs(src).log, { recursive: true });
  mkdirSync(join(src, "Notes"), { recursive: true });
  writeFileSync(join(src, "Notes", "team-note.md"), "---\ntitle: Team note\n---\nA note.\n");
  writePreference(src, {
    slug: "team-rule",
    topic: "team",
    principle: "Principle for team-rule",
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: [],
  });
  const selected = selectKnowledgePack(src, ["topic:team", "Notes/team-note.md"]);
  const packDir = join(parent, "pack");
  const sealed = sealKnowledgePack({
    name: "team-rules",
    version: "1.0.0",
    selection: selected.selection,
    okfManifest: selected.okfManifest,
    pageFiles: selected.pageFiles,
    preferences: selected.preferences,
    now: new Date("2026-11-01T00:00:00Z"),
  });
  writeOkfBundle(packDir, { manifest: selected.okfManifest, files: sealed.files });
  rmSync(src, { recursive: true, force: true });
  return packDir;
}

// A self-referencing `Brain` link fails the look with ELOOP while the rest
// of the vault stays readable. Symlinks need privileges on Windows.
test.skipIf(IS_WINDOWS)(
  "a confirmed uninstall refuses before removing anything when Brain/ cannot be examined",
  () => {
    env = makeStoreEnv("osb-kpack-undetermined-", { legacyTree: false, dualWrite: false });
    const { vault } = env;
    const pack = readKnowledgePack(teamPack(env.parent));
    installKnowledgePack(vault, pack, { now: new Date("2026-11-02T00:00:00Z") });
    const listed = listInstalledKnowledgePacks(vault);
    const staged = listed[0]!.entries.filter((e) => e.kind === "page").map((e) => e.path);
    expect(staged).toHaveLength(1);
    expect(loadPreference(vault, "team-rule")).not.toBeNull();

    symlinkSync("Brain", join(vault, "Brain"));
    const confirmed = () =>
      uninstallKnowledgePack(vault, "team-rules", {
        confirm: true,
        now: new Date("2026-11-03T00:00:00Z"),
      });
    expect(confirmed).toThrow(StoreOnlyUndeterminedError);
    expect(existsSync(join(vault, staged[0]!))).toBe(true);
    // Neither the dry run nor the listing answers a partial list: without
    // the pack's rules both would read as a pack of one staged page.
    expect(() => uninstallKnowledgePack(vault, "team-rules")).toThrow(StoreOnlyUndeterminedError);
    expect(() => listInstalledKnowledgePacks(vault)).toThrow(StoreOnlyUndeterminedError);

    rmSync(join(vault, "Brain"));
    expect(loadPreference(vault, "team-rule")).not.toBeNull();
  },
);

test.skipIf(IS_WINDOWS)("a preference the removal refuses is reported, not deleted", () => {
  env = makeStoreEnv("osb-kpack-refused-");
  const { vault } = env;
  const pack = readKnowledgePack(teamPack(env.parent));
  installKnowledgePack(vault, pack, { now: new Date("2026-11-02T00:00:00Z") });
  // The stamped rule's file is replaced by a link to a copy outside the
  // vault: the scan reads it through the link, the removal refuses it.
  const rule = join(brainDirs(vault).preferences, "pref-team-rule.md");
  const outside = join(env.parent, "outside-rule.md");
  writeFileSync(outside, readFileSync(rule, "utf8"));
  rmSync(rule);
  symlinkSync(outside, rule);

  const done = uninstallKnowledgePack(vault, "team-rules", {
    confirm: true,
    now: new Date("2026-11-03T00:00:00Z"),
  });
  expect(done.deleted).not.toContain("Brain/preferences/pref-team-rule.md");
  expect(done.refused).toEqual(["Brain/preferences/pref-team-rule.md"]);
  expect(done.deleted).toHaveLength(1);
  expect(existsSync(outside)).toBe(true);
});
