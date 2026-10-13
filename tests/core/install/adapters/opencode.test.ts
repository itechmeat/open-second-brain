/**
 * opencode adapter tests.
 *
 * The adapter writes the config opencode actually reads:
 * `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`, `mcp` key,
 * entries shaped `{type: "local", command: [bin, ...args],
 * environment?, enabled: true}` (verified against opencode.ai/docs
 * 2026-06-10). At the native V2 `mcp.servers` shape the entry instead
 * carries `disabled: false` - the V2 field list replaces `enabled` with
 * `disabled` - and never `enabled`. Earlier Open Second Brain releases
 * wrote `~/.config/opencode/mcp.json` with an `mcpServers` key - a file
 * opencode never reads; apply migrates our keys out of it.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Writable } from "node:stream";

import { opencodeAdapter } from "../../../../src/core/install/adapters/opencode.ts";
import { installedPluginContent } from "../../../../src/core/install/opencode-plugin-asset.ts";
import {
  WINDOWS_LAUNCHER_ENV,
  buildPayload,
  launcherCommand,
} from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { InstallError } from "../../../../src/core/install/types.ts";
import { JsoncEditError, parseJsoncObject } from "../../../../src/core/install/jsonc.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-opencode-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-opencode-h-"));
});
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function env(extraEnv: Record<string, string> = {}) {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-dev-agent", VAULT_TIMEZONE: "UTC", ...extraEnv },
    now: new Date("2026-06-10T12:00:00.000Z"),
  };
}

function applyOpts() {
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
  };
}

function payload() {
  return buildPayload({ vault, agent_name: "claude-dev-agent", timezone: "UTC" });
}

function configPath() {
  return join(home, ".config", "opencode", "opencode.json");
}

function legacyPath() {
  return join(home, ".config", "opencode", "mcp.json");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `key` member of `value` as a record, or a named failure naming
 * both - the narrow a `parseJsoncObject` result needs before its JSONC
 * members (typed `unknown`) can be asserted on.
 */
function recordAt(value: unknown, key: string): Record<string, unknown> {
  const member = isRecord(value) ? value[key] : undefined;
  if (!isRecord(member)) {
    throw new Error(`expected "${key}" to be a JSON object, received ${JSON.stringify(member)}`);
  }
  return member;
}

describe("opencode adapter - config path", () => {
  test("default path is ~/.config/opencode/opencode.json", () => {
    const r = opencodeAdapter.detect(env());
    expect(r.configPath).toBe(configPath());
  });

  test("XDG_CONFIG_HOME override is honoured", () => {
    const xdg = mkdtempSync(join(tmpdir(), "osb-xdg-"));
    const r = opencodeAdapter.detect(env({ XDG_CONFIG_HOME: xdg }));
    expect(r.configPath).toBe(join(xdg, "opencode", "opencode.json"));
    try {
      rmSync(xdg, { recursive: true, force: true });
    } catch {}
  });
});

/** The launcher words ahead of `mcp`: `o2b` on POSIX, `cmd /d /c o2b` on Windows. */
const LAUNCHER_ARGV = [launcherCommand().command, ...launcherCommand().prefix];

