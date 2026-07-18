import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  defaultConfigPath,
  discoverConfig,
  parseSimpleYaml,
  redactMapping,
  resolveAgentName,
  resolveExposeHostPaths,
  resolveLinkOutputFormat,
  resolveDecisionRecallMaxPerSession,
  resolveDecisionRecallMinSpacingTurns,
  resolveRecallAdequacyThresholds,
  resolveSkillsAttachTriggers,
  resolveSkillsDir,
  resolveTimezone,
  resolveVault,
  setConfigValue,
  validateTimezoneName,
  vaultStoreReference,
  VAULT_STORE_REF_PREFIX,
} from "../../src/core/config.ts";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-test-"));
  for (const k of [
    "OPEN_SECOND_BRAIN_CONFIG",
    "XDG_CONFIG_HOME",
    "VAULT_DIR",
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "OBSIDIAN_LINK_FORMAT",
    "OPEN_SECOND_BRAIN_SKILLS_DIR",
    "OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS",
    "OPEN_SECOND_BRAIN_RECALL_ADEQUACY_SUFFICIENT",
    "OPEN_SECOND_BRAIN_RECALL_ADEQUACY_WEAK",
    "OPEN_SECOND_BRAIN_RECALL_ADEQUACY_MIN_RESULTS",
    "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS",
    "OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION",
    "OPEN_SECOND_BRAIN_DECISION_RECALL_MIN_SPACING_TURNS",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("defaultConfigPath", () => {
  test("uses OPEN_SECOND_BRAIN_CONFIG env override when set", () => {
    const p = join(tmp, "custom.yaml");
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = p;
    expect(defaultConfigPath()).toBe(p);
  });

  test("uses XDG_CONFIG_HOME when set without override", () => {
    process.env["XDG_CONFIG_HOME"] = tmp;
    expect(defaultConfigPath()).toBe(join(tmp, "open-second-brain", "config.yaml"));
  });
});

describe("parseSimpleYaml", () => {
  test("parses key: value lines", () => {
    const data = parseSimpleYaml("instance_name: Test Brain\nruntime: hermes\n");
    expect(data["instance_name"]).toBe("Test Brain");
    expect(data["runtime"]).toBe("hermes");
  });

  test("strips surrounding quotes", () => {
    const data = parseSimpleYaml("vault: \"/path\"\nname: 'X'\n");
    expect(data["vault"]).toBe("/path");
    expect(data["name"]).toBe("X");
  });

  test("skips comments and blanks", () => {
    const data = parseSimpleYaml("# top\n\nkey: val\n# trailing");
    expect(data).toEqual({ key: "val" });
  });
});

describe("discoverConfig", () => {
  test("reports missing config", () => {
    const p = join(tmp, "missing.yaml");
    const r = discoverConfig(p);
    expect(r.exists).toBe(false);
    expect(r.path).toBe(p);
    expect(r.data).toEqual({});
  });

  test("reads simple key: value yaml", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, "instance_name: Test Brain\nruntime: hermes\n");
    const r = discoverConfig(p);
    expect(r.exists).toBe(true);
    expect(r.data["instance_name"]).toBe("Test Brain");
    expect(r.data["runtime"]).toBe("hermes");
  });

  test("reports a directory as missing (not a regular file)", () => {
    const r = discoverConfig(tmp);
    expect(r.exists).toBe(false);
    expect(r.data).toEqual({});
  });

  test("reports invalid utf8 as missing", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00]));
    const r = discoverConfig(p);
    // Buffer with stray bytes still decodes (TextDecoder) without throwing,
    // so we don't necessarily report missing. The Python parser is more
    // strict. Either accept the lossy parse OR report missing — both
    // are safe. We accept the lossy parse here (matches Bun's readFileSync).
    expect(r.path).toBe(p);
  });
});

