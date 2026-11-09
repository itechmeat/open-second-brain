/**
 * Accepted skills stay files agents read, in every mode (design D14, task
 * 2.10): with no `skills_dir`, an unswitched machine keeps `Brain/skills`,
 * a switched one `<vault>/skills`, a machine with no vault its
 * device-local skills folder; none of them is a store record, and the
 * skill listing finds the accepted skill.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { commitSkillPageDraft } from "../../../src/core/brain/skill-page-drafts.ts";
import { acceptSkillProposal } from "../../../src/core/brain/skill-proposals.ts";
import { machineStatePath } from "../../../src/core/state/machine-state.ts";
import { laneVaultRoot } from "../../../src/core/store/lane-pages.ts";
import { discoverSkills, skillRoots } from "../../../src/core/surface/skills.ts";
import { defaultSkillsDir } from "../../../src/core/surface/skills-dir.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-08-22T10:00:00Z");
const PAGE = "notes/release-ritual.md";
const DRAFT = {
  name: "release-ritual",
  description: "Cut a release the way this vault says releases are cut.",
  triggers: ["release", "tag"],
  body: "1. Name the theme.\n2. Cut the branch.",
};

function seedMaturePage(vault: string): void {
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, PAGE),
    "---\ntitle: Release ritual\ntier: core\n_lifecycle: verified\n_confidence: high\ncreated_at: 2026-08-01T00:00:00Z\n---\n\n# Release ritual\n\nCut the branch.\n",
  );
  appendContinuityRecord(vault, {
    kind: "recall_observed_use",
    createdAt: NOW.toISOString(),
    sourceRefs: [{ id: "reuse:1" }],
    payload: {
      session_id: "s",
      entries: Array.from({ length: 4 }, () => ({ path: PAGE, verdict: "USED" })),
    },
  });
}

describe.each(LANE_MODES)("skills directory (%s)", (mode) => {
  test("the default directory is a files folder outside the store", () => {
    lane = makeLaneEnv(mode);
    const expected =
      mode === "legacy"
        ? join(lane.vault, "Brain", "skills")
        : mode === "store"
          ? join(lane.vault, "skills")
          : machineStatePath(null, "skills");
    expect(defaultSkillsDir(mode === "no-vault" ? null : lane.vault)).toBe(expected);
  });

  test("an accepted skill is a SKILL.md the listing finds, never a lane record", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    if (mode === "no-vault") {
      // A mature page is a note of the user's vault; with none, the skills
      // a machine holds are the device-local folder's files.
      const dir = join(defaultSkillsDir(null), DRAFT.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${DRAFT.name}\ndescription: d\n---\nBody.\n`,
      );
    } else {
      seedMaturePage(vault);
      const staged = commitSkillPageDraft(vault, PAGE, DRAFT, { now: NOW });
      const accepted = acceptSkillProposal(vault, staged.slug, { now: NOW });
      expect(accepted.skillPath).toBe(join(defaultSkillsDir(vault), DRAFT.name, "SKILL.md"));
      expect(existsSync(accepted.skillPath!)).toBe(true);
    }
    const roots = skillRoots({ vault: mode === "no-vault" ? null : vault });
    expect(discoverSkills(roots).map((s) => s.name)).toContain(DRAFT.name);
    const skillRecords = lane
      .laneRecords()
      .filter((r) => String(r.body["entry"]).includes("skills"));
    expect(skillRecords).toEqual([]);
    expect(existsSync(laneVaultRoot(null))).toBe(false);
  });
});

describe("the default skills directory with no vault named", () => {
  test("an empty vault string is no vault, never the working directory", () => {
    lane = makeLaneEnv("legacy");
    expect(defaultSkillsDir("")).toBe(defaultSkillsDir(null));
    expect(defaultSkillsDir("  ")).toBe(defaultSkillsDir(null));
  });
});
