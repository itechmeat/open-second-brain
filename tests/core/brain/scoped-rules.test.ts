/**
 * Scoped operator rules: the vocabularies, the key normaliser and the
 * paths of `Brain/standing-rules/<axis>/<key>.md`.
 *
 * The key normaliser keeps Unicode letters and digits so a project whose
 * name carries no Latin character still keys; no language is enumerated.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BRAIN_SCOPED_RULES_DIR } from "../../../src/core/brain/path-constants.ts";
import { brainScopedRulePath, brainScopedRulesDir } from "../../../src/core/brain/paths.ts";
import {
  HARNESS_ID,
  HARNESS_IDS,
  isHarnessId,
  isScopedRuleAxis,
  readScopedRules,
  SCOPED_RULE_AXES,
  SCOPED_RULE_AXIS,
  SCOPED_RULE_AXIS_LABEL,
  SCOPED_RULE_KEY_MAX_CHARS,
  SCOPED_RULES_HEADER,
  SCOPED_RULES_HOST_UNREADABLE_NOTICE,
  SCOPED_RULES_MAX_CHARS_DEFAULT,
  SCOPED_RULES_MAX_CHARS_MAX,
  SCOPED_RULES_MAX_CHARS_MIN,
  SCOPED_RULES_NOTICE_RESERVE,
  scopedRuleKey,
  type ScopedRuleAxis,
  type ScopedRuleIdentity,
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

  test("keeps combining marks, so a word in an abugida or with vowel marks keys whole", () => {
    expect(scopedRuleKey("हिन्दी")).toBe("हिन्दी");
    expect(scopedRuleKey("مُحَمَّد")).toBe("مُحَمَّد");
    // The lowercase of a dotted capital I is i plus a combining dot above,
    // which NFC cannot recompose; the mark stays part of the key.
    expect(scopedRuleKey("İstanbul")).toBe("i\u0307stanbul");
    expect(scopedRuleKey("Café")).toBe("café");
    expect(scopedRuleKey("café")).toBe("café");
    expect(scopedRuleKey("Cafe\u0301")).toBe("café");
    // A capital with no precomposed form whose lowercase has one: only an
    // NFC pass after lowercasing gives both spellings one key.
    expect(scopedRuleKey("T\u0308ag")).toBe("\u1e97ag");
    expect(scopedRuleKey("\u1e97ag")).toBe("\u1e97ag");
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

// ---------- Reader ----------

const NO_SCOPE: ScopedRuleIdentity = Object.freeze({ project: null, harness: null, host: null });

function vaultWith(files: Partial<Record<string, string>>): string {
  const vault = mkTemp("o2b-scoped-read-");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const [axis, key] = rel.split("/") as [ScopedRuleAxis, string];
    const path = brainScopedRulePath(vault, axis, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body ?? "");
  }
  return vault;
}

function vaultMarkers(vault: string): string[] {
  const posixVault = vault.replaceAll("\\", "/");
  return [vault, posixVault];
}

/** The rules read for project `x` whose file is `length` characters, at the default cap. */
function projectRuleOf(length: number): ReturnType<typeof readScopedRules> {
  return readScopedRules(vaultWith({ "project/x": "a".repeat(length) }), {
    ...NO_SCOPE,
    project: "x",
  });
}

