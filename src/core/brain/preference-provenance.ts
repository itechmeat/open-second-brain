/**
 * Read-time provenance join for surfaced preferences (recall lane).
 *
 * A preference's `evidenced_by` frontmatter cites its origin signals as
 * wikilinks (`[[sig-...]]`), and a signal may carry a `session_ref` —
 * the coordinates of the conversation moment the fact came from. This
 * module joins the two at READ time: parse the ref, order the origins
 * by the preference's own evidence order, and hand the caller the
 * earliest cited one. The order is the preference's `evidenced_by`
 * order — never re-sorted, and never a chronological claim: merges
 * sort evidence lexically and windowed rewrites can drop older
 * signals from the list, so `origins[0]` is the earliest origin the
 * preference cites, not the earliest signal in time. Nothing is
 * written: no new frontmatter field, no preference rewrite, so a join
 * cannot corrupt the provenance it only reads.
 *
 * Three producers write `session_ref` today, each with its own shape,
 * and the parser is per-producer aware rather than shape-guessing:
 *
 *   - import-session: `<portable basename>#<turn id>` (the ref is
 *     composed in `src/core/brain/sessions/import.ts` from
 *     `sessionRefIdentity`'s basename key; the fragment is a real
 *     turn id) — resolves with kind `turn`;
 *   - capture lifecycle: `session:<id>#<event>` (composed in
 *     `src/core/brain/session-lifecycle.ts`; the fragment is a hook
 *     event NAME — UserPromptSubmit, Stop, SessionEnd — not an event
 *     id, so every prompt-sourced signal in a session shares the one
 *     coordinate) — resolves with kind `session`: session-level
 *     provenance, labeled as what it is;
 *   - auto-extract: a bare session reference with no fragment
 *     (`src/core/brain/extract-signals.ts` stores the caller's
 *     session id verbatim) — resolves to NOTHING, because no turn is
 *     available.
 *
 * The never-guess rule governs every shape outside those three: a ref
 * that is blank, fragment-less, double-hashed, or half-empty yields no
 * provenance rather than a best-effort reading. Callers report an
 * honestly-unresolved preference instead of an invented coordinate.
 *
 * Pure and deterministic, in the `detectThreadFacets` mold
 * (thread-topics.ts): no I/O, no clock, no randomness, no imports at
 * all — the signal lookup is injected, so the same input yields the
 * same origins in the same order across calls.
 */

/** How the fragment of a parsed `session_ref` should be read. */
export type SessionRefOriginKind = "turn" | "session";

/**
 * One origin coordinate parsed from a signal's `session_ref`.
 * `sessionKey` is the ref's key segment verbatim — the portable
 * session basename for import-session refs, the `session:<id>` form
 * for capture-lifecycle refs — so a consumer never sees a rewritten
 * identity.
 */
export interface SessionRefOrigin {
  readonly sessionKey: string;
  /** The ref's fragment: a turn id (`turn`) or a hook event name (`session`). */
  readonly fragment: string;
  readonly kind: SessionRefOriginKind;
}

/** The slice of a parsed preference the join needs. */
export interface PreferenceEvidenceSource {
  /** Preference id (`pref-<slug>`); becomes the stable `pref:<id>` key. */
  readonly id: string;
  /** Origin-signal wikilinks, in the preference's own evidence order. */
  readonly evidenced_by: ReadonlyArray<string>;
}

/**
 * Signal-id → `session_ref` lookup, injected so this module stays a
 * leaf. Returns `undefined` when the signal does not exist or carries
 * no `session_ref` — both mean "contributes no origin", never an error.
 */
export type SignalSessionRefLookup = (signalId: string) => string | undefined;

/**
 * The resolved provenance of one preference. `origins` follows the
 * preference's `evidenced_by` order (never re-sorted), with duplicate
 * coordinates folded into their first position, so `origins[0]` is the
 * earliest cited origin - an evidence-order figure, never a
 * chronological claim.
 */
export interface PreferenceProvenance {
  /** Stable facet key: `pref:<preference id>`. */
  readonly key: string;
  readonly preferenceId: string;
  readonly origins: ReadonlyArray<SessionRefOrigin>;
}

