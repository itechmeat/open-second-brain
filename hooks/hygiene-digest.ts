#!/usr/bin/env -S bun
/**
 * Stop hook: surfaces pending Brain hygiene findings as ONE line,
 * once per change, behind the opt-in `hygiene_digest_enabled` flag
 * (context-injection-pipeline, lane B, task B3).
 *
 * The line folds the default detector sweep plus the index-backed
 * dangling-link count into counts per detector (composer:
 * hooks/lib/hygiene-digest-text.ts). Silence is the steady state: zero
 * eligible findings, an unmeasurable scan, a state the vault-level
 * hash ledger already emitted, or a runtime with no non-blocking
 * channel all exit 0 with no output.
 *
 * Gates, in cost order:
 *
 *   1. Unreadable payload -> silent.
 *   2. `stop_hook_active === true` -> silent (the once-per-turn guard;
 *      this hook never continues a turn itself, and a continued turn
 *      must not re-run the sweep).
 *   3. Flag off -> silent. Checked BEFORE vault resolution, and before
 *      the heavy imports: the detectors and the search index load
 *      lazily after every gate, so a default-off run pays one config
 *      read (reground-deliver precedent).
 *   4. Runtime without a non-blocking Stop channel -> silent. Only
 *      Claude Code gets the line: the hook hands it over to the async
 *      `stop-advisory-deliver` hook (hooks/lib/stop-advisory-handover.ts),
 *      whose `additionalContext` reaches the model with the next user
 *      message, unprinted and without a turn of its own. Everywhere else a
 *      Stop block
 *      (`decision: "block"`) is a forced continuation turn, and an
 *      opt-in digest must never buy one - so Codex, Grok Build and
 *      unrecognised runtimes exit here, before any transcript work.
 *   5. No transcript, unreadable transcript, or a turn that wrote no
 *      artifact -> silent. "Once per change" means once per
 *      artifact-writing turn (`summarizeTurn` hadArtifact, the
 *      stop-log-guardrail gate) - an artifact write anywhere, code
 *      included, counts; the sweep is not vault-scoped.
 *   6. `resolveHookVault()` null -> silent.
 *
 * Change detection is a hash ledger,
 * `<vault>/.open-second-brain/hygiene-digest.hash`
 * (hooks/lib/hygiene-digest-state.ts): hash differs -> deliver, then
 * write; hash equal -> nothing. The write lands AFTER the line was handed
 * over (or printed), so a crash in between loses the dedupe and the next
 * eligible turn emits again - lose-not-duplicate.
 *
 * Delivery. This hook is synchronous: the sweep and the ledger write
 * happen here. With the default `stop_advisory_delivery: "async"` it prints
 * nothing and hands the line to the async `stop-advisory-deliver` hook; a
 * one-shot `claude -p` run that kills that hook loses only the line. With
 * `"sync"` it prints the line as a synchronous Stop `additionalContext`,
 * which Claude Code shows as "Stop hook says: ..." and answers with one
 * more turn. The Stop guardrail (hooks/stop-log-guardrail.ts) keeps its
 * portable block shape on the runtimes without a non-blocking channel - it
 * is always-on and its continuation is the point there.
 *
 * Crashes exit 0 - never deadlock.
 */

import { writeSync } from "node:fs";

import { resolveHygieneDigestEnabled } from "../src/core/config.ts";
import { detectHookRuntime, summarizeTurn } from "./lib/detect.ts";
import { composeHygieneDigest } from "./lib/hygiene-digest-text.ts";
import {
  computeHygieneDigestHash,
  hygieneDigestHashMatches,
  writeHygieneDigestHash,
} from "./lib/hygiene-digest-state.ts";
import { asHookPayload, type HookPayloadBase, readHookInput } from "./lib/stdin.ts";
import { stopAdvisoryHandsOver, writeStopAdvisoryHandover } from "./lib/stop-advisory-handover.ts";
import { readTranscript } from "./lib/transcript.ts";
import { resolveHookVault } from "./lib/hook-vault.ts";
import { fitHostContext } from "./lib/host-context-ceiling.ts";

