/**
 * `brain_feedback` (task 3.19): the preference- and signal-feedback
 * capture lane, with the forced-confirmation gate, the write-refusal
 * mapping and the slug derivation it answers through. Split from
 * `feedback-tools.ts`; registration happens through that module's
 * registry, which preserves the public FEEDBACK_TOOLS surface.
 */

import { resolve } from "node:path";
import { loadPermissionsDocumentFor } from "../../core/brain/permissions/document-source.ts";
import { resolveAgentName } from "../../core/config.ts";
import { resolveEffectiveScope, signalRecordExists, writeSignal } from "../../core/brain/signal.ts";
import { computePayloadHash, lookupKey, rememberKey } from "../../core/brain/idempotency-ledger.ts";
import { ROUTE_STAGE, timeStageSync } from "../../core/route-scope.ts";
import {
  adviseIncomingFeedback,
  adviseUnroutableCapture,
  captureRoutingHintField,
  type CaptureRoutingHint,
  type WriteConflictAdvisory,
} from "../../core/brain/write-advisory.ts";
import { loadFeedbackDefaultScopeSafe } from "../../core/brain/policy.ts";
import { writePreference } from "../../core/brain/preference.ts";
import { normalizeExpirationDate } from "../../core/brain/expiration.ts";
import { validateBrainFeedbackInput } from "../../core/brain/sessions/validate-feedback.ts";
import { isoDate, isoSecond } from "../../core/brain/time.ts";
import { slugify } from "../../core/vault.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainSignalSign,
} from "../../core/brain/types.ts";
import { appendLogEvent } from "../../core/brain/log.ts";
import {
  mirrorReportFields,
  mirrorSignal,
  resolveSharedNamespace,
} from "../../core/brain/shared-namespace.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import {
  PENDING_STAGED_DIAGNOSTIC_CODE,
  WRITE_REFUSAL_CODES,
  WriteRefusedError,
} from "../../core/brain/pending/pending-lanes.ts";
import { nextCommandField, requireNextStep } from "../../core/brain/next-step.ts";
import { resolvePermission } from "../../core/brain/permissions/resolve.ts";
import { substrateSubject } from "../../core/brain/write-disposition.ts";
import { contextVault, type ServerContext } from "../tool-contract.ts";
import { refuseAgentClaim } from "./agent-claim.ts";
import { coerceStr, coerceIsoDate } from "../coerce.ts";
import { toolPath } from "./device-path.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";

export const FORCE_CONFIRMED_EXIT = requireNextStep(
  WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow,
).nextCommand;

/**
 * The MCP mapping of a document-deny refusal (write-side trust, Task
 * 12): named code, the rule that decided, the principal it named, and
 * the operator exit - the write never landed, so the refusal is the
 * whole answer. Shared by the writers on this surface that let the
 * disposition layer refuse through a typed error.
 */