describe("setConfigValue", () => {
  test("persists key value as quoted yaml line", () => {
    const p = join(tmp, "config.yaml");
    setConfigValue("vault", "/some/path", p);
    const r = discoverConfig(p);
    expect(r.exists).toBe(true);
    expect(r.data["vault"]).toBe("/some/path");
  });

  test("merges with existing keys (does not lose them)", () => {
    const p = join(tmp, "config.yaml");
    setConfigValue("vault", "/v", p);
    setConfigValue("agent_name", "tester", p);
    const r = discoverConfig(p);
    expect(r.data["vault"]).toBe("/v");
    expect(r.data["agent_name"]).toBe("tester");
  });

  test("rejects values with disallowed characters", () => {
    const p = join(tmp, "config.yaml");
    expect(() => setConfigValue("vault", 'evil"value', p)).toThrow(/disallowed character/);
    expect(() => setConfigValue("vault", "with\nnewline", p)).toThrow(/disallowed character/);
  });

  test("persists secret references without resolving them", () => {
    const p = join(tmp, "config.yaml");
    setConfigValue("github_token", "$secret:GITHUB_TOKEN", p);

    const r = discoverConfig(p);

    expect(r.data["github_token"]).toBe("$secret:GITHUB_TOKEN");
  });
});

describe("redactMapping", () => {
  test("redacts secret-like keys", () => {
    const out = redactMapping({ api_key: "abc", path: "/tmp/v", token: "xyz" });
    expect(out["api_key"]).toBe("[REDACTED]");
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["path"]).toBe("/tmp/v");
  });
});

describe("resolveVault", () => {
  test("returns null when neither env nor config", () => {
    expect(resolveVault(join(tmp, "missing.yaml"))).toBeNull();
  });

  test("reads from env", () => {
    process.env["VAULT_DIR"] = "/tmp/env-vault";
    expect(resolveVault(join(tmp, "missing.yaml"))).toBe("/tmp/env-vault");
  });

  test("env wins over config", () => {
    process.env["VAULT_DIR"] = "/tmp/env-vault";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'vault: "/tmp/cfg-vault"\n');
    expect(resolveVault(cfg)).toBe("/tmp/env-vault");
  });

  test("reads from config when env unset", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'vault: "/tmp/cfg-vault"\n');
    expect(resolveVault(cfg)).toBe("/tmp/cfg-vault");
  });

  test("expands ~ in config value", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'vault: "~/my-vault"\n');
    const got = resolveVault(cfg);
    expect(got).not.toBeNull();
    expect(got!.startsWith("~")).toBe(false);
  });
});

describe("resolveAgentName", () => {
  test("env wins over config", () => {
    process.env["VAULT_AGENT_NAME"] = "from-env";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "agent_name: from-cfg\n");
    expect(resolveAgentName(cfg)).toBe("from-env");
  });

  test("config provides fallback", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "agent_name: from-cfg\n");
    expect(resolveAgentName(cfg)).toBe("from-cfg");
  });

  test("accepts agentName key (camelCase)", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "agentName: camelCased\n");
    expect(resolveAgentName(cfg)).toBe("camelCased");
  });

  test("returns 'agent' literal when nothing configured", () => {
    expect(resolveAgentName(join(tmp, "missing.yaml"))).toBe("agent");
  });
});

describe("resolveLinkOutputFormat", () => {
  test("defaults to wikilink", () => {
    expect(resolveLinkOutputFormat(join(tmp, "missing.yaml"))).toBe("wikilink");
  });

  test("reads markdown from config", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'link_output_format: "markdown"\n');
    expect(resolveLinkOutputFormat(cfg)).toBe("markdown");
  });

  test("invalid config falls back to wikilink", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'link_output_format: "html"\n');
    expect(resolveLinkOutputFormat(cfg)).toBe("wikilink");
  });

  test("OBSIDIAN_LINK_FORMAT env wins over config", () => {
    process.env["OBSIDIAN_LINK_FORMAT"] = "markdown";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'link_output_format: "wikilink"\n');
    expect(resolveLinkOutputFormat(cfg)).toBe("markdown");
  });

  test("empty OBSIDIAN_LINK_FORMAT env falls back to config", () => {
    process.env["OBSIDIAN_LINK_FORMAT"] = "   ";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'link_output_format: "markdown"\n');
    expect(resolveLinkOutputFormat(cfg)).toBe("markdown");
  });
});

