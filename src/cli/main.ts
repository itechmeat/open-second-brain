/**
 * `o2b` CLI entry point. Mirrors `src/open_second_brain/cli.py` from the
 * legacy implementation: same subcommands, same flag names, same exit codes,
 * same error messages (verified by ports of the Python integration tests).
 *
 * Each subcommand resolves its inputs, delegates to `core/*` for business
 * logic, and returns a `0`/`1` exit code. The dispatcher is a small `switch`
 * statement, not a registry — keeps the control flow obvious.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ConfigReadError,
  defaultConfigPath,
  discoverConfig,
  resolveMcpToolProfile,
  setConfigValue,
  validateTimezoneName,
} from "../core/config.ts";
import { EGRESS_OUTCOME, redactForEgress } from "../core/egress/guard.ts";
import { listSecretReferences } from "../core/secret-ref.ts";
import { BRAIN_INDEX_REL } from "../core/brain/paths.ts";
import { ensureVaultCurrent } from "../core/maintenance/ensure-current.ts";
import { doctor } from "../core/doctor.ts";
import { checkHermesResolverParity } from "../core/doctor-hermes-parity.ts";
import { runReadinessProbes, type ReadinessReport } from "../core/doctor-readiness.ts";
import { listVaultPages, writeFrontmatter } from "../core/vault.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { installStdoutEpipeGuard, isEpipeError } from "./stdout-guard.ts";
import { handleAiderSubcommand } from "./aider.ts";
import { handleBrainSubcommand } from "./brain.ts";
import { handleDisciplineSubcommand } from "./discipline.ts";
import { handlePartnerSubcommand } from "./partner.ts";
import { handleSearchSubcommand } from "./search.ts";
import { handleVaultSubcommand } from "./vault.ts";
import {
  NoVaultConfiguredError,
  requireVault,
  resolveSemanticConfigState,
  sortedReplacer,
} from "./helpers.ts";
import { nextCommandField } from "../core/brain/next-step.ts";
import { emitNextStep, type AdvisoryStream } from "./advisory-rail.ts";
import { renderHelp, renderUsage } from "./help-render.ts";
import { ownsInternalJson, wantsJsonFlag, withJsonFallback } from "./json-helpers.ts";
import {
  installCli,
  renderInstallResult,
  renderUninstallResult,
  uninstallCli,
} from "./install-cli.ts";
import { cmdUpdate } from "./update.ts";
import { planUninstall, renderPlan } from "./uninstall.ts";
import { cmdInstall } from "./install/install.ts";
import { cmdUninstallTarget } from "./install/uninstall-target.ts";
import { cmdInitInteractive } from "./install/init-interactive.ts";
import {
  buildOnboardingChecklist,
  renderOnboardingChecklist,
  searchIndexExists,
} from "./onboarding.ts";
import { CLI_COMMAND_MANIFEST, manifestForJson } from "./command-manifest.ts";
import { COMPLETION_SHELLS, isCompletionShell, renderCompletions } from "./completions.ts";
import { MCPServer } from "../mcp/server.ts";
import { startHttp, isLoopbackHost } from "../mcp/http.ts";
import { serveStdio } from "../mcp/stdio.ts";
import { SERVER_VERSION } from "../mcp/protocol.ts";
import { buildToolTable } from "../mcp/tools.ts";
import { evaluateToolCapabilities, type RuntimeCapabilityWindow } from "../mcp/capabilities.ts";
import { resolveToolSurface, toolSurfaceProfileNames } from "../mcp/profiles.ts";

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdStatus(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const result = discoverConfig(flags["config"] as string | undefined);
  // v0.10.10 — semantic-search hint. Same truthy / key-present logic as
  // `writeSearchInitBlock`; lifted into `resolveSemanticConfigState`
  // so both call sites share a single source of truth.
  const semantic = resolveSemanticConfigState(result.data, process.env);
  if (flags["json"]) {
    const output: Record<string, unknown> = {
      config_path: String(result.path),
      config_exists: result.exists,
      semantic_enabled: semantic.semantic_enabled,
      embedding_key_present: semantic.embedding_key_present,
      semantic_hint: semantic.hint,
    };
    if (Object.keys(result.data).length > 0) {
      output["config_keys"] = Object.keys(result.data).toSorted();
    }
    if (flags["vault"]) output["vault"] = String(flags["vault"]);
    // no-dead-ends, phase 3: the human stream prints this exit as a rail
    // line; the machine stream carried nothing at all until now.
    if (!result.exists) Object.assign(output, nextCommandField("cli-config-absent"));
    process.stdout.write(JSON.stringify(output, sortedReplacer, 2) + "\n");
  } else {
    process.stdout.write(`config_path: ${result.path}\n`);
    process.stdout.write(`config_exists: ${result.exists ? "true" : "false"}\n`);
    if (Object.keys(result.data).length > 0) {
      process.stdout.write("config_keys:\n");
      for (const key of Object.keys(result.data).toSorted()) {
        process.stdout.write(`- ${key}\n`);
      }
    }
    if (semantic.off && semantic.hint) {
      process.stdout.write(`semantic: off (${semantic.hint})\n`);
    }
  }
  // no-dead-ends, task 7: the terminal-state census found this one. With
  // no configuration file there is nothing else this verb can report and
  // nothing the caller can do with the report, so it names the command
  // that creates one. With a config present it stays byte-identical.
  if (!result.exists) {
    emitNextStep("cli-config-absent", {
      command: "status",
      argv,
      jsonRequested: Boolean(flags["json"]),
    });
  }
  return 0;
}

async function cmdInit(argv: string[]): Promise<number> {
  // `--interactive` is its own mode — composed of `init` + `brain init` +
  // per-target `install`. The non-interactive path below requires --vault.
  if (argv.includes("--interactive")) {
    return await cmdInitInteractive(argv.filter((a) => a !== "--interactive"));
  }
  const { flags } = parseFlags(argv, {
    vault: { type: "string", required: true },
    name: { type: "string", default: "Second Brain" },
    "agent-name": { type: "string" },
    timezone: { type: "string" },
    force: { type: "boolean" },
  });
  const vault = String(flags["vault"]);
  const agentName = (flags["agent-name"] as string | undefined) ?? null;
  const timezone = (flags["timezone"] as string | undefined) ?? null;

  if (timezone) {
    const timezoneValidation = validateTimezoneName(timezone);
    if (!timezoneValidation.ok) {
      process.stderr.write(
        `error: --timezone ${JSON.stringify(timezone)} is not a valid IANA name ` +
          `(${timezoneValidation.error}). ` +
          "Examples: Europe/Belgrade, America/New_York, UTC.\n",
      );
      return 1;
    }
  }

  // v0.11.0: `o2b init` no longer writes content into the vault.
  // Content scaffolding belongs to `o2b brain init` (the Brain layer).
  // This verb persists machine-local config (vault path, agent name,
  // timezone) so other CLI verbs default to the right vault without
  // a --vault flag.
  void flags["force"]; // accepted for backward CLI compat; unused
  void flags["name"]; // accepted for backward CLI compat; unused
  const resolvedVault = resolve(vault).replace(/\\/g, "/");
  let configPath: string;
  try {
    configPath = setConfigValue("vault", resolvedVault);
    if (agentName) setConfigValue("agent_name", agentName);
    if (timezone) setConfigValue("timezone", timezone);
  } catch (exc) {
    process.stderr.write(
      `error: failed to persist plugin config: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  process.stdout.write(`initialized vault: ${resolvedVault}\n`);
  process.stdout.write(`vault path persisted to: ${configPath}\n`);
  if (agentName) {
    process.stdout.write(`agent name registered: ${agentName}\n`);
    process.stdout.write(`agent name persisted to: ${configPath}\n`);
  }
  if (timezone) {
    process.stdout.write(`timezone registered: ${timezone}\n`);
    process.stdout.write(`timezone persisted to: ${configPath}\n`);
  }
  writeSearchInitBlock(resolvedVault, configPath, {
    command: "init",
    argv,
    jsonRequested: flags["json"] === true,
  });
  // Guided first-run onboarding: turn the bare init into a walked-through
  // checklist of state-aware next steps (t_84500f39). Additive - the search
  // block above is unchanged. Best-effort: a checklist failure must never fail
  // the init that already persisted config.
  try {
    const checklist = buildOnboardingChecklist(resolvedVault, { configPath });
    process.stdout.write(renderOnboardingChecklist(checklist));
  } catch {
    // onboarding is advisory; never break init
  }
  return 0;
}

async function cmdOnboarding(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const checklist = buildOnboardingChecklist(vault, { configPath: config });
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(checklist, sortedReplacer, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderOnboardingChecklist(checklist));
  return 0;
}

/**
 * Print the post-init search-onboarding block (design §10).
 *
 * Advertises `o2b search index` when the vault has no index. When the
 * user has already flipped `search_semantic_enabled` to true but no
 * embedding key is resolvable, the detailed configuration template is
 * appended. The block prints once, only during `o2b init` — no nagging
 * on other CLI invocations (the dedicated diagnostic is
 * `o2b search check`).
 */
