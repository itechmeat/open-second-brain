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
  hostProbeEnvironment,
  HOST_PROBE_RESULT,
  probeHost,
  probeRefutedVerdict,
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
  /**
   * `copilot <args>` against the host `env` describes.
   *
   * The environment is a parameter for the same reason `list` takes one:
   * `mcp add` persists into Copilot's own configuration root, and an
   * `apply` that wrote to the ambient machine while `verify` asked the
   * injected one would report drift against a registration it had just
   * made.
   */
  run(args: ReadonlyArray<string>, env: InstallEnv): CopilotRunResult;
  /**
   * Ask the host named by `env` what it has registered. The environment is
   * a parameter for the reason the probe seam takes one: Copilot derives
   * its own `${XDG_CONFIG_HOME:-$HOME/.config}/github-copilot` root, and a
   * question asked of the ambient process is a question about a different
   * machine than the one `fallbackPath(env)` writes to.
   */
  list(env: InstallEnv): CopilotListResult;
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
  run(args, env) {
    const r = Bun.spawnSync({
      cmd: ["copilot", ...args],
      // The machine `env` describes, plus a PATH. `PATH` is not part of
      // "which machine's configuration" - it is how the `copilot`
      // executable was located in the first place, and `available()`
      // above locates it with the ambient one - so an `InstallEnv` that
      // carries no PATH must not make the very binary this runner just
      // confirmed present unspawnable. Everything that decides WHICH
      // configuration root Copilot writes (`HOME`, `XDG_CONFIG_HOME`)
      // comes from `env`, so apply and verify address one machine.
      env: {
        PATH: process.env["PATH"] ?? "",
        ...hostProbeEnvironment(env),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
    };
  },
  list(env: InstallEnv): CopilotListResult {
    // One implementation of "ask copilot what it has registered", shared
    // with `verify` through the declared `RUNTIME_FACTS` probe rather
    // than spelled a second time here.
    const outcome = probeHost(TARGET, env);
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
  env: InstallEnv,
  payload: McpPayload,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
): { ok: boolean; reason?: string } {
  // best-effort remove
  for (const name of [OSB_KEY_FULL, OSB_KEY_WRITER]) {
    activeRunner.run(["mcp", "remove", name], env);
  }
  for (const [name, entry] of [
    [OSB_KEY_FULL, payload.full],
    [OSB_KEY_WRITER, payload.writer],
  ] as const) {
    const r = activeRunner.run(addArgs(name, entry), env);
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

/**
 * Remove both servers from the host's own registry.
 *
 * `failed` is reported apart from the removed names because the manifest
 * entry may only be dropped when nothing was left behind - see the guard
 * in `uninstall`.
 */
function uninstallViaCli(env: InstallEnv): {
  removed: string[];
  failures: Array<readonly [string, string]>;
} {
  const removed: string[] = [];
  const failures: Array<readonly [string, string]> = [];
  for (const name of [OSB_KEY_FULL, OSB_KEY_WRITER]) {
    const r = activeRunner.run(["mcp", "remove", name], env);
    if (r.exitCode === 0) removed.push(name);
    else failures.push([name, `copilot mcp remove exited ${r.exitCode}`]);
  }
  return { removed, failures };
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
      const lst = activeRunner.list(env);
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
      const r = opts.dryRun ? { ok: true } : applyViaCli(env, payload, opts.stderr);
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

    // A skip is not a failure: an unchanged fallback file means there was
    // nothing left to remove. Only a removal this build attempted and
    // could not carry out may keep the manifest entry alive.
    let failed = false;
    const viaCli = stored?.operation === "subprocess";
    if (viaCli) {
      if (opts.dryRun) {
        // Dry-run must not touch the runtime's MCP registry. Simulate
        // the two removals so the operator sees what would happen.
        removed_keys.push(OSB_KEY_FULL, OSB_KEY_WRITER);
      } else {
        const { removed, failures } = uninstallViaCli(env);
        for (const r of removed) removed_keys.push(r);
        for (const f of failures) skipped.push(f);
        failed = failures.length > 0;
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
    // Dropping the manifest entry after a FAILED removal makes the retry
    // impossible: the next `o2b uninstall` finds no entry, throws
    // `manifest-missing` and demands `--force-from-snippet` for a server
    // the host still has. grok already guards this; this adapter did not.
    if (!opts.dryRun && !failed) removeEntry(env.vault, TARGET);
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
    const probe = probeHost(TARGET, env);
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
      // Subprocess mode leaves no artifact, so `artifactMatches` is false
      // and the shared rule returns DRIFT rather than unreachable: the
      // host was reached, the host IS the record, and it reported the
      // registration itself as incomplete. Re-applying is what repairs it.
      const verdict = probeRefutedVerdict({
        target: TARGET,
        label: LABEL,
        artifactMatches: false,
      });
      return {
        target: TARGET,
        status: verdict.status,
        details: [handshakeNote(probe)],
        fix_hint: verdict.fixHint,
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
          const verdict = probeRefutedVerdict({
            target: TARGET,
            label: LABEL,
            artifactMatches: true,
          });
          return {
            target: TARGET,
            status: verdict.status,
            details: [`${path}: matches the canonical payload, but ${handshakeNote(probe)}`],
            fix_hint: verdict.fixHint,
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
