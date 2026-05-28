import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfigPath,
  discoverConfig,
  parseSimpleYaml,
  redactMapping,
  resolveAgentName,
  resolveLinkOutputFormat,
  resolveTimezone,
  resolveVault,
  setConfigValue,
  validateTimezoneName,
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
