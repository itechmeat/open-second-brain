/**
 * The Codex CLI adapter, on both of the paths it can take.
 *
 * Codex is the second subprocess-primary target after `copilot-cli`, and
 * it differs from that precedent in one way this file is built around:
 * `codex mcp add` PERSISTS into the same `~/.codex/config.toml` the
 * fallback writes. So the file is evidence in both modes - but only in
 * the fallback mode did this build write the bytes, and the fake host
 * below deliberately serialises its tables in a different (still valid)
 * layout to prove `verify` does not demand our formatting from a
 * registration the host itself made.
 *
 * Three properties every case here exists to hold:
 *
 *   - **The subprocess is told which home to install into.** The runner
 *     seam takes the resolved Codex home as its first argument, because
 *     an adapter that installs into `InstallEnv.home` while its
 *     subprocess writes the ambient `~/.codex` would mutate the
 *     operator's real machine from a test.
 *   - **Unrelated TOML survives.** A `~/.codex/config.toml` carries
 *     `[plugins."..."]` and `[marketplaces....]` tables this build has no
 *     business touching; the fallback path is asserted byte-for-byte
 *     against them.
 *   - **A probe that could not run is named, never assumed.** Both skip
 *     branches (binary absent, binary refuses) are driven.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  codexAdapter,
  resetCodexRunner,
  setCodexRunner,
  type CodexRunner,
} from "../../../../src/core/install/adapters/codex.ts";
import {
  resetHostProbeRunner,
  setHostProbeRunner,
} from "../../../../src/core/install/host-probe.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../../../../src/core/install/json-merge.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import type { InstallEnv, McpPayload } from "../../../../src/core/install/types.ts";

let vault: string;
let home: string;
let stderrBuf: string[];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-codex-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-codex-h-"));
  stderrBuf = [];
});

afterEach(() => {
  resetCodexRunner();
  resetHostProbeRunner();
  for (const dir of [vault, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function env(overrides: Record<string, string> = {}): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC", ...overrides },
    now: new Date("2026-08-16T12:00:00.000Z"),
  };
}

function applyOpts() {
  const stdout = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrBuf.push(chunk.toString());
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  };
}

function payload(): McpPayload {
  return buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
}

function configPath(base: string = join(home, ".codex")): string {
  return join(base, "config.toml");
}

function install(installEnv: InstallEnv = env()): void {
  const p = payload();
  codexAdapter.apply(codexAdapter.plan(p, installEnv), p, installEnv, applyOpts());
}

/** Unrelated tables a real `~/.codex/config.toml` carries. */
const FOREIGN_TOML = [
  'model = "gpt-5-codex"',
  "",
  '[plugins."open-second-brain@open-second-brain"]',
  "enabled = true",
  "",
  "[marketplaces.builtin]",
  'url = "https://example.invalid/marketplace"',
  "",
  "[mcp_servers.some-other-tool]",
  'command = "other"',
  'args = ["serve"]',
  "",
].join("\n");

// ---------- Fakes ----------

interface FakeHost {
  readonly runner: CodexRunner;
  readonly calls: ReadonlyArray<ReadonlyArray<string>>;
  readonly homes: ReadonlyArray<string>;
  registered(): ReadonlyArray<string>;
}

/**
 * A `codex` binary that behaves like the real one: `mcp add` appends a
 * `[mcp_servers.<name>]` table to `$CODEX_HOME/config.toml` in ITS OWN
 * layout (multi-line `args`), `mcp remove` deletes it.
 */
