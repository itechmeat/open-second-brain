/**
 * `o2b bootstrap` (write-side-trust, Task 14).
 *
 *   o2b bootstrap --target codex --agent codex --token   # provision + mint
 *   o2b bootstrap --target codex --rotate                # re-mint, reprint once
 *   o2b bootstrap --target codex --check                 # drift from InstallEnv alone
 *   o2b bootstrap --target generic --token               # print-and-paste
 *   o2b bootstrap --target claude-code --token           # plugin verify-only
 *
 * One idempotent command per harness: it runs the target adapter's
 * existing apply (which is itself idempotent), mints the per-agent MCP
 * token named `mcp_token_<target>`, and records a receipt at
 * `<vault>/.open-second-brain/bootstrap.lock.json`. The material is
 * printed to stdout EXACTLY ONCE with a shown-once notice - never on
 * argv, never in any harness config, never in the receipt. The payload
 * env block stays credential-free: the token reaches the agent through
 * its environment or a `$secret:` reference.
 *
 * Idempotency contract: a second identical run is a byte-identical
 * no-op. When the token already exists and the adapter verifies clean,
 * bootstrap writes nothing at all - not the config, not the install
 * manifest, not the receipt - and says so.
 *
 * Exit codes ({@link BOOTSTRAP_EXIT}), the `INSTALL_EXIT` table style:
 *   0  success / no drift
 *   1  I/O, store, or adapter runtime error
 *   2  usage error (unknown target, bad flag combination, no vault)
 *   3  --check found drift (including never-provisioned)
 *   4  user-modified-block conflict on apply (use --force to override)
 *   5  --check found the runtime unreachable
 */

import { defaultConfigPath, discoverConfig, resolveVault } from "../../core/config.ts";
import "../../core/install/adapters/all.ts";
import { buildInstallEnv, VAULT_NOT_CONFIGURED_REASON } from "../../core/install/env.ts";
import { buildPayload, PayloadError } from "../../core/install/payload.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
import { InstallError } from "../../core/install/types.ts";
import type { ApplyOpts, ManifestEntry } from "../../core/install/types.ts";
import {
  listAgentTokens,
  mintAgentToken,
  rotateAgentToken,
} from "../../core/brain/secrets/token-store.ts";
import { McpTokenStoreError } from "../../core/brain/secrets/token-store.ts";
import { parseFlags } from "../argparse.ts";
import { SHOWN_ONCE_NOTICE } from "./token-cli.ts";
import {
  receiptEntryEqualsExcludingTimestamp,
  receiptTokenMatches,
  BootstrapReceiptError,
  bootstrapReceiptPath,
  readBootstrapReceipt,
  upsertBootstrapReceiptEntry,
  type BootstrapReceiptEntry,
} from "./receipt.ts";
import {
  BOOTSTRAP_TARGET_LIST,
  resolveBootstrapTarget,
  tokenNameForTarget,
  type BootstrapMode,
  type BootstrapTarget,
} from "./targets.ts";

/**
 * Every code this verb can return, named once so the docblock above, the
 * returns below and the tests all read the same table.
 */
export const BOOTSTRAP_EXIT = Object.freeze({
  ok: 0,
  runtimeError: 1,
  usage: 2,
  drift: 3,
  userModifiedBlock: 4,
  mcpUnreachable: 5,
} as const);

class BootstrapUsageError extends Error {}

interface ParsedBootstrapArgs {
  readonly target: string | null;
  readonly agent: string | null;
  readonly token: boolean;
  readonly rotate: boolean;
  readonly check: boolean;
  readonly force: boolean;
  readonly vault: string | null;
  readonly config: string;
}

function parseBootstrapArgs(argv: string[]): ParsedBootstrapArgs {
  const { flags, positional } = parseFlags(argv, {
    target: { type: "string" },
    agent: { type: "string" },
    token: { type: "boolean" },
    rotate: { type: "boolean" },
    check: { type: "boolean" },
    force: { type: "boolean" },
    vault: { type: "string" },
    config: { type: "string" },
  });
  if (positional.length > 0) {
    throw new BootstrapUsageError(
      `o2b bootstrap does not accept positional arguments: ${positional.join(" ")}`,
    );
  }
  return {
    target: (flags["target"] as string | undefined) ?? null,
    agent: (flags["agent"] as string | undefined) ?? null,
    token: Boolean(flags["token"]),
    rotate: Boolean(flags["rotate"]),
    check: Boolean(flags["check"]),
    force: Boolean(flags["force"]),
    vault: (flags["vault"] as string | undefined) ?? null,
    config: (flags["config"] as string | undefined) ?? defaultConfigPath(),
  };
}

function usageRefusal(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return BOOTSTRAP_EXIT.usage;
}

