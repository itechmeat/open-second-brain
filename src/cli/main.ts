/**
 * `o2b` CLI entry point. Mirrors `src/open_second_brain/cli.py` from the
 * legacy implementation: same subcommands, same flag names, same exit codes,
 * same error messages (verified by ports of the Python integration tests).
 *
 * Each subcommand resolves its inputs, delegates to `core/*` for business
 * logic, and returns a `0`/`1` exit code. The dispatcher is a small `switch`
 * statement, not a registry — keeps the control flow obvious.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  defaultConfigPath,
  discoverConfig,
  redactMapping,
  resolveAgentName,
  resolveTimezone,
  resolveVault,
  setConfigValue,
} from "../core/config.ts";
import { doctor } from "../core/doctor.ts";
import { appendEvent } from "../core/event-log.ts";
import { bootstrapVault } from "../core/init.ts";
import {
  approvePendingRequest,
  buildPaymentDigest,
  checkPolicy,
  consumePendingRequest,
  listPendingRequests,
  loadPendingRequest,
  payMemoryDirs,
  rejectPendingRequest,
  renderPaymentDigestTelegram,
  vaultRelativePath,
  writeAsset,
  writePendingRequest,
  writePolicyIfMissing,
  writeReceipt,
  writeReport,
} from "../core/pay-memory/index.ts";
import type { ReceiptPolicyStatus } from "../core/pay-memory/types.ts";
import { listVaultPages, writeFrontmatter } from "../core/vault.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { handleBrainSubcommand } from "./brain.ts";
import { handleDisciplineSubcommand } from "./discipline.ts";
import { handleSearchSubcommand } from "./search.ts";
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

/**
 * Emit `payload` as pretty-printed JSON with sorted keys, plus a trailing
 * newline. Centralises the format so the eleven Pay Memory subcommands
 * don't each repeat the same `JSON.stringify(...) + "\n"` boilerplate.
 */
function writeJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, sortedReplacer, 2) + "\n");
}

/**
 * Render a uniform `error: failed to <action>: <reason>\n` message on
 * stderr and return exit-code 1. Use as the `return failWith(...)` last
 * expression of a catch arm so the subcommand keeps its single-exit
 * shape.
 */
function failWith(action: string, exc: unknown): number {
  const reason = (exc as Error)?.message ?? String(exc);
  process.stderr.write(`error: failed to ${action}: ${reason}\n`);
  return 1;
}

/**
 * Parse an optional `--<name>` flag whose value should be a finite number.
 * Returns `{ value: number | null, error: string | null }`. The caller is
 * expected to bail with exit 2 + the error string when `error` is set.
 *
 * Trim before testing for emptiness — `Number(" ")` evaluates to `0` in
 * JS, and without this whitespace-only flags would silently bypass the
 * missing-amount guard in `check-payment-policy` and
 * `request-payment-approval`.
 */
