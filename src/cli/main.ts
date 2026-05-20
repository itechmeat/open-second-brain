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
  defaultConfigPath,
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
  setConfigValue,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent } from "../core/event-log.ts";
import { bootstrapVault } from "../core/init.ts";
import { listVaultPages, writeFrontmatter } from "../core/vault.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { handleBrainSubcommand } from "./brain.ts";
import { handleDisciplineSubcommand } from "./discipline.ts";
import { handleSearchSubcommand } from "./search.ts";
import { handleVaultSubcommand } from "./vault.ts";
import {
  NoVaultConfiguredError,
  normalizeFlagString,
  requireVault,
  resolveSemanticConfigState,
  sortedReplacer,
} from "./helpers.ts";
import {
  cmdInitPayMemory,
  cmdAppendPaymentReceipt,
  cmdCaptureAsset,
  cmdPaymentDigest,
  cmdRequestPaymentApproval,
  cmdApprovePaymentRequest,
  cmdRejectPaymentRequest,
  cmdConsumePaymentRequest,
  cmdListPendingPayments,
  cmdCheckPaymentPolicy,
  cmdPaymentReport,
} from "./pay-memory/index.ts";
import {
  installCli,
  renderInstallResult,
  renderUninstallResult,
  uninstallCli,
} from "./install-cli.ts";
import { planUninstall, renderPlan } from "./uninstall.ts";
import { cmdInstall } from "./install/install.ts";
import { cmdUninstallTarget } from "./install/uninstall-target.ts";
import { cmdInitInteractive } from "./install/init-interactive.ts";
import { MCPServer } from "../mcp/server.ts";
import { serveStdio } from "../mcp/stdio.ts";
import { SERVER_VERSION } from "../mcp/protocol.ts";
import { buildToolTable } from "../mcp/tools.ts";

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
      output["config_keys"] = Object.keys(result.data).sort();
    }
    if (flags["vault"]) output["vault"] = String(flags["vault"]);
    process.stdout.write(JSON.stringify(output, sortedReplacer, 2) + "\n");
  } else {
    process.stdout.write(`config_path: ${result.path}\n`);
    process.stdout.write(`config_exists: ${result.exists ? "true" : "false"}\n`);
    if (Object.keys(result.data).length > 0) {
      process.stdout.write("config_keys:\n");
      for (const key of Object.keys(result.data).sort()) {
        process.stdout.write(`- ${key}\n`);
      }
    }
    if (semantic.off && semantic.hint) {
      process.stdout.write(`semantic: off (${semantic.hint})\n`);
    }
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
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch (exc) {
      process.stderr.write(
        `error: --timezone ${JSON.stringify(timezone)} is not a valid IANA name ` +
          `(${(exc as Error).message ?? exc}). ` +
          "Examples: Europe/Belgrade, America/New_York, UTC.\n",
      );
      return 1;
    }
  }

  let created: string[];
  try {
    created = bootstrapVault(vault, {
      name: String(flags["name"] ?? "Second Brain"),
      agentName,
      force: Boolean(flags["force"]),
    });
  } catch (exc) {
    process.stderr.write(`error: failed to initialize vault: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }

  if (created.length > 0) {
    process.stdout.write(`initialized vault: ${vault}\n`);
    for (const p of created) process.stdout.write(`  created: ${p}\n`);
  } else {
    process.stdout.write(`vault already initialized: ${vault}\n`);
    process.stdout.write("use --force to overwrite existing files\n");
  }
  // Persist vault/agent/timezone in one guarded block so a write failure
  // (read-only config dir, disk full) surfaces as a clean CLI exit instead
  // of an uncaught exception after the vault scaffolding is already on disk.
  let configPath: string;
  try {
    configPath = setConfigValue("vault", resolve(vault));
    if (agentName) setConfigValue("agent_name", agentName);
    if (timezone) setConfigValue("timezone", timezone);
  } catch (exc) {
    process.stderr.write(
      `error: failed to persist plugin config: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  process.stdout.write(`vault path persisted to: ${configPath}\n`);
  if (agentName) {
    process.stdout.write(`agent name registered: ${agentName}\n`);
    process.stdout.write(`agent name persisted to: ${configPath}\n`);
  }
  if (timezone) {
    process.stdout.write(`timezone registered: ${timezone}\n`);
    process.stdout.write(`timezone persisted to: ${configPath}\n`);
  }
  writeSearchInitBlock(configPath);
  return 0;
}

/**
 * Print the post-init search-onboarding block (design §10).
 *
 * Always advertises `o2b search index`. When the user has already
 * flipped `search_semantic_enabled` to true but no embedding key is
 * resolvable, the detailed configuration template is appended. The
 * block prints once, only during `o2b init` — no nagging on other
 * CLI invocations (the dedicated diagnostic is `o2b search check`).
 */
function writeSearchInitBlock(configPath: string): void {
  process.stdout.write("\nSearch:\n");
  process.stdout.write("  next: o2b search index   # build the vault search index\n");

  const data = discoverConfig(configPath).data;
  // v0.10.10 — share the truthy / key-present logic with `o2b status`
  // through `resolveSemanticConfigState`. We only emit the detailed
  // template when the operator explicitly turned semantic search on
  // but did not configure the key.
  const semantic = resolveSemanticConfigState(data, process.env);
  // Skip the embedding-key prompt when search is explicitly disabled
  // (no point onboarding semantic when the whole layer is off), the
  // semantic flag is off, or the key is already present.
  if (
    semantic.search_disabled ||
    !semantic.semantic_enabled ||
    semantic.embedding_key_present
  ) {
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
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let results;
  try {
    results = doctor({ vault, config, repoRoot: (flags["repo"] as string | undefined) ?? null });
  } catch (exc) {
    process.stderr.write(`error: doctor failed: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  let allOk = true;
  for (const r of results) {
    process.stdout.write(`[${r.ok ? "OK" : "FAIL"}] ${r.name}: ${r.message}\n`);
    if (!r.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}

async function cmdAppendEvent(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    as: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    config: { type: "string" },
  });
  if (positional.length < 1) {
    process.stderr.write("error: append-event requires a message argument\n");
    return 2;
  }
  const message = positional[0]!;
  // §32F (v0.10.8): resolve the agent identity through the shared
  // resolver instead of the literal `"agent"` fallback. The resolver
  // chain honours `--as` -> `VAULT_AGENT_NAME` env -> `agent_name`
  // from the plugin config -> the placeholder `"agent"` (only as the
  // very last resort). Cron-jobs and shell scripts get the
  // config-declared identity instead of corrupted `@agent` entries.
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const tz = resolveTimezone(config);
  const explicit = normalizeFlagString(flags["as"]);
  if (flags["as"] !== undefined && explicit === null) {
    process.stderr.write("error: --as must be a non-empty string when provided\n");
    return 2;
  }
  const agent = explicit ?? resolveAgentName(config);

  let path: string;
  try {
    path = await appendEvent(vault, agent, message, {
      date: (flags["date"] as string | undefined) ?? null,
      time: (flags["time"] as string | undefined) ?? null,
      tz,
    });
  } catch (exc) {
    process.stderr.write(`error: failed to append event: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  process.stdout.write(`appended: ${resolve(path)}\n`);
  return 0;
}

async function cmdExportConfig(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    output: { type: "string", required: true },
  });
  const result = discoverConfig(flags["config"] as string | undefined);
  const snapshot = {
    config_path: String(result.path),
    config_exists: result.exists,
    config: redactMapping(result.data),
  };
  const output = String(flags["output"]);
  try {
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, JSON.stringify(snapshot, sortedReplacer, 2) + "\n", "utf8");
  } catch (exc) {
    process.stderr.write(`error: failed to export config: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  process.stdout.write(`exported: ${output}\n`);
  return 0;
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
  const indexPath = resolve(vault, "AI Wiki", "index.md");
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
    probe: { type: "boolean" },
  });

  // `--writer-only` is an alias for `--scope writer`. The two flags
  // are mutually consistent; if the user passes both, `--writer-only`
  // wins only when `--scope` is absent or already "writer". A
  // contradictory pair (e.g. `--scope full --writer-only`) is
  // rejected to avoid silent surprises.
  const writerOnly = Boolean(flags["writer-only"]);
  const rawScope = (flags["scope"] as string | undefined) ?? (writerOnly ? "writer" : "full");
  if (rawScope !== "full" && rawScope !== "writer") {
    process.stderr.write(
      `o2b mcp: invalid --scope value: ${rawScope}; expected one of: full, writer\n`,
    );
    return 2;
  }
  if (writerOnly && rawScope !== "writer") {
    process.stderr.write(
      `o2b mcp: --writer-only conflicts with --scope ${rawScope}\n`,
    );
    return 2;
  }
  const scope = rawScope;
  const serverName =
    scope === "writer" ? "open-second-brain-writer" : "open-second-brain";

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();

  if (flags["probe"]) {
    return await runMcpProbe({
      vault: flags["vault"] as string | undefined,
      config,
      scope,
      serverName,
    });
  }

  const vault = requireVault(flags["vault"] as string | undefined, config);
  const repoRoot = (flags["repo"] as string | undefined) ?? null;

  process.stderr.write(
    `[mcp] ${serverName} ${SERVER_VERSION} listening on stdio (vault=${vault})\n`,
  );
  return await serveStdio({ vault, configPath: config, repoRoot }, {}, { scope, serverName });
}

async function runMcpProbe(args: {
  vault: string | undefined;
  config: string;
  scope: "full" | "writer";
  serverName: string;
}): Promise<number> {
  // The probe is an in-process MCP handshake: it counts the tools the
  // server would advertise and exits. Used by `o2b install --check`
  // to verify the server starts cleanly.
  let vault: string;
  try {
    vault = requireVault(args.vault, args.config);
  } catch (e) {
    process.stdout.write(
      `mcp probe FAIL: vault not configured (${(e as Error).message})\n`,
    );
    return 1;
  }
  try {
    const tools = buildToolTable(args.scope);
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
  // `--target X` is its own mode — per-runtime uninstall, distinct from the
  // legacy `--apply-local` config-removal path.
  if (argv.includes("--target")) {
    return await cmdUninstallTarget(argv);
  }
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    "apply-local": { type: "boolean" },
    "remove-cli": { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const plan = planUninstall({ configPath: config, applyLocal: Boolean(flags["apply-local"]) });
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

const HELP = `usage: o2b <command> [args...]

Commands:
  status                    Show Open Second Brain configuration status
  init                      Initialize a vault profile with required files
  doctor                    Run health checks on vault, config, and plugins
  append-event              Append an event to the configured event log backend
  export-config             Write a redacted config snapshot
  index                     Regenerate the vault index from discovered pages
  mcp                       Run the optional MCP tool server (stdio JSON-RPC)
  install-cli               Create symlinks for o2b and vault-log in ~/.local/bin
  uninstall                 Print an uninstall plan and (optionally) clean local config and CLI symlinks
  tool-call                 Invoke an MCP tool handler from the CLI and print JSON to stdout

Pay Memory:
  init-pay-memory           Bootstrap policies/, payments/, assets/, drafts/, reports/
  append-payment-receipt    Save a Markdown receipt for a paid API call
  capture-asset             Save a Markdown note for an asset produced by a paid call
  payment-report            Aggregate a date's receipts into a Markdown report
  check-payment-policy      Evaluate a prospective paid call against policies/spending.json
  request-payment-approval  Create a pending payment request the user must approve
  approve-payment-request   Mark a pending request as approved (human action)
  reject-payment-request    Mark a pending request as rejected (human action)
  consume-payment-request   Link an approved request to its resulting receipt
  list-pending-payments     List pending/approved/etc. requests
  payment-digest            Render a Telegram-friendly 4-line summary for a date (Hermes cron-friendly)

Brain (observing memory):
  brain init                Bootstrap <vault>/Brain/ skeleton (idempotent)
  brain feedback            Record a taste signal into Brain/inbox/
  brain dream               Run the deterministic dreaming pass (idempotent)
  brain apply-evidence      Log a real-work application of a preference
  brain note                Append a one-line narrative milestone to Brain/log/today
  brain digest              Render the recent-changes digest (markdown or --json)
  brain query               Read by --preference, --topic, or --since
  brain reject              Move a preference to retired/ (user-rejected)
  brain pin                 Mark a preference exempt from automatic retire
  brain unpin               Clear the pinned flag
  brain rollback            Restore Brain/ from a snapshot (--list / <run_id>)
  brain doctor              Validate Brain invariants (--strict promotes warnings)

Discipline:
  discipline report         Render the daily discipline report block (Telegram-safe)

Search:
  search "<query>"          Search the vault index (default verb is 'query')
  search index              Incrementally update the index from the vault
  search reindex            Rebuild the index atomically (.new -> rename -> .bak)
  search status             Print index summary (counts, model, vec extension)
  search check              Pre-flight diagnostics (SQLite, FTS5, vec, provider)

Vault scope:
  vault status              Show how many files/dirs the active policy includes and which rules excluded
  vault inspect <relpath>   Point-check one vault-relative path against the policy
`;

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const command = argv[0]!;
  const rest = argv.slice(1);

  // Per-command --help support: print the dedicated help line plus generic.
  // The `brain` subcommand has its own dispatcher with per-verb help, so we
  // skip the generic shortcut and hand control over directly.
  if (
    rest.length === 1 &&
    (rest[0] === "-h" || rest[0] === "--help") &&
    command !== "brain" &&
    command !== "vault"
  ) {
    process.stdout.write(`${command}: see https://github.com/itechmeat/open-second-brain\n`);
    if (command === "uninstall") {
      process.stdout.write(
        "Read-only by default. Prints the Hermes commands you must run yourself " +
          "(this tool never touches ~/.hermes/config.yaml or the installed plugin). " +
          "With --apply-local it may remove the machine-local Open Second Brain " +
          "config directory only. Your vault, Daily/, AI Wiki/, and Markdown notes " +
          "are never removed. With --remove-cli it also removes the o2b/vault-log " +
          "symlinks created by 'o2b install-cli'.\n",
      );
    }
    return 0;
  }

  try {
    switch (command) {
      case "status":
        return await cmdStatus(rest);
      case "init":
        return await cmdInit(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "append-event":
        return await cmdAppendEvent(rest);
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
      case "uninstall":
        return await cmdUninstall(rest);
      case "tool-call":
        return await cmdToolCall(rest);
      case "init-pay-memory":
        return await cmdInitPayMemory(rest);
      case "append-payment-receipt":
        return await cmdAppendPaymentReceipt(rest);
      case "capture-asset":
        return await cmdCaptureAsset(rest);
      case "payment-report":
        return await cmdPaymentReport(rest);
      case "check-payment-policy":
        return await cmdCheckPaymentPolicy(rest);
      case "request-payment-approval":
        return await cmdRequestPaymentApproval(rest);
      case "approve-payment-request":
        return await cmdApprovePaymentRequest(rest);
      case "reject-payment-request":
        return await cmdRejectPaymentRequest(rest);
      case "consume-payment-request":
        return await cmdConsumePaymentRequest(rest);
      case "list-pending-payments":
        return await cmdListPendingPayments(rest);
      case "payment-digest":
        return await cmdPaymentDigest(rest);
      case "brain":
        return await handleBrainSubcommand(rest);
      case "discipline":
        return await handleDisciplineSubcommand(rest);
      case "search":
        return await handleSearchSubcommand(rest);
      case "vault":
        return await handleVaultSubcommand(rest);
      default:
        process.stderr.write(`error: unknown command: ${command}\n`);
        process.stderr.write(HELP);
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
    throw exc;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
