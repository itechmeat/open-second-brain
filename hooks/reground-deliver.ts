#!/usr/bin/env -S bun
/**
 * PostToolUse / UserPromptSubmit hook: hands out the queued parts of an
 * oversized SessionStart payload (recall-injection-lifecycle, t_55ee804e).
 *
 * The host persists an `additionalContext` past roughly 10,000 UTF-16
 * units to a file and shows only a preview, so with
 * `reground_parts_enabled` on (default OFF) active-inject emits part 1 of
 * a payload that large and queues parts 2..n in the session ledger. This
 * carrier delivers exactly one queued part per event, until the queue is
 * empty or a new SessionStart replaces it.
 *
 * Contract:
 *   stdin: hook payload JSON with `hook_event_name` and `session_id`.
 *   stdout: nothing, or
 *     { "hookSpecificOutput": { "hookEventName": "<event>", "additionalContext": "<part>" } }
 *
 * Emits nothing for a tool call made inside a sub-agent (the payload
 * carries a non-empty `agent_id`), so the part stays queued for the main
 * agent's next event.
 *
 * Emits only for an exact `PostToolUse` or `UserPromptSubmit`, the two
 * events registered for it: emitting under an event whose schema does not
 * accept `additionalContext` echoes the payload into a validation error.
 * A user prompt carries a part rather than cancelling the queue - after a
 * manual `/compact` the very next event is a prompt, and cancelling there
 * would drop parts 2..n almost every time.
 *
 * Cheap when off: the flag is checked before the vault is resolved or any
 * state is read, because this runs after every tool call on every install,
 * and the ledger, lock and audit modules are imported only after it, so a
 * default-off run never loads them.
 * The take is try-once under the scope lock: on contention the event
 * passes silently and the next one delivers. The cursor advances before
 * the part is printed, so a crash in between loses that part and never
 * duplicates it.
 *
 * Quiet on failures: exit 0 with no output on any error. A take that
 * fails for a reason other than contention leaves a
 * `reground_take_failed` audit line, once per queue epoch: a state write
 * that keeps failing leaves the queue undrained, so every later tool call
 * fails the same way, and one line plus an fsync per call is noise. The
 * epoch already audited is remembered in a per-machine marker under the OS
 * temp directory, because the failing `hook-state/` tree cannot hold it.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRegroundPartsEnabled, resolveVault } from "../src/core/config.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";

const HOOK_NAME = "reground-deliver";

/** The events this hook is registered on; any other emits nothing. */
const CARRIER_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "UserPromptSubmit"]);

const UTF8 = new TextEncoder();

/**
 * Open flags for the failed-take marker. The temp directory can be shared
 * with other local accounts, so never follow a symlink planted at the
 * marker name where the platform can refuse one.
 */
const MARKER_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const MARKER_READ_FLAGS = fsConstants.O_RDONLY | MARKER_NOFOLLOW;
const MARKER_WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | MARKER_NOFOLLOW;

/** Appends one hook audit line; bound once the audit module is loaded. */
type HookAuditor = (
  action: string,
  target: string,
  ok: boolean,
  details: Record<string, unknown>,
) => void;

/**
 * Load the audit writer for `vault`. The returned auditor is best-effort and
 * never throws: a failure to record must never disturb the fail-soft hook
 * contract.
 */
async function loadAuditor(vault: string): Promise<HookAuditor> {
  const [{ hookAuditDir }, { appendAuditRecord }] = await Promise.all([
    import("../src/core/brain/paths.ts"),
    import("../src/core/reliability/audit.ts"),
  ]);
  return (action, target, ok, details) => {
    try {
      appendAuditRecord(hookAuditDir(vault), {
        timestamp: new Date().toISOString(),
        actor: HOOK_NAME,
        action,
        target,
        ok,
        details,
      });
    } catch {
      // best-effort
    }
  };
}

/**
 * Whether a failed take of `epoch` is the first one this machine has seen
 * for the session, recording it when so. Any marker I/O error answers
 * `true`: an extra audit line beats a silent failure.
 */
function firstTakeFailureOfEpoch(vault: string, sessionId: string, epoch: string | null): boolean {
  const scope = createHash("sha256").update(`${vault}\0${sessionId}`).digest("hex").slice(0, 16);
  const marker = join(tmpdir(), `o2b-reground-take-failed-${scope}`);
  const seen = epoch ?? "";
  try {
    const fd = openSync(marker, MARKER_READ_FLAGS);
    try {
      if (readFileSync(fd, "utf8") === seen) return false;
    } finally {
      closeSync(fd);
    }
  } catch {
    // no marker yet
  }
  try {
    const fd = openSync(marker, MARKER_WRITE_FLAGS, 0o600);
    try {
      writeFileSync(fd, seen);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
  return true;
}

async function main(): Promise<void> {
  let audit: HookAuditor | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => audit?.("hook_ceiling_exceeded", "reground", false, { hook: HOOK_NAME }),
  });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    // Before anything else: off is the default, and this runs per tool call.
    if (!resolveRegroundPartsEnabled()) return;

    const hookEventName = payload.hook_event_name;
    if (typeof hookEventName !== "string" || !CARRIER_EVENTS.has(hookEventName)) return;

    // A tool call made inside a delegated sub-agent shares the parent's
    // session id; taking a part there would hand the operator's rules to the
    // sub-agent and starve the main agent. The host marks such calls with
    // `agent_id`. `agent_type` alone is not a sub-agent marker: the host also
    // sends it on the main thread of a session started with `--agent`.
    if (typeof payload.agent_id === "string" && payload.agent_id.length > 0) return;

    const { isRealSessionId, takeRegroundPart } = await import("./lib/injection-ledger.ts");
    if (!isRealSessionId(payload.session_id)) return;

    const vault = resolveVault();
    if (vault === null) return;
    audit = await loadAuditor(vault);

    const take = takeRegroundPart(vault, payload.session_id);
    if (take.status === "failed") {
      if (firstTakeFailureOfEpoch(vault, payload.session_id, take.epoch)) {
        audit("reground_take_failed", hookEventName, false, { epoch: take.epoch });
      }
      return;
    }
    if (take.status !== "part") return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: take.part,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");

    audit("reground_part_delivered", hookEventName, true, {
      part: take.index,
      total: take.total,
      epoch: take.epoch,
      bytes: UTF8.encode(take.part).length,
      utf16_chars: take.part.length,
      part_ceiling_chars: take.partCeilingChars,
      over_budget: take.part.length > take.partCeilingChars,
    });
  } finally {
    disarm();
  }
}

main().catch(() => {
  // Never block on hook crash.
});
