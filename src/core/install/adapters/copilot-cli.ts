/**
 * GitHub Copilot CLI adapter — subprocess-driven, with JSON-file
 * fallback when `copilot` CLI is missing or its `mcp add` errors out.
 *
 * Primary path:
 *   - `copilot mcp remove <name>` (best-effort; non-zero is ok if the
 *     server wasn't registered)
 *   - `copilot mcp add <name> --command <cmd> --arg <arg> ... [--env K=V ...]`
 *
 * Fallback path:
 *   - JSON-merge into `${XDG_CONFIG_HOME:-$HOME/.config}/github-copilot/mcp.json`.
 *     The exact fallback path is the one Copilot CLI consults at startup
 *     when its CLI is not used to register the server.
 *
 * The subprocess seam is injectable via `setCopilotRunner` so tests
 * can drive both branches deterministically.
 *
 * Two seams, not one, and the split is deliberate: `CopilotRunner` owns
 * the commands that CHANGE this host (`mcp add`, `mcp remove`) and the
 * presence check that decides which path apply takes, while
 * `src/core/install/host-probe.ts` owns the read-only question "what does
 * this host say it has registered". The read is declared once, in
 * `RUNTIME_FACTS[copilot-cli].hostProbe`, so `verify` asks the same
 * question every other probe-bearing target will be asked, in the same
 * words - see the note that used to be blanket in `_json-mcp.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { INSTALL_TARGET_ID } from "../../runtime/host-facts.ts";
import {
  handshakeNote,
  HOST_PROBE_RESULT,
  probeHost,
  probeRefutedFixHint,
  probeRefutes,
} from "../host-probe.ts";
import { mergeMcpServers, removeMcpServers, OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { payloadForHost } from "../payload-host.ts";
import { expectedPayloadFromEnv, payloadKeyEquals } from "../payload-equals.ts";
import { recordEntry, readManifest, removeEntry } from "../manifest.ts";
import { defaultRegistry } from "../registry.ts";
import {
  InstallError,
  type ApplyOpts,
  type ApplyResult,
  type DetectResult,
  type InstallAdapter,
  type InstallEnv,
  type InstallPlan,
  type ManifestEntry,
  type McpPayload,
  type McpServerEntry,
  type UninstallResult,
  type VerifyResult,
  type SessionPathsResult,
} from "../types.ts";
import { sessionPathsFor } from "../session-paths.ts";

const TARGET = INSTALL_TARGET_ID.copilotCli;
const LABEL = "GitHub Copilot CLI";

// ---------- Injectable subprocess runner ----------

export interface CopilotRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What `detect` needs from the host: which OSB names it reports, or that
 * it could not be asked. `verify` does NOT read this - it asks
 * {@link probeHost} directly, so the reason a probe was skipped survives
 * into the verdict instead of collapsing into `ok: false`.
 */
export interface CopilotListResult {
  readonly ok: boolean;
  readonly names: ReadonlyArray<string>;
}

export interface CopilotRunner {
  available(): boolean;
  run(args: ReadonlyArray<string>): CopilotRunResult;
  list(): CopilotListResult;
}

