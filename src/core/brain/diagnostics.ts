/**
 * Diagnostics-signal model + guarded repair driver (Source pipeline
 * integrity suite, O2, t_bd6cc4cb).
 *
 * This module is the ONE home for the diagnostics-signal shape the wave
 * introduced: an issue class carries its own next-command hint and, when
 * a safe deterministic repair exists, its fixer. Hints travel WITH the
 * issue definition (the {@link DIAGNOSTIC_SIGNALS} registry) so no
 * downstream formatter - not the repair preview, not the O3 operator
 * snapshot - hardcodes a command string. Detection stays in its existing
 * home: `doctor.ts` produces the issue stream and this module keys off it,
 * never re-implementing a lint.
 *
 * Repair contract:
 *   - `doctor.ts` (plain / `--strict`) is read-only and byte-identical;
 *     nothing here runs unless the operator opts in with `--repair`.
 *   - `planRepair` is a pure read: it previews what `--apply` would do,
 *     DERIVED FROM the doctor's findings rather than from a scan of its
 *     own (no-dead-ends, task 9). Each fixer receives exactly the
 *     findings carrying the doctor code it covers. Neither fixer keeps a
 *     private detector: the doctor reports `dangling-workrun` from the
 *     same scan the WAL fixer used to run, and `broken-wikilink` is a
 *     superset of the orphaned-reference population.
 *   - `applyRepair({ dryRun: true })` is the preview surface (writes
 *     nothing); `{ dryRun: false }` performs the fixes and appends ONE
 *     typed `doctor-repair` event per applied fix.
 *   - Every fixer is safe, deterministic, and idempotent: a second apply
 *     finds nothing to do and writes nothing. A detected instance a fixer
 *     cannot safely repair is reported as needs-review, never silently
 *     dropped and never pretended-fixed.
 *
 * Fixers exist ONLY for issue classes the doctor already detects:
 *   - `wal-gap` closes a dangling dream workrun (an append-only,
 *     write-ahead-style checkpoint log that never reached a terminal
 *     phase) by appending the missing terminal `interrupted` marker.
 *     Additive: forensic content is preserved, the gap is closed.
 *   - `orphaned-reference` prunes a dead `evidenced_by` wikilink (a
 *     Brain-managed `pref-`/`ret-`/`sig-` target with no file) from a
 *     preference or retired record. The removed pointer is captured in
 *     the typed event, so the change is auditable and recoverable.
 *     Broken structural links (`supersedes`, `retired_by`,
 *     `superseded_by`) are reported needs-review: removing one would drop
 *     lifecycle provenance or break a required field.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeAgentArgument } from "../agent-identity.ts";
import { resolveAgentName } from "../config.ts";
import { vaultRelative } from "../path-safety.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";

import { UnclassifiedRepairCodeError, requireMechanicalRepair } from "./applier-capability.ts";

import { collectAllBasenames, runDoctor } from "./doctor.ts";
import {
  ENTITY_QUOTE_VARIANT_COLLISION_CODE,
  ENTITY_QUOTE_VARIANT_COLLISION_COMMAND,
} from "./entities/canonical.ts";
import { scanDanglingWorkruns, WORKRUN_PHASE } from "./dream-workrun.ts";
import { LINT_CONSOLIDATE_KIND } from "./lint-consolidate.ts";
import { appendLogEvent } from "./log.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, type DoctorIssue } from "./types.ts";
import { isBrainArtifactId, normaliseWikilinkTarget } from "./wikilink.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

// ----- Diagnostics-signal model --------------------------------------------

/**
 * One diagnostics signal: an issue class plus the exact CLI command an
 * operator runs next to act on it. `autoRepairable` is true only when a
 * fixer in this module can safely, idempotently repair the class.
 */
export interface DiagnosticSignal {
  /** Stable code: a doctor issue code, a fixer code, or an O3 source code. */
  readonly code: string;
  /** Short human label for the issue class. */
  readonly issueClass: string;
  /** Exact next command to run (a structural CLI string, never prose). */
  readonly nextCommand: string;
  /** True iff a fixer in this module repairs the class. */
  readonly autoRepairable: boolean;
}

/**
 * The two states of the search index FILE itself, named here so the
 * producer and the registry entry cannot drift into two spellings of one
 * code. They are separate classes because their exits differ: an absent
 * index is built incrementally, a malformed one is only ever replaced.
 */
export const SEARCH_INDEX_MISSING_CODE = "search-index-missing";
export const SEARCH_INDEX_CORRUPT_CODE = "search-index-corrupt";

/**
 * The state the memory-graph repair lane's holdout gate refuses in: at
 * least one edge the lane proposes has a target that resolves to no
 * durable-memory note, or resolves to one that hydrates into no evidence.
 * Named here beside the code it is registered under so the producer in
 * `cli/brain/verbs/repair-lane.ts` and the entry below cannot drift into
 * two spellings of one code.
 */
export const REPAIR_HOLDOUT_UNRESOLVED_CODE = "repair-holdout-unresolved";

/** Fixer codes (the two auto-repairable classes this release ships). */
export const REPAIR_CODE = Object.freeze({
  walGap: "wal-gap",
  orphanedReference: "orphaned-reference",
} as const);

/**
 * Registry: the single home for every issue class this wave surfaces and
 * its next-command hint. Doctor codes, fixer codes, and the O3 snapshot
 * source codes all resolve here so a hint is defined exactly once.
 *
 * no-dead-ends (task 5) widened the population from "issue" to "state a
 * caller can be left in": a verb that succeeded and printed nothing
 * forward is the same defect from the caller's side, and giving those
 * states a code here is what stops the command being retyped inside an
 * `ok()` string. Nothing iterates this map expecting only faults; every
 * consumer resolves by code.
 */