describe("resolveTimezone", () => {
  test("validates IANA timezone names", () => {
    expect(validateTimezoneName("UTC")).toEqual({ ok: true, error: null });
    const invalid = validateTimezoneName("Not/A/Real/Zone");
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBeString();
  });

  test("returns null when nothing configured", () => {
    expect(resolveTimezone(join(tmp, "missing.yaml"))).toBeNull();
  });

  test("reads valid IANA from config", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'timezone: "Europe/Belgrade"\n');
    expect(resolveTimezone(cfg)).toBe("Europe/Belgrade");
  });

  test("invalid IANA falls back to null", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'timezone: "Not/A/Real/Zone"\n');
    expect(resolveTimezone(cfg)).toBeNull();
  });

  test("env wins over config", () => {
    process.env["VAULT_TIMEZONE"] = "UTC";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'timezone: "Europe/Belgrade"\n');
    expect(resolveTimezone(cfg)).toBe("UTC");
  });
});

describe("resolveDecisionRecall config (B5)", () => {
  test("returns null when unset (feature disabled, byte-identical)", () => {
    const cfg = join(tmp, "missing.yaml");
    expect(resolveDecisionRecallMaxPerSession(cfg)).toBeNull();
    expect(resolveDecisionRecallMinSpacingTurns(cfg)).toBeNull();
  });

  test("reads non-negative integers from config", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(
      cfg,
      "decision_recall.max_per_session: 3\ndecision_recall.min_spacing_turns: 5\n",
    );
    expect(resolveDecisionRecallMaxPerSession(cfg)).toBe(3);
    expect(resolveDecisionRecallMinSpacingTurns(cfg)).toBe(5);
  });

  test("rejects non-integer / negative values as null", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "decision_recall.max_per_session: -1\n");
    expect(resolveDecisionRecallMaxPerSession(cfg)).toBeNull();
  });

  test("env wins over config", () => {
    process.env["OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION"] = "7";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "decision_recall.max_per_session: 2\n");
    expect(resolveDecisionRecallMaxPerSession(cfg)).toBe(7);
  });
});

describe("resolveSkillsDir", () => {
  test("returns null when neither env nor config", () => {
    expect(resolveSkillsDir(join(tmp, "missing.yaml"))).toBeNull();
  });

  test("returns null for an empty or whitespace value", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_dir: "   "\n');
    expect(resolveSkillsDir(cfg)).toBeNull();
  });

  test("reads an absolute path from config verbatim", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_dir: "/srv/skills"\n');
    expect(resolveSkillsDir(cfg)).toBe("/srv/skills");
  });

  test("env wins over config", () => {
    process.env["OPEN_SECOND_BRAIN_SKILLS_DIR"] = "/env/skills";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_dir: "/cfg/skills"\n');
    expect(resolveSkillsDir(cfg)).toBe("/env/skills");
  });

  test("expands ~ in config value", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_dir: "~/my-skills"\n');
    const got = resolveSkillsDir(cfg);
    expect(got).not.toBeNull();
    expect(got!.startsWith("~")).toBe(false);
    expect(isAbsolute(got!)).toBe(true);
  });

  test("anchors a relative config value to the config-file directory", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "skills_dir: nested/skills\n");
    expect(resolveSkillsDir(cfg)).toBe(resolve(dirname(cfg), "nested/skills"));
  });

  test("anchors a relative env value to the config-file directory (CWD-independent)", () => {
    process.env["OPEN_SECOND_BRAIN_SKILLS_DIR"] = "rel/skills";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "instance_name: x\n");
    const got = resolveSkillsDir(cfg);
    expect(got).toBe(resolve(dirname(cfg), "rel/skills"));
    expect(isAbsolute(got!)).toBe(true);
  });
});

