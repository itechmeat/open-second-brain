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
 * On a store-only machine (task 2.10) the flip is one `preference-set`
 * record of the field, read against the store's fold; no page changes.
 *
 * A successful flip emits a `pin` or `unpin` log event via
 * `appendLogEvent`. A no-op (`changed: false`) emits no log entry — the
 * log is reserved for state transitions, not redundant calls.
 */

import { legacyVaultOf } from "./no-vault.ts";
import { existsSync } from "node:fs";

import { writeFrontmatterAtomic, parseFrontmatter } from "../vault.ts";
import { authorityFromOrigin } from "../store/dual-write.ts";
import { routeWrite } from "../store/store-write.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { preferenceSetRecord } from "../store/dual-write-records.ts";
import { callerInput, opaqueFields } from "../store/operation-privacy.ts";
import { regenerateActiveQuiet } from "./active.ts";
import { appendLogEvent, logEventPrivacyContent, type BrainLogEntry } from "./log.ts";
import {
  loadPreference,
  preferencePrivacy,
  storeFieldsOf,
  storePreferenceMeta,
} from "./preference.ts";
import { preferencesStoreOnly } from "./preference-store.ts";
import { preferencePathOf, validateSlug } from "./paths.ts";
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
  vault: string | null,
  prefId: string,
  value: boolean,
  opts: SetPinnedOptions = {},
): SetPinnedResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). With no
  // vault the store write checks the store identity instead (D14 item 13).
  if (vault !== null) assertVaultIdentityForWrite(vault);
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
  const path = preferencePathOf(vault, slug);
  // Store-only (task 2.10), and always with no vault: the preference is the
  // store's fold and the flip is one `preference-set` record; no page is
  // rewritten.
  const storeOnly = vault === null || preferencesStoreOnly(vault);
  // Parse the preference once, to drive the idempotency check off the
  // canonical boolean (rather than the raw frontmatter string), and to
  // validate its shape before we rewrite it. A corrupt preference here
  // is a hard error — the caller asked us to mutate a specific rule;
  // we refuse to make that decision blindly. `null` is "no such
  // preference" in both modes (no page, or no live fold entry).
  const loaded = storeOnly || existsSync(path) ? loadPreference(vault, slug) : null;
  if (loaded === null) throw new BrainPreferenceNotFoundError(`pref-${slug}`, path);
  const current: BrainPreference = loaded;
  if (current.pinned === value) {
    return { path, changed: false };
  }

  // Read the raw frontmatter + body so we can rewrite without
  // disturbing the human-authored prose ("## Principle", "## Origin",
  // "## How to apply", and any custom sections appended downstream).
  // The preference's fields, for the privacy verdict below.
  const meta = storeOnly ? (storePreferenceMeta(slug)?.meta ?? {}) : parseFrontmatter(path)[0];
  const newMeta = { ...meta, pinned: value };
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
    // On a store-only machine that record is the whole write.
    const routed = routeWrite({
      // The page is read again inside the write: whatever mode the route
      // decides on, the legacy page keeps its own prose and frontmatter.
      legacy: () => {
        const [pageMeta, pageBody] = parseFrontmatter(path);
        return writeFrontmatterAtomic(path, { ...pageMeta, pinned: value }, pageBody, {
          overwrite: true,
          existsErrorKind: "preference",
          vaultForRelativePath: legacyVaultOf(vault, "setPinned"),
        });
      },
      store: () => {
        const record = preferenceSetRecord({
          id: `pref-${slug}`,
          frontmatter: { pinned: value },
          authority: authorityFromOrigin(),
          private: privacy(),
        });
        const scope = current.scope?.trim();
        return record === null ? null : { ...record, scope: scope ? scope : null };
      },
      context: { vault },
    });
    appendLogEvent(vault, entry, { storePrivate: privacy });
    // The digest is a page of the legacy tree; a store-only machine renders
    // it on demand (design D14 item 7). Decided by the route the write took.
    if (routed.mode === "legacy") regenerateActiveQuiet(legacyVaultOf(vault, "setPinned"), { now });

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
