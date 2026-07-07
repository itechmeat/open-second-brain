/**
 * `o2b aider wrap` — session-bracketing memory wrapper for Aider (E1).
 *
 *   o2b aider wrap [--session-id ID] [--aider-bin aider] [-- <aider args...>]
 *
 * Aider has no MCP client, so this wraps the Aider CLI as a process:
 *   1. LOAD-HALF: regenerate the live context sidecar and inject it into
 *      Aider's read context (`--read <sidecar>`).
 *   2. Exec Aider (stdio inherited — a fully interactive session).
 *   3. WRITE-BACK HALF: capture the session transcript (the new tail of
 *      Aider's `.aider.chat.history.md`) and persist it into the Brain via
 *      the deterministic `pre_compact_extract` path — honestly flagged
 *      `interrupted` when Aider exited non-zero / on a signal.
 *
 * The static `o2b install --target aider --apply` sidecar remains the
 * fallback for users who do not run through this wrapper. Both share one
 * snapshot renderer (`renderAiderSidecar`).
 *
 * Exit codes mirror the wrapped Aider process so shell callers see the real
 * result: Aider's own exit code passes through; a usage error is 2.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseFlags } from "./argparse.ts";
import { defaultConfigPath, discoverConfig } from "../core/config.ts";
import { requireVault } from "./helpers.ts";
import { atomicWriteFileSync } from "../core/fs-atomic.ts";
import { buildPayload } from "../core/install/payload.ts";
import type { InstallEnv } from "../core/install/types.ts";
import {
  bracketAiderSession,
  renderAiderSidecar,
  resolveAiderSidecarPath,
  type AiderSpawnResult,
} from "../core/install/adapters/aider-wrapper.ts";
import { extractPreCompactRecords } from "../core/brain/pre-compact-extract.ts";

export async function handleAiderSubcommand(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(AIDER_HELP);
    return verb === undefined ? 2 : 0;
  }
  if (verb !== "wrap") {
    process.stderr.write(`error: unknown aider verb: ${verb}\n`);
    process.stderr.write(AIDER_HELP);
    return 2;
  }
  return await cmdAiderWrap(argv.slice(1));
}

const AIDER_HELP = `usage: o2b aider wrap [options] [-- <aider args...>]

Bracket an interactive Aider session with live memory load + write-back.

Options:
  --session-id ID     Session id recorded on the write-back (default: auto).
  --aider-bin PATH    Aider executable to run (default: aider).
  --chat-history PATH Aider chat history file to capture
                      (default: <cwd>/.aider.chat.history.md).
  --vault PATH        Vault whose Brain/ receives the write-back.
  --config PATH       Config file to resolve vault/agent from.

Everything after -- is forwarded verbatim to Aider.
`;

async function cmdAiderWrap(argv: string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    "session-id": { type: "string" },
    "aider-bin": { type: "string", default: "aider" },
    "chat-history": { type: "string" },
    vault: { type: "string" },
    config: { type: "string" },
  });

  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, configPath);
  const env = buildEnv(vault, configPath);
  const payload = buildPayload({
    vault,
    agent_name: env.env["VAULT_AGENT_NAME"] ?? null,
    timezone: env.env["VAULT_TIMEZONE"] ?? null,
  });

  const sidecarPath = resolveAiderSidecarPath(env, {});
  const aiderBin = flags["aider-bin"] as string;
  const chatHistoryPath = resolve(
    (flags["chat-history"] as string | undefined) ?? join(env.cwd, ".aider.chat.history.md"),
  );
  const sessionId = (flags["session-id"] as string | undefined) ?? `aider-${env.now.toISOString()}`;
  const aiderArgs = positional;

  // Capture the transcript by delta: record the chat-history size at load
  // time, then read only what Aider appended during the session.
  let historyOffsetAtStart = 0;

  const result = await bracketAiderSession(
    { sessionId, host: "aider" },
    {
      loadContext: () => {
        ensureParent(sidecarPath);
        atomicWriteFileSync(sidecarPath, renderAiderSidecar(env, payload));
        historyOffsetAtStart = fileSize(chatHistoryPath);
        return sidecarPath;
      },
      spawnAider: (sidecar) => Promise.resolve(runAider(aiderBin, sidecar, aiderArgs, env.cwd)),
      captureTranscript: () => readTail(chatHistoryPath, historyOffsetAtStart),
      persist: (input) => extractPreCompactRecords(vault, input),
    },
  );

  reportOutcome(result.exit, result.interrupted, result.persisted?.records.length ?? 0);

  // Pass Aider's own exit code through so shell callers see the real result.
  if (result.exit.signal !== null) return 1;
  return result.exit.code ?? 1;
}

function buildEnv(vault: string, configPath: string): InstallEnv {
  const cfg = discoverConfig(configPath).data;
  const merged = { ...process.env } as Record<string, string>;
  if (cfg["agent_name"]) merged["VAULT_AGENT_NAME"] = cfg["agent_name"];
  if (cfg["timezone"]) merged["VAULT_TIMEZONE"] = cfg["timezone"];
  return { vault, home: homedir(), cwd: process.cwd(), env: merged, now: new Date() };
}

function runAider(bin: string, sidecar: string, args: string[], cwd: string): AiderSpawnResult {
  const proc = spawnSync(bin, ["--read", sidecar, ...args], {
    cwd,
    stdio: "inherit",
  });
  if (proc.error) {
    // Missing binary / spawn failure — honest non-zero, not a silent success.
    process.stderr.write(`error: failed to launch aider (${bin}): ${proc.error.message}\n`);
    return { code: 127, signal: null };
  }
  return { code: proc.status, signal: proc.signal };
}

function reportOutcome(exit: AiderSpawnResult, interrupted: boolean, recordCount: number): void {
  const how = interrupted
    ? exit.signal !== null
      ? `interrupted by ${exit.signal}`
      : `interrupted (exit ${exit.code})`
    : "exited cleanly";
  process.stderr.write(`[aider-wrap] session ${how}; captured ${recordCount} memory record(s)\n`);
}

function ensureParent(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Read the bytes appended to `path` since `fromByte` (the session delta). */
function readTail(path: string, fromByte: number): string {
  if (!existsSync(path)) return "";
  // Slice by BYTES (statSync.size is bytes), so multi-byte UTF-8 offsets stay
  // correct. If the file shrank (rotated/truncated mid-session), capture the
  // whole current content rather than a bogus negative slice.
  const buf = readFileSync(path);
  const start = buf.length >= fromByte ? fromByte : 0;
  return buf.subarray(start).toString("utf8");
}