/** A minimal sink adapters write their apply output into, so this verb
 * composes the final stdout block in one deterministic order. */
function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  let buffer = "";
  const sink = {
    write(chunk: unknown): boolean {
      buffer +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      return true;
    },
  };
  return { stream: sink as unknown as NodeJS.WritableStream, text: () => buffer };
}

/** The vault this run provisions for, through the one chain the CLI uses. */
function resolveBootstrapVault(explicit: string | null, configPath: string): string {
  return explicit ?? resolveVault(configPath) ?? "";
}

/** The payload exactly as `o2b install` builds it: config, then env. */
function buildBootstrapPayload(vault: string, configPath: string) {
  const cfg = discoverConfig(configPath).data;
  return buildPayload({
    vault,
    agent_name: cfg["agent_name"] ?? process.env["VAULT_AGENT_NAME"] ?? null,
    timezone: cfg["timezone"] ?? process.env["VAULT_TIMEZONE"] ?? null,
  });
}

export async function cmdBootstrap(argv: string[]): Promise<number> {
  let args: ParsedBootstrapArgs;
  try {
    args = parseBootstrapArgs(argv);
  } catch (e) {
    if (e instanceof BootstrapUsageError) return usageRefusal(e.message);
    throw e;
  }

  const resolved: BootstrapTarget | null =
    args.target === null ? null : resolveBootstrapTarget(args.target);
  if (args.target === null) {
    return usageRefusal(
      `o2b bootstrap requires --target <name>. Available: ${BOOTSTRAP_TARGET_LIST}`,
    );
  }
  if (resolved === null) {
    return usageRefusal(
      `unknown bootstrap target: ${args.target}. Available: ${BOOTSTRAP_TARGET_LIST}`,
    );
  }
  if (args.check && (args.token || args.rotate)) {
    return usageRefusal("--check verifies only; drop --token/--rotate, or drop --check");
  }

  const vault = resolveBootstrapVault(args.vault, args.config);
  if (vault === "") {
    return usageRefusal(`o2b bootstrap: ${VAULT_NOT_CONFIGURED_REASON}`);
  }

  const target = resolved.target;
  const mode = resolved.mode;
  const agent = args.agent ?? target;
  const name = tokenNameForTarget(target);
  const now = new Date().toISOString();

  // The record bootstrap is about to mint, rotate, or keep. A live name
  // bound to a DIFFERENT agent refuses: bootstrap would silently rewrite
  // a credential's identity underneath a running agent.
  const existing = listAgentTokens(vault).find((t) => t.name === name) ?? null;
  if (existing !== null && existing.agent !== agent) {
    process.stderr.write(
      `error: token ${name} already belongs to agent ${JSON.stringify(existing.agent)}, ` +
        `not ${JSON.stringify(agent)}; mint a separate name with \`o2b mcp token mint\`\n`,
    );
    return BOOTSTRAP_EXIT.runtimeError;
  }

  // Both paths read the receipt, so both owe the operator the same clean
  // refusal when it is unreadable - a corrupt bootstrap.lock.json is a
  // named error, never a raw stack.
  try {
    if (args.check)
      return runCheck({
        target,
        mode,
        vault,
        name,
        env: buildInstallEnv({ vault, configPath: args.config }),
      });
    return runProvision({ args, target, mode, agent, name, vault, existing, now });
  } catch (e) {
    if (e instanceof BootstrapReceiptError) {
      process.stderr.write(`error: ${e.message}\n`);
      return BOOTSTRAP_EXIT.runtimeError;
    }
    throw e;
  }
}

interface CheckInput {
  readonly target: string;
  readonly mode: BootstrapMode;
  readonly vault: string;
  readonly name: string;
  readonly env: ReturnType<typeof buildInstallEnv>;
}

/**
 * `--check`: drift from `InstallEnv` alone. Never mints, never writes -
 * the adapter verifies against what is on disk, and the token half is
 * answered from the store and the receipt. `not-installed` is drift
 * here (unlike the install verb's table, where it stays 0): the
 * operator NAMED this target, so an absent bootstrap is the finding.
 */