export function writeRefusedToMcp(tool: string, err: WriteRefusedError): MCPError {
  return new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`, {
    code: err.code,
    rule: err.rule,
    agent: err.agent,
    next_command: err.nextCommand,
  });
}

/**
 * Build the slug used in the signal / preference filename. We never let
 * the agent decide the slug directly — taking `topic` as the slug stem
 * is what the design doc §9.2 prescribes (slugs are deterministic from
 * topic). The slug is run through `slugify` defensively so a slightly
 * mis-shaped topic still yields a filesystem-safe basename.
 */
export function deriveSlug(topic: string): string {
  return slugify(topic);
}

/** How a result names a record written with no vault. */
export const STORE_RECORD_PREFIX = "store:";

/**
 * The ledger namespace of the force-confirmed capture markers. A marker
 * lives outside the shared key space so a client key reused across tools
 * never collides with one.
 */
const PREFERENCE_MARKER_NAMESPACE = "brain-feedback-preference";

/**
 * Ledger keys of the force-confirmed capture marker: the PENDING marker
 * is appended right before the confirmed preference write is attempted,
 * the DONE marker right after it succeeded. The append-only ledger cannot
 * update a receipt, so completion is a second receipt, and "unfinished"
 * is positive evidence: PENDING present, DONE absent. Both carry the same
 * capture hash, so a retry whose force flag or expiration differs from
 * the original call never resumes the original's capture.
 */
const preferenceMarkerKey = (idempotencyKey: string): string => `${idempotencyKey}#preference`;
const preferenceDoneKey = (idempotencyKey: string): string => `${idempotencyKey}#preference-done`;

/**
 * The payload identity of the force-confirmed preference write, hashed
 * into the marker pair: WHAT is captured (topic, principle, agent,
 * scope), THAT it is force-confirmed, and HOW LONG it lives. Two calls
 * that differ in any of these are different payloads, so a forced retry
 * of an unforced capture (no marker exists) and a forced retry with a
 * different expiration (marker hash differs) both stay true no-ops.
 * Old receipts stay readable: the marker namespace is new, so receipts
 * written before it existed simply never resume.
 */
function preferenceCaptureHash(input: {
  topic: string;
  principle: string;
  agent: string;
  scope: string | undefined;
  expires: string | undefined;
}): string {
  return computePayloadHash({
    force_confirmed: true,
    topic: input.topic,
    principle: input.principle,
    agent: input.agent,
    scope: input.scope ?? undefined,
    expiration_date: input.expires ?? undefined,
  });
}

/** Append one capture-marker receipt, failing soft: the marker is a
 * repair aid, so an unreadable key or a full disk must never break the
 * capture it guards (the same policy the log appends follow). */
function appendMarkerReceipt(
  vault: string | null,
  key: string,
  captureHash: string,
  createdAt: string,
): void {
  try {
    rememberKey(vault, {
      key,
      namespace: PREFERENCE_MARKER_NAMESPACE,
      contentHash: captureHash,
      createdAt,
    });
  } catch (err) {
    process.stderr.write(
      `warning: record feedback capture marker failed: ${(err as Error).message}\n`,
    );
  }
}

export async function toolBrainFeedback(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // `null` on a server with no vault: the writes are store records (D14).
  const vault = contextVault(ctx);
  // Single source of truth for the brain_feedback payload contract —
  // session-replay (sessions/import.ts) and the MCP live path now go
  // through the same validator so rule shape cannot drift between the
  // two surfaces.
  const validated = validateBrainFeedbackInput(args);
  if (!validated.ok) {
    throw new MCPError(INVALID_PARAMS, validated.reason);
  }
  const {
    topic,
    signal: signalRaw,
    principle,
    scope,
    raw,
    source,
    force_confirmed,
  } = validated.value;
  const forceConfirmed = force_confirmed ?? false;

  // Identity, resolved once (write-side trust, Task 7). The
  // transport-minted identity WINS over the config resolution, and under
  // a token a caller-supplied `agent` that claims somebody else is
  // refused outright; resolveAgentName stays the stdio and CLI fallback.
  const identity = ctx.requestIdentity;
  const claimedAgent = normalizeAgentArgument(validated.value.agent ?? null);
  refuseAgentClaim(identity, claimedAgent, "brain_feedback");
  const agent = claimedAgent ?? identity?.agent ?? resolveAgentName(ctx.configPath ?? undefined);
  // The subject the write-side gates answer for: the credential-minted
  // one when the transport minted it, the config-shaped one otherwise.
  const subject = identity ?? { agent, via: "config" as const };

  // The force-confirmed rule (write-side trust, Task 12). `force_confirmed`
  // skips the dream trial window - the one write whose whole point is to
  // bypass a review - so under a permissions document that bypass belongs
  // to the operator, not the caller: the caller's `write` verdict must be
  // `allow`, and anything else refuses with the named token BEFORE any
  // write. With no document this block never runs, so the document-absent
  // behavior is byte-identically the pre-Task-12 one. The verdict consult
  // is the substrate resolver directly - no disposition row - because the
  // write it guards has its own gate; this check only polices the bypass,
  // and it answers for the credential-minted subject, never for a name
  // the request argued for.
  if (forceConfirmed) {
    // The permissions document: the operator's shared setting, or the legacy
    // file on an unswitched machine (document-source.ts).
    const { document } = loadPermissionsDocumentFor(vault);
    if (document !== null) {
      const decision = resolvePermission(document, substrateSubject(subject), "write");
      if (decision.verdict !== "allow") {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_feedback refused (${WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow}): ` +
            "force_confirmed skips the dream trial window, which the permissions " +
            `document reserves for allow-verdict callers. Rule ${decision.source} ` +
            `(${decision.reason}) decided ${decision.verdict} for agent ` +
            `${JSON.stringify(subject.agent)}. The operator can review the policy: ` +
            FORCE_CONFIRMED_EXIT,
          {
            code: WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow,
            rule: decision.source,
            verdict: decision.verdict,
            agent: subject.agent,
          },
        );
      }
    }
  }

  // Per-row event-time (A2 / t_7526e8d3): an optional caller-supplied
  // `event_time` lets a backfilled / imported "remember" carry when it
  // actually happened instead of the wall-clock. When present and valid,
  // it drives the signal's `created_at` / filename day and the
  // bi-temporal `valid_from` / `recorded_at` slots. The audit log and any
  // force-confirmed preference stay stamped at the real write moment
  // (`now`) so the audit chronology is not rewritten. Absent →
  // byte-identical to the historical wall-clock path.
  const eventTime = coerceIsoDate(args, "event_time");
  // Optional client idempotency key (C1 / t_213f356b): forwarded to the
  // signal writer so a retried / double-delivered feedback call dedupes
  // instead of appending a second signal. Absent → historical behaviour.
  const idempotencyKey = coerceStr(args, "idempotency_key", false);
  // Creation-time expiration (unit 3c). Validated through the one
  // chokepoint BEFORE the signal write, so an unparseable date refuses
  // the whole call rather than landing a signal and then failing on the
  // preference beside it.
  const expiresRaw = coerceStr(args, "expires", false);
  let expires: string | undefined;
  if (expiresRaw !== null && expiresRaw !== undefined) {
    try {
      expires = normalizeExpirationDate(expiresRaw);
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `brain_feedback: expires: ${(err as Error).message}`);
    }
  }
  const now = new Date();
  const createdAt = isoSecond(now);
  const signalStamp = eventTime ?? now;
  const signalCreatedAt = isoSecond(signalStamp);
  const signalDate = isoDate(signalStamp);
  const slug = deriveSlug(topic);

  // Vault-configured fallback scope (`feedback.default_scope`). Applied
  // only when the call passes no explicit scope. Compute one effective
  // scope so the signal, its mirror, and any force-confirmed preference
  // all land on the same scope.
  const defaultScope = loadFeedbackDefaultScopeSafe(vault);
  const effectiveScope = resolveEffectiveScope(scope, defaultScope);
  const writeOpts = defaultScope !== undefined ? { defaultScope } : {};

  // 1. Always write the signal to inbox/. Mirrors the CLI handler so the
  //    audit trail in `Brain/log/` and `inbox/processed/` stays consistent
  //    across CLI and MCP entry points. `--force-confirmed` ADDITIONALLY
  //    creates a confirmed pref below. The transport-minted identity
  //    rides to the review gate as its subject (write-side-trust, Task
  //    7): a document that denies the token's agent refuses this write
  //    before any byte exists.
  const signalInput = {
    topic,
    signal: signalRaw as BrainSignalSign,
    agent,
    principle,
    created_at: signalCreatedAt,
    date: signalDate,
    slug,
    ...(scope ? { scope } : {}),
    ...(source && source.length > 0 ? { source: [...source] } : {}),
    ...(raw ? { raw } : {}),
    // Stamp the bi-temporal slots only when an explicit event_time was
    // supplied, so a live "remember" stays byte-identical.
    ...(eventTime ? { valid_from: signalCreatedAt, recorded_at: signalCreatedAt } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(expires !== undefined ? { expiration_date: expires } : {}),
  };
  let sigResult;
  try {
    sigResult = writeSignal(vault, signalInput, {
      ...writeOpts,
      // The review disposition always answers for THIS tool's resolved
      // identity: the credential-minted subject when the transport minted
      // one, the config-shaped subject this tool resolved (config path
      // honored, caller claim refused) otherwise. Leaving the subject off
      // would make the disposition re-resolve the agent without this
      // context's config path and answer for a stranger.
      subject,
    });
  } catch (err) {
    if (err instanceof WriteRefusedError) throw writeRefusedToMcp("brain_feedback", err);
    throw err;
  }
  // A deduped signal means this whole feedback call is a retry of one
  // already recorded — skip the log event, the shared-namespace mirror,
  // and any force-confirmed pref so the retry stays a true no-op.
  // EXCEPT a capture the ledger shows is UNFINISHED: when the original
  // call was force-confirmed, its signal landed, and its preference
  // write never completed, the call leaves a PENDING capture marker in
  // the idempotency ledger (below) and the retry that finds PENDING
  // without DONE, with the same capture payload, and with the signal
  // still present, completes the write. Everything else stays a true
  // no-op:
  //   - a completed capture (DONE exists),
  //   - a capture whose signal delete-by-source later forgot (the
  //     signal page / store record is gone - a user's forget must not
  //     be undone by a replay),
  //   - a first call made WITHOUT force_confirmed (no marker exists),
  //   - a retry whose force flag or expiration differs from the
  //     original (the marker hash names both, so it does not match).
  // "The preference is absent" proves none of this - a preference the
  // user removed by hand reads exactly like one never written - which is
  // why the resume reads the marker pair instead.
  // The force-confirmed preference write, spelled once so the deduped
  // retry path can resume it: same payload, same stamps, same writer.
  const writeConfirmedPreference = (): { path: string; id: string } =>
    timeStageSync(ROUTE_STAGE.preferenceWrite, () =>
      writePreference(
        vault,
        {
          slug,
          topic: topic.trim(),
          principle: principle.trim(),
          created_at: createdAt,
          unconfirmed_until: createdAt,
          status: BRAIN_PREFERENCE_STATUS.confirmed,
          evidenced_by: [`[[${sigResult.id}]]`],
          confirmed_at: createdAt,
          // Issue #149: an explicit zero, not an absent value. The
          // on-disk encoding of "absent" is the literal `null`, and two
          // ranking surfaces (`pre-compress-pack`, `morning-brief`) map
          // `null` to negative infinity before sorting - so a rule
          // force-confirmed a second ago would sort BELOW every rule
          // that has a number, including one measured at zero. Zero is
          // also the true Wilson lower bound on no evidence, which is
          // why the dream pass already pre-seeds it for new
          // preferences. This writer now matches it.
          confidence_value: 0,
          ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
          // The same lifetime the signal carries: a rule confirmed from an
          // observation that expires on a date does not outlive it.
          ...(expires !== undefined ? { expiration_date: expires } : {}),
        },
        // Ownership is resolved by the writer, never echoed from `agent`:
        // that argument is caller-supplied, and a caller must not be able to
        // name whose memory this becomes. The server's config path is handed
        // over rather than a resolved name for the same reason, and the
        // transport-minted identity rides as the credential-minted subject
        // (write-side-trust, Task 7) so the gate and the stamp answer for
        // the token's agent.
        {
          ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
          ...(identity !== undefined ? { subject: identity } : {}),
        },
      ),
    );
  const logConfirmedPreference = (preferenceId: string): void => {
    try {
      // Offset by 1s so the force-confirmed event sorts after the feedback
      // event on the same UTC second (parseLogDay is stable on ties, but a
      // visible chronology reads cleaner).
      timeStageSync(ROUTE_STAGE.logAppend, () =>
        appendLogEvent(vault, {
          timestamp: isoSecond(new Date(now.getTime() + 1000)),
          eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
          body: {
            preference: `[[${preferenceId}]]`,
            agent,
          },
        }),
      );
    } catch (err) {
      process.stderr.write(
        `warning: append force-confirmed log failed: ${(err as Error).message}\n`,
      );
    }
  };
  // The capture hash and marker keys, computed once: both the fresh
  // path (before the write) and the deduped retry path (to decide the
  // resume) read them.
  const captureHash = preferenceCaptureHash({
    topic: topic.trim(),
    principle: principle.trim(),
    agent,
    scope: effectiveScope,
    expires,
  });
  const markerKey =
    idempotencyKey !== null && idempotencyKey !== undefined
      ? preferenceMarkerKey(idempotencyKey)
      : undefined;
  const doneKey =
    idempotencyKey !== null && idempotencyKey !== undefined
      ? preferenceDoneKey(idempotencyKey)
      : undefined;
  if (sigResult.deduped) {
    // Positive evidence this capture is unfinished: the marker pair from
    // a force-confirmed original, with the same payload as THIS retry,
    // and a signal that still exists on disk / in the store.
    const resumable =
      markerKey !== undefined &&
      doneKey !== undefined &&
      forceConfirmed &&
      lookupKey(vault, markerKey, PREFERENCE_MARKER_NAMESPACE)?.contentHash === captureHash &&
      lookupKey(vault, doneKey, PREFERENCE_MARKER_NAMESPACE) === null &&
      signalRecordExists(vault, sigResult.path, sigResult.id);
    if (resumable) {
      const resumed = writeConfirmedPreference();
      if (doneKey !== undefined) appendMarkerReceipt(vault, doneKey, captureHash, createdAt);
      logConfirmedPreference(resumed.id);
      return {
        kind: "preference",
        deduped: true,
        // The signal was deduped, so the retry staged nothing new.
        staged: false,
        signal_path:
          vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : toolPath(ctx, sigResult.path),
        signal_absolute_path:
          vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : resolve(sigResult.path),
        signal_id: sigResult.id,
        preference_path:
          vault === null ? `${STORE_RECORD_PREFIX}${resumed.id}` : toolPath(ctx, resumed.path),
        preference_absolute_path:
          vault === null ? `${STORE_RECORD_PREFIX}${resumed.id}` : resolve(resumed.path),
        preference_id: resumed.id,
        path: vault === null ? `${STORE_RECORD_PREFIX}${resumed.id}` : toolPath(ctx, resumed.path),
        absolute_path:
          vault === null ? `${STORE_RECORD_PREFIX}${resumed.id}` : resolve(resumed.path),
        id: resumed.id,
        agent,
      };
    }
    return {
      kind: "signal",
      deduped: true,
      // A dedup wrote nothing, so it staged nothing.
      staged: false,
      signal_path:
        vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : toolPath(ctx, sigResult.path),
      signal_absolute_path:
        vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : resolve(sigResult.path),
      signal_id: sigResult.id,
      path:
        vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : toolPath(ctx, sigResult.path),
      absolute_path:
        vault === null ? `${STORE_RECORD_PREFIX}${sigResult.id}` : resolve(sigResult.path),
      id: sigResult.id,
      agent,
    };
  }
  // t_936a1a61: fail-soft mirror into the shared namespace AFTER the
  // primary write; `mirror` is reported only when the key is configured.
  const sharedNamespace = resolveSharedNamespace(ctx.configPath);
  // The mirror copies from a vault, so there is none without one.
  const mirror =
    sharedNamespace === null || vault === null
      ? undefined
      : mirrorSignal(sharedNamespace, vault, signalInput, writeOpts);

  try {
    timeStageSync(ROUTE_STAGE.logAppend, () =>
      appendLogEvent(vault, {
        timestamp: createdAt,
        eventType: BRAIN_LOG_EVENT_KIND.feedback,
        body: {
          signal: `[[${sigResult.id}]]`,
          topic: topic.trim(),
          sign: signalRaw,
          agent,
        },
      }),
    );
  } catch (err) {
    process.stderr.write(`warning: append feedback log failed: ${(err as Error).message}\n`);
  }

  // Write-time conflict advisory (A4): compare the incoming principle
  // against confirmed same-scope preferences and surface a non-blocking
  // advisory when it closely resembles an existing rule. Computed BEFORE
  // any force-confirmed write so it never matches the pref this very call
  // is about to create. The write has already landed; this never blocks it.
  // Both advisories answer at the caller's reach: a preference or signal
  // the caller may not read is never scored, named or counted.
  const readable = readableAtContextReachOrUndefined(ctx);
  const advisory: WriteConflictAdvisory | null = adviseIncomingFeedback(vault, {
    principle,
    ...(readable !== undefined ? { readable } : {}),
    ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
    agent,
    now,
  });

  // Unroutable-capture routing hint (unit 4): the signal above resolved
  // no scope, so no scoped recall reaches it. Non-blocking like the
  // advisory, and absent entirely when this vault uses no scopes yet.
  const routingHint: CaptureRoutingHint | null = adviseUnroutableCapture(vault, {
    ...(readable !== undefined ? { readable } : {}),
    ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
    agent,
    now,
  });

  let prefResult: { path: string; id: string } | null = null;
  if (forceConfirmed) {
    // Leave the PENDING capture marker BEFORE the write: the signal and
    // its own receipt have already landed, so a crash or refusal inside
    // `writePreference` leaves PENDING without DONE - the positive mark
    // a deduped retry reads to finish this capture (see the deduped
    // branch above). Fail-soft: without a client key there is nothing to
    // mark, and a marker that cannot be stored only costs the repair.
    if (markerKey !== undefined) appendMarkerReceipt(vault, markerKey, captureHash, createdAt);
    // Escape hatch: skip the dream pass and create the confirmed rule now.
    // `confirmed_at` is now; `unconfirmed_until` is also now so the trial
    // window collapses on inspection. The just-written signal is recorded
    // as the rule's origin under `evidenced_by`. A throw here leaves
    // PENDING without DONE in the ledger - exactly the resume mark.
    prefResult = writeConfirmedPreference();
    if (doneKey !== undefined) appendMarkerReceipt(vault, doneKey, captureHash, createdAt);
    logConfirmedPreference(prefResult.id);
  }

  // With no vault the records have no file: both fields name the record
  // (`store:<id>`), as the CLI does.
  const named = (path: string, id: string): string =>
    vault === null ? `${STORE_RECORD_PREFIX}${id}` : toolPath(ctx, path);
  const absolute = (path: string, id: string): string =>
    vault === null ? `${STORE_RECORD_PREFIX}${id}` : resolve(path);
  return {
    kind: prefResult ? "preference" : "signal",
    ...mirrorReportFields(mirror),
    ...(advisory !== null ? { advisory } : {}),
    // Same key and same resolution as the CLI's `--json` renderer, from
    // the one composer: an agent that learns the exit on one surface
    // reads it on the other.
    ...captureRoutingHintField(routingHint),
    // Write-side trust (Task 6): the gate resolved inside writeSignal, so
    // the receipt says which directory the bytes actually landed in. An
    // agent that reads `staged: true` knows the signal is awaiting review
    // under `Brain/pending/`, not recalled from `Brain/inbox/`. The
    // pending id and the queue command (Task 9) give that agent the
    // handle and the exit, since applying is an operator's move.
    staged: sigResult.staged,
    ...(sigResult.staged
      ? {
          pending_id: sigResult.id,
          ...nextCommandField(PENDING_STAGED_DIAGNOSTIC_CODE),
        }
      : {}),
    signal_path: named(sigResult.path, sigResult.id),
    signal_absolute_path: absolute(sigResult.path, sigResult.id),
    signal_id: sigResult.id,
    ...(prefResult
      ? {
          preference_path: named(prefResult.path, prefResult.id),
          preference_absolute_path: absolute(prefResult.path, prefResult.id),
          preference_id: prefResult.id,
          // Back-compat: top-level `path`/`id` previously pointed at the
          // pref on the force-confirmed branch. Keep them aligned for
          // callers that look at the bare fields.
          path: named(prefResult.path, prefResult.id),
          absolute_path: absolute(prefResult.path, prefResult.id),
          id: prefResult.id,
        }
      : {
          path: named(sigResult.path, sigResult.id),
          absolute_path: absolute(sigResult.path, sigResult.id),
          id: sigResult.id,
        }),
    agent,
  };
}
