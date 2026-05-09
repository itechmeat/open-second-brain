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
  resolveTimezone,
  resolveVault,
  setConfigValue,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent } from "../core/event-log.ts";
import { bootstrapVault } from "../core/init.ts";
import { listVaultPages, writeFrontmatter } from "../core/vault.ts";
import { CliError, parseFlags } from "./argparse.ts";
import {
  installCli,
  renderInstallResult,
  renderUninstallResult,
  uninstallCli,
} from "./install-cli.ts";
import { planUninstall, renderPlan } from "./uninstall.ts";
import { MCPServer } from "../mcp/server.ts";
import { serveStdio } from "../mcp/stdio.ts";
import { SERVER_VERSION } from "../mcp/protocol.ts";

const NO_VAULT_ERROR =
  "error: no vault configured. Pass --vault <path> explicitly, " +
  "set VAULT_DIR in the environment, or run " +
  "`o2b init --vault <path> ...` first to persist a default.";

class NoVaultConfiguredError extends Error {
  constructor() {
    super(NO_VAULT_ERROR);
    this.name = "NoVaultConfiguredError";
  }
}

function requireVault(flagVal: string | undefined, configPath: string | null): string {
  const vault = flagVal ?? resolveVault(configPath ?? undefined);
  if (vault === null || vault === undefined) {
    // Throw rather than process.exit so the dispatcher's catch can convert
    // this into a clean exit code 1 — main() stays reusable in-process
    // (e.g. test harnesses that import and call it).
    throw new NoVaultConfiguredError();
  }
  return vault;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdStatus(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    config: { type: "string" },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const result = discoverConfig(flags["config"] as string | undefined);
  if (flags["json"]) {
    const output: Record<string, unknown> = {
      config_path: String(result.path),
      config_exists: result.exists,
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
  }
  return 0;
}

async function cmdInit(argv: string[]): Promise<number> {
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
  return 0;
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
    as: { type: "string", default: process.env["VAULT_AGENT_NAME"] ?? "agent" },
    date: { type: "string" },
    time: { type: "string" },
  });
  if (positional.length < 1) {
    process.stderr.write("error: append-event requires a message argument\n");
    return 2;
  }
  const message = positional[0]!;
  const vault = requireVault(flags["vault"] as string | undefined, defaultConfigPath());
  const tz = resolveTimezone();

  let path: string;
  try {
    path = await appendEvent(vault, String(flags["as"] ?? "agent"), message, {
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
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const repoRoot = (flags["repo"] as string | undefined) ?? null;

  process.stderr.write(
    `[mcp] open-second-brain ${SERVER_VERSION} listening on stdio (vault=${vault})\n`,
  );
  const server = new MCPServer({ vault, configPath: config, repoRoot });
  return await serveStdio(server);
}

async function cmdInstallCli(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, { bindir: { type: "string" } });
  const result = installCli(flags["bindir"] as string | undefined);
  process.stdout.write(renderInstallResult(result));
  return result.errors.length > 0 ? 1 : 0;
}

async function cmdUninstall(argv: string[]): Promise<number> {
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
  status            Show Open Second Brain configuration status
  init              Initialize a vault profile with required files
  doctor            Run health checks on vault, config, and plugins
  append-event      Append an event to the configured event log backend
  export-config     Write a redacted config snapshot
  index             Regenerate the vault index from discovered pages
  mcp               Run the optional MCP tool server (stdio JSON-RPC)
  install-cli       Create symlinks for o2b and vault-log in ~/.local/bin
  uninstall         Print an uninstall plan and (optionally) clean local config and CLI symlinks
  tool-call         Invoke an MCP tool handler from the CLI and print JSON to stdout
`;

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const command = argv[0]!;
  const rest = argv.slice(1);

  // Per-command --help support: print the dedicated help line plus generic.
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
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
      case "uninstall":
        return await cmdUninstall(rest);
      case "tool-call":
        return await cmdToolCall(rest);
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