describe("readScopedRules", () => {
  test("renders only the file matching the resolved value, after the header", () => {
    const vault = vaultWith({
      "project/x": "zzprojectxzz rule\n",
      "project/y": "zzprojectyzz rule",
    });
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" });
    expect(rules.text.startsWith(SCOPED_RULES_HEADER)).toBe(true);
    expect(rules.text).toContain("### Project: x");
    expect(rules.text).toContain("zzprojectxzz rule");
    expect(rules.text).not.toContain("zzprojectyzz");
    expect(rules.text.indexOf("### Project: x")).toBeGreaterThan(SCOPED_RULES_HEADER.length - 1);
    expect(rules.files).toEqual([
      { axis: "project", key: "x", path: "Brain/standing-rules/project/x.md", truncated: false },
    ]);
    expect(rules.identity).toEqual({ project: "x", harness: null, host: null });
  });

  test("a null axis matches nothing and nothing matched renders nothing", () => {
    const vault = vaultWith({
      "project/x": "rule",
      "harness/codex": "rule",
      "host/aaaa0001": "rule",
    });
    const rules = readScopedRules(vault, NO_SCOPE);
    expect(rules.text).toBe("");
    expect(rules.files).toEqual([]);
  });

  test("an absent or empty file is absence", () => {
    const vault = vaultWith({ "project/x": "  \n\n" });
    expect(readScopedRules(vault, { ...NO_SCOPE, project: "x", host: "aaaa0001" }).text).toBe("");
  });

  test("all three axes render in project, harness, host order", () => {
    const vault = vaultWith({
      "project/x": "zzp",
      "harness/codex": "zzh",
      "host/aaaa0001": "zzd",
    });
    const rules = readScopedRules(vault, { project: "x", harness: "codex", host: "aaaa0001" });
    const at = (needle: string): number => rules.text.indexOf(needle);
    expect(at("### Project: x")).toBeLessThan(at("### Harness: codex"));
    expect(at("### Harness: codex")).toBeLessThan(at("### Host: aaaa0001"));
    expect(rules.files.map((file) => file.axis)).toEqual(["project", "harness", "host"]);
  });

  test("the cap drops the host file first and the notice reports integers", () => {
    // 96 + 2 + 100 characters fit 200 once the host section (103) is dropped.
    const body = "r".repeat(80);
    const vault = vaultWith({ "project/x": body, "harness/codex": body, "host/aaaa0001": body });
    const rules = readScopedRules(
      vault,
      { project: "x", harness: "codex", host: "aaaa0001" },
      { maxChars: 200 },
    );
    expect(rules.text).toContain("### Project: x");
    expect(rules.text).toContain("### Harness: codex");
    expect(rules.text).not.toContain("### Host: aaaa0001");
    expect(rules.text).toMatch(
      /_Scoped rules truncated to the configured cap: kept \d+ of \d+ characters, 1 file\(s\) dropped\._$/,
    );
    expect(rules.files.map((file) => [file.axis, file.truncated])).toEqual([
      ["project", false],
      ["harness", false],
      ["host", true],
    ]);
  });

  test("a file trimmed by the cap is marked truncated", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the project rules`).join("\n");
    const vault = vaultWith({ "project/x": body });
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" }, { maxChars: 200 });
    expect(rules.files).toEqual([
      { axis: "project", key: "x", path: "Brain/standing-rules/project/x.md", truncated: true },
    ]);
    expect(rules.text).toContain("0 file(s) dropped");
  });

  test("an unreadable file renders a vault-relative UNAVAILABLE line, never the error text", () => {
    const vault = vaultWith({});
    // A directory in the file's place fails the read on every platform.
    mkdirSync(brainScopedRulePath(vault, "project", "x"), { recursive: true });
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" });
    expect(rules.text).toContain(
      "UNAVAILABLE: Brain/standing-rules/project/x.md could not be read (EISDIR).",
    );
    expect(rules.files).toEqual([
      { axis: "project", key: "x", path: "Brain/standing-rules/project/x.md", truncated: false },
    ]);
    for (const marker of vaultMarkers(vault)) expect(rules.text).not.toContain(marker);
  });

  test("an unreadable device id with a host file appends the host notice", () => {
    const vault = vaultWith({ "host/bbbb0002": "zzhostzz" });
    const alone = readScopedRules(vault, NO_SCOPE, { hostUnreadable: true });
    expect(alone.text).toBe(`${SCOPED_RULES_HEADER}\n\n${SCOPED_RULES_HOST_UNREADABLE_NOTICE}`);
    expect(alone.files).toEqual([]);

    const withProject = vaultWith({ "project/x": "zzp", "host/bbbb0002": "zzhostzz" });
    const both = readScopedRules(
      withProject,
      { ...NO_SCOPE, project: "x" },
      { hostUnreadable: true },
    );
    expect(both.text.endsWith(`\n\n${SCOPED_RULES_HOST_UNREADABLE_NOTICE}`)).toBe(true);
    expect(both.text).not.toContain("zzhostzz");
  });

  test("an unreadable device id with no host file says nothing", () => {
    const vault = vaultWith({ "project/x": "zzp" });
    const rules = readScopedRules(vault, NO_SCOPE, { hostUnreadable: true });
    expect(rules.text).toBe("");
  });

  test("no rendered text carries the vault's absolute path", () => {
    const vault = vaultWith({ "project/x": "zzp", "host/aaaa0001": "r".repeat(400) });
    const rules = readScopedRules(
      vault,
      { project: "x", harness: null, host: "aaaa0001" },
      { maxChars: 200, hostUnreadable: true },
    );
    for (const marker of vaultMarkers(vault)) expect(rules.text).not.toContain(marker);
  });

  test("a section whose body cannot fit is dropped whole, never left as a bare heading", () => {
    const vault = vaultWith({ "project/x": `zzp ${"x".repeat(5000)}` });
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" }, { maxChars: 200 });
    expect(rules.text).not.toContain("### Project: x");
    expect(rules.text).toContain("1 file(s) dropped");
    expect(rules.files).toEqual([
      { axis: "project", key: "x", path: "Brain/standing-rules/project/x.md", truncated: true },
    ]);
  });

  test("the notice reserve covers every notice the block can carry", () => {
    // Every axis matched, the cap at its maximum and an unreadable device id.
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const vault = vaultWith({ "project/x": body, "harness/codex": body, "host/aaaa0001": body });
    const rules = readScopedRules(
      vault,
      { project: "x", harness: "codex", host: null },
      { maxChars: SCOPED_RULES_MAX_CHARS_MAX, hostUnreadable: true },
    );
    expect(rules.text.length).toBeLessThanOrEqual(
      SCOPED_RULES_HEADER.length + SCOPED_RULES_MAX_CHARS_MAX + SCOPED_RULES_NOTICE_RESERVE,
    );
  });

  test("the notice reserve covers both notices when the kept sections fill the cap", () => {
    // One-character lines, so the cut keeps the sections within a line of
    // the cap and both the truncation and the host notice ride on top.
    const vault = vaultWith({
      "project/x": "a\n".repeat(SCOPED_RULES_MAX_CHARS_DEFAULT),
      "host/aaaa0001": "zzhostzz",
    });
    const rules = readScopedRules(
      vault,
      { ...NO_SCOPE, project: "x" },
      { maxChars: SCOPED_RULES_MAX_CHARS_DEFAULT, hostUnreadable: true },
    );
    expect(rules.files[0]?.truncated).toBe(true);
    expect(rules.text).toEndWith(SCOPED_RULES_HOST_UNREADABLE_NOTICE);
    expect(rules.text.length).toBeLessThanOrEqual(
      SCOPED_RULES_HEADER.length + SCOPED_RULES_MAX_CHARS_DEFAULT + SCOPED_RULES_NOTICE_RESERVE,
    );
  });

  test("the default cap is the documented default", () => {
    // The section is "### Project: x\n\n" (16 characters) plus the body:
    // 100 under the default fits, 100 over it is cut. A default moved by
    // more than 100 either way flips one of the two.
    expect(projectRuleOf(SCOPED_RULES_MAX_CHARS_DEFAULT - 116).files[0]?.truncated).toBe(false);
    expect(projectRuleOf(SCOPED_RULES_MAX_CHARS_DEFAULT + 100).files[0]?.truncated).toBe(true);
  });

  test("a resolved value that spells a path never leaves its axis directory", () => {
    const vault = vaultWith({ "project/etc": "zzinsidezz" });
    writeFileSync(join(vault, "Brain", "etc.md"), "zzoutsidezz");
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "../../etc" });
    expect(rules.text).toContain("zzinsidezz");
    expect(rules.text).not.toContain("zzoutsidezz");
    expect(rules.files.map((file) => file.path)).toEqual(["Brain/standing-rules/project/etc.md"]);
  });
});

describe("readScopedRules and a symlink leaving the vault", () => {
  const SYMLINKS = canSymlink();
  const ESCAPED = "UNAVAILABLE: Brain/standing-rules/project/x.md could not be read (ESCAPE).";

  test.skipIf(!SYMLINKS)("a symlinked rule file renders the UNAVAILABLE line", () => {
    const vault = vaultWith({});
    const outside = join(mkTemp("o2b-scoped-outside-"), "x.md");
    writeFileSync(outside, "zzoutsidezz");
    mkdirSync(dirname(brainScopedRulePath(vault, "project", "x")), { recursive: true });
    symlinkSync(outside, brainScopedRulePath(vault, "project", "x"), "file");
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" });
    expect(rules.text).toContain(ESCAPED);
    expect(rules.text).not.toContain("zzoutsidezz");
    for (const marker of vaultMarkers(vault)) expect(rules.text).not.toContain(marker);
  });

  test.skipIf(!SYMLINKS)("a symlinked axis folder renders the UNAVAILABLE line", () => {
    const vault = vaultWith({});
    const outside = mkTemp("o2b-scoped-outside-");
    writeFileSync(join(outside, "x.md"), "zzoutsidezz");
    mkdirSync(brainScopedRulesDir(vault), { recursive: true });
    symlinkSync(outside, join(brainScopedRulesDir(vault), "project"), "dir");
    const rules = readScopedRules(vault, { ...NO_SCOPE, project: "x" });
    expect(rules.text).toContain(ESCAPED);
    expect(rules.text).not.toContain("zzoutsidezz");
    for (const marker of vaultMarkers(vault)) expect(rules.text).not.toContain(marker);
  });
});

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