function parseOptionalNumberFlag(
  flags: Record<string, string | boolean | string[] | undefined>,
  name: string,
): { value: number | null; error: string | null } {
  const raw = flags[name] as string | undefined;
  if (raw === undefined) return { value: null, error: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `--${name} must be a number, got: ${raw}` };
  }
  return { value: parsed, error: null };
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
  // Accept "true" / "True" / "TRUE" / "1" from both the config file
  // and the env override — matches the parseBool helper inside
  // resolveSearchConfig so the init banner does not lie about state.
  const truthy = (v: unknown): boolean => {
    if (typeof v !== "string") return false;
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1";
  };
  const enabled =
    truthy(data["search_semantic_enabled"]) ||
    truthy(process.env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"]);
  const keyPresent = !!(
    (data["embedding_api_key"] && data["embedding_api_key"] !== "") ||
    process.env["OPEN_SECOND_BRAIN_EMBEDDING_KEY"]
  );
  if (!enabled || keyPresent) return;

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

// ── Pay Memory subcommands ──────────────────────────────────────────────────

async function cmdInitPayMemory(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  const dirs = payMemoryDirs(vault);
  const dirList = [dirs.policies, dirs.payments, dirs.assets, dirs.drafts, dirs.reports];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirList) {
    const existed = existsSync(dir);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (exc) {
      process.stderr.write(
        `error: failed to create ${dir}: ${(exc as Error).message ?? exc}\n`,
      );
      return 1;
    }
    (existed ? skipped : created).push(vaultRelativePath(dir, vault));
  }

  let policy;
  try {
    policy = writePolicyIfMissing(vault, { overwrite: Boolean(flags["overwrite"]) });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write policy: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  const policyRel = vaultRelativePath(policy.path, vault);
  const policyStatus = policy.status;

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          vault_path: vault,
          agent,
          created,
          skipped,
          policy_path: policyRel,
          policy_status: policyStatus,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(`pay-memory layout initialized: ${vault}\n`);
  for (const rel of created) process.stdout.write(`  created: ${rel}\n`);
  for (const rel of skipped) process.stdout.write(`  exists: ${rel}\n`);
  process.stdout.write(`  ${policyStatus}: ${policyRel}\n`);
  process.stdout.write(`agent: ${agent}\n`);
  return 0;
}

async function cmdAppendPaymentReceipt(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    service: { type: "string", required: true },
    status: { type: "string", required: true },
    reason: { type: "string", required: true },
    category: { type: "string" },
    endpoint: { type: "string" },
    "expected-cost": { type: "string" },
    "actual-amount": { type: "string" },
    currency: { type: "string" },
    "payment-proof": { type: "string" },
    "result-ref": { type: "string" },
    "result-note": { type: "string" },
    "raw-output-file": { type: "string" },
    slug: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
    "policy-status": { type: "string" },
    "policy-rule": { type: "string" },
    "policy-reasons": { type: "string-array" },
    "policy-checked-at": { type: "string" },
    "from-request": { type: "string" },
    "payment-layer": { type: "string" },
    network: { type: "string" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const tz = resolveTimezone(config);

  let rawOutput: string | undefined;
  const rawOutputFile = flags["raw-output-file"] as string | undefined;
  if (rawOutputFile) {
    try {
      rawOutput = readFileSync(rawOutputFile, "utf8");
    } catch (exc) {
      process.stderr.write(
        `error: cannot read raw-output-file: ${(exc as Error).message ?? exc}\n`,
      );
      return 1;
    }
  }

  // --policy-status / --from-request audit context. `--from-request`
  // pulls policy + approval state from the named pending-payment-request
  // so the agent doesn't have to repeat it on the command line. Explicit
  // flags win over `--from-request` so a caller can override individual
  // fields.
  let policyStatus = (flags["policy-status"] as string | undefined) ?? null;
  let policyRule = (flags["policy-rule"] as string | undefined) ?? null;
  let policyReasons = (flags["policy-reasons"] as string[] | undefined) ?? null;
  let policyCheckedAt =
    (flags["policy-checked-at"] as string | undefined) ?? null;
  let approvalStatus: string | null = null;
  let approvedBy: string | null = null;
  let approvedAt: string | null = null;
  const fromRequest = (flags["from-request"] as string | undefined) ?? null;
  if (fromRequest) {
    const loaded = loadPendingRequest(vault, fromRequest);
    if (!loaded) {
      process.stderr.write(`error: pending request not found: ${fromRequest}\n`);
      return 1;
    }
    const meta = loaded.metadata;
    const get = (k: string): string | null => {
      const v = meta[k];
      if (v === undefined || v === null) return null;
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    policyStatus ??= get("policy_status");
    policyRule ??= get("policy_rule");
    approvalStatus ??= loaded.status;
    approvedBy ??= get("approved_by");
    approvedAt ??= get("approved_at");
  }
  if (policyStatus !== null) {
    const allowed: ReadonlyArray<ReceiptPolicyStatus> = [
      "allowed",
      "approval_required",
      "denied",
      "not_checked",
    ];
    if (!allowed.includes(policyStatus as ReceiptPolicyStatus)) {
      process.stderr.write(
        `error: --policy-status must be one of: ${allowed.join(", ")}\n`,
      );
      return 2;
    }
  }

  let result;
  try {
    result = writeReceipt(vault, {
      agent,
      service: String(flags["service"]),
      status: String(flags["status"]),
      reason: String(flags["reason"]),
      paymentLayer: (flags["payment-layer"] as string | undefined) ?? null,
      network: (flags["network"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      endpoint: (flags["endpoint"] as string | undefined) ?? null,
      expectedCost: (flags["expected-cost"] as string | undefined) ?? null,
      actualAmount: (flags["actual-amount"] as string | undefined) ?? null,
      currency: (flags["currency"] as string | undefined) ?? null,
      paymentProof: (flags["payment-proof"] as string | undefined) ?? null,
      resultRef: (flags["result-ref"] as string | undefined) ?? null,
      resultNote: (flags["result-note"] as string | undefined) ?? null,
      rawOutput: rawOutput ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      time: (flags["time"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
      tz,
      policyStatus: policyStatus as ReceiptPolicyStatus | null,
      policyRule,
      policyReasons,
      policyCheckedAt,
      approvalRequestId: fromRequest,
      approvalStatus: approvalStatus as
        | "pending"
        | "approved"
        | "rejected"
        | "consumed"
        | null,
      approvedBy,
      approvedAt,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write receipt: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          path: result.relativePath,
          absolute_path: result.path,
          slug: result.slug,
          date: result.date,
          created: result.created,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`receipt: ${result.relativePath}\n`);
    process.stdout.write(`slug: ${result.slug}\n`);
    process.stdout.write(`date: ${result.date}\n`);
  }
  return 0;
}

async function cmdCaptureAsset(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    title: { type: "string", required: true },
    service: { type: "string", required: true },
    "result-url": { type: "string", required: true },
    "source-receipt": { type: "string" },
    "prompt-file": { type: "string" },
    "used-in": { type: "string" },
    slug: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let prompt: string | undefined;
  const promptFile = flags["prompt-file"] as string | undefined;
  if (promptFile) {
    try {
      prompt = readFileSync(promptFile, "utf8");
    } catch (exc) {
      process.stderr.write(
        `error: cannot read prompt-file: ${(exc as Error).message ?? exc}\n`,
      );
      return 1;
    }
  }

  let result;
  try {
    result = writeAsset(vault, {
      title: String(flags["title"]),
      service: String(flags["service"]),
      resultUrl: String(flags["result-url"]),
      sourceReceipt: (flags["source-receipt"] as string | undefined) ?? null,
      prompt: prompt ?? null,
      usedIn: (flags["used-in"] as string | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write asset: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          path: result.relativePath,
          absolute_path: result.path,
          slug: result.slug,
          created: result.created,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`asset: ${result.relativePath}\n`);
    process.stdout.write(`slug: ${result.slug}\n`);
  }
  return 0;
}

async function cmdPaymentDigest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    date: { type: "string" },
    "empty-mode": { type: "string", default: "silent" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const tz = resolveTimezone(config);

  const emptyMode = String(flags["empty-mode"]);
  if (!["silent", "empty", "summary"].includes(emptyMode)) {
    process.stderr.write(`error: --empty-mode must be silent|empty|summary\n`);
    return 2;
  }

  let digest;
  try {
    digest = buildPaymentDigest(vault, {
      date: (flags["date"] as string | undefined) ?? null,
      tz,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to build digest: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          date: digest.date,
          services: digest.services,
          receipts: digest.receipts,
          total_amount: digest.totalAmount,
          currency: digest.currency,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    const text = renderPaymentDigestTelegram(digest, {
      emptyMode: emptyMode as "silent" | "empty" | "summary",
    });
    if (text) process.stdout.write(text + "\n");
  }
  return 0;
}

async function cmdRequestPaymentApproval(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    service: { type: "string", required: true },
    reason: { type: "string", required: true },
    "expected-amount": { type: "string" },
    currency: { type: "string" },
    category: { type: "string" },
    endpoint: { type: "string" },
    "expected-output": { type: "string" },
    "vault-files": { type: "string-array" },
    slug: { type: "string" },
    date: { type: "string" },
    time: { type: "string" },
    "enforce-policy": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent =
    (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const tz = resolveTimezone(config);

  const { value: expectedAmount, error: expectedErr } = parseOptionalNumberFlag(
    flags,
    "expected-amount",
  );
  if (expectedErr) {
    process.stderr.write(`error: ${expectedErr}\n`);
    return 2;
  }

  let result;
  try {
    result = writePendingRequest(vault, {
      agent,
      service: String(flags["service"]),
      reason: String(flags["reason"]),
      expectedAmount,
      currency: (flags["currency"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      endpoint: (flags["endpoint"] as string | undefined) ?? null,
      expectedOutput: (flags["expected-output"] as string | undefined) ?? null,
      vaultFiles: (flags["vault-files"] as string[] | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      time: (flags["time"] as string | undefined) ?? null,
      tz,
      enforcePolicy: Boolean(flags["enforce-policy"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to create pending request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          id: result.id,
          path: result.relativePath,
          status: result.status,
          created: result.created,
          policy_status: result.policyDecision.status,
          policy_rule: result.policyDecision.rule,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`pending: ${result.relativePath}\n`);
    process.stdout.write(`id: ${result.id}\n`);
    process.stdout.write(`policy: ${result.policyDecision.status}\n`);
  }
  return 0;
}

async function cmdApprovePaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    "approved-by": { type: "string", required: true },
    note: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await approvePendingRequest(vault, String(flags["id"]), {
      approvedBy: String(flags["approved-by"]),
      note: (flags["note"] as string | undefined) ?? null,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to approve request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { id: result.id, status: result.status, path: result.relativePath },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`approved: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}

async function cmdRejectPaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    "rejected-by": { type: "string", required: true },
    reason: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await rejectPendingRequest(vault, String(flags["id"]), {
      rejectedBy: String(flags["rejected-by"]),
      reason: (flags["reason"] as string | undefined) ?? null,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to reject request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { id: result.id, status: result.status, path: result.relativePath },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`rejected: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}

async function cmdConsumePaymentRequest(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    id: { type: "string", required: true },
    receipt: { type: "string", required: true },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = await consumePendingRequest(vault, String(flags["id"]), {
      receiptPath: String(flags["receipt"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to consume request: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { id: result.id, status: result.status, path: result.relativePath },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`consumed: ${result.relativePath}\n`);
    process.stdout.write(`status: ${result.status}\n`);
  }
  return 0;
}

async function cmdListPendingPayments(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    status: { type: "string", default: "pending" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const status = String(flags["status"]);
  const valid = ["pending", "approved", "rejected", "consumed", "all"];
  if (!valid.includes(status)) {
    process.stderr.write(
      `error: --status must be one of: ${valid.join(", ")}\n`,
    );
    return 2;
  }

  let summaries;
  try {
    summaries = listPendingRequests(vault, {
      status: status as "pending" | "approved" | "rejected" | "consumed" | "all",
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to list requests: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        summaries.map((s) => ({
          id: s.id,
          path: s.relativePath,
          status: s.status,
          service: s.service,
          reason: s.reason,
          expected_amount: s.expectedAmount,
          currency: s.currency,
          created: s.created,
          policy_status: s.policyStatus,
        })),
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else if (summaries.length === 0) {
    process.stdout.write(`no requests with status: ${status}\n`);
  } else {
    for (const s of summaries) {
      // Use an explicit null check; a truthy check would hide an actual
      // `expected_amount: "0"` (legitimate for free-tier sandbox calls)
      // because `Boolean("0") === true` only happens for *strings* — once
      // any future change starts storing the field as a number, `0`
      // would silently disappear from the list output.
      const cost =
        s.expectedAmount !== null && s.expectedAmount !== ""
          ? ` (${s.expectedAmount}${s.currency ? " " + s.currency : ""})`
          : "";
      process.stdout.write(`${s.status}\t${s.id}\t${s.service}${cost}\t${s.reason}\n`);
    }
  }
  return 0;
}

async function cmdCheckPaymentPolicy(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    service: { type: "string", required: true },
    "expected-amount": { type: "string" },
    currency: { type: "string" },
    category: { type: "string" },
    date: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const tz = resolveTimezone(config);

  const { value: expectedAmount, error: expectedErr } = parseOptionalNumberFlag(
    flags,
    "expected-amount",
  );
  if (expectedErr) {
    process.stderr.write(`error: ${expectedErr}\n`);
    return 2;
  }

  let decision;
  try {
    decision = checkPolicy(vault, {
      service: String(flags["service"]),
      expectedAmount,
      currency: (flags["currency"] as string | undefined) ?? null,
      category: (flags["category"] as string | undefined) ?? null,
      date: (flags["date"] as string | undefined) ?? null,
      tz,
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to evaluate policy: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          status: decision.status,
          allowed: decision.allowed,
          approval_required: decision.approvalRequired,
          rule: decision.rule,
          reasons: decision.reasons,
          has_policy: decision.hasPolicy,
          policy_path:
            decision.policyPath !== null
              ? vaultRelativePath(decision.policyPath, vault)
              : null,
          currency: decision.currency,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`status: ${decision.status}\n`);
    process.stdout.write(`has_policy: ${decision.hasPolicy}\n`);
    if (decision.rule) process.stdout.write(`rule: ${decision.rule}\n`);
    for (const r of decision.reasons) process.stdout.write(`  - ${r}\n`);
  }
  // Exit 0 when allowed; 1 when denied; 3 when approval is required (the
  // shell distinguishes the three so a calling script can branch).
  if (decision.allowed) return 0;
  if (decision.approvalRequired) return 3;
  return 1;
}

async function cmdPaymentReport(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    date: { type: "string", required: true },
    title: { type: "string" },
    task: { type: "string" },
    slug: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = writeReport(vault, {
      date: String(flags["date"]),
      title: (flags["title"] as string | undefined) ?? null,
      task: (flags["task"] as string | undefined) ?? null,
      slug: (flags["slug"] as string | undefined) ?? null,
      overwrite: Boolean(flags["overwrite"]),
    });
  } catch (exc) {
    process.stderr.write(
      `error: failed to write report: ${(exc as Error).message ?? exc}\n`,
    );
    return 1;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          path: result.relativePath,
          absolute_path: result.path,
          slug: result.slug,
          receipts_used: result.receiptsUsed,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`report: ${result.relativePath}\n`);
    process.stdout.write(`receipts: ${result.receiptsUsed}\n`);
  }
  return 0;
}

async function cmdMcp(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    repo: { type: "string" },
    scope: { type: "string" },
  });

  // Validate --scope before doing anything that could fail for other reasons.
  const rawScope = (flags["scope"] as string | undefined) ?? "full";
  if (rawScope !== "full" && rawScope !== "writer") {
    process.stderr.write(
      `o2b mcp: invalid --scope value: ${rawScope}; expected one of: full, writer\n`,
    );
    return 2;
  }
  const scope = rawScope;
  const serverName =
    scope === "writer" ? "open-second-brain-writer" : "open-second-brain";

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const repoRoot = (flags["repo"] as string | undefined) ?? null;

  process.stderr.write(
    `[mcp] ${serverName} ${SERVER_VERSION} listening on stdio (vault=${vault})\n`,
  );
  return await serveStdio({ vault, configPath: config, repoRoot }, {}, { scope, serverName });
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
  // The `brain` subcommand has its own dispatcher with per-verb help, so we
  // skip the generic shortcut and hand control over directly.
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help") && command !== "brain") {
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