function runCheck(input: CheckInput): number {
  const { target, mode, vault, name, env } = input;
  const lines: string[] = [];
  // The two halves rank at the return: an unreachable runtime means the
  // registration half never ran at all, so it keeps exit 5 ("could not
  // check") even where the token half drifted - exit 3 is reserved for
  // "checked, and it disagreed".
  let drifted = false;
  let unreachable = false;

  if (mode === "adapter") {
    const adapter = defaultRegistry.get(target);
    if (adapter === undefined) {
      // Unreachable while BOOTSTRAP_TARGETS and the registry agree; a
      // refusal beats a crash if a future edit desynchronizes them.
      return usageRefusal(
        `bootstrap target ${target} has no install adapter. Available: ${BOOTSTRAP_TARGET_LIST}`,
      );
    }
    const result = adapter.verify(env);
    lines.push(`  registration: ${result.status} - ${result.details[0] ?? ""}`);
    if (result.fix_hint !== null) lines.push(`  fix: ${result.fix_hint}`);
    if (result.status === "drift" || result.status === "not-installed") drifted = true;
    else if (result.status === "mcp-unreachable") unreachable = true;
  } else if (mode === "print") {
    lines.push("  registration: print-and-paste; nothing on disk to verify");
  } else {
    lines.push("  registration: plugin-managed; verify with `o2b doctor`");
  }

  const record = listAgentTokens(vault).find((t) => t.name === name) ?? null;
  if (record === null || record.status !== "active") {
    lines.push(`  token: ${name} is not active; run o2b bootstrap --target ${target} --token`);
    drifted = true;
  } else {
    lines.push(`  token: ${name} active (prefix ${record.token_prefix})`);
  }

  const entry = readBootstrapReceipt(vault).entries[target];
  if (entry === undefined) {
    lines.push(`  receipt: no bootstrap receipt; run o2b bootstrap --target ${target} --token`);
    drifted = true;
  } else if (!receiptTokenMatches(entry, record ?? undefined)) {
    lines.push(
      `  receipt: the receipt disagrees with the token store; run o2b bootstrap --target ${target} --token`,
    );
    drifted = true;
  } else {
    lines.push("  receipt: ok");
  }

  process.stdout.write(`bootstrap check: ${target}\n${lines.join("\n")}\n`);
  if (unreachable) return BOOTSTRAP_EXIT.mcpUnreachable;
  if (drifted) return BOOTSTRAP_EXIT.drift;
  return BOOTSTRAP_EXIT.ok;
}

interface ProvisionInput {
  readonly args: ParsedBootstrapArgs;
  readonly target: string;
  readonly mode: BootstrapMode;
  readonly agent: string;
  readonly name: string;
  readonly vault: string;
  readonly existing: { name: string; agent: string; status: string; token_prefix: string } | null;
  readonly now: string;
}

