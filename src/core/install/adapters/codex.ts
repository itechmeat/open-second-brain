/**
 * Codex CLI adapter — subprocess-driven, with a TOML section merge into
 * `$CODEX_HOME/config.toml` when the `codex` binary is absent.
 *
 * Primary path:
 *   - `codex mcp remove <name>` (best-effort; non-zero is fine when the
 *     server was not registered)
 *   - `codex mcp add <name> [--env K=V ...] -- <command> <args...>`
 *
 * Fallback path:
 *   - upsert the two `[mcp_servers.<name>]` tables into
 *     `$CODEX_HOME/config.toml`, which is where `codex mcp add` persists
 *     them anyway. Every unrelated table - `[plugins."..."]`,
 *     `[marketplaces....]`, a foreign `[mcp_servers.*]` - survives
 *     byte-for-byte.
 *
 * ## Why `verify` asks two different questions of one file
 *
 * Unlike `copilot-cli`, whose subprocess mode leaves NO artifact, both
 * Codex paths end in the same `config.toml`. What differs is who wrote
 * the bytes:
 *
 *   - **fallback mode**: this build serialised the tables, so `verify`
 *     compares them against the payload it would write today. Any edit
 *     is drift.
 *   - **subprocess mode**: the Codex CLI serialised them in its own
 *     layout, which this build has no published grammar for and must not
 *     guess at. `verify` therefore checks that the two tables are still
 *     DECLARED and lets `codex mcp list` answer whether the host is
 *     actually serving them. That is a presence check, not a byte check,
 *     and the detail line says so rather than implying more.
 *
 * ## The Codex home is injected, never ambient
 *
 * `CODEX_HOME` relocates the whole Codex configuration directory, and the
 * Codex CLI REFUSES to start when it points at a path that does not
 * exist. The runner seam therefore takes the resolved home as its first
 * argument and the default runner creates it before spawning: an adapter
 * that resolved `InstallEnv.home` for its own file writes while its
 * subprocess wrote the ambient `~/.codex` would install into two places
 * at once - and would mutate the operator's real machine from a test.
 *
 * Two seams, for the reason `copilot-cli.ts` states: `CodexRunner` owns
 * the commands that CHANGE this host, while `../host-probe.ts` owns the
 * read-only question "what does this host say it has registered",
 * declared once in `RUNTIME_FACTS[codex].hostProbe`. BOTH seams take the
 * injected home - the probe through `hostProbeEnvironment(env)` - so the
 * file half and the handshake half of a `verify` describe one machine.
 * They described two for a release: the file half read the relocated
 * `CODEX_HOME` while `codex mcp list` answered about the operator's real
 * `~/.codex`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { codexHome as resolveCodexHome, INSTALL_TARGET_ID } from "../../runtime/host-facts.ts";
import { hasMcpServers, removeMcpServers, upsertMcpServers } from "../grok-config.ts";
import type { GrokMcpEntry } from "../grok-config.ts";
import {
  handshakeNote,
  probeHost,
  probeRefutedVerdict,
  probeRefutes,
  HOST_PROBE_RESULT,
} from "../host-probe.ts";
import { payloadWithRuntimeIdentity } from "../identity.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { readManifest, recordEntry, removeEntry } from "../manifest.ts";
import { expectedPayloadFromEnv } from "../payload-equals.ts";
import { payloadForHost } from "../payload-host.ts";
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

const TARGET = INSTALL_TARGET_ID.codex;
const LABEL = "Codex CLI";
const FIX_HINT = `o2b install --target ${TARGET} --apply`;
const SERVER_NAMES: ReadonlyArray<string> = Object.freeze([OSB_KEY_FULL, OSB_KEY_WRITER]);

/**
 * Codex's vendor token, combined with the operator's host segment into a
 * host-qualified identity by `../identity.ts` - so a Brain write made
 * through Codex says `codex-<host>-agent` instead of masquerading as the
 * operator's own name, exactly as grok and opencode already do.
 */
export const CODEX_RUNTIME_ID = TARGET;

// ---------- Injectable subprocess runner ----------

export interface CodexRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexRunner {
  available(): boolean;
  /** `codex <args>` with `CODEX_HOME` set to `home`, which must exist. */
  run(home: string, args: ReadonlyArray<string>): CodexRunResult;
}

