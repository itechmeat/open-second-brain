/**
 * Aider session-bracketing memory wrapper (E1).
 *
 * Aider has no native MCP client, so the static adapter (`aider.ts`) can only
 * inject a one-time context sidecar at install time and captures nothing back.
 * This module adds the live lifecycle Hindsight's Aider integration solved with
 * a wrapper process: it BRACKETS an interactive Aider session —
 *
 *   1. LOAD-HALF (mirrors Hermes `provider.py` `prefetch()`): regenerate the
 *      context sidecar fresh at session start and inject it into Aider's read
 *      context — live load, not a stale install-time snapshot.
 *   2. Exec the Aider binary bracketed between load and persist.
 *   3. WRITE-BACK HALF (mirrors `sync_turn()` / `on_session_end()`): capture the
 *      session transcript at session end and persist it into the Brain via the
 *      deterministic `pre_compact_extract` path — closing the write-back half
 *      the static adapter omits for Aider entirely.
 *
 * The static sidecar (`aider.ts`) stays the documented fallback for users who
 * do not run through the wrapper. Both share ONE snapshot renderer
 * (`renderAiderSidecar`) so their sidecar bytes never drift (DRY).
 *
 * The orchestrator (`bracketAiderSession`) takes injected deps so the
 * lifecycle is unit-testable without a real Aider binary; the CLI
 * (`src/cli/aider.ts`) supplies the real spawn/capture/persist wiring.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PreCompactExtractInput,
  PreCompactExtractResult,
} from "../../brain/pre-compact-extract.ts";
import type { InstallEnv, McpPayload } from "../types.ts";

// ── Shared snapshot logic (single source of truth for the sidecar) ───────────

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** Path to the Aider context sidecar template. */
export function aiderTemplatePath(): string {
  return join(repoRoot(), "templates", "install", "aider-context.md.tmpl");
}

/** Resolve the agent identity stamped into the sidecar. */
export function resolveAiderAgentName(env: InstallEnv, payload: McpPayload): string {
  return payload.full.env?.["VAULT_AGENT_NAME"] ?? env.env["VAULT_AGENT_NAME"] ?? "agent";
}

/**
 * Render the Aider context sidecar from the shipped template. This is the ONE
 * place the sidecar bytes are produced — the static adapter and the live
 * wrapper both call it, so their output can never drift.
 */
export function renderAiderSidecar(env: InstallEnv, payload: McpPayload): string {
  const tpl = readFileSync(aiderTemplatePath(), "utf8");
  return tpl
    .replace(/\{\{VAULT\}\}/g, env.vault)
    .replace(/\{\{AGENT_NAME\}\}/g, resolveAiderAgentName(env, payload));
}

/** Default sidecar location inside the vault's machine-artifact dir. */
export function resolveAiderSidecarPath(
  env: InstallEnv,
  opts: { aiderContextPath?: string },
): string {
  if (opts.aiderContextPath) return opts.aiderContextPath;
  return join(env.vault, ".open-second-brain", "aider-context.md");
}

// ── Session-bracketing lifecycle ─────────────────────────────────────────────

export interface AiderSpawnResult {
  /** Process exit code, or null if the process was killed by a signal. */
  readonly code: number | null;
  /** Signal that killed the process, or null on a normal exit. */
  readonly signal: string | null;
}

/** Which lifecycle phases actually ran (for observability + tests). */
export type BracketPhase = "load" | "spawn" | "persist";

export interface BracketAiderDeps {
  /**
   * LOAD-HALF: regenerate + inject the live context sidecar and return its
   * path. Mirrors `prefetch()`. Runs before Aider is spawned.
   */
  readonly loadContext: () => string;
  /**
   * Spawn the Aider binary with the injected read-context and resolve on exit.
   * Mirrors execing the wrapped CLI.
   */
  readonly spawnAider: (sidecarPath: string) => Promise<AiderSpawnResult>;
  /**
   * WRITE-BACK: capture the session transcript produced during the run.
   * Mirrors the `sync_turn()` buffer drained at session end.
   */
  readonly captureTranscript: () => string;
  /**
   * Persist the captured transcript into the Brain. Mirrors
   * `on_session_end()` → `brain_pre_compact_extract`.
   */
  readonly persist: (input: PreCompactExtractInput) => PreCompactExtractResult;
}

export interface BracketAiderConfig {
  readonly sessionId: string;
  readonly turnStart?: string;
  readonly turnEnd?: string;
  readonly host?: string;
}

export interface BracketAiderResult {
  readonly sidecarPath: string;
  readonly exit: AiderSpawnResult;
  readonly interrupted: boolean;
  /** Null when the session produced no capturable transcript. */
  readonly persisted: PreCompactExtractResult | null;
  readonly phases: ReadonlyArray<BracketPhase>;
}

/**
 * An Aider exit is "interrupted" when it did not exit cleanly: killed by a
 * signal (SIGTERM/SIGINT/force-quit), or a non-zero exit code, or an unknown
 * exit (both null). Mirrors the honest `interrupted` flag the Hermes
 * `on_session_end` hook forwards on a non-clean close.
 */
export function isInterruptedExit(exit: AiderSpawnResult): boolean {
  if (exit.signal !== null) return true;
  return exit.code !== 0;
}

/**
 * Bracket one interactive Aider session: load context, run Aider, persist the
 * session back. The write-back fires even on an interrupted close so no session
 * is lost — the record is just honestly flagged `interrupted`.
 */
export async function bracketAiderSession(
  config: BracketAiderConfig,
  deps: BracketAiderDeps,
): Promise<BracketAiderResult> {
  const phases: BracketPhase[] = [];

  // 1. LOAD-HALF — regenerate + inject the live context before Aider starts.
  const sidecarPath = deps.loadContext();
  phases.push("load");

  // 2. Run Aider, bracketed between the load and the write-back.
  const exit = await deps.spawnAider(sidecarPath);
  phases.push("spawn");
  const interrupted = isInterruptedExit(exit);

  // 3. WRITE-BACK HALF — capture + persist the session. Skip only when the
  // session produced nothing capturable (mirrors the empty-buffer early return
  // in Hermes `_flush_buffer`), so an empty run writes no spurious records.
  const transcript = deps.captureTranscript();
  let persisted: PreCompactExtractResult | null = null;
  if (transcript.trim().length > 0) {
    const input: PreCompactExtractInput = {
      sessionId: config.sessionId,
      turnStart: config.turnStart ?? "0",
      turnEnd: config.turnEnd ?? "0",
      text: transcript,
      ...(config.host !== undefined ? { host: config.host } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    };
    persisted = deps.persist(input);
    phases.push("persist");
  }

  return Object.freeze({
    sidecarPath,
    exit,
    interrupted,
    persisted,
    phases: Object.freeze(phases),
  });
}