function fakeCodex(opts: { available?: boolean; addExitCode?: number } = {}): FakeHost {
  const calls: string[][] = [];
  const homes: string[] = [];
  const names = new Set<string>();
  const write = (codexHome: string) => {
    const tables = [...names].map((name) =>
      [`[mcp_servers.${name}]`, `command = "o2b"`, "args = [", `  "mcp",`, "]", ""].join("\n"),
    );
    mkdirSync(codexHome, { recursive: true });
    const existing = existsSync(configPath(codexHome))
      ? readFileSync(configPath(codexHome), "utf8")
      : "";
    // Drop whole `[mcp_servers.<osb>]` sections, header through body, so
    // a re-add does not stack a second copy of the table.
    const kept: string[] = [];
    let skipping = false;
    for (const line of existing.split("\n")) {
      if (line.startsWith("[")) skipping = line.startsWith("[mcp_servers.open-second-brain");
      if (skipping || line.trim().length === 0) continue;
      kept.push(line);
    }
    const keep = kept.join("\n");
    writeFileSync(
      configPath(codexHome),
      (keep.length > 0 ? keep + "\n\n" : "") + tables.join("\n"),
    );
  };
  return {
    calls,
    homes,
    registered: () => [...names],
    runner: {
      available: () => opts.available ?? true,
      run(codexHome, args) {
        calls.push([...args]);
        homes.push(codexHome);
        const [verb, action, name] = args;
        if (verb !== "mcp" || typeof name !== "string") {
          return { exitCode: 1, stdout: "", stderr: `unknown command: ${args.join(" ")}` };
        }
        if (action === "add") {
          if (opts.addExitCode !== undefined && opts.addExitCode !== 0) {
            return { exitCode: opts.addExitCode, stdout: "", stderr: "codex refused the add" };
          }
          names.add(name);
          write(codexHome);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (action === "remove") {
          const had = names.delete(name);
          write(codexHome);
          return had
            ? { exitCode: 0, stdout: "", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: `no such server: ${name}` };
        }
        return { exitCode: 1, stdout: "", stderr: `unknown action: ${String(action)}` };
      },
    },
  };
}

/** A runner whose binary does not exist; running it is a test failure. */
function absentCodex(): CodexRunner {
  return {
    available: () => false,
    run: () => {
      throw new Error("the adapter must not spawn codex when it reported the binary absent");
    },
  };
}

/** The host answering the declared probe with `registered`, one per line. */
function stageProbe(registered: ReadonlyArray<string>): void {
  setHostProbeRunner({
    available: () => true,
    run: () => ({ exitCode: 0, stdout: `Name\n${registered.join("\n")}\n`, stderr: "" }),
  });
}

// ---------- The subprocess path ----------

describe("codex adapter — the CLI is present", () => {
  test("apply registers both servers through `codex mcp add`, command after the separator", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    const adds = host.calls.filter((c) => c[1] === "add");
    expect(adds.map((c) => c[2]).toSorted()).toEqual([OSB_KEY_FULL, OSB_KEY_WRITER].toSorted());
    const full = adds.find((c) => c[2] === OSB_KEY_FULL)!;
    expect(full.slice(full.indexOf("--") + 1)).toEqual([
      "o2b",
      "mcp",
      "--vault",
      vault,
      "--host-target",
      "codex",
    ]);
    expect(readManifest(vault).installs["codex"]!.operation).toBe("subprocess");
  });

  test("the subprocess is told the Codex home this env installs into", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    expect([...new Set(host.homes)]).toEqual([join(home, ".codex")]);
  });

  test("CODEX_HOME relocates both the config file and the subprocess home", () => {
    const elsewhere = join(home, "codex-elsewhere");
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install(env({ CODEX_HOME: elsewhere }));
    expect([...new Set(host.homes)]).toEqual([elsewhere]);
    expect(codexAdapter.detect(env({ CODEX_HOME: elsewhere })).configPath).toBe(
      configPath(elsewhere),
    );
  });

  test("the registration carries codex's own host-qualified agent name", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    const add = host.calls.find((c) => c[1] === "add" && c[2] === OSB_KEY_FULL)!;
    expect(add).toContain("VAULT_AGENT_NAME=codex-claude-vps");
    const hostQualified = fakeCodex();
    setCodexRunner(hostQualified.runner);
    const p = buildPayload({ vault, agent_name: "claude-vps-agent", timezone: "UTC" });
    const e = env({ VAULT_AGENT_NAME: "claude-vps-agent" });
    codexAdapter.apply(codexAdapter.plan(p, e), p, e, applyOpts());
    expect(hostQualified.calls.find((c) => c[1] === "add")!).toContain(
      "VAULT_AGENT_NAME=codex-vps-agent",
    );
  });

  test("apply is idempotent: a second run leaves the same two servers registered", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    const first = readFileSync(configPath(), "utf8");
    install();
    expect(readFileSync(configPath(), "utf8")).toBe(first);
    expect(host.registered().toSorted()).toEqual([OSB_KEY_FULL, OSB_KEY_WRITER].toSorted());
  });

  test("a dry run registers nothing and records no manifest entry", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    const p = payload();
    codexAdapter.apply(codexAdapter.plan(p, env()), p, env(), { ...applyOpts(), dryRun: true });
    expect(host.calls).toEqual([]);
    expect(readManifest(vault).installs["codex"]).toBeUndefined();
  });

  test("a failing `codex mcp add` falls back to the TOML merge and names the failure", () => {
    const host = fakeCodex({ addExitCode: 7 });
    setCodexRunner(host.runner);
    install();
    expect(stderrBuf.join("")).toContain("codex mcp add failed");
    expect(readFileSync(configPath(), "utf8")).toContain(`[mcp_servers.${OSB_KEY_FULL}]`);
    expect(readManifest(vault).installs["codex"]!.operation).toBe("managed-block");
  });
});