function writeSearchInitBlock(vault: string, configPath: string, stream: AdvisoryStream): void {
  process.stdout.write("\nSearch:\n");
  // no-dead-ends, phase 3. Two defects at one line. It hand-wrote the
  // rail's own `next: <command>` format, which is the second mechanism
  // the rail exists to prevent; and it advertised the indexer
  // unconditionally, so on a vault that already had an index this block
  // asserted `search-index-missing` two lines above the onboarding
  // checklist reporting that same step as done. One command, two
  // contradictory answers. The predicate is shared with the checklist so
  // they cannot disagree again.
  if (!searchIndexExists(vault, configPath)) emitNextStep("search-index-missing", stream);

  const data = discoverConfig(configPath).data;
  // v0.10.10 — share the truthy / key-present logic with `o2b status`
  // through `resolveSemanticConfigState`. We only emit the detailed
  // template when the operator explicitly turned semantic search on
  // but did not configure the key.
  const semantic = resolveSemanticConfigState(data, process.env);
  // Skip the embedding-key prompt when search is explicitly disabled
  // (no point onboarding semantic when the whole layer is off), the
  // semantic flag is off, or the key is already present.
  if (semantic.search_disabled || !semantic.semantic_enabled || semantic.embedding_key_present) {
    return;
  }

  process.stdout.write(
    [
      "",
      "Semantic search is enabled but no embedding key is configured.",
      "",
      "Either set in the config file (printed above), or via env vars:",
      "",
      `  search_semantic_enabled: "true"`,
      `  embedding_base_url:      "https://openrouter.ai/api/v1"`,
      `  embedding_model:         "google/gemini-embedding-2-preview"`,
      `  embedding_api_key:       "<your key>"`,
      "",
      "Env equivalents:",
      "  OPEN_SECOND_BRAIN_SEARCH_SEMANTIC=true",
      "  OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL=...",
      "  OPEN_SECOND_BRAIN_EMBEDDING_MODEL=...",
      "  OPEN_SECOND_BRAIN_EMBEDDING_KEY=...",
      "",
      "Then:",
      "  o2b search check",
      "  o2b search index --embeddings",
      "",
    ].join("\n"),
  );
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    repo: { type: "string" },
    json: { type: "boolean" },
    readiness: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let results;
  try {
    const repoRoot = (flags["repo"] as string | undefined) ?? null;
    results = doctor({ vault, config, repoRoot });
    // Appended here rather than inside `doctor()` because it spawns a Python
    // interpreter to run the plugin's own resolver, and `core/doctor.ts` is
    // bundled into the OpenClaw artifact, which refuses a Python reference.
    // See the module docblock: OpenClaw has no Hermes plugin, so the check is
    // meaningless there, and this verb is the surface that owns the question.
    const parity = checkHermesResolverParity({ config, repoRoot });
    if (parity) results.push(parity);
  } catch (exc) {
    process.stderr.write(`error: doctor failed: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  const failed = results.filter((r) => !r.ok).length;

  // Opt-in fail-fast readiness probes (t_cc234ff5). Without `--readiness`
  // this stays null and neither the output nor the exit code changes, so
  // plain `doctor` is byte-identical to before.
  let readiness: ReadinessReport | null = null;
  if (flags["readiness"]) {
    try {
      readiness = await runReadinessProbes({ vault, config, cwd: process.cwd() });
    } catch (exc) {
      process.stderr.write(`error: doctor readiness failed: ${(exc as Error).message ?? exc}\n`);
      return 1;
    }
  }
  const readinessFailed = readiness?.failed ?? 0;

  if (flags["json"]) {
    const payload = {
      ok: failed === 0 && readinessFailed === 0,
      checks: results.map((r) => ({
        name: r.name,
        ok: r.ok,
        message: r.message,
        ...(r.fix !== undefined ? { fix: r.fix } : {}),
      })),
      ...(readiness
        ? {
            readiness: readiness.probes.map((p) => ({
              name: p.name,
              status: p.status,
              detail: p.detail,
              duration_ms: p.durationMs,
            })),
          }
        : {}),
      summary: { total: results.length, failed },
    };
    process.stdout.write(JSON.stringify(payload, sortedReplacer, 2) + "\n");
    return failed === 0 && readinessFailed === 0 ? 0 : 1;
  }

  for (const r of results) {
    process.stdout.write(`[${r.ok ? "OK" : "FAIL"}] ${r.name}: ${r.message}\n`);
    // Attach the copy-pasteable remediation right under a failing check so an
    // operator can fix it without leaving the doctor output.
    if (!r.ok && r.fix) process.stdout.write(`       fix: ${r.fix}\n`);
  }
  // Scriptable aggregate: a summary line plus the 0/1 exit make `o2b doctor`
  // usable as a setup/CI gate.
  process.stdout.write(`\ndoctor: ${results.length} checks, ${failed} failed\n`);

  if (readiness) {
    process.stdout.write(
      `\nreadiness: ${readiness.probes.length} probes, ${readinessFailed} failed` +
        (readiness.unknown > 0 ? `, ${readiness.unknown} unknown\n` : `\n`),
    );
    for (const p of readiness.probes) {
      // Rendering `unknown` as SKIP would say "not configured" about a probe
      // that found something it could not read, which is the conflation this
      // release is about: the vocabulary grew a fourth member precisely
      // because three could not carry "could not measure" without lying in
      // one direction. Only the new member gets a new tag - the three that
      // already existed keep their exact spelling, so a reader sees a
      // byte-identical line for every outcome it already knew.
      const tag =
        p.status === "pass"
          ? "PASS"
          : p.status === "fail"
            ? "FAIL"
            : p.status === "skipped"
              ? "SKIP"
              : "UNKNOWN";
      process.stdout.write(`[${tag}] ${p.name}: ${p.detail}\n`);
    }
  }
  return failed === 0 && readinessFailed === 0 ? 0 : 1;
}

/**
 * `o2b export-config --output <file>` - the machine-config snapshot an
 * operator hands to someone else when reporting a problem, which is
 * exactly why it is an egress path (registry entry `config-export`).
 *
 * It used to redact through a private copy in `config.ts` that matched
 * five substrings against KEY NAMES and never inspected a value, so a
 * credential stored under a name that copy did not recognise was written
 * out in full. Both halves now come from the shared redactor, and a value
 * the redactor could only partially scan refuses the write instead of
 * producing a file that claims to be clean.
 */
async function cmdExportConfig(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    output: { type: "string", required: true },
  });
  const result = discoverConfig(flags["config"] as string | undefined);
  const verdict = redactForEgress("config-export", {
    config_path: String(result.path),
    config_exists: result.exists,
    config: result.data as Record<string, unknown>,
  });
  if (verdict.outcome !== EGRESS_OUTCOME.released) {
    process.stderr.write(`error: ${verdict.detail}\n`);
    return 1;
  }
  const output = String(flags["output"]);
  try {
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, JSON.stringify(verdict.payload, sortedReplacer, 2) + "\n", "utf8");
  } catch (exc) {
    process.stderr.write(`error: failed to export config: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  process.stdout.write(`exported: ${output}\n`);
  return 0;
}

async function cmdSecrets(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write("usage: o2b secrets list|status [args...]\n");
    return argv.length === 0 ? 2 : 0;
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);
  switch (verb) {
    case "list":
      return cmdSecretsList(rest);
    case "status":
      return cmdSecretsStatus(rest);
    default:
      process.stderr.write(`error: unknown secrets verb: ${verb}\n`);
      return 2;
  }
}

function cmdSecretsList(argv: string[]): number {
  const { flags, positional } = parseFlags(argv, {
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) {
    process.stderr.write(
      `error: secrets list does not accept positional arguments: ${positional.join(" ")}\n`,
    );
    return 2;
  }
  const discovery = discoverConfig(flags["config"] as string | undefined);
  const refs = listSecretReferences(discovery.data, process.env);
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          config_path: discovery.path,
          config_exists: discovery.exists,
          secrets: refs.map((ref) => ({
            config_key: ref.configKey,
            name: ref.name,
            available: ref.available,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  for (const ref of refs) {
    process.stdout.write(
      `${ref.configKey}: ${ref.name} (${ref.available ? "available" : "missing"})\n`,
    );
  }
  return 0;
}

function cmdSecretsStatus(argv: string[]): number {
  const { flags, positional } = parseFlags(argv, {
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length !== 1) {
    process.stderr.write("error: secrets status requires exactly one secret name\n");
    return 2;
  }
  void flags["config"];
  const name = positional[0]!;
  const available = Boolean(process.env[name]);
  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ name, available }, null, 2) + "\n");
  } else {
    process.stdout.write(`${name}: ${available ? "available" : "missing"}\n`);
  }
  return available ? 0 : 1;
}

async function cmdIndex(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, { vault: { type: "string" } });
  const vault = requireVault(flags["vault"] as string | undefined, defaultConfigPath());
  let pages;
  try {
    pages = listVaultPages(vault);
  } catch (exc) {
    process.stderr.write(`error: failed to list vault pages: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  if (pages.length === 0) {
    process.stdout.write(`no markdown pages found in vault: ${vault}\n`);
    return 0;
  }
  const lines: string[] = [
    `# Vault Index`,
    "",
    `Auto-generated index of ${pages.length} pages.`,
    "",
  ];
  for (const p of pages) {
    const rel = p.path.startsWith(vault) ? p.path.slice(vault.length).replace(/^\/+/, "") : p.path;
    lines.push(`- [[${p.title}]]  \`${rel}\``);
  }
  const indexPath = resolve(vault, BRAIN_INDEX_REL);
  try {
    writeFrontmatter(indexPath, { title: "Index", type: "index" }, lines.join("\n"));
  } catch (exc) {
    process.stderr.write(`error: failed to write index: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  process.stdout.write(`index regenerated: ${indexPath} (${pages.length} pages)\n`);
  return 0;
}

async function cmdMcp(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    repo: { type: "string" },
    scope: { type: "string" },
    "writer-only": { type: "boolean" },
    "tool-profile": { type: "string" },
    probe: { type: "boolean" },
    json: { type: "boolean" },
    transport: { type: "string", default: "stdio" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    "api-key": { type: "string" },
    "allow-tool": { type: "string-array" },
    "disable-tool": { type: "string-array" },
    "max-tools": { type: "string" },
  });

  // `--writer-only` is an alias for `--scope writer`. The two flags
  // are mutually consistent; if the user passes both, `--writer-only`
  // wins only when `--scope` is absent or already "writer". A
  // contradictory pair (e.g. `--scope full --writer-only`) is
  // rejected to avoid silent surprises.
  const writerOnly = Boolean(flags["writer-only"]);
  const explicitScope =
    (flags["scope"] as string | undefined) ?? (writerOnly ? "writer" : undefined);
  if (
    explicitScope !== undefined &&
    explicitScope !== "full" &&
    explicitScope !== "writer" &&
    explicitScope !== "catalog"
  ) {
    process.stderr.write(
      `o2b mcp: invalid --scope value: ${explicitScope}; expected one of: full, writer, catalog\n`,
    );
    return 2;
  }
  if (writerOnly && explicitScope !== "writer") {
    process.stderr.write(`o2b mcp: --writer-only conflicts with --scope ${explicitScope}\n`);
    return 2;
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const transport = flags["transport"] as string;
  if (transport !== "stdio" && transport !== "http") {
    process.stderr.write(
      `o2b mcp: invalid --transport value: ${transport}; expected one of: stdio, http\n`,
    );
    return 2;
  }
  const rawPort = flags["port"] as string;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`o2b mcp: --port must be an integer from 0 to 65535\n`);
    return 2;
  }
  const host = flags["host"] as string;
  const apiKey = flags["api-key"] as string | undefined;
  // Bearer is optional on a loopback bind (the loopback bind + Host/Origin
  // rebinding guard are the baseline defence) but mandatory on a non-loopback
  // host, which would otherwise expose the Brain unauthenticated on the network.
  if (transport === "http" && !isLoopbackHost(host) && (apiKey === undefined || apiKey === "")) {
    process.stderr.write(
      "o2b mcp: --api-key is required when --transport http binds a non-loopback --host\n",
    );
    return 2;
  }

  // Named tool-surface profile: flag wins over the config key; an
  // unknown name FAILS OPEN to the full surface (logged, never fatal).
  const profileName =
    (flags["tool-profile"] as string | undefined) ?? resolveMcpToolProfile(config);
  const explicitWindow = parseCapabilityWindow(flags);
  const surface = resolveToolSurface({
    profileName,
    ...(explicitScope !== undefined ? { explicitScope } : {}),
    ...(explicitWindow !== undefined ? { explicitWindow } : {}),
  });
  if (surface.unknownProfile !== undefined) {
    process.stderr.write(
      `o2b mcp: unknown tool profile "${surface.unknownProfile}"; ` +
        `failing open to the full surface (known: ${toolSurfaceProfileNames().join(", ")})\n`,
    );
  }
  const scope = surface.scope;
  const serverName = scope === "writer" ? "open-second-brain-writer" : "open-second-brain";
  const capabilityWindow = surface.window;

  if (flags["probe"]) {
    return await runMcpProbe({
      vault: flags["vault"] as string | undefined,
      config,
      scope,
      serverName,
      json: Boolean(flags["json"]),
      capabilityWindow,
    });
  }

  const vault = requireVault(flags["vault"] as string | undefined, config);
  const repoRoot = (flags["repo"] as string | undefined) ?? null;

  // Hands-off post-upgrade maintenance: if the vault's on-disk state lags the
  // running version (stale Brain managed files, stale/missing search index),
  // bring it current with no user action. Fire-and-forget, full scope only
  // (the writer server skips it), never blocks or fails server start; a needed
  // reindex runs detached in the background.
  if (scope === "full") {
    void ensureVaultCurrent(vault, { background: true, configPath: config }).catch(() => {
      // best-effort; the server must come up regardless
    });
  }

  if (transport === "http") {
    const handle = await startHttp(
      { vault, configPath: config, repoRoot },
      { host, port, apiKey },
      { scope, serverName, capabilityWindow },
    );
    // Log the actually-bound endpoint. With the default --port 0 the OS
    // assigns an ephemeral port, so the requested `port` value ("0") would
    // advertise the wrong URL. handle.url carries the real bound port.
    process.stderr.write(
      `[mcp] ${serverName} ${SERVER_VERSION} listening on ${handle.url} (vault=${vault})\n`,
    );
    await new Promise<void>((resolve) => handle.server.once("close", resolve));
    return 0;
  }

  process.stderr.write(
    `[mcp] ${serverName} ${SERVER_VERSION} listening on stdio (vault=${vault})\n`,
  );
  return await serveStdio(
    { vault, configPath: config, repoRoot },
    {},
    { scope, serverName, capabilityWindow },
  );
}

function parseCapabilityWindow(
  flags: Record<string, string | boolean | string[] | undefined>,
): RuntimeCapabilityWindow | undefined {
  const allowedTools = flags["allow-tool"] as string[] | undefined;
  const disabledTools = flags["disable-tool"] as string[] | undefined;
  const rawMaxTools = flags["max-tools"] as string | undefined;
  let maxTools: number | undefined;
  if (rawMaxTools !== undefined) {
    const parsed = Number(rawMaxTools);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new CliError("--max-tools must be a positive integer");
    }
    maxTools = parsed;
  }
  if (!allowedTools && !disabledTools && maxTools === undefined) return undefined;
  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(disabledTools ? { disabledTools } : {}),
    ...(maxTools !== undefined ? { maxTools } : {}),
  };
}

async function runMcpProbe(args: {
  vault: string | undefined;
  config: string;
  scope: "full" | "writer" | "catalog";
  serverName: string;
  json: boolean;
  capabilityWindow: RuntimeCapabilityWindow | undefined;
}): Promise<number> {
  // The probe is an in-process MCP handshake: it counts the tools the
  // server would advertise and exits. Used by `o2b install --check`
  // to verify the server starts cleanly.
  let vault: string;
  try {
    vault = requireVault(args.vault, args.config);
  } catch (e) {
    process.stdout.write(`mcp probe FAIL: vault not configured (${(e as Error).message})\n`);
    return 1;
  }
  try {
    const evaluated = evaluateToolCapabilities(buildToolTable(args.scope), {
      scope: args.scope,
      serverName: args.serverName,
      window: args.capabilityWindow,
    });
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            server_name: args.serverName,
            vault,
            capabilities: evaluated.report,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const tools = evaluated.tools;
    process.stdout.write(
      `mcp probe ok: ${args.serverName} (${tools.length} tools, vault=${vault})\n`,
    );
    return 0;
  } catch (e) {
    process.stdout.write(`mcp probe FAIL: ${(e as Error).message}\n`);
    return 1;
  }
}

async function cmdInstallCli(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, { bindir: { type: "string" } });
  const result = installCli(flags["bindir"] as string | undefined);
  process.stdout.write(renderInstallResult(result));
  return result.errors.length > 0 ? 1 : 0;
}

async function cmdUninstall(argv: string[]): Promise<number> {
  // `--target X` (and the `--target=X` form) is its own mode —
  // per-runtime uninstall, distinct from the legacy `--apply-local`
  // config-removal path.
  if (argv.some((a) => a === "--target" || a.startsWith("--target="))) {
    return await cmdUninstallTarget(argv);
  }
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    "apply-local": { type: "boolean" },
    "remove-cli": { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const plan = planUninstall({
    configPath: config,
    applyLocal: Boolean(flags["apply-local"]),
  });
  process.stdout.write(renderPlan(plan));
  let returnCode = 0;
  if (flags["remove-cli"]) {
    const result = uninstallCli();
    process.stdout.write("\n" + renderUninstallResult(result));
    if (result.errors.length > 0) returnCode = 1;
  }
  if (plan.errors.length > 0) returnCode = 1;
  return returnCode;
}

async function cmdToolCall(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    "tool-arg": { type: "string-array" },
  });
  if (positional.length < 1) {
    process.stderr.write("error: tool-call requires a tool name argument\n");
    return 2;
  }
  const toolName = positional[0]!;
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  const args: Record<string, unknown> = {};
  for (const pair of (flags["tool-arg"] as string[] | undefined) ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      // Argument-shape error: align with the dispatcher convention
      // (CliError → exit 2). Tool execution failures keep using exit 1.
      process.stderr.write(`error: --tool-arg must be key=value, got: ${pair}\n`);
      return 2;
    }
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    try {
      args[k] = JSON.parse(v);
    } catch {
      args[k] = v;
    }
  }
  const server = new MCPServer({ vault, configPath: config });
  try {
    const result = await server.callTool(toolName, args);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
}

function cmdHelp(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {});
  if (positional.length > 0) {
    process.stderr.write(
      `error: help does not accept positional arguments: ${positional.join(" ")}\n`,
    );
    return 2;
  }
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(manifestForJson(), null, 2) + "\n");
  } else {
    process.stdout.write(renderHelp());
  }
  return 0;
}

function cmdCompletions(argv: ReadonlyArray<string>): number {
  const { positional } = parseFlags(argv, {});
  if (positional.length !== 1) {
    process.stderr.write(
      `error: completions requires one shell (${COMPLETION_SHELLS.join("|")})\n`,
    );
    return 2;
  }
  const shell = positional[0]!;
  if (!isCompletionShell(shell)) {
    process.stderr.write(`error: unsupported completion shell: ${shell}\n`);
    return 2;
  }
  process.stdout.write(renderCompletions(shell, CLI_COMMAND_MANIFEST));
  return 0;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0) {
    // No command named: the terse banner, not the complete index. The
    // index is two hundred lines and would bury the fact that nothing
    // was asked for; the banner names where the index is.
    process.stdout.write(renderUsage());
    return 2;
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(renderHelp());
    return 0;
  }
  const command = argv[0]!;
  const rest = argv.slice(1);

  // Per-command --help support: print the dedicated help line plus generic.
  // The `brain` subcommand has its own dispatcher with per-verb help, so we
  // skip the generic shortcut and hand control over directly.
  if (
    rest.length === 1 &&
    (rest[0] === "-h" || rest[0] === "--help") &&
    command !== "aider" &&
    command !== "brain" &&
    command !== "vault"
  ) {
    process.stdout.write(`${command}: see https://github.com/itechmeat/open-second-brain\n`);
    if (command === "uninstall") {
      process.stdout.write(
        "Read-only by default. Prints the Hermes commands you must run yourself " +
          "(this tool never touches ~/.hermes/config.yaml or the installed plugin). " +
          "With --apply-local it may remove the machine-local Open Second Brain " +
          "config directory only. Your vault and Markdown notes are never removed. " +
          "With --remove-cli it also removes the o2b/vault-log " +
          "symlinks created by 'o2b install-cli'.\n",
      );
    }
    return 0;
  }

  const run = () => dispatchCommand(command, rest);
  if (wantsJsonFlag(rest) && !ownsInternalJson(command, rest)) {
    return await withJsonFallback(command, run);
  }
  return await run();
}

async function dispatchCommand(command: string, rest: string[]): Promise<number> {
  try {
    switch (command) {
      case "status":
        return await cmdStatus(rest);
      case "init":
        return await cmdInit(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "onboarding":
        return await cmdOnboarding(rest);
      case "export-config":
        return await cmdExportConfig(rest);
      case "index":
        return await cmdIndex(rest);
      case "mcp":
        return await cmdMcp(rest);
      case "install-cli":
        return await cmdInstallCli(rest);
      case "install":
        return await cmdInstall(rest);
      case "update":
        return await cmdUpdate(rest);
      case "uninstall":
        return await cmdUninstall(rest);
      case "tool-call":
        return await cmdToolCall(rest);
      case "secrets":
        return await cmdSecrets(rest);
      case "help":
        return cmdHelp(rest);
      case "completions":
        return cmdCompletions(rest);
      case "aider":
        return await handleAiderSubcommand(rest);
      case "brain":
        return await handleBrainSubcommand(rest);
      case "discipline":
        return await handleDisciplineSubcommand(rest);
      case "search":
        return await handleSearchSubcommand(rest);
      case "vault":
        return await handleVaultSubcommand(rest);
      case "partner":
        return await handlePartnerSubcommand(rest);
      default:
        process.stderr.write(`error: unknown command: ${command}\n`);
        process.stderr.write(renderUsage());
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 2;
    }
    if (exc instanceof NoVaultConfiguredError) {
      process.stderr.write(exc.message + "\n");
      return 1;
    }
    if (exc instanceof ConfigReadError) {
      return reportConfigReadError(exc, command, rest);
    }
    throw exc;
  }
}

/**
 * Refusal for a plugin config that is present but unreadable.
 *
 * Exit 1, joining `NoVaultConfiguredError` rather than `CliError`: this
 * command line reserves 2 for a mistake in the argv and 1 for a machine
 * that cannot answer the question. Nothing about the invocation is wrong
 * here - the same argv works the moment the file mode does.
 *
 * The message needs no assembly. {@link ConfigReadError} carries its own
 * remedy so that every surface it escapes through (here, an MCP error
 * envelope, a subcommand's own wrapper) says the same thing.
 *
 * A `--json` caller additionally gets a parseable object on stdout. For
 * every other command the {@link withJsonFallback} envelope already carries
 * the refusal - it could not before, because a THROWN error escaped the
 * envelope entirely and left stdout empty. A command that renders its own
 * JSON is not wrapped, so it would still be the one surface where a machine
 * consumer sees a non-zero exit and nothing to parse. The keys are the ones
 * `o2b status --json` and its MCP twin already use for this condition.
 */
function reportConfigReadError(exc: ConfigReadError, command: string, rest: string[]): number {
  process.stderr.write(`error: ${exc.message}\n`);
  if (wantsJsonFlag(rest) && ownsInternalJson(command, rest)) {
    process.stdout.write(
      JSON.stringify({ config_path: exc.path, error: exc.message }, sortedReplacer, 2) + "\n",
    );
  }
  return 1;
}

if (import.meta.main) {
  // O1 (t_2ed754d1): an early-closed stdout pipe (`o2b <listing> | head -1`)
  // must exit clean. The listener catches Bun's asynchronous closed-pipe
  // `error` event; the `.catch` covers a synchronous EPIPE throw. Every other
  // error keeps its existing loud failure.
  installStdoutEpipeGuard();
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (isEpipeError(err)) process.exit(0);
      throw err;
    });
}