describe("opencode adapter - apply", () => {
  test("clean home: writes opencode.json with both keys in the opencode entry schema", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    const full = parsed.mcp["open-second-brain"];
    expect(full).toEqual({
      type: "local",
      command: [...LAUNCHER_ARGV, "mcp", "--vault", vault, "--host-target", "opencode"],
      // opencode keeps the operator host ("dev") but swaps the vendor to its
      // own, rather than inheriting the operator name "claude-dev-agent".
      environment: {
        ...(process.platform === "win32" ? WINDOWS_LAUNCHER_ENV : {}),
        VAULT_AGENT_NAME: "opencode-dev-agent",
        VAULT_TIMEZONE: "UTC",
      },
      enabled: true,
    });
    const writer = parsed.mcp["open-second-brain-writer"];
    expect(writer.command).toEqual([
      ...LAUNCHER_ARGV,
      "mcp",
      "--writer-only",
      "--vault",
      vault,
      "--host-target",
      "opencode",
    ]);
    expect(writer.type).toBe("local");
    expect(readManifest(vault).installs["opencode"]).toBeDefined();
  });

  test("preserves user-authored opencode.json content", () => {
    writeJson(configPath(), {
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      mcp: { other: { type: "remote", url: "https://x" } },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed["$schema"]).toBe("https://opencode.ai/config.json");
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcp.other).toEqual({ type: "remote", url: "https://x" });
    expect(parsed.mcp["open-second-brain"].type).toBe("local");
  });

  test("idempotent re-apply executes no steps", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const before = readFileSync(configPath(), "utf8");
    const second = opencodeAdapter.apply(
      opencodeAdapter.plan(payload(), env()),
      payload(),
      env(),
      applyOpts(),
    );
    expect(second.steps_executed).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("opencode adapter - lifecycle", () => {
  test("detect installed and verify ok after apply", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(opencodeAdapter.detect(env()).status).toBe("installed");
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
  });

  test("verify reports drift when an entry field is edited", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    parsed.mcp["open-second-brain"].enabled = false;
    writeFileSync(configPath(), JSON.stringify(parsed, null, 2) + "\n");
    expect(opencodeAdapter.verify(env()).status).toBe("drift");
  });

  test("uninstall removes our keys, keeps user keys, clears manifest", () => {
    writeJson(configPath(), { mcp: { other: { type: "remote", url: "https://x" } } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    opencodeAdapter.uninstall(env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed.mcp["open-second-brain"]).toBeUndefined();
    expect(parsed.mcp["open-second-brain-writer"]).toBeUndefined();
    expect(parsed.mcp.other).toEqual({ type: "remote", url: "https://x" });
    expect(readManifest(vault).installs["opencode"]).toBeUndefined();
  });
});

describe("opencode adapter - legacy mcp.json migration", () => {
  function legacyEntry(writerOnly = false) {
    return {
      command: "o2b",
      args: writerOnly ? ["mcp", "--writer-only", "--vault", vault] : ["mcp", "--vault", vault],
      env: { VAULT_AGENT_NAME: "claude-dev-agent", VAULT_TIMEZONE: "UTC" },
    };
  }

  test("apply removes our keys from a legacy mcp.json, keeps user keys", () => {
    writeJson(legacyPath(), {
      mcpServers: {
        "open-second-brain": legacyEntry(),
        "open-second-brain-writer": legacyEntry(true),
        other: { command: "x", args: [] },
      },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const legacy = JSON.parse(readFileSync(legacyPath(), "utf8"));
    expect(legacy.mcpServers["open-second-brain"]).toBeUndefined();
    expect(legacy.mcpServers["open-second-brain-writer"]).toBeUndefined();
    expect(legacy.mcpServers.other).toEqual({ command: "x", args: [] });
  });

  test("apply deletes a legacy mcp.json that contained only our keys", () => {
    writeJson(legacyPath(), {
      mcpServers: {
        "open-second-brain": legacyEntry(),
        "open-second-brain-writer": legacyEntry(true),
      },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("apply leaves a legacy mcp.json without our keys untouched", () => {
    writeJson(legacyPath(), { mcpServers: { other: { command: "x" } } });
    const before = readFileSync(legacyPath(), "utf8");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(readFileSync(legacyPath(), "utf8")).toBe(before);
  });

  test("apply ignores a malformed legacy mcp.json", () => {
    mkdirSync(dirname(legacyPath()), { recursive: true });
    writeFileSync(legacyPath(), "{ not json");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(readFileSync(legacyPath(), "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).mcp["open-second-brain"]).toBeDefined();
  });
});

describe("opencode adapter - bundled plugin installation", () => {
  function pluginPath() {
    return join(home, ".config", "opencode", "plugins", "open-second-brain.ts");
  }

  test("apply copies the bundled plugin with a version-stamped header", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(existsSync(pluginPath())).toBe(true);
    const content = readFileSync(pluginPath(), "utf8");
    expect(content.startsWith("// open-second-brain plugin v")).toBe(true);
    expect(content).toContain("export default {");
  });

  test("manifest records the plugin file as an owned path", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const entry = readManifest(vault).installs["opencode"];
    expect(entry?.owned_paths).toContain(pluginPath());
  });

  test("verify reports drift when the installed plugin is edited", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
    writeFileSync(pluginPath(), "// hand-edited\n");
    const v = opencodeAdapter.verify(env());
    expect(v.status).toBe("drift");
    expect(v.details.join(" ")).toContain("plugin");
  });

  test("verify reports drift when the plugin file is missing", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    rmSync(pluginPath());
    expect(opencodeAdapter.verify(env()).status).toBe("drift");
  });

  test("re-apply refreshes an outdated plugin copy", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    writeFileSync(pluginPath(), "// stale copy from an older release\n");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(readFileSync(pluginPath(), "utf8")).toBe(installedPluginContent());
  });

  test("dry-run apply does not write the plugin file", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), {
      ...applyOpts(),
      dryRun: true,
    });
    expect(existsSync(pluginPath())).toBe(false);
  });

  test("verify reports drift when the plugin path is a directory", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    rmSync(pluginPath(), { recursive: true, force: true });
    mkdirSync(pluginPath(), { recursive: true });
    expect(opencodeAdapter.verify(env()).status).toBe("drift");
  });

  test("apply replaces a stray directory at the plugin path", () => {
    mkdirSync(pluginPath(), { recursive: true });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const content = readFileSync(pluginPath(), "utf8");
    expect(content).toContain("export default {");
  });

  test("uninstall removes the plugin file", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const r = opencodeAdapter.uninstall(env(), applyOpts());
    expect(existsSync(pluginPath())).toBe(false);
    expect(r.removed_paths).toContain(pluginPath());
  });
});

