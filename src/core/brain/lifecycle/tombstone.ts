/**
 * Cross-type tombstone + supersede lifecycle (Belief lifecycle suite,
 * Track A anchor, t_7d5a3589).
 *
 * A memory of ANY type - preference, signal, learning note - can be
 * tombstoned without deletion: the file gains `_status: tombstoned`,
 * `tombstoned_at`, `tombstone_reason`, and (for a supersede) a
 * `superseded_by` replacement pointer. The bytes stay on disk for
 * audit; recall / inject / active.md / dream exclude tombstoned
 * entries via {@link isTombstoned}.
 *
 * `supersede` is a tombstone that also records where the belief moved:
 * the predecessor is tombstoned and pointed at its successor. A chain
 * of supersessions is walked to its live tip by {@link resolveChainTip}.
 *
 * Idempotency: re-issuing a tombstone on an already-tombstoned file is a
 * byte-identical no-op that returns the existing state and emits no
 * event.
 *
 * The digest renderer depends only on the read side, so this writer can
 * refresh the digest after changing a preference without a module cycle.
 */

import { relative } from "node:path";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { appendDecisionChangeReceipt } from "../decisions/receipts.ts";
import { regenerateActiveQuiet } from "../active.ts";
import {
  LIFECYCLE_STATUS_KEY,
  LIFECYCLE_STATUS_KEY_NORMALIZED,
  TOMBSTONED_AT_KEY,
  TOMBSTONE_REASON_KEY,
  SUPERSEDED_BY_KEY,
  normalizeChainLink,
  readLifecycleState,
  readScalar,
  type LifecycleState,
} from "./tombstone-read.ts";
import { resolveNotePath } from "../note-path.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_TOMBSTONE_STATUS } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

// Keep the read API available through this module for existing callers.
export {
  LIFECYCLE_STATUS_KEY,
  LIFECYCLE_STATUS_KEY_NORMALIZED,
  TOMBSTONED_AT_KEY,
  TOMBSTONE_REASON_KEY,
  SUPERSEDED_BY_KEY,
  MAX_CHAIN_DEPTH,
  isTombstoned,
  normalizeChainLink,
  readLifecycleState,
  buildChainLookup,
  resolveChainTip,
  resolveChainTipInVault,
  type ChainLookup,
  type ChainLookupEntry,
  type LifecycleState,
  type ResolveChainTipResult,
} from "./tombstone-read.ts";

/** Default reason stamped when a supersede does not pass an explicit one. */
export const SUPERSEDE_DEFAULT_REASON = "superseded";
/** Cap on tombstone-reason length (mirrors the note-text field cap). */
const REASON_MAX_LEN = 512;

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class TombstoneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TombstoneError";
  }
}

/** Render a bare identifier as a canonical wikilink for on-disk storage. */
function toWikilink(raw: string): string {
  return `[[${normalizeChainLink(raw)}]]`;
}

// ----- Tombstone / supersede ------------------------------------------------

export interface TombstoneInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the target memory file. */
  readonly path: string;
  /** Operator-facing reason. Required, non-empty after trim. */
  readonly reason: string;
  /** Optional successor id / wikilink stored as `superseded_by`. */
  readonly supersededBy?: string;
  /** Identity override; resolver default used when omitted or blank. */
  readonly agent?: string;
  /** Wall clock for the timestamps. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Config path for `resolveAgentName`. Optional. */
  readonly configPath?: string;
  /**
   * The vault-relative paths the caller may read. A target it may not
   * read is refused as a missing one, before anything is written. Absent,
   * every target may be written.
   */
  readonly readable?: (rel: string) => boolean;
}

export interface TombstoneResult {
  /** `false` when the file was already tombstoned (no-op). */
  readonly changed: boolean;
  /** Vault-relative POSIX path of the target. */
  readonly path: string;
  readonly state: LifecycleState;
  /** Identity written into the log entry (only when `changed`). */
  readonly agent?: string;
  /** ISO-8601 UTC second of the emitted event (only when `changed`). */
  readonly loggedAt?: string;
}

function relForVault(vault: string, absPath: string): string {
  return relative(vault, absPath).split("\\").join("/");
}

/**
 * Tombstone a memory of any type in place. Sets `_status: tombstoned`
 * plus `tombstoned_at` / `tombstone_reason` (and `superseded_by` when a
 * successor is supplied), preserving the body and all other frontmatter.
 * Idempotent: an already-tombstoned file is left byte-identical and the
 * existing state is returned with `changed: false`.
 */