function runProvision(input: ProvisionInput): number {
  const { args, target, mode, agent, name, vault, existing, now } = input;

  // ----- token plan -----------------------------------------------------
  let tokenMaterial: string | null = null;
  let tokenEvent: "minted" | "rotated" | null = null;
  try {
    if (args.rotate) {
      if (existing === null) {
        process.stderr.write(
          `error: no token ${name} to rotate; run o2b bootstrap --target ${target} --token to mint it\n`,
        );
        return BOOTSTRAP_EXIT.runtimeError;
      }
      tokenMaterial = rotateAgentToken(vault, name).tokenMaterial;
      tokenEvent = "rotated";
    } else if (args.token && existing === null) {
      tokenMaterial = mintAgentToken(vault, name, agent).tokenMaterial;
      tokenEvent = "minted";
    } else if (existing !== null && existing.status === "revoked") {
      // Revoked is refused for EVERY provision form, not just --token: the
      // store refuses to rotate a revoked name, so bootstrap cannot re-mint
      // it, and falling through would let the no-churn gate below report a
      // healthy "already provisioned" for a credential that no longer
      // authenticates - the exact state `--check` calls drift.
      process.stderr.write(
        `error: token ${name} is revoked; mint a new name with \`o2b mcp token mint\` instead\n`,
      );
      return BOOTSTRAP_EXIT.runtimeError;
    }
  } catch (e) {
    if (e instanceof McpTokenStoreError) {
      process.stderr.write(`error: ${e.message}\n`);
      return BOOTSTRAP_EXIT.runtimeError;
    }
    throw e;
  }

  // ----- registration ---------------------------------------------------
  let manifest: ManifestEntry | null = null;
  let printedPayload = "";
  if (mode !== "verify-only") {
    const adapter = defaultRegistry.get(target);
    if (adapter === undefined) {
      return usageRefusal(
        `bootstrap target ${target} has no install adapter. Available: ${BOOTSTRAP_TARGET_LIST}`,
      );
    }
    const env = buildInstallEnv({ vault, configPath: args.config });

    // Byte-identical no-op: with no token event of its own, a clean
    // adapter verify and a consistent receipt mean there is nothing to
    // write - not the config, not the install manifest, not the receipt.
    if (tokenEvent === null) {
      const verdict = adapter.verify(env);
      const entry = readBootstrapReceipt(vault).entries[target];
      const record = listAgentTokens(vault).find((t) => t.name === name) ?? undefined;
      if (verdict.status === "ok" && receiptTokenMatches(entry, record)) {
        process.stdout.write(
          `bootstrap: ${target} already provisioned; nothing changed\n` +
            `  run with --token to mint ${name}, with --rotate to re-mint it, or with --check to verify\n`,
        );
        return BOOTSTRAP_EXIT.ok;
      }
    }

    let payload;
    try {
      payload = buildBootstrapPayload(vault, args.config);
    } catch (e) {
      if (e instanceof PayloadError) return usageRefusal(e.message);
      throw e;
    }
    const capture = captureStream();
    const opts: ApplyOpts = {
      dryRun: false,
      force: args.force,
      stdout: capture.stream,
      stderr: process.stderr,
    };
    let result;
    try {
      result = adapter.apply(adapter.plan(payload, env), payload, env, opts);
    } catch (e) {
      if (e instanceof InstallError) {
        process.stderr.write(`error: ${e.message}\n`);
        if (e.hint !== undefined) process.stderr.write(`hint: ${e.hint}\n`);
        return e.kind === "user-modified-block"
          ? BOOTSTRAP_EXIT.userModifiedBlock
          : BOOTSTRAP_EXIT.runtimeError;
      }
      throw e;
    }
    manifest = result.manifest;
    printedPayload = capture.text();
  }

  // ----- receipt (no-churn: skip when nothing would change) --------------
  const refreshed =
    listAgentTokens(vault).find((t) => t.name === name) ??
    (existing !== null && existing.status === "active" ? existing : null);
  const receiptPath = bootstrapReceiptPath(vault);
  if (mode !== "verify-only" || refreshed !== null) {
    const current = readBootstrapReceipt(vault).entries[target];
    const next = composeEntry({ target, mode, agent, name, manifest, current, refreshed, now });
    if (current === undefined || !receiptEntryEqualsExcludingTimestamp(current, next)) {
      upsertBootstrapReceiptEntry(vault, next);
    }
  }

  // ----- output ---------------------------------------------------------
  const header = `bootstrap: ${target} (${mode === "print" ? "print-and-paste" : mode === "verify-only" ? "plugin runtime; verify only" : "adapter"})`;
  const out: string[] = [header];
  if (mode === "adapter" && manifest !== null) {
    const owned = [...(manifest.owned_keys ?? []), ...(manifest.owned_paths ?? [])];
    out.push(
      `  registration: ${manifest.config_path ?? "(no config file)"}` +
        (owned.length > 0 ? ` (owned: ${owned.join(", ")})` : ""),
    );
  }
  if (mode === "print") {
    if (printedPayload.length > 0) out.push(printedPayload.trimEnd());
    out.push(
      "manual steps: copy the payload above into your runtime's MCP configuration; " +
        "give the agent the token through its environment, never a config file.",
    );
  }
  if (mode === "verify-only") {
    out.push(
      "  The plugin registers this server itself; nothing was written to any harness " +
        "config. Verify with `o2b doctor`.",
    );
  }
  if (tokenMaterial !== null) {
    out.push(
      `  token: ${name} (agent ${JSON.stringify(agent)}) ${tokenEvent} - ` +
        "shown exactly once, stored only as a hash",
    );
    out.push(`  ${tokenMaterial}`);
    out.push(`  ${SHOWN_ONCE_NOTICE}`);
  }
  if (mode !== "verify-only" || refreshed !== null) {
    out.push(`  receipt: ${receiptPath}`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return BOOTSTRAP_EXIT.ok;
}

/** The receipt entry this run leaves behind, reused fields preserved. */
function composeEntry(input: {
  readonly target: string;
  readonly mode: BootstrapMode;
  readonly agent: string;
  readonly name: string;
  readonly manifest: ManifestEntry | null;
  readonly current: BootstrapReceiptEntry | undefined;
  readonly refreshed: { name: string; token_prefix: string } | null;
  readonly now: string;
}): BootstrapReceiptEntry {
  const { target, mode, agent, name, manifest, current, refreshed, now } = input;
  const token =
    refreshed !== null
      ? { name, prefix: refreshed.token_prefix }
      : current?.token !== undefined
        ? current.token
        : undefined;
  return {
    target,
    mode,
    agent,
    config_path: manifest?.config_path ?? current?.config_path ?? null,
    ...(manifest?.owned_keys !== undefined || current?.owned_keys !== undefined
      ? { owned_keys: manifest?.owned_keys ?? current?.owned_keys }
      : {}),
    ...(manifest?.owned_paths !== undefined || current?.owned_paths !== undefined
      ? { owned_paths: manifest?.owned_paths ?? current?.owned_paths }
      : {}),
    ...(manifest?.owned_block_marker !== undefined || current?.owned_block_marker !== undefined
      ? { owned_block_marker: manifest?.owned_block_marker ?? current?.owned_block_marker }
      : {}),
    ...(token !== undefined ? { token } : {}),
    applied_at: now,
  };
}
