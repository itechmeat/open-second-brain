/**
 * Scoped operator rules: the vocabularies, the key normaliser and the
 * paths of `Brain/standing-rules/<axis>/<key>.md`.
 *
 * The key normaliser keeps Unicode letters and digits so a project whose
 * name carries no Latin character still keys; no language is enumerated.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_SCOPED_RULES_DIR } from "../../../src/core/brain/path-constants.ts";
import { brainScopedRulePath, brainScopedRulesDir } from "../../../src/core/brain/paths.ts";
import {
  HARNESS_ID,
  HARNESS_IDS,
  isHarnessId,
  isScopedRuleAxis,
  SCOPED_RULE_AXES,
  SCOPED_RULE_AXIS,
  SCOPED_RULE_AXIS_LABEL,
  SCOPED_RULE_KEY_MAX_CHARS,
  SCOPED_RULES_MAX_CHARS_DEFAULT,
  SCOPED_RULES_MAX_CHARS_MAX,
  SCOPED_RULES_MAX_CHARS_MIN,
  scopedRuleKey,
} from "../../../src/core/brain/scoped-rules.ts";
import { STANDING_RULES_MAX_CHARS_MAX } from "../../../src/core/brain/standing-rules.ts";
import { INSTALL_TARGET_IDS } from "../../../src/core/runtime/host-facts.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

describe("scopedRuleKey", () => {
  test("keeps letters and digits of any script", () => {
    expect(scopedRuleKey("プロジェクト 2")).toBe("プロジェクト-2");
    expect(scopedRuleKey("Έργο Άλφα")).toBe("έργο-άλφα");
  });

  test("folds case and collapses every other run to one dash", () => {
    expect(scopedRuleKey("  My_Repo.v2  ")).toBe("my-repo-v2");
  });

  test("a name with no letter or digit has no key", () => {
    expect(scopedRuleKey("---")).toBeNull();
    expect(scopedRuleKey("")).toBeNull();
  });

  test("caps the key and strips a dash left at the cut", () => {
    const long = "a".repeat(63) + "-" + "b".repeat(36);
    const key = scopedRuleKey(long);
    expect(key).not.toBeNull();
    expect((key ?? "").length).toBeLessThanOrEqual(SCOPED_RULE_KEY_MAX_CHARS);
    expect(key?.endsWith("-")).toBe(false);
    expect(scopedRuleKey("x".repeat(100))).toBe("x".repeat(64));
    // A letter outside the BMP at the cut is dropped whole, never halved.
    const astral = scopedRuleKey(`${"a".repeat(63)}\u{20000}b`);
    expect(astral).toBe("a".repeat(63));
  });

  test("normalises to NFC so composed and decomposed spellings share a key", () => {
    expect(scopedRuleKey("Café")).toBe(scopedRuleKey("Café"));
  });
});

describe("vocabularies", () => {
  test("the axes in drop-priority order", () => {
    expect([...SCOPED_RULE_AXES]).toEqual(["project", "harness", "host"]);
    expect(SCOPED_RULE_AXIS.project).toBe("project");
    expect(isScopedRuleAxis("host")).toBe(true);
    expect(isScopedRuleAxis("owner")).toBe(false);
    expect(SCOPED_RULE_AXIS_LABEL).toEqual({
      project: "Project",
      harness: "Harness",
      host: "Host",
    });
  });

  test("the harness ids are alphabetical and cover every install target", () => {
    expect([...HARNESS_IDS]).toEqual([
      "aider",
      "claude-code",
      "codex",
      "copilot-cli",
      "cursor",
      "gemini-cli",
      "generic",
      "grok",
      "hermes",
      "kiro",
      "openclaw",
      "opencode",
      "pi",
    ]);
    for (const target of INSTALL_TARGET_IDS) expect(HARNESS_IDS).toContain(target);
    expect(HARNESS_ID.claudeCode).toBe("claude-code");
    expect(isHarnessId("hermes")).toBe(true);
    expect(isHarnessId("Hermes")).toBe(false);
  });

  test("the cap bounds", () => {
    expect(SCOPED_RULES_MAX_CHARS_DEFAULT).toBe(2000);
    expect(SCOPED_RULES_MAX_CHARS_MIN).toBe(200);
    expect(SCOPED_RULES_MAX_CHARS_MAX).toBe(STANDING_RULES_MAX_CHARS_MAX);
  });
});

describe("paths", () => {
  test("the directory sits beside the constitution file under Brain/", () => {
    const vault = mkTemp("o2b-scoped-paths-");
    expect(BRAIN_SCOPED_RULES_DIR).toBe("standing-rules");
    expect(brainScopedRulesDir(vault).replaceAll("\\", "/")).toEndWith("Brain/standing-rules");
    expect(brainScopedRulePath(vault, "project", "x").replaceAll("\\", "/")).toEndWith(
      "Brain/standing-rules/project/x.md",
    );
  });
});
