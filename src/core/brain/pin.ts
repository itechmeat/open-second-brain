/**
 * Pin / unpin operations.
 *
 * A pinned preference is exempt from the three automatic retire reasons
 * (`stale-no-evidence`, `expired-unconfirmed`, `rebutted`). Pinning is a
 * CLI-only operation — the MCP surface deliberately does NOT expose it
 * so autonomous agents cannot mutate the protected set (design doc
 * §7.4, §15 Step 9b).
 *
 * Surface:
 *
 *   - {@link setPinned} flips a single preference's `pinned` boolean
 *     atomically. The frontmatter is rewritten through
 *     `writeFrontmatterAtomic` with `overwrite: true`. The body bytes
 *     of the preference are preserved verbatim — we only touch the
 *     frontmatter. The function is idempotent: a no-op flip returns
 *     `changed: false` and writes nothing.
 *
 *   - {@link isPinned} is the trivial accessor with a default of
 *     `false`. The parser in `preference.ts` already coerces missing
 *     frontmatter values to `false`, but we keep this helper for
 *     callers (notably `dream`) that want to express intent without
 *     reaching into the `BrainPreference` shape directly.
 *
 * A successful flip emits a `pin` or `unpin` log event via
 * `appendLogEvent`. A no-op (`changed: false`) emits no log entry — the
 * log is reserved for state transitions, not redundant calls.
 */

import { existsSync } from "node:fs";

import { writeFrontmatterAtomic, parseFrontmatter } from "../vault.ts";
import { authorityFromOrigin, dualWrite } from "../store/dual-write.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { preferenceSetRecord } from "../store/dual-write-records.ts";
import { callerInput, opaqueFields } from "../store/operation-privacy.ts";
import { regenerateActiveQuiet } from "./active.ts";
import { appendLogEvent, logEventPrivacyContent, type BrainLogEntry } from "./log.ts";
import { parsePreference, preferencePrivacy, storeFieldsOf } from "./preference.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainPreference } from "./types.ts";
import { renderPrefLink } from "./wikilink.ts";
import { BrainPreferenceNotFoundError } from "./apply-evidence.ts";

/** Fields of a pin call's input that are not text: its clock. */
const PIN_INPUT_OPAQUE: ReadonlySet<string> = opaqueFields("now");

export interface SetPinnedOptions {
  /** Override the wall clock used in the log event. */
  readonly now?: Date;
  /**
   * Source agent recorded as a payload field on the log event. Defaults
   * to `"cli"` to reflect that pinning is a CLI-only operation; the
   * CLI passes the resolved `AGENT_NAME`. The MCP surface never reaches
   * this code path (Brain MCP tools do not expose pin/unpin).
   */
  readonly agent?: string;
}

export interface SetPinnedResult {
  /** Absolute path of the preference file. */
  readonly path: string;
  /**
   * `true` if the on-disk value transitioned (false → true or
   * true → false). `false` when the requested state was already set —
   * the call is a no-op and no log entry was written.
   */
  readonly changed: boolean;
}

/**
 * Flip a preference's `pinned` frontmatter field. Atomic and
 * idempotent.
 *
 * @throws {@link BrainPreferenceNotFoundError} when the preference does
 *   not resolve to a file under `Brain/preferences/`. We reuse the
 *   `apply-evidence` error class so CLI surface treats both
 *   "wrong pref_id" cases consistently.
 */
export function setPinned(
  vault: string,
  prefId: string,
  value: boolean,
  opts: SetPinnedOptions = {},
): SetPinnedResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (typeof prefId !== "string" || !prefId.trim()) {
    throw new Error("setPinned missing field: pref_id");
  }
  if (typeof value !== "boolean") {
    throw new Error(`setPinned: 'value' must be a boolean; got ${JSON.stringify(value)}`);
  }

  const trimmed = prefId.trim();
  const slug = trimmed.startsWith("pref-") ? trimmed.slice("pref-".length) : trimmed;
  if (!slug) {
    throw new Error(`setPinned: invalid pref_id (empty slug): ${prefId}`);
  }
  validateSlug(slug);
  const path = preferencePath(vault, slug);
  if (!existsSync(path)) {
    throw new BrainPreferenceNotFoundError(`pref-${slug}`, path);
  }

  // Re-parse the file to drive the idempotency check off the canonical
  // boolean (rather than the raw frontmatter string), and to validate
  // the file's shape before we rewrite it. A corrupt preference here
  // is a hard error — the caller asked us to mutate a specific rule;
  // we refuse to make that decision blindly.
  const current = parsePreference(path);
  if (current.pinned === value) {
    return { path, changed: false };
  }

  // Read the raw frontmatter + body so we can rewrite without
  // disturbing the human-authored prose ("## Principle", "## Origin",
  // "## How to apply", and any custom sections appended downstream).
  const [meta, body] = parseFrontmatter(path);
  const newMeta = { ...meta, pinned: value };
  writeFrontmatterAtomic(path, newMeta, body, {
    overwrite: true,
    existsErrorKind: "preference",
    vaultForRelativePath: vault,
  });
  // Emit the log event only on a real transition.
  const now = opts.now ?? new Date();
  const entry: BrainLogEntry = {
    timestamp: isoSecond(now),
    eventType: value ? BRAIN_LOG_EVENT_KIND.pin : BRAIN_LOG_EVENT_KIND.unpin,
    body: {
      preference: renderPrefLink({
        id: `pref-${slug}`,
        principle: current.principle,
      }),
      agent: (opts.agent ?? "cli").trim() || "cli",
    },
  };
  // One privacy verdict for both store records of this call, the pinned
  // field and the log event: the preference's own (its frontmatter, its
  // content fields), the event's body and the caller's whole input.
  const privacy = preferencePrivacy(vault, storeFieldsOf(newMeta), [
    logEventPrivacyContent(entry.body),
    callerInput({ prefId, ...opts }, PIN_INPUT_OPAQUE),
  ]);
  // Every store record written from here on, by this call or by any
  // writer it calls, carries this verdict (`store/operation-scope.ts`).
  return withOperationPrivacy(privacy, () => {
    // Brain store dual write (task 1.11): the one field this call changed,
    // filed under the preference's own scope.
    dualWrite(
      () => {
        const record = preferenceSetRecord({
          id: `pref-${slug}`,
          frontmatter: { pinned: value },
          authority: authorityFromOrigin(),
          private: privacy(),
        });
        const scope = current.scope?.trim();
        return record === null ? null : { ...record, scope: scope ? scope : null };
      },
      { vault },
    );
    appendLogEvent(vault, entry, { storePrivate: privacy });
    regenerateActiveQuiet(vault, { now });

    return { path, changed: true };
  });
}

/**
 * Read the `pinned` boolean off a parsed preference, defaulting to
 * `false`. The parser already coerces missing/null values, so this is
 * a trivial accessor — but having it as a named helper keeps `dream`'s
 * pin-skip branches readable.
 */
export function isPinned(pref: BrainPreference): boolean {
  return pref.pinned === true;
}