describe("opencode adapter - plan completeness", () => {
  test("plan lists the plugin copy step", () => {
    const plan = opencodeAdapter.plan(payload(), env());
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("json-merge");
    expect(kinds).toContain("file-copy");
    expect(plan.steps.find((s) => s.kind === "file-copy")?.path).toContain(
      join("plugins", "open-second-brain.ts"),
    );
  });

  test("plan lists the legacy migration step only when mcp.json exists", () => {
    const without = opencodeAdapter.plan(payload(), env());
    expect(without.steps.some((s) => s.path === legacyPath())).toBe(false);
    writeJson(legacyPath(), { mcpServers: {} });
    const withLegacy = opencodeAdapter.plan(payload(), env());
    expect(withLegacy.steps.some((s) => s.path === legacyPath())).toBe(true);
  });
});

function jsoncConfigPath() {
  return join(home, ".config", "opencode", "opencode.jsonc");
}

/** A JSONC V2 fixture: header comment, inline comment, trailing comma. */
function writeJsoncV2Fixture(): string {
  const text = `// opencode configuration - operator notes survive
{
  "theme": "dark", // inline note
  "mcp": {
    "servers": {
      "other": { "type": "remote", "url": "https://x" },
    },
  },
}
`;
  mkdirSync(dirname(jsoncConfigPath()), { recursive: true });
  writeFileSync(jsoncConfigPath(), text);
  return text;
}