const defaultRunner: CodexRunner = {
  available(): boolean {
    try {
      return Bun.which("codex") !== null;
    } catch {
      return false;
    }
  },
  run(home, args) {
    // Codex refuses to load a configuration whose `CODEX_HOME` does not
    // exist, so the directory is created before the spawn rather than
    // letting the operator read that refusal as an OSB failure.
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    const r = Bun.spawnSync({
      cmd: ["codex", ...args],
      env: { ...process.env, CODEX_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
    };
  },
};

let activeRunner: CodexRunner = defaultRunner;

export function setCodexRunner(runner: CodexRunner): void {
  activeRunner = runner;
}

export function resetCodexRunner(): void {
  activeRunner = defaultRunner;
}

// ---------- Paths and payload ----------

/**
 * The Codex configuration directory this install is about.
 *
 * Delegated to `../../runtime/host-facts.ts` rather than re-derived: that
 * module already resolves the same `$CODEX_HOME`-or-`~/.codex` rule for
 * the session roots, and two copies of a relocation rule is two answers
 * waiting to disagree.
 */
function codexHome(env: InstallEnv): string {
  return resolveCodexHome({ home: env.home, env: env.env });
}

function configPath(env: InstallEnv): string {
  return join(codexHome(env), "config.toml");
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The payload as this host must receive it: host dimensions, then identity. */
function codexPayload(raw: McpPayload, env: InstallEnv): McpPayload {
  return payloadWithRuntimeIdentity(payloadForHost(TARGET, raw, env), CODEX_RUNTIME_ID);
}

/** The same payload rebuilt from the env alone, for the verify path. */
function expectedPayload(env: InstallEnv): McpPayload {
  return payloadWithRuntimeIdentity(expectedPayloadFromEnv(env, TARGET), CODEX_RUNTIME_ID);
}

/**
 * The two tables to write, in the shape `../grok-config.ts` serialises.
 *
 * That module is reused rather than re-implemented: Codex and grok name
 * the same `[mcp_servers.<name>]` table with the same `command` /
 * `args` / `env` value shapes, and a second line-section TOML editor in
 * this tree would be one more place for the byte-for-byte preservation
 * guarantee to be got wrong.
 */
function tomlEntry(entry: McpServerEntry): GrokMcpEntry {
  return {
    command: entry.command,
    args: [...entry.args],
    ...(entry.env ? { env: { ...entry.env } } : {}),
  };
}

function codexMcpServers(payload: McpPayload): Record<string, GrokMcpEntry> {
  return {
    [OSB_KEY_FULL]: tomlEntry(payload.full),
    [OSB_KEY_WRITER]: tomlEntry(payload.writer),
  };
}

/**
 * Whether `toml` DECLARES the `[mcp_servers.<name>]` table.
 *
 * Anchored to a whole line, and that is the point. A substring search
 * matches `# [mcp_servers.open-second-brain]` as readily as the table
 * itself, so an operator who commented both tables out - the ordinary way
 * to turn a server off - got `detect: installed` and `verify: ok` for a
 * registration Codex would not load. A commented header is the operator
 * saying no, and a reader that cannot tell it from a yes is reporting on a
 * file it did not understand.
 *
 * Leading whitespace is tolerated because TOML permits an indented table
 * header; anything else on the line - a `#`, a second table, trailing
 * prose - means this is not that header.
 */
function declaresTable(toml: string, name: string): boolean {
  const header = `[mcp_servers.${name}]`;
  return toml.split("\n").some((line) => line.trim() === header);
}

/** Whether both of our tables are declared at all, whoever wrote them. */
function declaresBothServers(toml: string): boolean {
  return SERVER_NAMES.every((name) => declaresTable(toml, name));
}

function declaredServers(toml: string): ReadonlyArray<string> {
  return SERVER_NAMES.filter((name) => declaresTable(toml, name));
}

/** The clause naming which of the two tables the file is missing. */
function undeclared(toml: string): string {
  const missing = SERVER_NAMES.filter((name) => !declaresTable(toml, name));
  return `does not declare ${missing.join(", ")}`;
}

// ---------- Apply helpers ----------

/** `codex mcp add <name> [--env K=V ...] -- <command> <args...>`. */
function addArgs(name: string, entry: McpServerEntry): string[] {
  const args = ["mcp", "add", name];
  for (const [key, value] of Object.entries(entry.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push("--", entry.command, ...entry.args);
  return args;
}

function applyViaCli(
  env: InstallEnv,
  payload: McpPayload,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
): boolean {
  const base = codexHome(env);
  for (const name of SERVER_NAMES) activeRunner.run(base, ["mcp", "remove", name]);
  for (const [name, entry] of [
    [OSB_KEY_FULL, payload.full],
    [OSB_KEY_WRITER, payload.writer],
  ] as const) {
    const result = activeRunner.run(base, addArgs(name, entry));
    if (result.exitCode !== 0) {
      stderr.write(
        `codex mcp add failed for ${name} (exit ${result.exitCode}): ${result.stderr.trim()}\n`,
      );
      return false;
    }
  }
  return true;
}

function applyViaFile(
  env: InstallEnv,
  payload: McpPayload,
  stderr: NodeJS.WriteStream | NodeJS.WritableStream,
  dryRun: boolean,
): void {
  const path = configPath(env);
  const next = upsertMcpServers(readFileOrEmpty(path), codexMcpServers(payload));
  if (!dryRun) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, next);
  }
  stderr.write(`codex: wrote the MCP servers to ${path} (file-fallback mode)\n`);
}

/**
 * Strip our two tables, leaving every other section untouched. Returns
 * whether the file carried any of them.
 */
function stripOurTables(env: InstallEnv, dryRun: boolean): boolean {
  const path = configPath(env);
  const current = readFileOrEmpty(path);
  if (declaredServers(current).length === 0) return false;
  const next = removeMcpServers(current, SERVER_NAMES).replace(/\s*$/, "");
  if (!dryRun) atomicWriteFileSync(path, next.length > 0 ? `${next}\n` : "");
  return true;
}

// ---------- Adapter ----------

export const codexAdapter: InstallAdapter = {
  target: TARGET,
  label: LABEL,

  detect(env: InstallEnv): DetectResult {
    const path = configPath(env);
    const declared = declaredServers(readFileOrEmpty(path));
    const cliNote = activeRunner.available()
      ? "codex CLI present; registration goes through `codex mcp add`"
      : "codex CLI not on PATH; registration goes through the config.toml merge";
    if (declared.length === SERVER_NAMES.length) {
      return { target: TARGET, status: "installed", configPath: path, notes: [cliNote] };
    }
    if (declared.length > 0) {
      return {
        target: TARGET,
        status: "drift",
        configPath: path,
        notes: [cliNote, `only ${declared.join(", ")} is declared`],
      };
    }
    return { target: TARGET, status: "not-installed", configPath: path, notes: [cliNote] };
  },

  plan(rawPayload: McpPayload, env: InstallEnv): InstallPlan {
    const path = configPath(env);
    // The preview prints the args that will actually be registered, for
    // the reason `_json-mcp.ts` prints them: a plan whose command line
    // differs from the applied one is a plan the operator cannot use to
    // review the change - and the host dimensions this transform adds
    // (`--tool-profile`, `--host-target`) are exactly what a reviewer of
    // a capped host is looking for.
    const payload = codexPayload(rawPayload, env);
    if (activeRunner.available()) {
      const commands = [
        ...SERVER_NAMES.map((name) => `codex mcp remove ${name}`),
        ...(
          [
            [OSB_KEY_FULL, payload.full],
            [OSB_KEY_WRITER, payload.writer],
          ] as const
        ).map(([name, entry]) => `codex ${addArgs(name, entry).join(" ")}`),
      ];
      return {
        target: TARGET,
        steps: [
          {
            kind: "subprocess",
            // Named even though the CLI writes it: this is where the
            // registration lands, and an operator reading a plan is owed
            // the file it will change.
            path,
            preview: `${commands.join("; ")} (persisted to ${path})`,
          },
        ],
        postNotes: [`codex CLI present; CODEX_HOME resolves to ${codexHome(env)}`],
      };
    }
    const tables = Object.entries(codexMcpServers(payload)).map(
      ([name, entry]) => `[mcp_servers.${name}] → ${entry.command} ${entry.args.join(" ")}`,
    );
    return {
      target: TARGET,
      steps: [
        {
          kind: "managed-block",
          path,
          preview:
            `codex CLI not on PATH; merge the two [mcp_servers.*] tables into ${path}: ` +
            tables.join("; "),
        },
      ],
      postNotes: [
        "the codex CLI was not detected; using the config.toml merge, which is the same file " +
          "`codex mcp add` would have written",
        "codex loads the MCP servers on its next session start",
      ],
    };
  },

  apply(_plan: InstallPlan, rawPayload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const payload = codexPayload(rawPayload, env);
    let viaCli: boolean;
    if (activeRunner.available()) {
      viaCli = opts.dryRun ? true : applyViaCli(env, payload, opts.stderr);
      if (!viaCli && !opts.dryRun) applyViaFile(env, payload, opts.stderr, false);
    } else {
      viaCli = false;
      applyViaFile(env, payload, opts.stderr, opts.dryRun);
    }

    const manifest: ManifestEntry = {
      target: TARGET,
      applied_at: env.now.toISOString(),
      operation: viaCli ? "subprocess" : "managed-block",
      config_path: configPath(env),
      owned_keys: [...SERVER_NAMES],
      ...(viaCli ? {} : { fallback_file: configPath(env) }),
    };
    if (!opts.dryRun) recordEntry(env.vault, manifest);
    return { target: TARGET, manifest, steps_executed: opts.dryRun ? 0 : 1 };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const stored = readManifest(env.vault).installs[TARGET];
    if (!stored && !opts.fromSnippet) {
      throw new InstallError(
        `${TARGET}: no install manifest entry found`,
        TARGET,
        "manifest-missing",
        `o2b uninstall --target ${TARGET} --apply --force-from-snippet`,
      );
    }
    const removed_keys: string[] = [];
    const removed_paths: string[] = [];
    const skipped: Array<readonly [string, string]> = [];
    // A skip is not a failure. "No OSB tables declared" means there was
    // nothing left to remove, which is a completed uninstall; only a
    // removal this build attempted and could not carry out may keep the
    // manifest entry alive. Tracked apart from `skipped` for that reason.
    let failed = false;

    if (stored?.operation === "subprocess" && activeRunner.available()) {
      if (opts.dryRun) {
        // A dry run must not touch the host's registry; report what the
        // two removals would take out.
        removed_keys.push(...SERVER_NAMES);
      } else {
        for (const name of SERVER_NAMES) {
          const result = activeRunner.run(codexHome(env), ["mcp", "remove", name]);
          if (result.exitCode === 0) removed_keys.push(name);
          else {
            skipped.push([name, `codex mcp remove exited ${result.exitCode}`]);
            failed = true;
          }
        }
      }
    } else if (stripOurTables(env, opts.dryRun)) {
      // Also the repair path for a subprocess install whose CLI has since
      // left the machine: the registration is in a file either way. The
      // file is reported as a touched path, exactly as grok reports its
      // hooks file - an uninstall that changed a file and named none left
      // the operator nothing to check.
      removed_keys.push(...SERVER_NAMES);
      removed_paths.push(configPath(env));
    } else {
      skipped.push([configPath(env), "no OSB tables declared"]);
    }

    // Dropping the manifest entry after a FAILED removal is what makes the
    // retry impossible: the next `o2b uninstall` finds no entry, throws
    // `manifest-missing` and demands `--force-from-snippet` for a server
    // that is still registered. grok already guards this; codex did not.
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
        fix_hint: FIX_HINT,
      };
    }
    const path = configPath(env);
    const toml = readFileOrEmpty(path);
    const probe = probeHost(TARGET, env);
    const declaresBoth = declaresBothServers(toml);

    if (stored.operation === "subprocess") {
      // The Codex CLI owns these bytes, so the host's own answer is the
      // strongest evidence available and is taken first. That is only
      // sound because the probe is asked about the SAME home this adapter
      // resolved - `probeHost` spawns under `hostProbeEnvironment(env)`,
      // so a relocated `CODEX_HOME` cannot be verified against the
      // operator's ambient `~/.codex`. The file is consulted only where
      // that answer is absent or negative - and it is consulted for
      // PRESENCE, because this build has no published grammar for the
      // layout the CLI writes and will not guess one.
      if (probe.kind === HOST_PROBE_RESULT.answered) {
        if (probe.missing.length === 0) {
          return { target: TARGET, status: "ok", details: [handshakeNote(probe)], fix_hint: null };
        }
        const verdict = probeRefutedVerdict({
          target: TARGET,
          label: LABEL,
          artifactMatches: declaresBoth,
        });
        return {
          target: TARGET,
          status: verdict.status,
          details: [
            declaresBoth
              ? `${path}: declares both OSB servers, but ${handshakeNote(probe)}`
              : `${path}: ${undeclared(toml)} (${handshakeNote(probe)})`,
          ],
          fix_hint: verdict.fixHint,
        };
      }
      if (!declaresBoth) {
        return {
          target: TARGET,
          status: "drift",
          details: [`${path}: ${undeclared(toml)} (${handshakeNote(probe)})`],
          fix_hint: FIX_HINT,
        };
      }
      return {
        target: TARGET,
        status: "ok",
        details: [
          `${path}: both OSB servers declared, in the layout the codex CLI wrote ` +
            `(${handshakeNote(probe)})`,
        ],
        fix_hint: null,
      };
    }

    // File-fallback mode: this build wrote the bytes, so it compares
    // them. A probe that answers cannot substitute for that - it reports
    // which names are registered and nothing about the command, the
    // arguments or the environment behind them.
    if (!hasMcpServers(toml, codexMcpServers(expectedPayload(env)))) {
      return {
        target: TARGET,
        status: "drift",
        details: [
          declaresBoth
            ? `${path}: the OSB tables differ from the canonical payload`
            : `${path}: ${undeclared(toml)}`,
        ],
        fix_hint: FIX_HINT,
      };
    }
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
      details: [`${path}: both OSB tables match the canonical payload (${handshakeNote(probe)})`],
      fix_hint: null,
    };
  },

  /**
   * Where this runtime keeps session logs, from the one declaration.
   * `Codex has moved its rollout files between four subdirectories of $CODEX_HOME across releases; all four are declared.`
   */
  sessionPaths(env: InstallEnv): SessionPathsResult | null {
    return sessionPathsFor(TARGET, env);
  },
};

defaultRegistry.register(codexAdapter);