export const DIAGNOSTIC_SIGNALS: ReadonlyMap<string, DiagnosticSignal> = new Map(
  (
    [
      // --- Auto-repairable fixer classes ---
      {
        code: REPAIR_CODE.walGap,
        issueClass: "dangling dream workrun (WAL gap)",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      {
        code: REPAIR_CODE.orphanedReference,
        issueClass: "orphaned evidence reference",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      // --- Doctor issue classes the fixers back (kept for hint lookup) ---
      {
        code: "dangling-workrun",
        issueClass: "dangling dream workrun (WAL gap)",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      {
        code: "broken-wikilink",
        issueClass: "broken frontmatter reference",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      // --- Detected-but-not-auto-repairable doctor classes ---
      {
        code: "config-missing",
        issueClass: "missing Brain config",
        nextCommand: "o2b brain init",
        autoRepairable: false,
      },
      {
        code: "config-invalid",
        issueClass: "invalid Brain config",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "schema-version-unknown",
        issueClass: "unknown schema version",
        nextCommand: "o2b brain upgrade --apply",
        autoRepairable: false,
      },
      {
        code: "principle-corrupted",
        issueClass: "corrupted preference principle",
        nextCommand: "o2b brain upgrade --apply",
        autoRepairable: false,
      },
      {
        code: "content-hash-drift",
        issueClass: "content-hash drift",
        nextCommand: "o2b brain doctor --remediate",
        autoRepairable: false,
      },
      {
        code: "duplicate-preferences",
        issueClass: "duplicate preferences",
        nextCommand: "o2b brain merge <keep> <drop>",
        autoRepairable: false,
      },
      {
        // Two topic spellings that fold onto one dream-pass key. The exit
        // is the same as the duplicate above because the required end
        // state is the same - one owner for the key - and it is the only
        // structural command that reaches it; renaming a topic is a hand
        // edit, which a next-step hint cannot spell.
        code: "topic-key-collision",
        issueClass: "topic key claimed by two spellings",
        nextCommand: "o2b brain merge <keep> <drop>",
        autoRepairable: false,
      },
      {
        code: "orphan-evidence",
        issueClass: "orphaned apply-evidence artifact",
        nextCommand: "o2b brain audit",
        autoRepairable: false,
      },
      {
        code: "broken-backlinks",
        issueClass: "broken Brain backlink",
        nextCommand: "o2b brain backlinks",
        autoRepairable: false,
      },
      {
        // U3, silence-is-not-an-answer. The reverse of the backlink
        // question above: not "this reference points at nothing" but
        // "this reference points at something that has since changed,
        // and the thing holding it predates the change". The trail of
        // the state itself is where an operator starts, because it says
        // what the rule became and why.
        code: "stale-dependency",
        issueClass: "consumer resting on a superseded state",
        nextCommand: "o2b brain audit <pref-id>",
        autoRepairable: false,
      },
      {
        // C1, evidence-at-the-boundary. The exit is the wider view of the
        // same measurement: the check reports one fixed window, and the
        // per-channel rollup over an operator-chosen one is what says
        // whether the transport ever delivered or merely stopped.
        code: "recall-channel-silent",
        issueClass: "installed recall channel with no deliveries",
        nextCommand: "o2b brain recall-telemetry summary --channel <channel> --since <iso>",
        autoRepairable: false,
      },
      {
        code: "sync-conflict-log",
        issueClass: "sync-conflict log copy",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "contradictory-preferences",
        issueClass: "contradictory preferences",
        nextCommand: "o2b brain health",
        autoRepairable: false,
      },
      {
        code: "stale-claim",
        issueClass: "stale confirmed preference",
        nextCommand: "o2b brain stale",
        autoRepairable: false,
      },
      {
        // Issue #149. The detector has existed since the hygiene lints
        // shipped; what it never had was an exit. Recording real use is
        // the only thing that moves a cold-start rule, and the reporter
        // reached for a synthetic confidence value precisely because no
        // surface said so.
        code: "low-evidence-confirmed",
        issueClass: "confirmed rule with no recorded use",
        nextCommand: "o2b brain apply-evidence --pref <id> --artifact <artifact> --result=applied",
        autoRepairable: false,
      },
      // --- O3 operator-snapshot source classes ---
      {
        code: "doctor-errors",
        issueClass: "doctor errors",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "doctor-warnings",
        issueClass: "doctor warnings",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "semantic-health",
        issueClass: "semantic-health findings",
        nextCommand: "o2b brain health",
        autoRepairable: false,
      },
      {
        code: "hygiene-findings",
        issueClass: "hygiene findings",
        nextCommand: "o2b brain hygiene scan",
        autoRepairable: false,
      },
      {
        code: "stale-notes",
        issueClass: "stale entries",
        nextCommand: "o2b brain stale",
        autoRepairable: false,
      },
      {
        code: "review-queue",
        issueClass: "review candidates pending",
        nextCommand: "o2b brain dream --dry-run",
        autoRepairable: false,
      },
      {
        code: "state-file",
        issueClass: "state-file health",
        nextCommand: "o2b brain init",
        autoRepairable: false,
      },
      // --- Terminal states (no-dead-ends, task 5) ---
      // A verb that succeeded and left the caller with nowhere to go.
      // These are not defects, so `issueClass` reads as the STATE the
      // caller is in rather than a fault; the field is otherwise the
      // same short label every other entry carries, and the registry
      // stays the single place a structural command is written down.
      {
        code: "brain-empty",
        issueClass: "Brain with nothing recorded in it",
        nextCommand: "o2b brain feedback --topic <topic> --signal=positive --principle <principle>",
        autoRepairable: false,
      },
      {
        code: "signal-clusters-absent",
        issueClass: "no active signal clusters to review",
        nextCommand: "o2b brain feedback --topic <topic> --signal=positive --principle <principle>",
        autoRepairable: false,
      },
      {
        code: "intentions-absent",
        issueClass: "no active intention chains",
        nextCommand: "o2b brain intention set --scope <scope> --text <text>",
        autoRepairable: false,
      },
      {
        code: "search-index-built",
        issueClass: "search index up to date",
        nextCommand: "o2b search query <text>",
        autoRepairable: false,
      },
      {
        code: SEARCH_INDEX_MISSING_CODE,
        issueClass: "search index not built",
        nextCommand: "o2b search index",
        autoRepairable: false,
      },
      {
        // The state a completed `PRAGMA quick_check` reports when the
        // index file is structurally malformed - pages damaged in place
        // by a truncated sync, a half-finished replication of the vault
        // directory, or failing storage. It is deliberately NOT
        // `search-index-missing`: that state's exit is `o2b search
        // index`, which is INCREMENTAL and would walk a vault whose
        // files have not changed, decide there is nothing to do, and
        // leave every damaged page exactly where it is. Only a rebuild
        // replaces the file, so only a rebuild ends this state.
        code: SEARCH_INDEX_CORRUPT_CODE,
        issueClass: "search index failed a structural integrity check",
        nextCommand: "o2b search reindex",
        autoRepairable: false,
      },
      // --- Semantic capability tiers (provenance-at-the-boundary, F1) ---
      // WHAT THE OPERATOR CONFIGURED, resolved by
      // `core/search/capability-tier.ts` and reported by the four
      // surfaces that used to each derive it themselves - one of them by
      // assembling these very sentences beside the call. The `SearchError`
      // codes answer the different question of what a call attempted and
      // could not do; nothing reports both for one condition.
      //
      // The exit for the two blocked tiers is the pre-flight diagnostic
      // rather than an edit command: the remediation is a config key, and
      // no verb in this tool writes one. `search check` is what names the
      // key, the provider and the env var for the operator to set.
      {
        code: "semantic-capability-disabled",
        // Two configurations reach this rung - `search_semantic_enabled=false`
        // and `embedding_provider=disabled` - so the sentence names the state
        // rather than one of its causes. It is a thrown error message on the
        // explicit arm now, where naming the wrong key would send an operator
        // to edit a setting that is already correct. `o2b search check` reports
        // which of the two it is.
        issueClass: "semantic search not configured (disabled by config or provider)",
        nextCommand: "o2b search check",
        autoRepairable: false,
      },
      {
        code: "semantic-capability-key-missing",
        issueClass: "embedding_api_key not configured",
        nextCommand: "o2b search check",
        autoRepairable: false,
      },
      {
        // Not a fault - the tier an operator wants to be at. It is
        // registered because the ladder must be total: a surface that
        // resolves a label per tier cannot have one rung with no entry,
        // and the honest exit from "configured" is to populate vectors.
        code: "semantic-capability-configured",
        issueClass: "semantic search configured",
        nextCommand: "o2b search vector-backfill",
        autoRepairable: false,
      },
      // --- Vector-population states (provenance-at-the-boundary, F) ---
      // Index facts, deliberately named apart from the capability tiers:
      // a chunk with no vector is a `chunks` row with no `embeddings` row,
      // which is a first-class, already-resumable state and not a
      // degraded one.
      {
        code: "semantic-vectors-deferred",
        issueClass: "embeddings not requested this run",
        nextCommand: "o2b search vector-backfill --apply",
        autoRepairable: false,
      },
      {
        code: "semantic-vectors-pending",
        issueClass: "indexed chunks with no vector",
        nextCommand: "o2b search vector-backfill --apply",
        autoRepairable: false,
      },
      // --- Event-anchor population (provenance-at-the-boundary) ---
      // The same class of index fact as the vector states, for the same
      // reason: a schema bump migrates in place and reindexes nothing,
      // and the indexer resolves an anchor only for content that
      // changed, so a document carried over from a pre-anchor binary
      // never gets one. It is a distinct code because the remedy is a
      // distinct verb, and because "no anchor resolved" must never be
      // reported as the note declaring no date.
      {
        code: "event-anchors-pending",
        issueClass: "indexed documents with no event anchor resolved",
        nextCommand: "o2b search event-anchor-backfill --apply",
        autoRepairable: false,
      },
      // --- Oversize-chunk census (what-the-index-already-knew, task H) ---
      // The configured chunk size and the configured model's declared
      // input window are two settings that overflow each other in
      // silence: a provider that truncates server-side returns a vector
      // of the right width for a prefix of the passage, and nothing
      // local can see that it happened. The census is what makes the
      // condition observable; these are its two exits.
      {
        code: "search-chunk-window-overflow",
        issueClass: "indexed chunks larger than the embedding model's input window",
        // The chunk boundaries are what must change, and only a rebuild
        // re-cuts them - `--embeddings` because vectors computed over the
        // old boundaries do not describe the new chunks. Lowering
        // `search_chunk_size` first is what makes the rebuild different
        // from the run that produced this state; no verb in this tool
        // writes a config key, so that half is named in the warning prose
        // rather than invented as a command here.
        nextCommand: "o2b search reindex --embeddings",
        autoRepairable: false,
      },
      {
        code: "search-chunk-window-undeclared",
        issueClass: "embedding model with no declared input window",
        // Not a fault and not a pass: the check could not run. The exit
        // is the curated catalog, because a declared window is exactly
        // what distinguishes a model in that table from one outside it,
        // and switching models is a config key no verb writes.
        nextCommand: "o2b search provider presets",
        autoRepairable: false,
      },
      {
        code: "git-history-absent",
        issueClass: "no ingested git history",
        nextCommand: "o2b brain git ingest <repo-path>",
        autoRepairable: false,
      },
      {
        code: "bridge-proposals-absent",
        issueClass: "no bridge-proposal artifact yet",
        nextCommand: "o2b brain bridges discover",
        autoRepairable: false,
      },
      {
        // provenance-at-the-boundary, unit B. A caller-named write
        // landed outside the `write_binding.path_prefixes` the operator
        // declared. The exit is the per-path policy inspector, which
        // reports the binding verdict for one path beside the
        // vault-scope verdict, so the operator sees WHY the write was
        // refused and what the declaration currently admits.
        code: "write-binding-refused",
        issueClass: "caller-named write outside the declared write binding",
        nextCommand: "o2b vault inspect <relpath>",
        autoRepairable: false,
      },
      {
        code: "cli-config-absent",
        issueClass: "no machine configuration file",
        nextCommand: "o2b init --vault <path> --name <name>",
        autoRepairable: false,
      },
      {
        code: "staged-captures-pending",
        issueClass: "staged captures previewed but not routed",
        nextCommand: "o2b brain inbox-drain --apply",
        autoRepairable: false,
      },
      {
        // what-the-index-already-knew, final unit. The repair lane's
        // holdout gate refuses an apply whose proposed edges point at
        // memory that is absent or empty. The exit is the vault-wide
        // structural scan rather than the lane itself: the lane reports
        // WHICH edges fail (every decision names its action and its
        // endpoints), but what has to change is the referenced note - a
        // reference to a note that was deleted, or a note that exists
        // with nothing in it. The doctor is the surface that finds those
        // across the vault, and `--repair --apply` prunes the subset it
        // can safely repair. Deliberately NOT `broken-wikilink`: these
        // edges are not written yet, so its fixer would find nothing to
        // prune and the pointer would promise a repair that never runs.
        code: REPAIR_HOLDOUT_UNRESOLVED_CODE,
        issueClass: "proposed repair edges point at absent or empty memory",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      // The five states whose exits used to be retyped inside an `ok()`
      // string beside the rail rather than resolved through it.
      {
        code: "dream-bundles-absent",
        issueClass: "no staged dream bundles",
        nextCommand: "o2b brain dream stage",
        autoRepairable: false,
      },
      {
        code: "cluster-notes-absent",
        issueClass: "no materialized cluster notes",
        nextCommand: "o2b brain clusters run",
        autoRepairable: false,
      },
      {
        code: "recall-tuning-absent",
        issueClass: "no persisted recall tuning",
        nextCommand: "o2b brain tune run --dataset <path>",
        autoRepairable: false,
      },
      // One finding, two readings, so two codes rather than one code
      // carrying two commands: which value is authoritative - the
      // indexed one or the note's - is the operator's call, and the
      // rail's batch form prints both exits for the one state.
      {
        code: "tier-drift-restore",
        issueClass: "tier drift, indexed value authoritative",
        nextCommand: "o2b brain tiers restore <path> --apply",
        autoRepairable: false,
      },
      {
        code: "tier-drift-accept",
        issueClass: "tier drift, note value authoritative",
        nextCommand: "o2b brain tiers accept <path>",
        autoRepairable: false,
      },
      // --- Doctor classes the exit census found unregistered ---
      // The census (`tests/core/brain/doctor-exit-census.test.ts`) forced
      // every doctor code into one of two buckets. These three turned out
      // to have a genuine single command; the other twenty-four are
      // recorded as having none, with the reason, in `doctor-exits.ts`.
      {
        code: "brain-root-absent",
        issueClass: "resolved root carries no Brain layer",
        nextCommand: "o2b brain init",
        autoRepairable: false,
      },
      {
        // The exit is the REVIEW, not the repair: what follows it is
        // `tier-drift-restore` or `tier-drift-accept`, registered above,
        // and which of the two applies is per drifted note.
        code: "tier-drift",
        issueClass: "identity-field hand-edits staged",
        nextCommand: "o2b brain tiers check",
        autoRepairable: false,
      },
      {
        code: "entity-label-malformed",
        issueClass: "entity label fails the quality gate",
        nextCommand: "o2b brain entity prune",
        autoRepairable: false,
      },
      {
        // what-the-index-already-knew, task A. The identity kernel now
        // folds typographic quote variants, so two records that differ
        // only in which apostrophe an editor inserted resolve to one
        // identity key. Records that coexisted before the fold therefore
        // collide after it, at a write seam the operator did nothing new
        // to reach - and a refusal met for the first time straight after
        // an upgrade is worse than the duplicate it fixes if it names no
        // way out.
        //
        // The exit is `entity archive`, not a merge verb: there is none,
        // and there should not be one here. Which of the two records
        // keeps the identity, its history and its edges is a reading of
        // both files - the same judgement `doctor-exits.ts` records for
        // `duplicate-entity` - so the command names the one mechanical
        // step that ends the collision and leaves the choice with the
        // operator.
        //
        // PRODUCER: `doctor/entity-checks.ts`, which splits the duplicate
        // report by cause and spells this code on the half the fold
        // created. That is what makes the registration live: the doctor's
        // surfaces resolve a finding's code through the rail, so the
        // command below is what an operator is shown. The registry's own
        // write-time and read-time refusals are thrown synchronously out
        // of core - too early for the rail, and unable to import it
        // without closing a module cycle - so they interpolate
        // `ENTITY_QUOTE_VARIANT_COLLISION_COMMAND`, the same constant this
        // entry is built from.
        code: ENTITY_QUOTE_VARIANT_COLLISION_CODE,
        issueClass: "entity labels differing only in typographic quote form",
        nextCommand: ENTITY_QUOTE_VARIANT_COLLISION_COMMAND,
        autoRepairable: false,
      },
      {
        // A subtree the doctor could not enter, reported into the
        // `uncertain` stream by every sweep that walks the store by
        // hand. The CLI folds that stream into the codes it resolves
        // exits for, so an unregistered code printed the finding and
        // nothing after it - the dead end this release removes.
        //
        // The exit is the RE-READ, as with `skill-accept-locked`: no
        // command changes a mode or a mount, and the one thing an
        // operator needs after restoring access is the pass over the
        // subtree that was skipped. Registering it here rather than
        // spelling a sentence beside the notice is what keeps the
        // structural command in one place.
        code: "vault-walk-entry-skipped",
        issueClass: "subtree the doctor could not read",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      // --- Skill-accept transaction refusals (no-dead-ends, phase 3) ---
      // Both are states the accept transaction itself can leave an
      // operator in, and both used to refuse without naming a way out.
      // They are registered here rather than spelled inside the two
      // error messages so the messages resolve one structural command
      // from the same registry every other surface reads.
      {
        code: "skill-accept-journal-unreadable",
        issueClass: "unreadable skill-accept journal marker",
        nextCommand: "o2b brain skill-proposals recover --discard-unreadable",
        autoRepairable: false,
      },
      {
        // The exit is the INSPECTION, not a repair: nothing breaks a
        // lock automatically, so what the operator needs first is the
        // full list of locks under the Brain tree with their paths.
        // Removing the file stays a human judgement - see the
        // `stale-lock` refusal in `applier-capability.ts`.
        code: "skill-accept-locked",
        issueClass: "skill-accept lock held",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      // --- Runtime-notice conditions (no-dead-ends, task 3) ---
      // The notice channel pushes a transient condition at the agent
      // (SessionStart injection, `vault_health`, the onboarding
      // checklist) rather than waiting to be polled, and it spells its
      // codes in the snake case its wire records use. Registering them
      // here is what lets a notice carry a structural command instead of
      // an English "Run: ..." tail a consumer has to regex.
      //
      // `search_index_missing` is the same condition the kebab-cased
      // `search-index-missing` terminal state reports from `o2b search
      // check`, and deliberately resolves to the same command: two
      // emitters, two code vocabularies, one exit. Only the codes with a
      // genuine single exit are listed - `vault_read_only`,
      // `vault_marker_absent`, `brain_config_unreadable` and
      // `reindex_in_progress` have none, each for a reason written down
      // beside the notice that raises it.
      {
        code: "search_index_missing",
        issueClass: "search index not built",
        nextCommand: "o2b search index",
        autoRepairable: false,
      },
      {
        code: "semantic_degraded",
        issueClass: "semantic search fell back to lexical",
        nextCommand: "o2b search check",
        autoRepairable: false,
      },
      // --- Capture-routing states (signals-that-survive, unit 4) ---
      // A capture that resolved no scope is recorded and unroutable: it
      // is not a fault - the write is exactly what the operator asked
      // for - but it leaves the signal in the one bucket no scoped
      // recall reaches. The exit is to re-record the SAME capture with
      // the routing signal it lacked, which is why the command carries
      // `--scope`: without it this entry would be indistinguishable
      // from `brain-empty`'s.
      // --- Self-healing lint classes (evidence-at-the-boundary, task A4) ---
      // Both were registered in `applier-capability.ts` as mechanically
      // repairable and NOWHERE here, so `nextCommandField("fix-merged-link")`
      // resolved to nothing: the table published that a fixer exists while
      // no surface could say what to run to reach it. The write-time page
      // lint carries the first of the two on a finding, which is what made
      // the omission observable.
      //
      // Both resolve to the same command because one pass performs both
      // repairs; `--yes` rides along because `--apply` refuses without it
      // on any non-interactive stream, which is every stream an agent has.
      {
        code: LINT_CONSOLIDATE_KIND.mergedLink,
        issueClass: "wikilink pointing at a page merged away",
        nextCommand: "o2b brain lint --consolidate --apply --yes",
        autoRepairable: true,
      },
      {
        code: LINT_CONSOLIDATE_KIND.staleStableDemotion,
        issueClass: "stable preference aged out with no verification",
        nextCommand: "o2b brain lint --consolidate --apply --yes",
        autoRepairable: true,
      },
      {
        code: "capture-scope-absent",
        issueClass: "capture recorded with no routing scope",
        nextCommand:
          "o2b brain feedback --topic <topic> --signal=positive --principle <principle> --scope <scope>",
        autoRepairable: false,
      },
    ] satisfies ReadonlyArray<DiagnosticSignal>
  ).map((s) => [s.code, Object.freeze(s)]),
);

/**
 * Resolve a signal by code, LENIENTLY. An unregistered code does not
 * resolve: this function fabricates a generic `o2b brain doctor` signal
 * whose `issueClass` is the raw code. That value is invented here, it is
 * not a registry entry, and it does not mean the code is known.
 *
 * Kept for its two existing consumers (the O3 operator snapshot and the
 * repair planner's unfixable aggregation), whose output shape predates
 * this release. New consumers MUST use `resolveNextStep` in
 * `next-step.ts`, which returns an explicit absent result instead of a
 * guessed command.
 */
export function resolveSignal(code: string): DiagnosticSignal {
  const known = DIAGNOSTIC_SIGNALS.get(code);
  if (known) return known;
  return Object.freeze({
    code,
    issueClass: code,
    nextCommand: "o2b brain doctor",
    autoRepairable: false,
  });
}

// ----- Repair plan shapes ---------------------------------------------------

/** One planned fix (applicable) or a detected-but-needs-review instance. */
export interface RepairItem {
  /** Fixer code ({@link REPAIR_CODE}). */
  readonly code: string;
  /** Stable, vault-relative target identifier the fix acts on. */
  readonly target: string;
  /** True when a fixer can safely apply this; false = needs-review. */
  readonly applicable: boolean;
  /** One-line human description of the planned action. */
  readonly detail: string;
  /** Why the instance is needs-review (present iff `applicable` is false). */
  readonly reason?: string;
}

/** A detected issue class with no fixer, aggregated for the preview. */
export interface UnfixableClass {
  readonly code: string;
  readonly issueClass: string;
  readonly count: number;
  readonly nextCommand: string;
}

export interface RepairPlan {
  /** Every fixer finding: applicable fixes plus needs-review instances. */
  readonly fixes: ReadonlyArray<RepairItem>;
  /** Detected classes no fixer addresses, each with its next command. */
  readonly unfixable: ReadonlyArray<UnfixableClass>;
}

// ----- Fixers ---------------------------------------------------------------

/**
 * A doctor finding did not carry the data its fixer needs to plan from.
 *
 * Raised, not skipped (no-dead-ends, task 9). A `dangling-workrun` with
 * no path, or a `broken-wikilink` with no field or target, means the
 * detector and this module disagree about the finding contract; dropping
 * the item would report a complete plan that had silently omitted a
 * detected defect.
 */
export class MalformedDoctorFindingError extends Error {
  readonly code: string;
  readonly missingField: string;

  constructor(code: string, missingField: string) {
    super(
      `doctor finding ${JSON.stringify(code)} carries no ${JSON.stringify(missingField)}, ` +
        "so the fixer for it cannot derive a repair target",
    );
    this.name = "MalformedDoctorFindingError";
    this.code = code;
    this.missingField = missingField;
  }
}

/**
 * A fixer owns one auto-repairable class. `coversDoctorCode` is the
 * doctor issue code the fixer represents: the planner hands it exactly
 * the findings carrying that code, and excludes the code from the
 * needs-a-different-tool `unfixable` list.
 *
 * `plan` receives those findings rather than the vault alone. Both
 * fixers' classes are reported in FULL by the doctor - `dangling-workrun`
 * comes from the same `scanDanglingWorkruns` the fixer used to call, and
 * `broken-wikilink` is a superset of the orphaned-reference population
 * (it also reports targets outside the Brain id space, which this fixer
 * skips) - so neither retains an independent scan. `vault` is still
 * passed because a repair target is vault-relative; it is not a licence
 * to look for work the findings did not name.
 */
interface Fixer {
  readonly code: string;
  readonly coversDoctorCode: string;
  plan(vault: string, findings: ReadonlyArray<DoctorIssue>): RepairItem[];
  /** Apply one applicable item. Returns null on an idempotent no-op. */
  apply(vault: string, item: RepairItem): AppliedFix | null;
}

/** Doctor field name for the evidence list; its raw key is `_evidenced_by`. */
const DOCTOR_EVIDENCE_FIELD = "evidenced_by";

/** Separator between the parts of an `orphaned-reference` target id. */
const TARGET_SEP = "::";
/** Raw frontmatter key for the derived evidence list. */
const EVIDENCED_BY_KEY = "_evidenced_by";

function isBrokenBrainRef(raw: string, known: ReadonlySet<string>): string | null {
  const target = normaliseWikilinkTarget(raw);
  if (!target) return null;
  if (!isBrainArtifactId(target)) return null; // external / non-Brain link: leave it
  if (known.has(target)) return null;
  return target;
}

const walGapFixer: Fixer = {
  code: REPAIR_CODE.walGap,
  coversDoctorCode: "dangling-workrun",
  plan(vault: string, findings: ReadonlyArray<DoctorIssue>): RepairItem[] {
    return findings.map((issue) => {
      if (issue.path === undefined) throw new MalformedDoctorFindingError(issue.code, "path");
      const rel = vaultRelative(issue.path, vault);
      return {
        code: REPAIR_CODE.walGap,
        target: rel,
        applicable: true,
        detail: `close dangling workrun ${rel} with a terminal 'interrupted' marker`,
      };
    });
  },
  apply(vault: string, item: RepairItem): AppliedFix | null {
    const path = join(vault, item.target);
    if (!existsSync(path)) return null;

    let handle: ReturnType<typeof acquireLockSync>;
    try {
      handle = acquireLockSync(path);
    } catch {
      return null; // contended: leave for a later run
    }
    try {
      // Re-check under the lock so two concurrent repairs cannot both observe
      // the run as dangling and append duplicate terminal markers (idempotent).
      if (!scanDanglingWorkruns(vault).some((p) => vaultRelative(p, vault) === item.target)) {
        return null;
      }
      const line =
        JSON.stringify({
          phase: WORKRUN_PHASE.interrupted,
          at: new Date().toISOString(),
          reason: "closed by doctor --repair",
        }) + "\n";
      const existing = readFileSync(path, "utf8");
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(path, prefix + line, "utf8");
      return {
        code: item.code,
        target: item.target,
        detail: item.detail,
      };
    } finally {
      handle.release();
    }
  },
};

const orphanedReferenceFixer: Fixer = {
  code: REPAIR_CODE.orphanedReference,
  coversDoctorCode: "broken-wikilink",
  plan(vault: string, findings: ReadonlyArray<DoctorIssue>): RepairItem[] {
    const items: RepairItem[] = [];
    for (const issue of findings) {
      if (issue.path === undefined) throw new MalformedDoctorFindingError(issue.code, "path");
      if (issue.field === undefined) throw new MalformedDoctorFindingError(issue.code, "field");
      if (issue.target === undefined) throw new MalformedDoctorFindingError(issue.code, "target");
      // The doctor reports every unresolvable basename; only Brain-managed
      // ids are this fixer's business. An external / non-Brain link is
      // left exactly where it is, as it always was.
      if (!isBrainArtifactId(issue.target)) continue;
      const rel = vaultRelative(issue.path, vault);
      items.push(
        issue.field === DOCTOR_EVIDENCE_FIELD
          ? evidencePrune(rel, issue.target)
          : structuralReview(rel, issue.field, issue.target),
      );
    }
    return items;
  },
  apply(vault: string, item: RepairItem): AppliedFix | null {
    const [rel, field, dead] = item.target.split(TARGET_SEP);
    if (rel === undefined || field !== EVIDENCED_BY_KEY || dead === undefined) return null;
    const path = join(vault, rel);
    if (!existsSync(path)) return null;
    const known = collectAllBasenames(vault);

    let handle: ReturnType<typeof acquireLockSync>;
    try {
      handle = acquireLockSync(path);
    } catch {
      return null; // contended: leave for a later run
    }
    try {
      const [meta, body] = parseFrontmatter(path);
      const arr = meta[EVIDENCED_BY_KEY];
      if (!Array.isArray(arr)) return null;
      const next = arr.filter((raw) => {
        if (typeof raw !== "string") return true;
        const broken = isBrokenBrainRef(raw, known);
        return broken !== dead; // drop exactly the still-dead target
      });
      if (next.length === arr.length) return null; // idempotent no-op
      meta[EVIDENCED_BY_KEY] = next;
      // Keep the human `## Origin` prose consistent: drop the matching
      // `- [[dead]]` bullet so the same dead target cannot re-surface as a
      // body-side broken-backlink after the frontmatter is pruned.
      const nextBody = removeOriginBullet(body, dead);
      writeFrontmatterAtomic(path, meta, nextBody, { overwrite: true });
      return { code: item.code, target: item.target, detail: item.detail };
    } finally {
      handle.release();
    }
  },
};

function evidencePrune(rel: string, dead: string): RepairItem {
  return {
    code: REPAIR_CODE.orphanedReference,
    target: [rel, EVIDENCED_BY_KEY, dead].join(TARGET_SEP),
    applicable: true,
    detail: `prune orphaned evidence [[${dead}]] from ${rel}`,
  };
}

function structuralReview(rel: string, field: string, dead: string): RepairItem {
  return {
    code: REPAIR_CODE.orphanedReference,
    target: [rel, field, dead].join(TARGET_SEP),
    applicable: false,
    detail: `${rel} has a broken '${field}' link [[${dead}]]`,
    reason:
      "removing a structural lifecycle link would drop provenance or break a required field; " +
      "reconcile it manually",
  };
}

/**
 * Remove every `- [[<dead>...]]` bullet from a preference/retired body so
 * the `## Origin` prose stops naming a target the frontmatter no longer
 * references. Only bullet lines whose wikilink normalises to `dead` are
 * dropped; all other body content is preserved verbatim.
 */
function removeOriginBullet(body: string, dead: string): string {
  const lines = body.split("\n");
  let inOrigin = false;
  const kept = lines.filter((line) => {
    // Track section boundaries so a matching bullet outside `## Origin` (in
    // Notes, How-to-apply, or any other section) is never dropped.
    if (/^#{1,6}\s+/.test(line)) {
      inOrigin = /^##\s+Origin\s*$/.test(line);
      return true;
    }
    if (!inOrigin) return true;
    const m = /^\s*-\s+(\[\[.+?\]\])\s*$/.exec(line);
    if (!m) return true;
    return normaliseWikilinkTarget(m[1]!) !== dead;
  });
  return kept.join("\n");
}

const FIXERS: ReadonlyArray<Fixer> = Object.freeze([walGapFixer, orphanedReferenceFixer]);
const FIXER_BY_CODE: ReadonlyMap<string, Fixer> = new Map(FIXERS.map((f) => [f.code, f]));
const COVERED_DOCTOR_CODES: ReadonlySet<string> = new Set(FIXERS.map((f) => f.coversDoctorCode));

/**
 * The classes this module's fixers repair, as a read-only set. Exported
 * so the applier capability table can be checked against the registry
 * that actually decides (no-dead-ends, task 8) rather than against a
 * hand-maintained copy of it.
 */
export const REPAIR_FIXER_CODES: ReadonlySet<string> = Object.freeze(
  new Set(FIXERS.map((f) => f.code)),
);

// ----- Planner --------------------------------------------------------------

export interface PlanRepairOptions {
  /**
   * The doctor findings to derive the plan from. Omitted, `planRepair`
   * runs the doctor itself, which is what every production caller does.
   *
   * Supplying them is how a caller that has ALREADY run the doctor avoids
   * a second full pass, and it is the seam that makes the derivation
   * observable: hand in findings that do not match the disk and the plan
   * follows the findings, which is the property a re-scanning planner
   * cannot have.
   */
  readonly issues?: ReadonlyArray<DoctorIssue>;
}

/**
 * Preview what a repair would do. Pure read.
 *
 * The plan is DERIVED FROM the doctor's findings (no-dead-ends, task 9).
 * Each fixer is handed exactly the findings carrying the doctor code it
 * covers and derives its items from those; it does not scan for work of
 * its own. Before this, every fixer re-scanned the vault independently
 * while the doctor's findings sat beside them consulted only for counts,
 * so the applier shared the detector's vocabulary without consuming its
 * output and nothing forced the two to agree.
 *
 * The remaining classes - the ones no fixer covers - are aggregated from
 * the same findings, each with its next-command hint.
 */
export function planRepair(vault: string, opts: PlanRepairOptions = {}): RepairPlan {
  const issues = opts.issues ?? collectDoctorIssues(vault);

  const fixes: RepairItem[] = [];
  for (const fixer of FIXERS) {
    fixes.push(
      ...fixer.plan(
        vault,
        issues.filter((i) => i.code === fixer.coversDoctorCode),
      ),
    );
  }

  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (COVERED_DOCTOR_CODES.has(issue.code)) continue;
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  const unfixable: UnfixableClass[] = [...counts.entries()]
    .map(([code, count]) => {
      const sig = resolveSignal(code);
      return {
        code,
        issueClass: sig.issueClass,
        count,
        nextCommand: sig.nextCommand,
      };
    })
    .toSorted((a, b) => a.code.localeCompare(b.code));

  return Object.freeze({ fixes: Object.freeze(fixes), unfixable: Object.freeze(unfixable) });
}

/** The doctor's errors and warnings as one stream, in report order. */
function collectDoctorIssues(vault: string): ReadonlyArray<DoctorIssue> {
  const doctor = runDoctor(vault);
  return [...doctor.errors, ...doctor.warnings];
}

// ----- Apply ----------------------------------------------------------------

export interface AppliedFix {
  readonly code: string;
  readonly target: string;
  readonly detail: string;
  /** Absolute path of the log file the typed event landed in (apply only). */
  readonly logPath?: string;
}

export interface RepairOutcome {
  readonly dryRun: boolean;
  /** Fixes that were (or, under dry-run, would be) applied. */
  readonly applied: ReadonlyArray<AppliedFix>;
  /** Detected-but-needs-review instances a fixer will not touch. */
  readonly needsReview: ReadonlyArray<RepairItem>;
  /** Detected classes no fixer addresses. */
  readonly unfixable: ReadonlyArray<UnfixableClass>;
}

export interface ApplyRepairOptions {
  /** True previews without writing; false performs the fixes. */
  readonly dryRun: boolean;
  /** Wall clock for the typed event timestamps. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Agent identity recorded on each event. Resolver default when blank. */
  readonly agent?: string;
  /** Config path for the agent-name resolver. */
  readonly configPath?: string;
}

/**
 * Run the guarded repair. `dryRun: true` returns exactly what would be
 * applied and writes nothing; `dryRun: false` performs each applicable
 * fix and appends one typed `doctor-repair` event per fix that actually
 * changed disk. Idempotent: a second non-dry-run call finds nothing to do.
 */
export function applyRepair(vault: string, opts: ApplyRepairOptions): RepairOutcome {
  // Vault-identity write guard (context-integrity-gates, Unit J), placed
  // per the one rule the three appliers now share: at the entry point,
  // before any other work, and only when the call will write. A dry run
  // previews and writes nothing, so it stays ungated. See the write-guard
  // section of `applier-capability.ts`.
  if (opts.dryRun !== true) assertVaultIdentityForWrite(vault);
  const plan = planRepair(vault);
  const needsReview = plan.fixes.filter((f) => !f.applicable);
  const applicable = plan.fixes.filter((f) => f.applicable);

  if (opts.dryRun) {
    const applied = applicable.map((f) => ({ code: f.code, target: f.target, detail: f.detail }));
    return Object.freeze({
      dryRun: true,
      applied: Object.freeze(applied),
      needsReview: Object.freeze(needsReview),
      unfixable: plan.unfixable,
    });
  }

  const agent = normalizeAgentArgument(opts.agent ?? null) ?? resolveAgentName(opts.configPath);
  const timestamp = isoSecond(opts.now ?? new Date());
  const applied: AppliedFix[] = [];
  for (const item of applicable) {
    // The capability table is the published statement that this code has
    // a mechanical repair; the registry is the thing that performs it.
    // Consulting the table first turns a disagreement between the two
    // into a named error instead of the silent `continue` that used to
    // stand here - which would have dropped an applicable item on the
    // floor and still reported success.
    requireMechanicalRepair(item.code);
    const fixer = FIXER_BY_CODE.get(item.code);
    if (fixer === undefined) throw new UnclassifiedRepairCodeError(item.code);
    const result = fixer.apply(vault, item);
    if (!result) continue; // idempotent no-op: nothing changed, no event
    const res = appendLogEvent(vault, {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.doctorRepair,
      body: { code: result.code, target: result.target, detail: result.detail, agent },
    });
    applied.push({ ...result, logPath: res.logPath });
  }

  return Object.freeze({
    dryRun: false,
    applied: Object.freeze(applied),
    needsReview: Object.freeze(needsReview),
    unfixable: plan.unfixable,
  });
}