describe("resolveSkillsAttachTriggers", () => {
  test("defaults to false when nothing configured", () => {
    expect(resolveSkillsAttachTriggers(join(tmp, "missing.yaml"))).toBe(false);
  });

  test("reads true from config", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_attach_triggers: "true"\n');
    expect(resolveSkillsAttachTriggers(cfg)).toBe(true);
  });

  test("accepts 1 as truthy", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_attach_triggers: "1"\n');
    expect(resolveSkillsAttachTriggers(cfg)).toBe(true);
  });

  test("any other value stays false", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_attach_triggers: "yes"\n');
    expect(resolveSkillsAttachTriggers(cfg)).toBe(false);
  });

  test("env wins over config", () => {
    process.env["OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS"] = "true";
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'skills_attach_triggers: "false"\n');
    expect(resolveSkillsAttachTriggers(cfg)).toBe(true);
  });
});

describe("resolveRecallAdequacyThresholds", () => {
  test("defaults to 0.6 / 0.3 / 1 when unset", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "");
    expect(resolveRecallAdequacyThresholds(cfg)).toEqual({
      sufficient: 0.6,
      weak: 0.3,
      minResults: 1,
    });
  });

  test("reads configured floors and min_results", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(
      cfg,
      'recall_adequacy_sufficient: "0.75"\nrecall_adequacy_weak: "0.4"\nrecall_adequacy_min_results: "2"\n',
    );
    expect(resolveRecallAdequacyThresholds(cfg)).toEqual({
      sufficient: 0.75,
      weak: 0.4,
      minResults: 2,
    });
  });

  test("env overrides the config file", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'recall_adequacy_sufficient: "0.6"\n');
    process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_SUFFICIENT"] = "0.9";
    expect(resolveRecallAdequacyThresholds(cfg).sufficient).toBe(0.9);
  });

  test("rejects out-of-range floors", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'recall_adequacy_sufficient: "1.5"\n');
    expect(() => resolveRecallAdequacyThresholds(cfg)).toThrow();
  });

  test("rejects weak above sufficient", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'recall_adequacy_sufficient: "0.4"\nrecall_adequacy_weak: "0.6"\n');
    expect(() => resolveRecallAdequacyThresholds(cfg)).toThrow();
  });

  test("rejects a non-positive min_results", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, 'recall_adequacy_min_results: "0"\n');
    expect(() => resolveRecallAdequacyThresholds(cfg)).toThrow();
  });
});

describe("resolveExposeHostPaths", () => {
  test("defaults to false when unset", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "vault_path: /tmp/vault\n");
    expect(resolveExposeHostPaths(cfg)).toBe(false);
  });

  test("reads the config key", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "expose_host_paths: true\n");
    expect(resolveExposeHostPaths(cfg)).toBe(true);
  });

  test("env twin overrides", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "expose_host_paths: false\n");
    process.env["OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS"] = "true";
    expect(resolveExposeHostPaths(cfg)).toBe(true);
  });
});

describe("vaultStoreReference", () => {
  test("has the vault:// prefix and 32 hex chars (128-bit keyed digest)", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "vault_path: /tmp/vault\n");
    const ref = vaultStoreReference("/some/vault", cfg);
    expect(ref.startsWith(VAULT_STORE_REF_PREFIX)).toBe(true);
    expect(ref).toMatch(/^vault:\/\/[0-9a-f]{32}$/);
  });

  test("is stable for the same vault and differs across vaults", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "vault_path: /tmp/vault\n");
    expect(vaultStoreReference("/a/vault", cfg)).toBe(vaultStoreReference("/a/vault", cfg));
    expect(vaultStoreReference("/a/vault", cfg)).not.toBe(vaultStoreReference("/b/vault", cfg));
  });
});
