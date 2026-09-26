#!/usr/bin/env -S bun
/**
 * Runtime lifecycle hook: capture prompt/tool/session observations into
 * Brain without writing hook output back to the runtime. Failures are
 * intentionally silent so a hook problem never blocks the agent.
 *
 * Two modes:
 *
 *   - HOOK (default): reads the host payload from stdin. An event whose
 *     capture may need the signal dedup index (see
 *     `lifecycleEventNeedsDedup`) is handed to a detached worker and the
 *     hook returns at once; every other event is captured inline. The
 *     dedup walk reads every `sig-*.md` and on a slow mount (WSL 9p) takes
 *     longer than the host's 10 s timeout - synchronously, so the
 *     in-process ceiling below could never cut it short.
 *   - WORKER (`--deferred <spool>`): reads the spooled payload, deletes the
 *     spool, and captures with no host deadline. Workers for one vault run
 *     one at a time, so two deferred events cannot both miss each other's
 *     signal in the dedup index.
 *
 * `OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER=0` disables the hand-off and
 * captures every event inline (the pre-1.58.1 behaviour).
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentName, resolveVault } from "../src/core/config.ts";
import {
  captureSessionLifecycleEvent,
  lifecycleEventNeedsDedup,
} from "../src/core/brain/session-lifecycle.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { normalizeHookPayload, readHookInput } from "./lib/stdin.ts";

const DEFERRED_FLAG = "--deferred";
/** A deferred worker has no host deadline, but it must still end. */
const WORKER_CEILING_MS = 10 * 60_000;
/** How long a worker waits for its vault's previous worker. */
const WORKER_LOCK_WAIT_MS = 5 * 60_000;
/** A lock older than this belongs to a worker that died; it is taken over. */
const WORKER_LOCK_STALE_MS = WORKER_CEILING_MS + 60_000;

function audit(vault: string | null, action: string, details: Record<string, unknown>): void {
  if (vault === null) return;
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: "session-capture",
      action,
      target: "session-capture",
      ok: action !== "hook_ceiling_exceeded",
      details: { hook: "session-capture", ...details },
    });
  } catch {
    // best-effort
  }
}

function deferEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER"]?.trim() !== "0";
}

/**
 * Spool the payload and start a detached worker on it. Returns false when
 * the hand-off could not be made, so the caller captures inline instead of
 * dropping the event.
 */
function handOff(payload: unknown): boolean {
  let spool: string | undefined;
  try {
    spool = join(tmpdir(), `o2b-capture-${process.pid}-${randomBytes(6).toString("hex")}.json`);
    writeFileSync(spool, JSON.stringify(payload), { mode: 0o600 });
    const child = spawn(process.execPath, ["run", import.meta.path, DEFERRED_FLAG, spool], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    if (spool !== undefined) {
      try {
        unlinkSync(spool);
      } catch {
        // nothing to clean
      }
    }
    return false;
  }
}

function lockPath(vault: string): string {
  const key = createHash("sha256").update(vault).digest("hex").slice(0, 16);
  return join(tmpdir(), `o2b-capture-${key}.lock`);
}

/** Take the per-vault worker lock; returns its release, or null on timeout. */
async function acquireWorkerLock(vault: string): Promise<(() => void) | null> {
  const path = lockPath(vault);
  const deadline = Date.now() + WORKER_LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > WORKER_LOCK_STALE_MS) unlinkSync(path);
      } catch {
        // raced with the holder's release; retry
      }
    }
    if (Date.now() >= deadline) return null;
    // oxlint-disable-next-line no-await-in-loop -- polling a lock, sequential by design
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function capture(vault: string, payload: unknown): Promise<void> {
  // Normalize grok's camelCase payload to the internal snake_case shape so the
  // lifecycle capture reads the same fields it does for Claude Code and Codex.
  await captureSessionLifecycleEvent(vault, normalizeHookPayload(payload), {
    agent: resolveAgentName(),
  });
}

async function runWorker(spool: string): Promise<void> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(readFileSync(spool, "utf8"));
  } catch {
    payload = null;
  } finally {
    try {
      unlinkSync(spool);
    } catch {
      // already consumed
    }
  }
  const vault = resolveVault();
  if (vault === null || payload === null) return;
  const disarm = armProcessCeiling({
    ceilingMs: WORKER_CEILING_MS,
    onExpire: () => audit(vault, "hook_ceiling_exceeded", { mode: "deferred" }),
  });
  const release = await acquireWorkerLock(vault);
  try {
    await capture(vault, payload);
  } finally {
    release?.();
    disarm();
  }
}

async function runHook(): Promise<void> {
  // Arm the process self-watchdog so a hung capture (stalled read, slow
  // continuity append) self-terminates at the ceiling instead of orphaning
  // the hook process or blocking the host agent.
  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => audit(auditVault, "hook_ceiling_exceeded", {}),
  });
  try {
    const vault = resolveVault();
    if (vault === null) return;
    auditVault = vault;
    let payload: unknown;
    try {
      payload = await readHookInput();
    } catch {
      payload = null;
    }
    const normalized = normalizeHookPayload(payload);
    if (deferEnabled() && lifecycleEventNeedsDedup(normalized) && handOff(normalized)) return;
    await capture(vault, normalized);
  } finally {
    disarm();
  }
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf(DEFERRED_FLAG);
  const spool = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (spool !== undefined) await runWorker(spool);
  else await runHook();
}

main().catch(() => {
  // Never block the runtime on lifecycle capture failures.
});