// ---------- The TOML fallback path ----------

describe("codex adapter — the CLI is absent", () => {
  test("the fallback writes both server tables into config.toml", () => {
    setCodexRunner(absentCodex());
    install();
    const toml = readFileSync(configPath(), "utf8");
    expect(toml).toContain(`[mcp_servers.${OSB_KEY_FULL}]`);
    expect(toml).toContain(`[mcp_servers.${OSB_KEY_WRITER}]`);
    expect(toml).toContain(`"--host-target", "codex"`);
    expect(toml).toContain('VAULT_AGENT_NAME = "codex-claude-vps"');
    expect(readManifest(vault).installs["codex"]!.operation).toBe("managed-block");
    expect(stderrBuf.join("")).toContain("file-fallback");
  });

  test("every unrelated table survives byte-for-byte", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(), FOREIGN_TOML);
    setCodexRunner(absentCodex());
    install();
    const toml = readFileSync(configPath(), "utf8");
    for (const line of FOREIGN_TOML.split("\n").filter((l) => l.trim().length > 0)) {
      expect(toml).toContain(line);
    }
    expect(toml.indexOf('[plugins."open-second-brain@open-second-brain"]')).toBeLessThan(
      toml.indexOf(`[mcp_servers.${OSB_KEY_FULL}]`),
    );
  });

  test("a second apply leaves the file byte-identical", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(), FOREIGN_TOML);
    setCodexRunner(absentCodex());
    install();
    const first = readFileSync(configPath(), "utf8");
    install();
    expect(readFileSync(configPath(), "utf8")).toBe(first);
  });

  test("a dry run on the fallback path writes nothing", () => {
    setCodexRunner(absentCodex());
    const p = payload();
    codexAdapter.apply(codexAdapter.plan(p, env()), p, env(), { ...applyOpts(), dryRun: true });
    expect(existsSync(configPath())).toBe(false);
  });
});

// ---------- detect and plan ----------

describe("codex adapter — detect and plan", () => {
  test("detect reports not-installed on a clean home and names the file it would write", () => {
    setCodexRunner(absentCodex());
    const result = codexAdapter.detect(env());
    expect(result.status).toBe("not-installed");
    expect(result.configPath).toBe(configPath());
  });

  test("detect reports drift when only one of the two tables is declared", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(), `[mcp_servers.${OSB_KEY_FULL}]\ncommand = "o2b"\nargs = []\n`);
    setCodexRunner(absentCodex());
    expect(codexAdapter.detect(env()).status).toBe("drift");
  });

  test("detect reports installed once both tables are declared", () => {
    setCodexRunner(absentCodex());
    install();
    expect(codexAdapter.detect(env()).status).toBe("installed");
  });

  test("plan names the subprocess when the binary is present and the merge when it is not", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    expect(codexAdapter.plan(payload(), env()).steps.map((s) => s.kind)).toEqual(["subprocess"]);
    setCodexRunner(absentCodex());
    const fallback = codexAdapter.plan(payload(), env());
    expect(fallback.steps.map((s) => s.kind)).toEqual(["managed-block"]);
    expect(fallback.steps[0]!.path).toBe(configPath());
    expect(fallback.postNotes.join("\n")).toContain("codex");
  });
});

// ---------- verify ----------