async function main(): Promise<void> {
  let payload;
  try {
    payload = asHookPayload(await readHookInput());
  } catch {
    return;
  }

  if (payload.stop_hook_active === true) return;

  // Off is the default and this runs after every turn: one config read,
  // no vault resolution, no heavy imports.
  if (!resolveHygieneDigestEnabled()) return;

  // Claude Code only: there the line reaches the model through the async
  // `stop-advisory-deliver` hook, with the next user message. On every
  // other runtime a Stop block forces a continuation turn, and an opt-in
  // digest must never do that. Payload-shape
  // detection only, so a silent runtime pays nothing further.
  if (detectHookRuntime(payload) !== "claudecode") return;

  // The default async delivery: the sweep and the ledger write happen here,
  // in the synchronous hook, and only the line goes to the async
  // `stop-advisory-deliver` hook. `stop_advisory_delivery: "sync"` prints
  // it here instead, as a synchronous Stop `additionalContext`.
  const handsOver = stopAdvisoryHandsOver(payload);
  let digest: HygieneDigest | null = null;
  let handedOver = false;
  try {
    digest = await computeDigest(payload);
  } finally {
    // Past the gates the deliver hook waits for this producer, so the
    // hand-over is written on every path, "nothing" and a crash included.
    if (handsOver) {
      handedOver = writeStopAdvisoryHandover(payload, "hygiene-digest", digest?.line ?? null);
    }
  }
  if (digest === null) return;
  // A hand-over that never landed is a line never delivered: no ledger write.
  if (handsOver && !handedOver) return;

  if (!handsOver) {
    // One blocking write to fd 1, not process.stdout.write: a write error
    // must surface HERE, before the ledger write below. Bun and Node
    // deliver stdout errors asynchronously, which would resolve main,
    // record this state as emitted while the line never landed, and crash
    // with a stderr banner. The synchronous write throws into main's
    // fail-soft catch instead and the next eligible turn re-emits - the
    // lose-not-duplicate order made real, not just ordered.
    writeSync(
      1,
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: fitHostContext(digest.line) } })}\n`,
    );
  }
  // Lose-not-duplicate: the ledger records the state only after the line
  // was printed or handed over, so a crash in between re-emits rather than
  // going silent.
  digest.commit();
}

/** A digest line to deliver, and the ledger write that records it as delivered. */
interface HygieneDigest {
  readonly line: string;
  readonly commit: () => void;
}

/** The sweep: the digest line for this turn, or null when there is nothing new. */
async function computeDigest(payload: HookPayloadBase): Promise<HygieneDigest | null> {
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;

  let signal;
  try {
    signal = readTranscript(transcriptPath);
  } catch {
    return null;
  }

  const summary = summarizeTurn(signal.toolCalls, signal.bashCommands);
  if (!summary.hadArtifact) return null;

  const vault = resolveHookVault();
  if (vault === null) return null;

  // Heavy imports, only past every gate: the detector sweep and the
  // search index are the whole cost of this hook.
  const { runHygieneScan } = await import("../src/core/brain/hygiene/scan.ts");
  const { resolveSearchConfig } = await import("../src/core/search/index.ts");
  const { measureFromIndex } = await import("../src/core/search/link-ratchet.ts");
  // The ledger is machine state: the vault before the switch, the
  // device-local state once store-only (nothing written into the vault).
  const { machineStateRoot } = await import("../src/core/state/machine-state.ts");

  const report = runHygieneScan(vault, { now: new Date() });
  // The dangling-link measurement must never fail the digest: resolving
  // the search config itself can throw (a bad `search_chunk_size` env or
  // config value), and an index that cannot be measured is unmeasured.
  // Both degrade to `null` here, never flattened into a zero - the same
  // composition the hygiene tool makes (measured:false with a reason).
  let danglingLinks: number | null = null;
  try {
    const measurement = await measureFromIndex(resolveSearchConfig({ vault }));
    danglingLinks = measurement.measurable ? measurement.dangling : null;
  } catch {
    // Absorbed: the count is unmeasured, the findings still surface.
  }

  const line = composeHygieneDigest({ findings: report.findings, danglingLinks });
  if (line === null) return null;

  const hash = computeHygieneDigestHash({ findings: report.findings, danglingLinks });
  const stateRoot = machineStateRoot(vault);
  if (hygieneDigestHashMatches(stateRoot, hash)) return null;
  return { line, commit: () => writeHygieneDigestHash(stateRoot, hash) };
}

main().catch(() => {
  // Never deadlock on a hook crash.
});