const defaultRunner: CopilotRunner = {
  available(): boolean {
    try {
      const r = Bun.spawnSync({ cmd: ["copilot", "--version"], stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  },
  run(args) {
    const r = Bun.spawnSync({ cmd: ["copilot", ...args], stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
    };
  },
  list(): CopilotListResult {
    // One implementation of "ask copilot what it has registered", shared
    // with `verify` through the declared `RUNTIME_FACTS` probe rather
    // than spelled a second time here.
    const outcome = probeHost(TARGET);
    if (outcome.kind !== HOST_PROBE_RESULT.answered) return { ok: false, names: [] };
    return { ok: true, names: outcome.registered };
  },
};

let activeRunner: CopilotRunner = defaultRunner;

export function setCopilotRunner(r: CopilotRunner): void {
  activeRunner = r;
}

export function resetCopilotRunner(): void {
  activeRunner = defaultRunner;
}

// ---------- helpers ----------

function fallbackPath(env: InstallEnv): string {
  const xdg = env.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(env.home, ".config");
  return join(base, "github-copilot", "mcp.json");
}

function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function addArgs(name: string, entry: McpServerEntry): string[] {
  const args = ["mcp", "add", name, "--command", entry.command];
  for (const a of entry.args) args.push("--arg", a);
  if (entry.env) {
    for (const [k, v] of Object.entries(entry.env)) args.push("--env", `${k}=${v}`);
  }
  return args;
}

interface ApplyOutcome {
  readonly viaCli: boolean;
  readonly fallbackFile: string | null;
}

function applyViaCli(
  payload: McpPayload,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
): { ok: boolean; reason?: string } {
  // best-effort remove
  for (const name of [OSB_KEY_FULL, OSB_KEY_WRITER]) {
    activeRunner.run(["mcp", "remove", name]);
  }
  for (const [name, entry] of [
    [OSB_KEY_FULL, payload.full],
    [OSB_KEY_WRITER, payload.writer],
  ] as const) {
    const r = activeRunner.run(addArgs(name, entry));
    if (r.exitCode !== 0) {
      stderr.write(`copilot mcp add failed for ${name} (exit ${r.exitCode}): ${r.stderr.trim()}\n`);
      return { ok: false, reason: r.stderr.trim() || `exit ${r.exitCode}` };
    }
  }
  return { ok: true };
}

function applyViaFile(
  env: InstallEnv,
  payload: McpPayload,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
  dryRun: boolean,
): string {
  const path = fallbackPath(env);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const merged = mergeMcpServers(current, payload);
  if (!dryRun) {
    ensureParent(path);
    atomicWriteFileSync(path, merged);
  }
  stderr.write(`copilot-cli: wrote MCP config to ${path} (file-fallback mode)\n`);
  return path;
}

function uninstallViaCli(): { removed: string[] } {
  const removed: string[] = [];
  for (const name of [OSB_KEY_FULL, OSB_KEY_WRITER]) {
    const r = activeRunner.run(["mcp", "remove", name]);
    if (r.exitCode === 0) removed.push(name);
  }
  return { removed };
}

function uninstallViaFile(
  env: InstallEnv,
  dryRun: boolean,
  storedPath?: string | null,
): { path: string; touched: boolean } {
  // Prefer the path recorded at install time; only fall back to env-derived
  // resolution when the manifest entry didn't carry one. This keeps
  // uninstall deterministic across XDG_CONFIG_HOME / HOME changes.
  const path = storedPath ?? fallbackPath(env);
  if (!existsSync(path)) return { path, touched: false };
  const current = readFileSync(path, "utf8");
  const next = removeMcpServers(current);
  if (!dryRun && next !== current) atomicWriteFileSync(path, next);
  return { path, touched: next !== current };
}

// ---------- adapter ----------

export const copilotCliAdapter: InstallAdapter = {
  target: TARGET,
  label: LABEL,

  detect(env: InstallEnv): DetectResult {
    const cliAvailable = activeRunner.available();
    if (cliAvailable) {
      const lst = activeRunner.list();
      if (lst.ok) {
        const has = (n: string) => lst.names.includes(n);
        if (has(OSB_KEY_FULL) && has(OSB_KEY_WRITER)) {
          return {
            target: TARGET,
            status: "installed",
            configPath: null,
            notes: ["copilot CLI present; both OSB MCP servers registered"],
          };
        }
        if (has(OSB_KEY_FULL) || has(OSB_KEY_WRITER)) {
          return {
            target: TARGET,
            status: "drift",
            configPath: null,
            notes: ["copilot CLI present; only one of the two OSB MCP servers registered"],
          };
        }
        return { target: TARGET, status: "not-installed", configPath: null, notes: [] };
      }
    }
    const fb = fallbackPath(env);
    if (existsSync(fb)) {
      try {
        const parsed = JSON.parse(readFileSync(fb, "utf8")) as Record<string, unknown>;
        const block = (parsed["mcpServers"] ?? {}) as Record<string, unknown>;
        const has = (n: string) => n in block;
        if (has(OSB_KEY_FULL) && has(OSB_KEY_WRITER)) {
          return {
            target: TARGET,
            status: "installed",
            configPath: fb,
            notes: ["file-fallback: both OSB keys present"],
          };
        }
        if (has(OSB_KEY_FULL) || has(OSB_KEY_WRITER)) {
          return {
            target: TARGET,
            status: "drift",
            configPath: fb,
            notes: ["file-fallback: partial OSB keys"],
          };
        }
      } catch {
        // parse error → drift
        return {
          target: TARGET,
          status: "drift",
          configPath: fb,
          notes: ["fallback file not valid JSON"],
        };
      }
    }
    return {
      target: TARGET,
      status: "not-installed",
      configPath: cliAvailable ? null : fb,
      notes: cliAvailable ? [] : ["copilot CLI not available; will use file fallback"],
    };
  },

  plan(payload: McpPayload, env: InstallEnv): InstallPlan {
    void payload;
    const cliAvailable = activeRunner.available();
    if (cliAvailable) {
      return {
        target: TARGET,
        steps: [
          {
            kind: "subprocess",
            path: null,
            preview: `copilot mcp remove ${OSB_KEY_FULL}; copilot mcp remove ${OSB_KEY_WRITER}; copilot mcp add ${OSB_KEY_FULL} ...; copilot mcp add ${OSB_KEY_WRITER} ...`,
          },
        ],
        postNotes: ["copilot CLI present"],
      };
    }
    return {
      target: TARGET,
      steps: [
        {
          kind: "json-merge",
          path: fallbackPath(env),
          preview: `copilot CLI not on PATH; write to fallback file ${fallbackPath(env)}`,
        },
      ],
      postNotes: [
        "copilot CLI was not detected; using file-fallback path",
        "install the copilot CLI for the recommended subprocess-driven flow",
      ],
    };
  },

  apply(_plan: InstallPlan, rawPayload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    // Same transform `verify` re-computes below, so a fresh install
    // compares against the bytes it just registered.
    const payload = payloadForHost(TARGET, rawPayload, env);
    let outcome: ApplyOutcome;
    if (activeRunner.available()) {
      const r = opts.dryRun ? { ok: true } : applyViaCli(payload, opts.stderr);
      if (r.ok) {
        outcome = { viaCli: true, fallbackFile: null };
      } else {
        const file = opts.dryRun
          ? fallbackPath(env)
          : applyViaFile(env, payload, opts.stderr, false);
        outcome = { viaCli: false, fallbackFile: file };
      }
    } else {
      const file = applyViaFile(env, payload, opts.stderr, opts.dryRun);
      outcome = { viaCli: false, fallbackFile: file };
    }

    const manifest: ManifestEntry = {
      target: TARGET,
      applied_at: env.now.toISOString(),
      operation: outcome.viaCli ? "subprocess" : "json-merge",
      config_path: outcome.fallbackFile,
      fallback_file: outcome.fallbackFile,
      ...(outcome.viaCli
        ? {}
        : { owned_keys: [`mcpServers.${OSB_KEY_FULL}`, `mcpServers.${OSB_KEY_WRITER}`] }),
    };
    if (!opts.dryRun) recordEntry(env.vault, manifest);
    return { target: TARGET, manifest, steps_executed: opts.dryRun ? 0 : 1 };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const stored = readManifest(env.vault).installs[TARGET];
    const removed_keys: string[] = [];
    const removed_paths: string[] = [];
    const skipped: Array<readonly [string, string]> = [];

    if (!stored && !opts.fromSnippet) {
      throw new InstallError(
        "copilot-cli: no install manifest entry found",
        TARGET,
        "manifest-missing",
        "o2b uninstall --target copilot-cli --apply --force-from-snippet",
      );
    }

    const viaCli = stored?.operation === "subprocess";
    if (viaCli) {
      if (opts.dryRun) {
        // Dry-run must not touch the runtime's MCP registry. Simulate
        // the two removals so the operator sees what would happen.
        removed_keys.push(OSB_KEY_FULL, OSB_KEY_WRITER);
      } else {
        const { removed } = uninstallViaCli();
        for (const r of removed) removed_keys.push(r);
      }
    } else {
      const { path, touched } = uninstallViaFile(
        env,
        opts.dryRun,
        stored?.fallback_file ?? stored?.config_path ?? null,
      );
      if (touched) {
        removed_keys.push(`mcpServers.${OSB_KEY_FULL}`, `mcpServers.${OSB_KEY_WRITER}`);
      } else {
        skipped.push([path, "fallback file unchanged"]);
      }
    }
    if (!opts.dryRun) removeEntry(env.vault, TARGET);
    return { target: TARGET, removed_keys, removed_paths, skipped };
  },

  verify(env: InstallEnv): VerifyResult {
    const stored = readManifest(env.vault).installs[TARGET];
    if (!stored) {
      return {
        target: TARGET,
        status: "not-installed",
        details: ["no install manifest entry"],
        fix_hint: null,
      };
    }
    // The host's own answer, or the named reason there is none. Asked
    // before the branch because BOTH modes are owed it: the subprocess
    // mode has nothing else to compare, and the file mode has a
    // comparison that cannot establish the host ever loaded the file.
    const probe = probeHost(TARGET);
    if (stored.operation === "subprocess") {
      // In this mode the host CLI IS the registry - there is no file to
      // fall back on - so a probe that could not run leaves nothing
      // verified, and says which of the two obstacles it hit.
      if (probe.kind !== HOST_PROBE_RESULT.answered) {
        return {
          target: TARGET,
          status: "mcp-unreachable",
          details: [handshakeNote(probe)],
          fix_hint:
            "put the copilot CLI on PATH and authenticate it - in subprocess mode it holds the " +
            "only record of this registration",
        };
      }
      if (probe.missing.length === 0) {
        return {
          target: TARGET,
          status: "ok",
          details: [handshakeNote(probe)],
          fix_hint: null,
        };
      }
      // A partial answer here is DRIFT, not unreachable: the host was
      // reached and reported the registration itself as incomplete, and
      // re-applying is what repairs it.
      return {
        target: TARGET,
        status: "drift",
        details: [handshakeNote(probe)],
        fix_hint: "o2b install --target copilot-cli --apply",
      };
    }
    // file-fallback path
    const path = stored.fallback_file ?? fallbackPath(env);
    if (!existsSync(path)) {
      return {
        target: TARGET,
        status: "drift",
        details: [`fallback file missing: ${path}`],
        fix_hint: "o2b install --target copilot-cli --apply",
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const block = (parsed["mcpServers"] ?? {}) as Record<string, unknown>;
      const expected = expectedPayloadFromEnv(env, TARGET);
      if (
        payloadKeyEquals(
          block[OSB_KEY_FULL] as Record<string, unknown> | undefined,
          expected.full,
        ) &&
        payloadKeyEquals(
          block[OSB_KEY_WRITER] as Record<string, unknown> | undefined,
          expected.writer,
        )
      ) {
        // The file is right. Whether the host READ it is the probe's
        // question, and a host that answers and does not list the servers
        // has not loaded the file the operator just verified.
        if (probeRefutes(probe)) {
          return {
            target: TARGET,
            status: "mcp-unreachable",
            details: [`${path}: matches the canonical payload, but ${handshakeNote(probe)}`],
            fix_hint: probeRefutedFixHint(LABEL),
          };
        }
        return {
          target: TARGET,
          status: "ok",
          details: [`${path}: both keys present (${handshakeNote(probe)})`],
          fix_hint: null,
        };
      }
      if (block[OSB_KEY_FULL] && block[OSB_KEY_WRITER]) {
        return {
          target: TARGET,
          status: "drift",
          details: [`${path}: OSB keys differ from canonical payload`],
          fix_hint: "o2b install --target copilot-cli --apply",
        };
      }
      return {
        target: TARGET,
        status: "drift",
        details: [`${path}: missing OSB keys`],
        fix_hint: "o2b install --target copilot-cli --apply",
      };
    } catch {
      return {
        target: TARGET,
        status: "drift",
        details: [`${path}: not valid JSON`],
        fix_hint: "o2b install --target copilot-cli --apply",
      };
    }
  },

  /**
   * Where this runtime keeps session logs, from the one declaration.
   * `GitHub Copilot CLI keeps no transcript store this build can locate, so the declaration is empty and the answer is null.`
   */
  sessionPaths(env: InstallEnv): SessionPathsResult | null {
    return sessionPathsFor(TARGET, env);
  },
};

defaultRegistry.register(copilotCliAdapter);