export function tombstone(input: TombstoneInput): TombstoneResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(input.vault);
  const reason = sanitiseTextField(input.reason, {
    maxLen: REASON_MAX_LEN,
    singleLine: true,
  }).trim();
  if (!reason) {
    throw new TombstoneError("tombstone: reason is required");
  }

  let abs: string;
  try {
    abs = resolveNotePath(input.vault, input.path, {
      mustExist: true,
      ...(input.readable !== undefined ? { readable: input.readable } : {}),
    });
  } catch (err) {
    throw new TombstoneError(
      `tombstone: target does not resolve inside the vault: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const relPath = relForVault(input.vault, abs);
  const [rawMeta, body] = parseFrontmatter(abs);

  const existing = readLifecycleState(rawMeta);
  if (existing.tombstoned) {
    // Idempotent no-op: never rewrite, never log.
    return { changed: false, path: relPath, state: existing };
  }

  const priorStatus =
    readScalar(rawMeta, LIFECYCLE_STATUS_KEY) ??
    readScalar(rawMeta, LIFECYCLE_STATUS_KEY_NORMALIZED) ??
    "unknown";
  const now = input.now ?? new Date();
  const tombstonedAt = isoSecond(now);
  const supersededBy = input.supersededBy ? toWikilink(input.supersededBy) : null;

  const nextMeta: FrontmatterMap = { ...(rawMeta as FrontmatterMap) };
  nextMeta[LIFECYCLE_STATUS_KEY] = BRAIN_TOMBSTONE_STATUS;
  nextMeta[TOMBSTONED_AT_KEY] = tombstonedAt;
  nextMeta[TOMBSTONE_REASON_KEY] = reason;
  if (supersededBy !== null) nextMeta[SUPERSEDED_BY_KEY] = supersededBy;

  try {
    writeFrontmatterAtomic(abs, nextMeta, body, { overwrite: true });
  } catch (err) {
    throw new TombstoneError(`tombstone: failed to write ${relPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  try {
    const explicitAgent = normalizeAgentArgument(input.agent ?? null);
    const agent = explicitAgent ?? resolveAgentName(input.configPath);
    appendLogEvent(input.vault, {
      timestamp: tombstonedAt,
      eventType: BRAIN_LOG_EVENT_KIND.tombstone,
      body: {
        path: relPath,
        reason,
        prior_status: priorStatus,
        ...(supersededBy !== null ? { superseded_by: supersededBy } : {}),
        agent,
      },
    });

    // Belief lifecycle suite (B4): a supersede/tombstone is a belief change,
    // so it emits a decision-change receipt. The receipt's own idempotency
    // key (subject + before + after) makes a replay a no-op, mirroring the
    // tombstone no-op above. Fail-soft: an accountability-log hiccup must
    // never fail the tombstone write itself.
    try {
      appendDecisionChangeReceipt(input.vault, {
        subject: relPath,
        before: `status:${priorStatus}`,
        after:
          supersededBy !== null
            ? `status:tombstoned superseded_by:${supersededBy}`
            : "status:tombstoned",
        actor: agent,
        rationale: reason,
        reasonCode: supersededBy !== null ? "supersede" : "tombstone",
        ...(supersededBy !== null ? { alternatives: [priorStatus] } : {}),
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
    } catch {
      // Receipt is best-effort accountability; the tombstone frontmatter and
      // its `tombstone` log event remain authoritative.
    }
    return {
      changed: true,
      path: relPath,
      state: {
        tombstoned: true,
        tombstonedAt,
        tombstoneReason: reason,
        supersededBy,
      },
      agent,
      loggedAt: tombstonedAt,
    };
  } finally {
    // The frontmatter is already committed, even if the audit append throws.
    if (rawMeta["kind"] === "brain-preference") {
      regenerateActiveQuiet(input.vault, { now, legacyOnly: true });
    }
  }
}

export interface SupersedeInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the predecessor being replaced. */
  readonly predecessor: string;
  /** Successor id / wikilink that supersedes the predecessor. */
  readonly successor: string;
  /** Optional reason; defaults to {@link SUPERSEDE_DEFAULT_REASON}. */
  readonly reason?: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
  /** The vault-relative paths the caller may read; see {@link TombstoneInput.readable}. */
  readonly readable?: (rel: string) => boolean;
}

/**
 * Supersede a predecessor with a successor: tombstone the predecessor and
 * record the replacement pointer. Thin wrapper over {@link tombstone}.
 */
export function supersede(input: SupersedeInput): TombstoneResult {
  const successor = input.successor.trim();
  if (!successor) {
    throw new TombstoneError("supersede: successor is required");
  }
  return tombstone({
    vault: input.vault,
    path: input.predecessor,
    reason: input.reason ?? SUPERSEDE_DEFAULT_REASON,
    supersededBy: successor,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
  });
}