describe("opencode adapter - V2 mcp.servers shape", () => {
  test("a config carrying an mcp.servers object applies to mcp.servers and records nested owned_keys", () => {
    writeJson(configPath(), { mcp: { servers: { other: { type: "remote", url: "https://x" } } } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed.mcp.servers["open-second-brain"].type).toBe("local");
    expect(parsed.mcp.servers["open-second-brain"].environment.VAULT_AGENT_NAME).toBe(
      "opencode-dev-agent",
    );
    // The V2 field list replaces `enabled` with `disabled`: the native
    // entry carries `disabled: false` and never an `enabled` field.
    expect(parsed.mcp.servers["open-second-brain"].disabled).toBe(false);
    expect(parsed.mcp.servers["open-second-brain"].enabled).toBeUndefined();
    expect(parsed.mcp.servers["open-second-brain-writer"].disabled).toBe(false);
    expect(parsed.mcp.servers["open-second-brain-writer"].enabled).toBeUndefined();
    expect(parsed.mcp.servers.other).toEqual({ type: "remote", url: "https://x" });
    // No shadowing copy under the legacy top-level key.
    expect(parsed.mcp["open-second-brain"]).toBeUndefined();
    expect(readManifest(vault).installs["opencode"]?.owned_keys).toEqual([
      "mcp.servers.open-second-brain",
      "mcp.servers.open-second-brain-writer",
    ]);
  });

  test("a V1 config whose user server is named servers keeps the legacy shape", () => {
    // `mcp.servers` holding a server ENTRY (the type/command fields on
    // the block itself) is a user's server, not the native map of them.
    writeJson(configPath(), {
      mcp: { servers: { type: "local", command: ["other-agent", "mcp"], enabled: true } },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    // The user's entry is untouched and ours land at the top level.
    expect(parsed.mcp.servers.type).toBe("local");
    expect(parsed.mcp.servers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcp["open-second-brain"].type).toBe("local");
    expect(parsed.mcp["open-second-brain"].enabled).toBe(true);
    expect(readManifest(vault).installs["opencode"]?.owned_keys).toEqual([
      "mcp.open-second-brain",
      "mcp.open-second-brain-writer",
    ]);
  });

  test("verify reports shadowed legacy copies in a V2 file as drift", () => {
    writeJson(configPath(), { mcp: { servers: {} } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
    // A stale legacy copy of ours reappears beside the native entries
    // (an old sync tool, say): apply would remove it as non-canonical,
    // so verify must not call the same state ok.
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    parsed.mcp["open-second-brain"] = { type: "local", command: ["o2b", "mcp"], enabled: true };
    writeFileSync(configPath(), JSON.stringify(parsed, null, 2) + "\n");
    const v = opencodeAdapter.verify(env());
    expect(v.status).toBe("drift");
    expect(v.details.join(" ")).toContain("legacy");
    expect(v.details.join(" ")).toContain("open-second-brain");
  });

  test("detect reports a V2 file whose only copies are shadowed legacy ones as drift", () => {
    // A V1 install first, then the host's own upgrade adds a native
    // mcp.servers block: our keys are now registered at a site the
    // resolved shape does not read. That is an owned install at the
    // wrong place, not an absent one - verify calls the same state
    // drift, and a not-installed verdict here would make `o2b update`,
    // which skips only not-installed targets, skip the repair.
    writeJson(configPath(), { mcp: {} });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    parsed.mcp.servers = { other: { type: "remote", url: "https://x" } };
    writeFileSync(configPath(), JSON.stringify(parsed, null, 2) + "\n");
    const d = opencodeAdapter.detect(env());
    expect(d.status).toBe("drift");
    expect(d.notes.join(" ")).toContain("mcp");
    expect(d.notes.join(" ")).toContain("mcp.servers");
    // verify agrees the same file is drifted.
    expect(opencodeAdapter.verify(env()).status).toBe("drift");
    // `o2b update` no longer skips the target (drift, not
    // not-installed): the repair is the documented forced re-apply, the
    // guard naming the hand-edit first.
    let thrown: unknown;
    try {
      opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InstallError);
    expect((thrown as InstallError).kind).toBe("user-modified-block");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), {
      ...applyOpts(),
      force: true,
    });
    expect(opencodeAdapter.detect(env()).status).toBe("installed");
  });

  test("a fresh V2 install verifies clean against itself and detects as installed", () => {
    writeJson(configPath(), { mcp: { servers: {} } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
    expect(opencodeAdapter.detect(env()).status).toBe("installed");
    expect(opencodeAdapter.detect(env()).notes.join(" ")).toContain("mcp.servers");
  });

  test("V2 re-apply is idempotent and executes no steps", () => {
    writeJson(configPath(), { mcp: { servers: {} } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const before = readFileSync(configPath(), "utf8");
    const second = opencodeAdapter.apply(
      opencodeAdapter.plan(payload(), env()),
      payload(),
      env(),
      applyOpts(),
    );
    expect(second.steps_executed).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  test("V2 uninstall removes exactly the nested keys and keeps user keys", () => {
    writeJson(configPath(), { mcp: { servers: { other: { type: "remote", url: "https://x" } } } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const r = opencodeAdapter.uninstall(env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed.mcp.servers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcp.servers["open-second-brain-writer"]).toBeUndefined();
    expect(parsed.mcp.servers.other).toEqual({ type: "remote", url: "https://x" });
    expect(r.removed_keys).toEqual([
      "mcp.servers.open-second-brain",
      "mcp.servers.open-second-brain-writer",
    ]);
    expect(readManifest(vault).installs["opencode"]).toBeUndefined();
  });

  test("a V1-shaped config is byte-identical through apply: json-merge serialization, top-level mcp (off proof)", () => {
    writeJson(configPath(), {
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "remote", url: "https://x" } },
    });
    const before = readFileSync(configPath(), "utf8");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const after = readFileSync(configPath(), "utf8");
    // The json-merge contract: whole-root re-serialization at the detected indent.
    expect(after).toBe(JSON.stringify(JSON.parse(after), null, 2) + "\n");
    const parsed = JSON.parse(after);
    expect(parsed.mcp["open-second-brain"].type).toBe("local");
    expect(parsed.mcp.servers).toBeUndefined();
    expect(parsed["$schema"]).toBe("https://opencode.ai/config.json");
    // The plan preview keeps today's wording for the V1 route.
    expect(opencodeAdapter.plan(payload(), env()).steps[0]?.preview).toContain("into mcp at ");
    expect(before).not.toBe(after);
  });

  test("when only opencode.jsonc exists it is the resolved path and comments survive apply byte-for-byte", () => {
    const text = writeJsoncV2Fixture();
    expect(opencodeAdapter.detect(env()).configPath).toBe(jsoncConfigPath());
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const after = readFileSync(jsoncConfigPath(), "utf8");
    expect(after.startsWith("// opencode configuration - operator notes survive\n")).toBe(true);
    expect(after).toContain('"theme": "dark", // inline note\n');
    // The untouched comment-carrying lines are byte-identical; only the
    // spliced entry is new.
    const parsed = parseJsoncObject(after);
    const servers = recordAt(recordAt(parsed, "mcp"), "servers");
    expect(recordAt(servers, "open-second-brain").type).toBe("local");
    expect(servers.other).toEqual({ type: "remote", url: "https://x" });
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
    expect(text).toContain('"other": { "type": "remote", "url": "https://x" },\n');
    expect(after).toContain('"other": { "type": "remote", "url": "https://x" },\n');
  });

  test("a .jsonc file with a V1 shape gets top-level mcp with comments preserved", () => {
    const text = `// operator notes survive here too
{
  "theme": "dark", // inline note
}
`;
    mkdirSync(dirname(jsoncConfigPath()), { recursive: true });
    writeFileSync(jsoncConfigPath(), text);
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const after = readFileSync(jsoncConfigPath(), "utf8");
    expect(after.startsWith("// operator notes survive here too\n")).toBe(true);
    // The comment bytes survive; a comment sitting between the last
    // entry and the closing brace ends up trailing the splice point,
    // still inside the object it documents.
    expect(after).toContain("// inline note");
    const parsed = parseJsoncObject(after);
    expect(parsed.theme).toBe("dark");
    const mcp = recordAt(parsed, "mcp");
    expect(recordAt(mcp, "open-second-brain").type).toBe("local");
    expect(mcp.servers).toBeUndefined();
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
  });

  test("a commented JSONC config with no mcp key detects as not-installed, like plain JSON", () => {
    // An operator's hand-written config that merely carries comments: no
    // mcp key at all. Base detect maps the absent key to not-installed;
    // the editor route must agree, or `o2b update` - which skips only
    // not-installed targets - would perform a full install into an
    // opencode that was never installed.
    mkdirSync(dirname(jsoncConfigPath()), { recursive: true });
    writeFileSync(jsoncConfigPath(), `// my notes\n{\n  "theme": "dark"\n}\n`);
    const d = opencodeAdapter.detect(env());
    expect(d.status).toBe("not-installed");
    expect(d.notes).toEqual([]);
    // The plain-JSON twin of the same content agrees, so the verdict
    // splits on key presence, not on the file's syntax.
    writeJson(configPath(), { theme: "dark" });
    expect(opencodeAdapter.detect(env()).status).toBe("not-installed");
    rmSync(configPath());
    // A PRESENT-but-non-object mcp block is still drift: the file carries
    // something where our registration belongs.
    writeFileSync(jsoncConfigPath(), `// my notes\n{\n  "theme": "dark",\n  "mcp": "enabled"\n}\n`);
    const drift = opencodeAdapter.detect(env());
    expect(drift.status).toBe("drift");
    expect(drift.notes.join(" ")).toContain("mcp is not a JSON object");
  });

  test("duplicate top-level keys refuse apply naming the file, without a partial write", () => {
    const dup = `// ambiguous config
{
  "theme": "dark",
  "theme": "light",
}
`;
    mkdirSync(dirname(jsoncConfigPath()), { recursive: true });
    writeFileSync(jsoncConfigPath(), dup);
    let thrown: unknown;
    try {
      opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JsoncEditError);
    expect((thrown as Error).message).toContain(jsoncConfigPath());
    expect((thrown as Error).name).toBe("JsoncEditError");
    expect(readFileSync(jsoncConfigPath(), "utf8")).toBe(dup);
  });

  test("an mcp.servers appearance is not migrated until re-apply, and the first re-apply refuses through the guard", () => {
    // A healthy V1 install first.
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    // The host upgrades to the native shape: mcp.servers appears, the
    // file is touched after the manifest's applied_at.
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    parsed.mcp.servers = {};
    writeFileSync(configPath(), JSON.stringify(parsed, null, 2) + "\n");
    const future = new Date(env().now.getTime() + 60_000);
    utimesSync(configPath(), future, future);

    // Nothing migrates without an operator re-apply.
    const before = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(before.mcp["open-second-brain"]).toBeDefined();
    expect(before.mcp.servers["open-second-brain"]).toBeUndefined();

    // verify reports the one-time drift: the native shape lacks our entries.
    expect(opencodeAdapter.verify(env()).status).toBe("drift");

    // The first re-apply refuses through the user-modified-block guard.
    let thrown: unknown;
    try {
      opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InstallError);
    expect((thrown as InstallError).kind).toBe("user-modified-block");
    expect((thrown as Error).message).toContain("hand-edited");

    // The operator's forced re-apply lands the native entries and removes
    // our shadowed legacy copies.
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), {
      ...applyOpts(),
      force: true,
    });
    const after = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(after.mcp.servers["open-second-brain"].type).toBe("local");
    expect(after.mcp["open-second-brain"]).toBeUndefined();
    expect(after.mcp["open-second-brain-writer"]).toBeUndefined();
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
  });

  test("the plan names the resolved shape before any write", () => {
    // No config: today's fresh-install wording.
    expect(opencodeAdapter.plan(payload(), env()).steps[0]?.preview).toContain("into mcp at ");
    writeJson(configPath(), { mcp: { servers: {} } });
    const v2Plan = opencodeAdapter.plan(payload(), env());
    expect(v2Plan.steps[0]?.preview).toContain("into mcp.servers at ");
    expect(v2Plan.steps[0]?.path).toBe(configPath());
  });
});

describe("opencode adapter - __proto__ injection", () => {
  /**
   * The audit's attack: a cloned or synced config whose only Open
   * Second Brain registration sits under a literal `__proto__` key. A
   * host parsing with JSON.parse sees no registration; the adapter must
   * agree.
   */
  function writeCraftedProtoConfig(): string {
    const text = `{
  "mcp": {
    "servers": {
      "__proto__": {
        "open-second-brain": { "type": "local", "command": ["evil"], "enabled": true },
        "open-second-brain-writer": { "type": "local", "command": ["evil"], "enabled": true }
      }
    }
  }
}
`;
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), text);
    return text;
  }

  test("a crafted __proto__ key never reads as an install", () => {
    writeCraftedProtoConfig();
    expect(opencodeAdapter.detect(env()).status).toBe("not-installed");
    expect(opencodeAdapter.verify(env()).status).toBe("not-installed");
  });

  test("apply heals a polluted file with real own keys instead of refusing", () => {
    // An owned install first, so the user-modified-block guard is armed.
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    writeCraftedProtoConfig();
    // Pre-fix the in-based guard saw our keys through the injected
    // prototype and refused with the hand-edited message on content that
    // registers nothing.
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as {
      mcp: { servers: Record<string, unknown> };
    };
    const servers = parsed.mcp.servers;
    // A JSON.parse host now sees a real registration beside the inert
    // literal key - which is file content this adapter does not own and
    // leaves alone.
    expect(Object.hasOwn(servers, "open-second-brain")).toBe(true);
    expect(Object.hasOwn(servers, "open-second-brain-writer")).toBe(true);
    expect(Object.hasOwn(servers, "__proto__")).toBe(true);
    expect(opencodeAdapter.detect(env()).status).toBe("installed");
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
  });
});

describe("opencode adapter - both-files precedence", () => {
  test("a legacy opencode.json with our keys outranks a newer opencode.jsonc for every verb", () => {
    // A real V1 install first: our keys live in opencode.json.
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    // The host later creates a newer opencode.jsonc carrying mcp.servers.
    const jsoncText = `// newer host-managed config
{
  "mcp": {
    "servers": {
      "other": { "type": "remote", "url": "https://x" },
    },
  },
}
`;
    mkdirSync(dirname(jsoncConfigPath()), { recursive: true });
    writeFileSync(jsoncConfigPath(), jsoncText);

    // detect resolves to the legacy file and finds our keys there.
    const d = opencodeAdapter.detect(env());
    expect(d.configPath).toBe(configPath());
    expect(d.status).toBe("installed");

    // apply services the legacy file; the .jsonc file is never touched.
    const result = opencodeAdapter.apply(
      opencodeAdapter.plan(payload(), env()),
      payload(),
      env(),
      applyOpts(),
    );
    expect(result.manifest.config_path).toBe(configPath());
    expect(readFileSync(jsoncConfigPath(), "utf8")).toBe(jsoncText);
    expect(readManifest(vault).installs["opencode"]?.config_path).toBe(configPath());

    // verify reads the legacy file and reports ok against it.
    expect(opencodeAdapter.verify(env()).status).toBe("ok");

    // uninstall sweeps the legacy file; the .jsonc file stays byte-identical.
    const u = opencodeAdapter.uninstall(env(), applyOpts());
    expect(u.removed_keys).toEqual(["mcp.open-second-brain", "mcp.open-second-brain-writer"]);
    expect(readFileSync(jsoncConfigPath(), "utf8")).toBe(jsoncText);
    const after = JSON.parse(readFileSync(configPath(), "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(after.mcp["open-second-brain"]).toBeUndefined();
    expect(after.mcp["open-second-brain-writer"]).toBeUndefined();
    expect(readManifest(vault).installs["opencode"]).toBeUndefined();
    expect(opencodeAdapter.detect(env()).status).toBe("not-installed");
  });
});