describe("codex adapter — verify", () => {
  test("no manifest entry is not-installed, with the remedy", () => {
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("not-installed");
    expect(result.fix_hint).toBe("o2b install --target codex --apply");
  });

  test("the host reports both servers: ok, naming the probe it ran", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    stageProbe([OSB_KEY_FULL, OSB_KEY_WRITER]);
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("ok");
    expect(result.details.join("; ")).toContain("`codex mcp list` reports both OSB servers");
  });

  test("the fallback file matching the canonical payload verifies ok", () => {
    setCodexRunner(absentCodex());
    install();
    stageProbe([OSB_KEY_FULL, OSB_KEY_WRITER]);
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("ok");
    expect(result.details.join("; ")).toContain(configPath());
  });

  test("an edited table on the fallback path is drift, and re-applying is the remedy", () => {
    setCodexRunner(absentCodex());
    install();
    stageProbe([OSB_KEY_FULL, OSB_KEY_WRITER]);
    writeFileSync(
      configPath(),
      readFileSync(configPath(), "utf8").replace('command = "o2b"', 'command = "TAMPERED"'),
    );
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("drift");
    expect(result.fix_hint).toBe("o2b install --target codex --apply");
  });

  test("the host's own formatting is not drift: a subprocess install verifies on presence", () => {
    // `codex mcp add` writes the table in codex's layout, not ours. A
    // byte comparison against our serializer would report drift on a
    // registration the host itself made and is serving correctly.
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    expect(readFileSync(configPath(), "utf8")).not.toContain("--host-target");
    stageProbe([OSB_KEY_FULL, OSB_KEY_WRITER]);
    expect(codexAdapter.verify(env()).status).toBe("ok");
  });

  test("the config declares both but the host reports neither: unreachable, not ok", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    stageProbe([]);
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("mcp-unreachable");
    expect(result.details.join("; ")).toContain(OSB_KEY_FULL);
    expect(result.fix_hint ?? "").toContain("restart");
  });

  test("the host reports nothing and the config lost the tables: drift", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    writeFileSync(configPath(), FOREIGN_TOML);
    stageProbe([]);
    expect(codexAdapter.verify(env()).status).toBe("drift");
  });

  test("the binary is absent: the skip is named and the file still answers", () => {
    setCodexRunner(absentCodex());
    install();
    setHostProbeRunner({
      available: () => false,
      run: () => {
        throw new Error("the probe must not spawn a binary it reported absent");
      },
    });
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("ok");
    expect(result.details.join("; ")).toContain("`codex` is not on PATH");
  });

  test("the binary refuses: the exit code and its first stderr line are named", () => {
    setCodexRunner(absentCodex());
    install();
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 4, stdout: "", stderr: "failed to load configuration\n" }),
    });
    const result = codexAdapter.verify(env());
    expect(result.details.join("; ")).toContain("exited 4: failed to load configuration");
  });
});

// ---------- uninstall ----------

describe("codex adapter — uninstall", () => {
  test("the CLI path removes both names and drops the manifest entry", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    codexAdapter.uninstall(env(), applyOpts());
    expect(host.registered()).toEqual([]);
    expect(
      host.calls.filter((c) => c[1] === "remove" && c[2] === OSB_KEY_WRITER).length,
    ).toBeGreaterThan(0);
    expect(readManifest(vault).installs["codex"]).toBeUndefined();
  });

  test("the fallback path removes only our tables", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(configPath(), FOREIGN_TOML);
    setCodexRunner(absentCodex());
    install();
    codexAdapter.uninstall(env(), applyOpts());
    const toml = readFileSync(configPath(), "utf8");
    expect(toml).not.toContain(`[mcp_servers.${OSB_KEY_FULL}]`);
    expect(toml).not.toContain(`[mcp_servers.${OSB_KEY_WRITER}]`);
    expect(toml).toContain("[mcp_servers.some-other-tool]");
    expect(toml).toContain('[plugins."open-second-brain@open-second-brain"]');
  });

  test("a subprocess install whose CLI is gone is still removed from the file", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    setCodexRunner(absentCodex());
    codexAdapter.uninstall(env(), applyOpts());
    expect(readFileSync(configPath(), "utf8")).not.toContain(`[mcp_servers.${OSB_KEY_FULL}]`);
  });

  test("a dry run removes nothing", () => {
    setCodexRunner(absentCodex());
    install();
    codexAdapter.uninstall(env(), { ...applyOpts(), dryRun: true });
    expect(readFileSync(configPath(), "utf8")).toContain(`[mcp_servers.${OSB_KEY_FULL}]`);
    expect(readManifest(vault).installs["codex"]).toBeDefined();
  });

  test("uninstalling what was never installed is refused by name, with the remedy", () => {
    setCodexRunner(absentCodex());
    let message = "";
    let hint = "";
    try {
      codexAdapter.uninstall(env(), applyOpts());
    } catch (e) {
      message = (e as Error).message;
      hint = (e as { hint?: string }).hint ?? "";
    }
    expect(message).toContain("codex");
    expect(hint).toContain("--force-from-snippet");
  });
});

