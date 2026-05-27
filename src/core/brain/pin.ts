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
import { regenerateActiveQuiet } from "./active.ts";
import { appendLogEvent, type BrainLogEntry } from "./log.ts";
import { parsePreference } from "./preference.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainPreference } from "./types.ts";
import { renderPrefLink } from "./wikilink.ts";
import { BrainPreferenceNotFoundError } from "./apply-evidence.ts";

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
  appendLogEvent(vault, entry);
  regenerateActiveQuiet(vault, { now });

  return { path, changed: true };
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