/** The capture-lifecycle key prefix; the one producer key that is not a basename. */
const CAPTURE_LIFECYCLE_SCHEME = "session:";
/** The stand-in id the lifecycle writer emits when the payload carries none. */
const CAPTURE_LIFECYCLE_UNKNOWN_ID = "unknown";
/**
 * The lifecycle writer's session-id grammar: the host's session id is a
 * UUID. The prefix alone is not evidence - an imported session file could
 * be named with the same prefix, and import keys are verbatim basenames -
 * so only the documented producer shapes mark a session-level fragment.
 */
const CAPTURE_LIFECYCLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse one signal `session_ref` into its origin coordinates, or
 * `null` when the ref is absent, blank, fragment-less (the auto-extract
 * shape — no turn exists to cite), double-hashed (no producer emits
 * it), halves-empty, or `session:`-prefixed in a form neither producer
 * writes. The split is on the FIRST `#`, per the documented
 * `<key>#<fragment>` contract. A key in the capture-lifecycle writer's
 * exact forms - `session:<uuid>` or the `session:unknown` stand-in -
 * marks a hook-event fragment and resolves as `session` (session-level
 * provenance: the fragment names the hook, never a turn). Import keys
 * are verbatim basenames, so a basename that merely starts with the
 * scheme cannot be told from a lifecycle key by the ref alone: such a
 * ref yields no provenance rather than a guessed label - the
 * coordinates are never wrong, and no origin reads as no mention.
 */
export function parseSessionRef(ref: string): SessionRefOrigin | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;
  const hash = trimmed.indexOf("#");
  // Bare reference: the auto-extract producer's shape, and no other
  // writer's. No fragment means no turn to cite — no provenance.
  if (hash < 0) return null;
  // A second `#` is a shape no producer emits; reading one would be a
  // guess about which segment is the fragment.
  if (trimmed.indexOf("#", hash + 1) >= 0) return null;
  const sessionKey = trimmed.slice(0, hash);
  const fragment = trimmed.slice(hash + 1);
  if (sessionKey.length === 0 || fragment.length === 0) return null;
  if (sessionKey.startsWith(CAPTURE_LIFECYCLE_SCHEME)) {
    const id = sessionKey.slice(CAPTURE_LIFECYCLE_SCHEME.length);
    if (id === CAPTURE_LIFECYCLE_UNKNOWN_ID || CAPTURE_LIFECYCLE_ID_RE.test(id)) {
      return Object.freeze({ sessionKey, fragment, kind: "session" });
    }
    // Neither lifecycle shape: a basename that collides with the scheme
    // (or an id no writer emits). The kind cannot be read without
    // guessing - no provenance, never a guessed label.
    return null;
  }
  return Object.freeze({ sessionKey, fragment, kind: "turn" });
}

/**
 * Evidence wikilinks are written as the exact `[[<signal id>]]` form;
 * anything else (a bare id, prose embedding a link, an aliased variant)
 * is not an evidence link this join may interpret, and yields no
 * target rather than a guessed one.
 */
const EXACT_EVIDENCE_WIKILINK_RE = /^\[\[([^[\]]+)\]\]$/;

function evidenceTarget(entry: string): string | null {
  // Inside a character class a lone `[` needs no escape, so the class
  // reads "one or more characters that are neither bracket kind".
  const match = EXACT_EVIDENCE_WIKILINK_RE.exec(entry.trim());
  if (match === null) return null;
  const target = match[1]?.trim() ?? "";
  return target.length > 0 ? target : null;
}

/**
 * Resolve one preference's origin provenance: walk `evidenced_by` in
 * order, resolve each exact evidence wikilink through `lookup`, parse
 * the signal's `session_ref`, and keep the origins that resolve —
 * duplicates folded into their first position. Returns `null` when
 * nothing resolves: an honestly-unresolved preference, never an empty
 * stand-in that could read as provenance.
 */
export function resolvePreferenceProvenance(
  preference: PreferenceEvidenceSource,
  lookup: SignalSessionRefLookup,
): PreferenceProvenance | null {
  const origins: SessionRefOrigin[] = [];
  const seen = new Set<string>();
  for (const entry of preference.evidenced_by) {
    const target = evidenceTarget(entry);
    if (target === null) continue;
    const ref = lookup(target);
    if (ref === undefined) continue;
    const origin = parseSessionRef(ref);
    if (origin === null) continue;
    const dedupKey = `${origin.kind}\u0000${origin.sessionKey}\u0000${origin.fragment}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    origins.push(origin);
  }
  if (origins.length === 0) return null;
  return Object.freeze({
    key: `pref:${preference.id}`,
    preferenceId: preference.id,
    origins: Object.freeze(origins),
  });
}