// ---------- A commented-out table is the operator saying no ----------

describe("a commented-out table is not a declaration", () => {
  /** The file an operator produces by commenting both tables out. */
  function commentOutOurTables(): void {
    const path = configPath();
    const current = readFileSync(path, "utf8");
    writeFileSync(
      path,
      current
        .split("\n")
        .map((line) => (line.trim().length === 0 ? line : `# ${line}`))
        .join("\n"),
    );
  }

  test("detect reports not-installed, not installed", () => {
    // `toml.includes("[mcp_servers.open-second-brain]")` matches
    // `# [mcp_servers.open-second-brain]` just as readily, so commenting
    // both tables out - the ordinary way to turn a server off - left
    // `detect` reporting a registration Codex would never load.
    setCodexRunner(absentCodex());
    install();
    commentOutOurTables();
    expect(codexAdapter.detect(env()).status).toBe("not-installed");
  });

  test("verify reports drift and names both missing tables", () => {
    setCodexRunner(absentCodex());
    install();
    commentOutOurTables();
    setHostProbeRunner({
      available: () => false,
      run: () => ({ exitCode: 127, stdout: "", stderr: "" }),
    });
    const result = codexAdapter.verify(env());
    expect(result.status).toBe("drift");
    expect(result.details.join("; ")).toContain(OSB_KEY_FULL);
    expect(result.details.join("; ")).toContain(OSB_KEY_WRITER);
  });

  test("an indented but uncommented header still counts as declared", () => {
    // The anchor is a whole-line match with leading whitespace tolerated:
    // TOML permits an indented table header, and refusing one would be
    // the same misreading pointed the other way.
    setCodexRunner(absentCodex());
    install();
    const path = configPath();
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("[mcp_servers.", "  [mcp_servers."));
    expect(codexAdapter.detect(env()).status).toBe("installed");
  });
});

// ---------- A failed removal keeps the manifest entry ----------

describe("uninstall does not forget an install it failed to remove", () => {
  test("a `codex mcp remove` that fails leaves the entry, so the retry works", () => {
    // Dropping the manifest entry after a failed removal makes the retry
    // impossible: the next `o2b uninstall` finds no entry, throws
    // `manifest-missing` and demands `--force-from-snippet` for a server
    // the host still has. grok already guarded this; codex did not.
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    expect(readManifest(vault).installs["codex"]).toBeDefined();

    setCodexRunner({
      available: () => true,
      run: () => ({ exitCode: 3, stdout: "", stderr: "codex refused the remove" }),
    });
    const result = codexAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(result.removed_keys).toEqual([]);
    expect(result.skipped.map(([name]) => name).toSorted()).toEqual(
      [OSB_KEY_FULL, OSB_KEY_WRITER].toSorted(),
    );
    expect(readManifest(vault).installs["codex"]).toBeDefined();

    // The retry, once the host is willing again.
    setCodexRunner(host.runner);
    const retry = codexAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(retry.removed_keys.toSorted()).toEqual([OSB_KEY_FULL, OSB_KEY_WRITER].toSorted());
    expect(readManifest(vault).installs["codex"]).toBeUndefined();
  });

  test("a clean removal still drops the entry", () => {
    const host = fakeCodex();
    setCodexRunner(host.runner);
    install();
    codexAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(readManifest(vault).installs["codex"]).toBeUndefined();
  });

  test("nothing left to remove is a completed uninstall, not a failure", () => {
    // A skip is not a failure. `no OSB tables declared` means the file
    // path found nothing to strip, and keeping the entry alive for that
    // would make the manifest unclearable.
    setCodexRunner(absentCodex());
    install();
    writeFileSync(configPath(), "");
    const result = codexAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(result.skipped.length).toBe(1);
    expect(readManifest(vault).installs["codex"]).toBeUndefined();
  });

  test("the file path reports the config it changed", () => {
    // grok names its hooks file; codex named nothing, so an uninstall that
    // rewrote `config.toml` left the operator no path to check.
    setCodexRunner(absentCodex());
    install();
    const result = codexAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(result.removed_paths).toEqual([configPath()]);
  });
});
