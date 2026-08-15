/**
 * Census over the closed verdict vocabularies.
 *
 * The silence-is-not-an-answer wave turns "could not check" into a
 * first-class value in several unrelated subsystems. Each one owns its own
 * vocabulary, because a suppression status, a coverage verdict and an
 * archive-inclusion decision are not the same type - but they all follow
 * one convention this project already uses: a frozen object of values, a
 * companion list of members, and a type guard that decides whether a
 * string read back off disk is one of them.
 *
 * That trio can drift. A value added to the object and forgotten in the
 * list makes the guard reject a value the code itself produces; a guard
 * written against a stale list silently rejects a member. Grounding found
 * exactly this class already shipped elsewhere - a status list copied as a
 * literal into a tool schema with nothing asserting the two agree.
 *
 * This file is the assertion that they agree. Every vocabulary the wave
 * introduces registers below, and so does any closed vocabulary whose
 * values the wave copies OUT of TypeScript - a code interpolated into an
 * emitted shell script is the same drift risk by another route.
 *
 * It deliberately does NOT require values to be unique across
 * vocabularies. An absent config file and an absent store file are both
 * honestly named `absent`, and forcing them apart would buy nothing.
 *
 * ## The population is READ, not remembered
 *
 * The registry below used to be the whole file: a hand-written list of
 * imports, auditing the vocabularies somebody remembered to add and
 * nothing at all about the ones they did not. A new module carrying a
 * duplicate value, a phantom member and a guard that accepts every
 * string ran clean, because an unregistered vocabulary was invisible.
 * {@link scanVocabularies} closes that: it walks `src/`, finds every
 * vocabulary that carries the FOUR-PIECE shape, and
 * {@link CENSUS} must account for each one.
 *
 * The four pieces, all four required and all four in one module:
 *
 *   1. `const NAME = Object.freeze({ … })` whose every entry is
 *      `key: "string literal"`;
 *   2. a union derived from it - `(typeof NAME)[keyof typeof NAME]`;
 *   3. a membership list built from it - a const initialised from
 *      `Object.values(NAME)` or from an array of `NAME.member`;
 *   4. a guard: a function or arrow taking a parameter typed `unknown`
 *      that reads the membership list or the object.
 *
 * All four, because all four is exactly what {@link auditVocabulary}
 * audits: two of its seven checks ask what the guard accepts, and an
 * object with no guard is one whose values never have to survive the
 * round trip through a string that the guard exists to police.
 * Widening the rule to three pieces would also enrol lists that are
 * curated ORDERINGS rather than membership - `DREAM_STEP_RUNNABLE` (the
 * steps that can be run on their own) and `DREAM_GATE_NAMES` (the gates
 * an operator may override). Both name every member of their object
 * today; the day one of them does not - a step that cannot run alone, a
 * gate that is not overridable - that is a correct divergence, and a
 * census that reported it as drift would be teaching contributors to
 * ignore it. That is also why there is no exemption list here: a
 * construct with all four pieces has nothing to be excused from, and an
 * empty escape hatch is an invitation rather than a policy.
 *
 * ## What the scan cannot see, stated rather than implied
 *
 * It reads text, not a parse tree - this repository has one runtime
 * dependency and no TypeScript AST library - so it masks comments and
 * string CONTENTS before matching (a `"{"` inside a value cannot
 * mis-terminate a body) and then reads brackets. What that still leaves:
 *
 *   - A vocabulary SPLIT ACROSS MODULES: object here, membership list or
 *     guard there. Detection is per-file, so a split trio is out of
 *     population entirely. No vocabulary in this tree is split.
 *   - A vocabulary with no membership list or no guard. Two pieces are
 *     not the idiom, and there is nothing for the audit to compare -
 *     but it is the cheapest way to leave the population, so it is named
 *     here rather than left for a reader to discover.
 *   - Values that are not literals in the object: a spread of another
 *     object, a computed key's value, a value built by a call. Any of
 *     these drops the object out of the population.
 *   - A guard whose parameter is typed `string`. It is a guard that can
 *     only be called once the caller proved what it was asked to prove,
 *     and the idiom's own rule is `unknown`.
 *   - Trees other than `src/`. `hooks/`, `scripts/` and `plugins/`
 *     declare no derived-union vocabulary today; if one appears there it
 *     is invisible until this root list grows.
 *   - Code inside a `${…}` interpolation: a template literal is blanked
 *     whole, so a vocabulary piece written inside one is not read. A
 *     template can also legally span lines, which is why the masker's
 *     "a quote with no partner on this line is not a string" rule - the
 *     rule that keeps a regex literal such as `/["]/` from blanking the
 *     rest of a module - applies to `"` and `'` only.
 *
 * The progress census next door reads its population the same way, off a
 * lexed view with offsets preserved, and states its own blind spots in
 * the same place. Two censuses, one technique; the shared lexer they both
 * deserve is a consolidation neither owns alone.
 *
 * Each of those is a shape a future contributor could write. The
 * "the scan sees the shapes it claims to" block below pins the ones it
 * DOES see, one synthetic module per shape - and, in the same block, the
 * frozen objects that must stay OUT - so a scan that quietly stops
 * matching fails by name instead of reporting a smaller population.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  isSchemaPackIntegrityStatus,
  isSchemaPackUnverifiedReason,
  SCHEMA_PACK_INTEGRITY,
  SCHEMA_PACK_INTEGRITY_STATUSES,
  SCHEMA_PACK_UNVERIFIED_REASON,
  SCHEMA_PACK_UNVERIFIED_REASONS,
} from "../../../src/core/brain/schema-integrity.ts";
import {
  isNegativeRecallState,
  isNegativeRecallUnknownReason,
  isRetractionEvidenceKind,
  NEGATIVE_RECALL_STATE,
  NEGATIVE_RECALL_STATES,
  NEGATIVE_RECALL_UNKNOWN_REASON,
  NEGATIVE_RECALL_UNKNOWN_REASONS,
  RETRACTION_EVIDENCE_KIND,
  RETRACTION_EVIDENCE_KINDS,
} from "../../../src/core/brain/negative-recall.ts";
import {
  isStaleDependencyConsumerKind,
  isStaleDependencyStateKind,
  STALE_DEPENDENCY_CONSUMER,
  STALE_DEPENDENCY_CONSUMERS,
  STALE_DEPENDENCY_STATE,
  STALE_DEPENDENCY_STATES,
} from "../../../src/core/brain/doctor/stale-dependency-check.ts";
import {
  isSnapshotStoreExclusionReason,
  SNAPSHOT_STORE_EXCLUSION,
  SNAPSHOT_STORE_EXCLUSION_REASONS,
} from "../../../src/core/brain/manifest.ts";
import {
  isSnapshotEntrySkipReason,
  isSnapshotPruneRefusal,
  SNAPSHOT_ENTRY_SKIP_REASON,
  SNAPSHOT_ENTRY_SKIP_REASONS,
  SNAPSHOT_PRUNE_REFUSAL,
  SNAPSHOT_PRUNE_REFUSALS,
} from "../../../src/core/brain/snapshot.ts";
import { GATE_MODE, GATE_MODES, isGateMode } from "../../../src/core/integrity/stamp.ts";
import {
  isTriggerStatus,
  TRIGGER_STATUS,
  TRIGGER_STATUSES,
} from "../../../src/core/brain/triggers/types.ts";
import {
  BRAIN_SNAPSHOT_REASON,
  BRAIN_SNAPSHOT_REASONS,
  isBrainSnapshotReason,
} from "../../../src/core/brain/types.ts";
import {
  GRAPH_HEALTH_CODE_LIST,
  GRAPH_HEALTH_CODES,
  isGraphHealthCode,
} from "../../../src/core/partner/codegraph-health.ts";
import {
  isRecallInjectFault,
  RECALL_INJECT_FAULT,
  RECALL_INJECT_FAULTS,
} from "../../../src/core/brain/recall-inject.ts";
import {
  isRecallChannel,
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  RECALL_CHANNEL,
  RECALL_CHANNELS,
  RECALL_TELEMETRY_MODE,
  RECALL_TELEMETRY_MODES,
  RECALL_TELEMETRY_STATUS,
  RECALL_TELEMETRY_STATUSES,
} from "../../../src/core/brain/recall-telemetry.ts";
import {
  isMaterializeFreshness,
  isMaterializeStaleReason,
  isMaterializeUnknownReason,
  MATERIALIZE_FRESHNESS,
  MATERIALIZE_FRESHNESS_STATES,
  MATERIALIZE_STALE_REASON,
  MATERIALIZE_STALE_REASONS,
  MATERIALIZE_UNKNOWN_REASON,
  MATERIALIZE_UNKNOWN_REASONS,
} from "../../../src/core/brain/staleness.ts";
import {
  isReadinessStatus,
  READINESS_STATUS,
  READINESS_STATUSES,
} from "../../../src/core/doctor-readiness.ts";
import {
  isRetrievalDegradationCode,
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_DEGRADATION_CODES,
} from "../../../src/core/search/retrieval-trail.ts";
import {
  isPageLintSkipReason,
  PAGE_LINT_SKIP_REASON,
  PAGE_LINT_SKIP_REASONS,
} from "../../../src/core/brain/page-lint.ts";
import {
  EGRESS_REDACTION,
  EGRESS_REDACTION_STATUSES,
  isEgressRedactionStatus,
} from "../../../src/core/egress/registry.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_OUTCOMES,
  isEgressOutcome,
} from "../../../src/core/egress/guard.ts";
import {
  isProviderProbeState,
  PROVIDER_PROBE,
  PROVIDER_PROBE_STATES,
} from "../../../src/core/search/provider-probe.ts";
import {
  isPreferenceRestoreFailure,
  PREFERENCE_RESTORE_FAILURE,
  PREFERENCE_RESTORE_FAILURES,
} from "../../../src/core/brain/portability/preference-restore.ts";
import {
  isSchemaCompletenessRule,
  isSchemaNodeKind,
  SCHEMA_COMPLETENESS_RULE,
  SCHEMA_COMPLETENESS_RULES,
  SCHEMA_NODE_KIND,
  SCHEMA_NODE_KINDS,
} from "../../../src/mcp/registry-guard.ts";
import {
  isRecoverabilityBlocker,
  isRecoverabilityState,
  isRecoveryCoverage,
  RECOVERABILITY_BLOCKER,
  RECOVERABILITY_BLOCKERS,
  RECOVERABILITY_STATE,
  RECOVERABILITY_STATES,
  RECOVERY_COVERAGE,
  RECOVERY_COVERAGES,
} from "../../../src/core/brain/gates/recoverability.ts";
import {
  BASENAME_REWRITE,
  BASENAME_REWRITES,
  INDEX_EVIDENCE,
  INDEX_EVIDENCE_STATES,
  isBasenameRewrite,
  isIndexEvidenceState,
  isNoteLifecycleAction,
  NOTE_LIFECYCLE_ACTION,
  NOTE_LIFECYCLE_ACTIONS,
} from "../../../src/core/brain/notes/lifecycle.ts";
import {
  DANGLING_SCAN,
  DANGLING_SCANS,
  isDanglingScan,
} from "../../../src/core/brain/notes/scaffold-stub.ts";
import {
  isStubScaffoldAction,
  STUB_SCAFFOLD_ACTION,
  STUB_SCAFFOLD_ACTIONS,
} from "../../../src/mcp/brain/lifecycle-file-tools.ts";
import {
  isSessionAdapterId,
  SESSION_ADAPTER_ID,
  SESSION_ADAPTER_IDS,
} from "../../../src/core/brain/sessions/types.ts";
import {
  isTranscriptScan,
  TRANSCRIPT_SCAN,
  TRANSCRIPT_SCANS,
} from "../../../src/core/discipline/transcripts/types.ts";
import {
  IMPORT_WRITE_MODE,
  IMPORT_WRITE_MODES,
  isImportWriteMode,
} from "../../../src/core/brain/sessions/import.ts";
import {
  EMBEDDING_SUNSET,
  EMBEDDING_SUNSET_SOURCE,
  EMBEDDING_SUNSET_SOURCES,
  EMBEDDING_SUNSET_STATES,
  EMBEDDING_SUNSET_UNDETERMINED_REASON,
  EMBEDDING_SUNSET_UNDETERMINED_REASONS,
  isEmbeddingSunsetSource,
  isEmbeddingSunsetState,
  isEmbeddingSunsetUndeterminedReason,
} from "../../../src/core/search/embeddings/sunset.ts";
import {
  isVaultBackingState,
  isVaultBackingUndeterminedReason,
  VAULT_BACKING,
  VAULT_BACKING_STATES,
  VAULT_BACKING_UNDETERMINED_REASON,
  VAULT_BACKING_UNDETERMINED_REASONS,
} from "../../../src/core/vault-backing.ts";
import {
  isSelfHealReindexOutcome,
  isSelfHealSpawnDecision,
  SELF_HEAL_REINDEX_OUTCOME,
  SELF_HEAL_REINDEX_OUTCOMES,
  SELF_HEAL_SPAWN,
  SELF_HEAL_SPAWN_DECISIONS,
} from "../../../src/core/maintenance/self-heal-reindex.ts";
import {
  isProgressKind,
  isProgressReason,
  PROGRESS_KIND,
  PROGRESS_KINDS,
  PROGRESS_REASON,
  PROGRESS_REASONS,
} from "../../../src/core/brain/progress.ts";
import { isOperation, OPERATION, OPERATIONS } from "../../../src/core/brain/safeguard.ts";
import {
  isTokenCountMethod,
  TOKEN_COUNT_METHOD,
  TOKEN_COUNT_METHODS,
} from "../../../src/core/brain/token-impact.ts";
import {
  isRecallFailure,
  RECALL_FAILURE,
  RECALL_FAILURES,
} from "../../../src/core/bench/failure-modes.ts";
import {
  isMaintenanceVerdict,
  MAINTENANCE_VERDICT,
  MAINTENANCE_VERDICTS,
} from "../../../src/core/brain/maintenance/journal.ts";
import {
  isProgressOutcome,
  PROGRESS_OUTCOME,
  PROGRESS_OUTCOMES,
} from "../../../src/cli/progress-rail.ts";
import {
  HOST_PRESSURE,
  HOST_PRESSURE_STATES,
  HOST_PRESSURE_UNMEASURABLE_REASON,
  HOST_PRESSURE_UNMEASURABLE_REASONS,
  isHostPressureState,
  isHostPressureUnmeasurableReason,
} from "../../../src/core/brain/maintenance/host-pressure.ts";

interface VocabularyUnderCensus {
  /** Identifies the vocabulary in a failure message. */
  readonly name: string;
  /** The frozen object every producer reads its value from. */
  readonly values: Readonly<Record<string, string>>;
  /** The companion membership list every reader validates against. */
  readonly members: ReadonlyArray<string>;
  /** The guard that decides whether a persisted string is a member. */
  readonly guard: (value: unknown) => boolean;
}

/**
 * Strings that must never be accepted by any guard here. They are shaped
 * like plausible drift - a case change, a stray space, an empty value, a
 * near-miss spelling - rather than obvious garbage.
 */
const NON_MEMBERS: ReadonlyArray<unknown> = Object.freeze([
  "",
  " ",
  "unknown-vocabulary-member",
  null,
  undefined,
  42,
  {},
]);

/** Returns one line per defect. An empty array is a clean vocabulary. */
function auditVocabulary(vocabulary: VocabularyUnderCensus): ReadonlyArray<string> {
  const problems: string[] = [];
  const { name, values, members, guard } = vocabulary;

  if (!Object.isFrozen(values)) problems.push(`${name}: values object is not frozen`);

  const declared = Object.values(values);
  const declaredSet = new Set(declared);
  if (declaredSet.size !== declared.length) {
    problems.push(`${name}: values object carries a duplicate value`);
  }

  const memberSet = new Set(members);
  if (memberSet.size !== members.length) {
    problems.push(`${name}: membership list carries a duplicate value`);
  }

  for (const value of declaredSet) {
    if (!memberSet.has(value)) problems.push(`${name}: "${value}" is declared but not a member`);
    if (!guard(value)) problems.push(`${name}: guard rejects declared value "${value}"`);
  }
  for (const member of memberSet) {
    if (!declaredSet.has(member)) problems.push(`${name}: "${member}" is a member of nothing`);
  }
  for (const outsider of NON_MEMBERS) {
    if (declaredSet.has(outsider as string)) continue;
    if (guard(outsider))
      problems.push(`${name}: guard accepts non-member ${JSON.stringify(outsider)}`);
  }
  return problems;
}

/**
 * Every closed vocabulary that follows the trio convention. Units of this
 * wave append here as they land; the seed entry is the one vocabulary that
 * already shipped the complete trio.
 */
const CENSUS: ReadonlyArray<VocabularyUnderCensus> = Object.freeze([
  {
    // B5. `unknown` is the member the trio was missing: the install-state
    // probe reads a manifest that can exist and refuse to parse, and among
    // pass, fail and skipped there was no answer for "could not measure"
    // that was not a lie in one direction or the other.
    name: "READINESS_STATUS",
    values: READINESS_STATUS,
    members: READINESS_STATUSES,
    guard: isReadinessStatus,
  },
  { name: "GATE_MODE", values: GATE_MODE, members: GATE_MODES, guard: isGateMode },
  {
    name: "SCHEMA_PACK_INTEGRITY",
    values: SCHEMA_PACK_INTEGRITY,
    members: SCHEMA_PACK_INTEGRITY_STATUSES,
    guard: isSchemaPackIntegrityStatus,
  },
  {
    name: "SCHEMA_PACK_UNVERIFIED_REASON",
    values: SCHEMA_PACK_UNVERIFIED_REASON,
    members: SCHEMA_PACK_UNVERIFIED_REASONS,
    guard: isSchemaPackUnverifiedReason,
  },
  {
    // U5. The trio was incomplete when the wave started: the list and
    // the guard shipped, the frozen object did not, and the MCP tool
    // schema carried a fourth hand-written copy of the list.
    name: "TRIGGER_STATUS",
    values: TRIGGER_STATUS,
    members: TRIGGER_STATUSES,
    guard: isTriggerStatus,
  },
  {
    // U2. Three vocabularies, because a corpus verdict, the reason it
    // could not be reached, and the stored edge that grounds a
    // non-occurrence are three types - the wave's rule that a union of
    // disjoint sets is a namespace rather than an abstraction.
    name: "NEGATIVE_RECALL_STATE",
    values: NEGATIVE_RECALL_STATE,
    members: NEGATIVE_RECALL_STATES,
    guard: isNegativeRecallState,
  },
  {
    name: "NEGATIVE_RECALL_UNKNOWN_REASON",
    values: NEGATIVE_RECALL_UNKNOWN_REASON,
    members: NEGATIVE_RECALL_UNKNOWN_REASONS,
    guard: isNegativeRecallUnknownReason,
  },
  {
    name: "RETRACTION_EVIDENCE_KIND",
    values: RETRACTION_EVIDENCE_KIND,
    members: RETRACTION_EVIDENCE_KINDS,
    guard: isRetractionEvidenceKind,
  },
  {
    // U3. Two vocabularies for the two sides of one row: what stopped
    // being current, and what kind of thing is still resting on it. They
    // are read from different stores and lead to different remedies, so
    // collapsing them into one axis would name neither.
    name: "STALE_DEPENDENCY_CONSUMER",
    values: STALE_DEPENDENCY_CONSUMER,
    members: STALE_DEPENDENCY_CONSUMERS,
    guard: isStaleDependencyConsumerKind,
  },
  {
    name: "STALE_DEPENDENCY_STATE",
    values: STALE_DEPENDENCY_STATE,
    members: STALE_DEPENDENCY_STATES,
    guard: isStaleDependencyStateKind,
  },
  {
    // U6. Persisted into a replicated sidecar, so the guard is what
    // stands between a peer's hand-edited manifest and a restore acting
    // on a reason this build does not understand.
    name: "SNAPSHOT_STORE_EXCLUSION",
    values: SNAPSHOT_STORE_EXCLUSION,
    members: SNAPSHOT_STORE_EXCLUSION_REASONS,
    guard: isSnapshotStoreExclusionReason,
  },
  {
    // U7. Four of its nine members have no producer in this release
    // (snapshots at a session, plan or decision boundary are deferred, and
    // nothing takes one on demand), and the census does not care: what it
    // asserts is that the guard accepts every member, which is precisely
    // what lets this build read a sidecar a later release wrote and
    // replicated back.
    name: "BRAIN_SNAPSHOT_REASON",
    values: BRAIN_SNAPSHOT_REASON,
    members: BRAIN_SNAPSHOT_REASONS,
    guard: isBrainSnapshotReason,
  },
  {
    // U4. Registered because the values leave TypeScript: the resync cron
    // recipe interpolates one of them into the shell gate it emits, which
    // is the copy-drift class this census exists for - a code renamed here
    // and left as a literal there would silently stop matching, and the
    // emitted gate would pass every report.
    name: "GRAPH_HEALTH_CODES",
    values: GRAPH_HEALTH_CODES,
    members: GRAPH_HEALTH_CODE_LIST,
    guard: isGraphHealthCode,
  },
  {
    // B4. Three vocabularies for one gate, because the verdict, the
    // reason an artifact is out of date, and the reason no verdict could
    // be reached are three disjoint sets. The verdict replaced a boolean
    // `fresh`, which is exactly the shape that forced a failed
    // measurement to be reported as one of the two real answers.
    name: "MATERIALIZE_FRESHNESS",
    values: MATERIALIZE_FRESHNESS,
    members: MATERIALIZE_FRESHNESS_STATES,
    guard: isMaterializeFreshness,
  },
  {
    // B4. Registered separately from the verdict: a stale reason is only
    // ever paired with `stale`, and a guard that accepted both sets
    // would let a persisted `unknown` reason be read back as a claim
    // that the outputs are merely out of date.
    name: "MATERIALIZE_STALE_REASON",
    values: MATERIALIZE_STALE_REASON,
    members: MATERIALIZE_STALE_REASONS,
    guard: isMaterializeStaleReason,
  },
  {
    // B4. These values leave TypeScript: the `--if-stale` fast-path
    // writes the reason into the `communities` metric payload and into
    // its `--json` output, so a rename here with the reader left alone
    // is the copy-drift this census exists for.
    name: "MATERIALIZE_UNKNOWN_REASON",
    values: MATERIALIZE_UNKNOWN_REASON,
    members: MATERIALIZE_UNKNOWN_REASONS,
    guard: isMaterializeUnknownReason,
  },
  {
    // C1. The transport a recall record arrived on. Registered because
    // the doctor check that crosses it against an install state switches
    // over it with no default arm, and because the value is persisted
    // into the continuity log and copied into a tool-schema enum - both
    // routes out of TypeScript this census exists to pin.
    name: "RECALL_CHANNEL",
    values: RECALL_CHANNEL,
    members: RECALL_CHANNELS,
    guard: isRecallChannel,
  },
  {
    // C1. Not new - the guard was a hand-rolled equality chain, so
    // `query` was added to the union and three copies of the list went
    // stale, one of them a tool-schema enum that then rejected a mode
    // the server itself records.
    name: "RECALL_TELEMETRY_MODE",
    values: RECALL_TELEMETRY_MODE,
    members: RECALL_TELEMETRY_MODES,
    guard: isRecallTelemetryMode,
  },
  {
    // C1. The same conversion, and the vocabulary the injecting hook's
    // three decisions map onto.
    name: "RECALL_TELEMETRY_STATUS",
    values: RECALL_TELEMETRY_STATUS,
    members: RECALL_TELEMETRY_STATUSES,
    guard: isRecallTelemetryStatus,
  },
  {
    // Why the prompt-time recall hook failed. Minted because the error
    // decision used to carry the retriever's RAW message and the hook
    // copied it onto a synced continuity record that
    // `brain_recall_telemetry` returns verbatim to a model - a SQLite or
    // config failure names the index file or the config path, and the
    // redactor strips secret-shaped tokens, not paths. Registered here
    // because the value leaves TypeScript: it is persisted into that
    // payload, and a member added to the object and forgotten in the list
    // would be a fault no reader could narrow back.
    name: "RECALL_INJECT_FAULT",
    values: RECALL_INJECT_FAULT,
    members: RECALL_INJECT_FAULTS,
    guard: isRecallInjectFault,
  },
  {
    // C2. Why a retrieval narrowed or came back empty. Registered because
    // the values leave TypeScript twice over: they are declared as an
    // `enum` in the `brain_search` output schema, where an undeclared code
    // fails the response contract, and they are emitted as recall-telemetry
    // gap strings - two hand-written copies away from the one definition if
    // nothing asserts the trio agrees.
    name: "RETRIEVAL_DEGRADATION",
    values: RETRIEVAL_DEGRADATION,
    members: RETRIEVAL_DEGRADATION_CODES,
    guard: isRetrievalDegradationCode,
  },
  {
    // C3. The two vocabularies the schema-completeness audit is built on:
    // what kind of schema node the walk is standing on, and what a node
    // failed to declare. Test-time only, so no value crosses a wire - but
    // the rule vocabulary is the audit's whole contract with its readers,
    // and a member added to the object and forgotten in the list would be
    // a rule that never appears in a failure message.
    name: "SCHEMA_NODE_KIND",
    values: SCHEMA_NODE_KIND,
    members: SCHEMA_NODE_KINDS,
    guard: isSchemaNodeKind,
  },
  {
    name: "SCHEMA_COMPLETENESS_RULE",
    values: SCHEMA_COMPLETENESS_RULE,
    members: SCHEMA_COMPLETENESS_RULES,
    guard: isSchemaCompletenessRule,
  },
  {
    // A4. Why a written page was not linted. The values ride out of
    // TypeScript in the `lint.skipped[]` array of all four note-write
    // tools, where a caller reads the reason to decide whether the silence
    // about that page means clean or means unread - so a value added here
    // and forgotten in the list is a reason no reader can narrow.
    name: "PAGE_LINT_SKIP_REASON",
    values: PAGE_LINT_SKIP_REASON,
    members: PAGE_LINT_SKIP_REASONS,
    guard: isPageLintSkipReason,
  },
  {
    // C1. What a given export path does about secrets on the way out.
    // Registered because the value is the load-bearing field of a
    // declaration that a source-reading census checks against the code:
    // a status renamed here and left spelled the old way in the census
    // would silently stop matching, and every entry would read as
    // accounted for.
    name: "EGRESS_REDACTION",
    values: EGRESS_REDACTION,
    members: EGRESS_REDACTION_STATUSES,
    guard: isEgressRedactionStatus,
  },
  {
    // C1. Released or refused at the export boundary. Registered
    // separately from the status above because they answer different
    // questions - what a PATH does in general, and what happened to ONE
    // payload - and a guard that accepted both would let a refusal be
    // read back as a policy.
    name: "EGRESS_OUTCOME",
    values: EGRESS_OUTCOME,
    members: EGRESS_OUTCOMES,
    guard: isEgressOutcome,
  },
  {
    // E1. What the live embedding-provider probe of `o2b search check`
    // concluded. It replaced a `boolean | null` that had to answer four
    // questions with two truth values, so a provider that answered with a
    // refusal and one that never answered were the same `false`. The
    // values leave TypeScript through the verb's `--json` payload, where
    // a caller reads `provider_probe` to decide whether the silence about
    // an endpoint means healthy, broken, or unmeasured - which is exactly
    // the copy this census exists to keep honest.
    name: "PROVIDER_PROBE",
    values: PROVIDER_PROBE,
    members: PROVIDER_PROBE_STATES,
    guard: isProviderProbeState,
  },
  {
    // E2. Why one preference in a bank bundle did not restore. The values
    // ride out of TypeScript in the `preferences.failed[]` array of the
    // bank-import result and its `--json` rendering, where an operator
    // reads the reason to decide whether to re-export, resolve a
    // divergence by hand, or upgrade an old bundle. A value the guard
    // rejects would read back off that JSON as an unknown refusal.
    name: "PREFERENCE_RESTORE_FAILURE",
    values: PREFERENCE_RESTORE_FAILURE,
    members: PREFERENCE_RESTORE_FAILURES,
    guard: isPreferenceRestoreFailure,
  },
  {
    // R1a. Three vocabularies for one gate, by the same rule U2 states at
    // :228-232: what a recovery point is worth, which regions of the vault
    // an archive actually holds, and what stops a region being provable
    // are three disjoint sets, so they are a namespace rather than an
    // abstraction. The state replaced a `throw`-or-`DestructiveSnapshot`
    // pair that had no way to say "a recovery point exists and it does not
    // cover all of this" - which is what `--include-originals` needed to
    // say while it reported a snapshot path instead.
    name: "RECOVERABILITY_STATE",
    values: RECOVERABILITY_STATE,
    members: RECOVERABILITY_STATES,
    guard: isRecoverabilityState,
  },
  {
    // R1a. Registered separately because the regions are read back off a
    // gate result and switched over by the destructive-site registry: a
    // guard that also accepted a state would let `partial` be read as a
    // region of the vault an archive holds.
    name: "RECOVERY_COVERAGE",
    values: RECOVERY_COVERAGE,
    members: RECOVERY_COVERAGES,
    guard: isRecoveryCoverage,
  },
  {
    // R1a. These values leave TypeScript: they ride out in the
    // `recoverability.blockers[]` array of the delete-by-source response,
    // where a caller reads them to decide whether the deletion it just
    // authorised is reversible.
    name: "RECOVERABILITY_BLOCKER",
    values: RECOVERABILITY_BLOCKER,
    members: RECOVERABILITY_BLOCKERS,
    guard: isRecoverabilityBlocker,
  },
  {
    // B1. One member, and the census does not care how many: what it
    // asserts is that the guard accepts it and rejects everything else.
    // The value rides out of TypeScript in the prune report the
    // destructive gate returns and the CLI prints, and it exists because
    // a configured retention of zero used to make the most destructive
    // operation in the snapshot module remove every archive in the vault
    // without a word.
    name: "SNAPSHOT_PRUNE_REFUSAL",
    values: SNAPSHOT_PRUNE_REFUSAL,
    members: SNAPSHOT_PRUNE_REFUSALS,
    guard: isSnapshotPruneRefusal,
  },
  {
    // B2. The dispatch key of the note-file lifecycle tool, so the value
    // arrives as an untyped MCP argument or a raw CLI positional and the
    // guard is the boundary between the two.
    name: "NOTE_LIFECYCLE_ACTION",
    values: NOTE_LIFECYCLE_ACTION,
    members: NOTE_LIFECYCLE_ACTIONS,
    guard: isNoteLifecycleAction,
  },
  {
    // B2. What a rename did about `[[Basename]]` - the one inbound
    // spelling that is not unique by construction. Three answers, and
    // the reason it is a vocabulary rather than a boolean is that
    // "withheld because two notes carry the name" and "there was nothing
    // to rewrite" are opposite facts a boolean would collapse.
    name: "BASENAME_REWRITE",
    values: BASENAME_REWRITE,
    members: BASENAME_REWRITES,
    guard: isBasenameRewrite,
  },
  {
    // B2. The freshness of the derived index a relocation could not
    // update. No `current` member: nothing in this codebase writes the
    // `links` table on a note write, so an index that exists is stale
    // with respect to a rename that just happened, and declaring a
    // member nothing produces would invite the opposite reading.
    name: "INDEX_EVIDENCE",
    values: INDEX_EVIDENCE,
    members: INDEX_EVIDENCE_STATES,
    guard: isIndexEvidenceState,
  },
  {
    // B3. Three of its four members are refusals, and that is the unit:
    // the index reports dangling links as a COUNT, and a count taken
    // after an incremental pass is not reproducible. An empty list from
    // a partially-resolved index would read as a clean vault, so the
    // scan says which of the four states produced the answer.
    name: "DANGLING_SCAN",
    values: DANGLING_SCAN,
    members: DANGLING_SCANS,
    guard: isDanglingScan,
  },
  {
    // B3. The dispatch key of the stub-scaffolding tool. Separate from
    // NOTE_LIFECYCLE_ACTION because the subjects are different kinds:
    // every lifecycle action names an existing note by path, and a
    // dangling target has no path yet - that is what makes it dangling.
    name: "STUB_SCAFFOLD_ACTION",
    values: STUB_SCAFFOLD_ACTION,
    members: STUB_SCAFFOLD_ACTIONS,
    guard: isStubScaffoldAction,
  },
  {
    // U10. How a token-impact sample's counts were PRODUCED. Promoted to
    // the idiom when its members were renamed off `exact` / `fallback`:
    // the ledger counts nothing, so labelling a caller's integer exact
    // asserted a property nothing had checked. The guard is the boundary
    // for a value arriving as an untyped MCP argument or read back out of
    // a continuity payload written by an older build.
    name: "TOKEN_COUNT_METHOD",
    values: TOKEN_COUNT_METHOD,
    members: TOKEN_COUNT_METHODS,
    guard: isTokenCountMethod,
  },
  {
    // U10. How one proactive-recall decision failed. `faulted` is the
    // member that earns the vocabulary: a retriever that threw is not a
    // memory that stayed quiet, and a boolean would collapse them - which
    // would let a broken harness report itself as a cautious one. The
    // guard is the boundary for a value read back out of a persisted
    // retrieve-phase result file.
    name: "RECALL_FAILURE",
    values: RECALL_FAILURE,
    members: RECALL_FAILURES,
    guard: isRecallFailure,
  },
  {
    // U1. What one progress tick says happened. `refused` and `stopped`
    // are the members that earn the vocabulary: an operation whose events
    // no transport could carry, and one the operator cancelled, are
    // different facts, and both were previously reported as an absence of
    // progress - which is what a hung run looks like too.
    name: "PROGRESS_KIND",
    values: PROGRESS_KIND,
    members: PROGRESS_KINDS,
    guard: isProgressKind,
  },
  {
    // U1. Why a run stopped short or why its ticks could not be carried.
    // Closed for the same reason the kind is: a reader must branch on it,
    // and a free string would let prose onto a structured surface.
    name: "PROGRESS_REASON",
    values: PROGRESS_REASON,
    members: PROGRESS_REASONS,
    guard: isProgressReason,
  },
  {
    // U1. The operations this repository calls long. It was a bare union
    // owned by the safeguard; the progress spine needed to name the same
    // population, and a second list would have drifted. Registering it
    // here is what stops the two readers - the timeout ladder and the
    // progress event - from disagreeing about what is long.
    name: "OPERATION",
    values: OPERATION,
    members: OPERATIONS,
    guard: isOperation,
  },
  {
    // U5. What the parent did about a reindex it found necessary. The
    // values leave TypeScript into `Brain/metrics/self_heal_reindex.jsonl`,
    // a file that is synced to peer devices and read back by a build that
    // may not be the one that wrote it - so the guard is the boundary
    // between this release and a row it does not understand.
    name: "SELF_HEAL_SPAWN",
    values: SELF_HEAL_SPAWN,
    members: SELF_HEAL_SPAWN_DECISIONS,
    guard: isSelfHealSpawnDecision,
  },
  {
    // U5. Registered separately from the decision above because the two
    // are answered by different processes to different questions - whether
    // a child was started, and what a started child ended as - and one
    // guard over both would let a refusal to start be read back off the
    // same file as a rebuild that finished.
    name: "SELF_HEAL_REINDEX_OUTCOME",
    values: SELF_HEAL_REINDEX_OUTCOME,
    members: SELF_HEAL_REINDEX_OUTCOMES,
    guard: isSelfHealReindexOutcome,
  },
  {
    // A2. What filesystem backs the vault path. `undetermined` is the
    // member that earns the vocabulary: the alternative design classified
    // the HOST as local / cloud sandbox / ephemeral, and every signal that
    // classifier reads is one-way, so a negative container marker would
    // have bought a positive durability verdict on every modern container
    // that does not ship one.
    name: "VAULT_BACKING",
    values: VAULT_BACKING,
    members: VAULT_BACKING_STATES,
    guard: isVaultBackingState,
  },
  {
    // A2. Why the backing probe reached no verdict. Separate from the
    // state for the reason MATERIALIZE_UNKNOWN_REASON is separate from its
    // freshness: one guard over both would let `path_unreadable` be read
    // back off a payload everywhere a survival verdict is expected.
    name: "VAULT_BACKING_UNDETERMINED_REASON",
    values: VAULT_BACKING_UNDETERMINED_REASON,
    members: VAULT_BACKING_UNDETERMINED_REASONS,
    guard: isVaultBackingUndeterminedReason,
  },
  {
    // U7. The runtimes whose session adapters ship in this tree. It was a
    // hand-written string union with a guard taking `string`, which is a
    // guard that can only be called once the caller has already proved
    // what it was asked to prove - and `--format` hands it a raw argv
    // value. The registry it names is keyed by `string` and open to a
    // caller's own adapter; this vocabulary is the closed half, and
    // `tests/core/brain/sessions/adapter-registry.test.ts` locks it to
    // the built-in registry's keys.
    name: "SESSION_ADAPTER_ID",
    values: SESSION_ADAPTER_ID,
    members: SESSION_ADAPTER_IDS,
    guard: isSessionAdapterId,
  },
  {
    // U7. Which emptiness a transcript scan found. `root_absent`,
    // `unreadable` and `idle` were one value - a zero file count - feeding
    // an alert that exists to notice a day with no recorded work, so an
    // unreadable home was read as a confirmed quiet day. The three cannot
    // be one member for the same reason `partial` is not `full`: the
    // middle one is the report failing, not the agent resting.
    name: "TRANSCRIPT_SCAN",
    values: TRANSCRIPT_SCAN,
    members: TRANSCRIPT_SCANS,
    guard: isTranscriptScan,
  },
  {
    // U7. Whether an import result's counters describe writes that happened
    // or writes it would have made. Two members, and the vocabulary earns
    // its place on the pair it separates: `signals_created: 0` was the
    // honest answer for a dry run AND for a real run over a session with
    // nothing in it, so the counters alone could not say which run the
    // operator had just performed.
    name: "IMPORT_WRITE_MODE",
    values: IMPORT_WRITE_MODE,
    members: IMPORT_WRITE_MODES,
    guard: isImportWriteMode,
  },
  {
    // B1. What this build can say about one embedding model's
    // decommission. `unsurveyed` and `none_announced` are separate
    // members and that separation IS the unit: `embedding_model` is a
    // free string with no validation and off-catalog is the normal case,
    // so reporting "no sunset announced" for a model nobody looked up is
    // the misleading silence the check exists to remove.
    name: "EMBEDDING_SUNSET",
    values: EMBEDDING_SUNSET,
    members: EMBEDDING_SUNSET_STATES,
    guard: isEmbeddingSunsetState,
  },
  {
    // B1. Why no sunset verdict was reached. Separate from the state so
    // `survey_stale` - a fact about this build's own table rather than
    // about the model - can never be read back where a verdict belongs.
    name: "EMBEDDING_SUNSET_UNDETERMINED_REASON",
    values: EMBEDDING_SUNSET_UNDETERMINED_REASON,
    members: EMBEDDING_SUNSET_UNDETERMINED_REASONS,
    guard: isEmbeddingSunsetUndeterminedReason,
  },
  {
    // B1. Which layer answered a sunset question - the operator's
    // declaration in `_brain.yaml`, this build's table, or NEITHER. A
    // boolean was the obvious shape and it is wrong: it would have made
    // "the survey answered" and "nothing answered" the same value, which
    // is the collapse this whole check exists to undo.
    name: "EMBEDDING_SUNSET_SOURCE",
    values: EMBEDDING_SUNSET_SOURCE,
    members: EMBEDDING_SUNSET_SOURCES,
    guard: isEmbeddingSunsetSource,
  },
  {
    // U6. What one maintenance-lane journal row records. It was a bare
    // union, and the fourth gate is what made the trio worth having: the
    // rows are persisted as JSONL and read back by whichever build runs
    // next, which after an upgrade is not the build that wrote them.
    // `pressure:unmeasurable` is the member that earns the vocabulary -
    // it is a NOTICE that a gate did not evaluate, emitted beside the
    // decision rather than instead of it, so an operator can tell a host
    // that was quiet from one that could not say.
    name: "MAINTENANCE_VERDICT",
    values: MAINTENANCE_VERDICT,
    members: MAINTENANCE_VERDICTS,
    guard: isMaintenanceVerdict,
  },
  {
    // U6. Whether host pressure is a number or a named absence. Two
    // members, and the pair is the whole unit: `os.loadavg()` returns
    // zero both on an idle host and on the platform that does not
    // implement it, so without this state the gate's "quiet" would have
    // been indistinguishable from its "I cannot see".
    name: "HOST_PRESSURE",
    values: HOST_PRESSURE,
    members: HOST_PRESSURE_STATES,
    guard: isHostPressureState,
  },
  {
    // U6. Which question failed. Separate from the state for the reason
    // every undetermined-reason vocabulary here is separate from its
    // verdict: the value is persisted into a journal row's
    // `pressure_reason`, and one guard over both would let
    // `cpu_quota_in_force` be read back where a load percentage belongs.
    name: "HOST_PRESSURE_UNMEASURABLE_REASON",
    values: HOST_PRESSURE_UNMEASURABLE_REASON,
    members: HOST_PRESSURE_UNMEASURABLE_REASONS,
    guard: isHostPressureUnmeasurableReason,
  },
  {
    // U1. Whether a progress line reached stderr or was refused because
    // the command's streams are buffered for the whole run. It was NOT
    // registered here when it shipped, and the source scan below is how
    // it was found - the first vocabulary this census enrolled because
    // the tree said so rather than because an author remembered.
    name: "PROGRESS_OUTCOME",
    values: PROGRESS_OUTCOME,
    members: PROGRESS_OUTCOMES,
    guard: isProgressOutcome,
  },
  {
    // U6. Why one `.snapshots/` entry could not become a listing row.
    // The second vocabulary the scan enrolled rather than an author: it
    // shipped complete, beside SNAPSHOT_PRUNE_REFUSAL in the same module,
    // and was registered here by nobody.
    name: "SNAPSHOT_ENTRY_SKIP_REASON",
    values: SNAPSHOT_ENTRY_SKIP_REASON,
    members: SNAPSHOT_ENTRY_SKIP_REASONS,
    guard: isSnapshotEntrySkipReason,
  },
]);

// ---------------------------------------------------------------------------
// The population, read from `src/`
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Roots the scan walks. See the docblock for what living outside costs. */
const SCANNED_ROOTS: ReadonlyArray<string> = Object.freeze(["src"]);

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readSourceTree(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(REPO_ROOT, root));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * The same source with comment bodies and string CONTENTS replaced by
 * spaces, character offsets preserved.
 *
 * Structure is read off the mask and content off the original at the same
 * index. This is what makes bracket matching honest: a `"}"` inside a
 * value cannot close an object, and `// }` in a comment cannot either.
 */
function maskSource(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let k = i + 1;
      while (k < text.length) {
        if (text[k] === "\\") {
          k += 2;
          continue;
        }
        if (text[k] === char) break;
        // A `"` or `'` with no partner before the newline is not a string
        // opener - it is a quote inside a regular expression literal,
        // `/["']/` being the shape that occurs here. Treating it as an
        // opener would blank real code from that point to the next quote
        // ANYWHERE in the file, which is worse than a miss: the scan would
        // report a fact about a module it never read. Only a template can
        // legally span lines.
        if (char !== "`" && text[k] === "\n") {
          k = i;
          break;
        }
        k += 1;
      }
      if (k === i) {
        i += 1;
        continue;
      }
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const CLOSER: Readonly<Record<string, string>> = Object.freeze({
  "{": "}",
  "[": "]",
  "(": ")",
});

/** Index of the bracket closing the one at `open`, or -1. */
function matchBracket(masked: string, open: number): number {
  const opener = masked[open]!;
  const closer = CLOSER[opener]!;
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A `const NAME = …` whose initialiser is a bracketed expression. */
interface Binding {
  readonly name: string;
  /** Index of the opening bracket of the initialiser's outermost group. */
  readonly open: number;
  /** Index of its closer. */
  readonly close: number;
  /** `{` for an object literal, `[` for an array, `(` for `Object.freeze(…)`. */
  readonly bracket: string;
}

/**
 * `Object.freeze(` and bare-array bindings. The optional type annotation
 * is matched as "anything up to the `=`" excluding `;` and `=`, which is
 * every annotation in this tree; a function-typed annotation (`() => T`)
 * would hide the binding, and hiding a MEMBERSHIP LIST is the only way
 * that matters - it drops its vocabulary out of the population.
 */
const FROZEN_BINDING_RE =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^;=]*)?=\s*Object\s*\.\s*freeze\s*\(/g;
const ARRAY_BINDING_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^;=]*)?=\s*\[/g;

function bindings(masked: string): Binding[] {
  const found: Binding[] = [];
  for (const match of masked.matchAll(FROZEN_BINDING_RE)) {
    const paren = match.index! + match[0].length - 1;
    const close = matchBracket(masked, paren);
    if (close === -1) continue;
    // `Object.freeze({ … })` and `Object.freeze([ … ])` are reported as
    // the literal they wrap; `Object.freeze(Object.values(X))` stays a
    // call, which is a membership list and never an object literal.
    const inner = masked.slice(paren + 1, close);
    const offset = inner.search(/\S/);
    const first = offset === -1 ? "" : inner[offset];
    if (first === "{" || first === "[") {
      const open = paren + 1 + offset;
      const innerClose = matchBracket(masked, open);
      if (innerClose !== -1) {
        found.push({ name: match[1]!, open, close: innerClose, bracket: first });
        continue;
      }
    }
    found.push({ name: match[1]!, open: paren, close, bracket: "(" });
  }
  for (const match of masked.matchAll(ARRAY_BINDING_RE)) {
    const open = match.index! + match[0].length - 1;
    const close = matchBracket(masked, open);
    if (close !== -1) found.push({ name: match[1]!, open, close, bracket: "[" });
  }
  return found;
}

/** Top-level `,`-separated segments of a bracketed body, as index pairs. */
function segments(masked: string, open: number, close: number): Array<readonly [number, number]> {
  const parts: Array<readonly [number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const char = masked[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, close]);
  return parts;
}

const ENTRY_RE = /^\s*(?:[A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:\s*(["'])/;

/**
 * The declared values of a frozen object literal, in source order, or
 * `null` when ANY entry is something other than `key: "literal"` - a
 * spread, a nested object, a call. Not-a-literal is not a partial read:
 * it means this object is not a string vocabulary.
 */
function declaredValues(masked: string, text: string, binding: Binding): string[] | null {
  if (binding.bracket !== "{") return null;
  const values: string[] = [];
  for (const [from, to] of segments(masked, binding.open, binding.close)) {
    const segment = masked.slice(from, to);
    if (segment.trim() === "") continue;
    const match = ENTRY_RE.exec(segment);
    if (match === null) return null;
    const quote = match[1]!;
    const valueStart = from + match[0].length;
    const valueEnd = masked.indexOf(quote, valueStart);
    if (valueEnd === -1 || valueEnd >= to) return null;
    values.push(text.slice(valueStart, valueEnd));
  }
  return values.length > 0 ? values : null;
}

/** A declaration that takes a parameter typed `unknown`. */
interface GuardCandidate {
  readonly name: string;
  /** Source range of the whole declaration, signature and body. */
  readonly from: number;
  readonly to: number;
}

const FUNCTION_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ARROW_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^;=]*)?=\s*(?:async\s*)?\(/g;

/** Index of the end of the statement starting at `from`, at depth zero. */
function statementEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0) return i;
    } else if (char === ";" && depth === 0) return i;
  }
  return masked.length;
}

function guardCandidates(masked: string): GuardCandidate[] {
  const found: GuardCandidate[] = [];
  for (const match of masked.matchAll(FUNCTION_RE)) {
    const paramsOpen = match.index! + match[0].length - 1;
    const paramsClose = matchBracket(masked, paramsOpen);
    if (paramsClose === -1) continue;
    if (!/:\s*unknown\b/.test(masked.slice(paramsOpen, paramsClose))) continue;
    const bodyOpen = masked.indexOf("{", paramsClose);
    const bodyClose = bodyOpen === -1 ? -1 : matchBracket(masked, bodyOpen);
    found.push({
      name: match[1]!,
      from: match.index!,
      to: bodyClose === -1 ? masked.length : bodyClose,
    });
  }
  for (const match of masked.matchAll(ARROW_RE)) {
    const paramsOpen = match.index! + match[0].length - 1;
    const paramsClose = matchBracket(masked, paramsOpen);
    if (paramsClose === -1) continue;
    if (!/:\s*unknown\b/.test(masked.slice(paramsOpen, paramsClose))) continue;
    if (!/^[^;{]*=>/.test(masked.slice(paramsClose + 1))) continue;
    found.push({ name: match[1]!, from: match.index!, to: statementEnd(masked, paramsClose + 1) });
  }
  return found;
}

/** One vocabulary the tree declares, as the scan reads it. */
interface ScannedVocabulary {
  readonly file: string;
  /** The frozen object's identifier. `CENSUS.name` must equal it. */
  readonly name: string;
  /** Its declared values, in source order. */
  readonly values: ReadonlyArray<string>;
  /** The membership-list constant built from it. */
  readonly members: string;
  /** The guard that takes `unknown`. */
  readonly guard: string;
}

function scanVocabularies(files: ReadonlyArray<SourceFile>): ScannedVocabulary[] {
  const found: ScannedVocabulary[] = [];
  for (const file of files) {
    const masked = maskSource(file.text);
    const declared = bindings(masked);
    const guards = guardCandidates(masked);
    for (const binding of declared) {
      const values = declaredValues(masked, file.text, binding);
      if (values === null) continue;
      const name = binding.name;
      const derived = new RegExp(
        String.raw`\(\s*typeof\s+${name}\s*\)\s*\[\s*keyof\s+typeof\s+${name}\s*\]`,
      );
      if (!derived.test(masked)) continue;
      const referencesObject = new RegExp(
        String.raw`\b${name}\s*\.|Object\s*\.\s*values\s*\(\s*${name}\s*\)`,
      );
      const list = declared.find(
        (candidate) =>
          candidate !== binding &&
          candidate.bracket !== "{" &&
          referencesObject.test(masked.slice(candidate.open, candidate.close)),
      );
      if (list === undefined) continue;
      const reads = new RegExp(String.raw`\b(?:${list.name}|${name})\b`);
      const guard = guards.find((candidate) =>
        reads.test(masked.slice(candidate.from, candidate.to)),
      );
      if (guard === undefined) continue;
      found.push({
        file: file.path,
        name,
        values,
        members: list.name,
        guard: guard.name,
      });
    }
  }
  return found;
}

const SOURCE_TREE = readSourceTree();
const SCANNED = scanVocabularies(SOURCE_TREE);
const REGISTERED = new Map(CENSUS.map((entry) => [entry.name, entry] as const));

describe("verdict vocabulary census", () => {
  test("the registry is not empty", () => {
    // A census with nothing in it passes for the wrong reason. This is the
    // guard against the registry being emptied rather than fixed.
    expect(CENSUS.length).toBeGreaterThan(0);
  });

  for (const vocabulary of CENSUS) {
    test(`${vocabulary.name} object, membership list and guard agree`, () => {
      expect(auditVocabulary(vocabulary)).toEqual([]);
    });
  }
});

describe("the census itself catches drift", () => {
  // Without these, a broken audit would report every vocabulary clean and
  // the file above would be decoration.
  const values = Object.freeze({ ok: "ok", unverified: "unverified" });
  const members = ["ok", "unverified"];
  const guard = (value: unknown): boolean => members.includes(value as string);

  test("accepts a well-formed vocabulary", () => {
    expect(auditVocabulary({ name: "synthetic", values, members, guard })).toEqual([]);
  });

  test("catches a value that is missing from the membership list", () => {
    const problems = auditVocabulary({ name: "synthetic", values, members: ["ok"], guard });
    expect(problems).toContain('synthetic: "unverified" is declared but not a member');
  });

  test("catches a member that no value declares", () => {
    const problems = auditVocabulary({
      name: "synthetic",
      values,
      members: [...members, "modified"],
      guard,
    });
    expect(problems).toContain('synthetic: "modified" is a member of nothing');
  });

  test("catches a guard that rejects one of its own values", () => {
    const problems = auditVocabulary({
      name: "synthetic",
      values,
      members,
      guard: (value) => value === "ok",
    });
    expect(problems).toContain('synthetic: guard rejects declared value "unverified"');
  });

  test("catches a guard that accepts anything", () => {
    const problems = auditVocabulary({ name: "synthetic", values, members, guard: () => true });
    expect(problems).toContain('synthetic: guard accepts non-member ""');
  });

  test("catches an unfrozen values object", () => {
    const problems = auditVocabulary({
      name: "synthetic",
      values: { ok: "ok", unverified: "unverified" },
      members,
      guard,
    });
    expect(problems).toContain("synthetic: values object is not frozen");
  });

  test("catches a duplicate value", () => {
    const problems = auditVocabulary({
      name: "synthetic",
      values: Object.freeze({ ok: "ok", alsoOk: "ok" }),
      members: ["ok"],
      guard: (value) => value === "ok",
    });
    expect(problems).toContain("synthetic: values object carries a duplicate value");
  });
});

describe("the census reads the tree", () => {
  test("every four-piece vocabulary in src/ is registered", () => {
    // The finding this block exists for: an unregistered vocabulary used
    // to be invisible, so a module carrying a duplicate value, a phantom
    // member and a guard that accepts every string ran clean.
    const unregistered = SCANNED.filter((row) => !REGISTERED.has(row.name)).map(
      (row) => `${row.name} (${row.file})`,
    );
    // Named, not counted: the failure has to say which vocabulary.
    expect(unregistered).toEqual([]);
  });

  test("no registration outlives the vocabulary it audits", () => {
    // The other direction, and the reason the scan can be trusted at all:
    // if it stopped seeing a shape, the vocabularies written in that shape
    // would go missing here rather than silently leave the population.
    const scanned = new Set(SCANNED.map((row) => row.name));
    const orphaned = CENSUS.filter((entry) => !scanned.has(entry.name)).map((entry) => entry.name);
    expect(orphaned).toEqual([]);
  });

  test("each registration names the object the source declares", () => {
    // `name` is the source identifier, which is what lets the two halves
    // be joined at all. A registration pointing at a different object -
    // the copy-paste failure this file is one long list of opportunities
    // for - lands here as a value mismatch.
    const mismatched: string[] = [];
    for (const row of SCANNED) {
      const entry = REGISTERED.get(row.name);
      if (entry === undefined) continue;
      const registered = Object.values(entry.values).toSorted();
      const read = [...row.values].toSorted();
      if (registered.join(" ") !== read.join(" ")) {
        mismatched.push(
          `${row.name}: registered [${registered.join(",")}] source [${read.join(",")}]`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  test("the scan still finds the population it measures", () => {
    // A scanner that matched nothing would report a clean sweep over an
    // empty set. Set just under the measurement: a floor of 20 against 57
    // would let two thirds of the population stop being seen.
    expect(SCANNED.length).toBeGreaterThan(50);
    expect(SOURCE_TREE.length).toBeGreaterThan(500);
  });

  test("a vocabulary whose list is a multi-line Object.values stays visible", () => {
    // The concrete shape a line-oriented scan loses: the membership list
    // is `Object.freeze(` then `Object.values(HOST_PRESSURE),` on the next
    // line, so no single line carries both. Pinned by name because a
    // regression to line matching drops 20-odd rows at once and every
    // other test in this file still passes.
    const row = SCANNED.find((candidate) => candidate.name === "HOST_PRESSURE");
    expect(`${row?.members} ${row?.guard} ${row?.values.join(",")}`).toBe(
      "HOST_PRESSURE_STATES isHostPressureState measured,unmeasurable",
    );
  });
});

describe("the scan sees the shapes it claims to", () => {
  /**
   * The real scan and the real registry, over one synthetic module.
   *
   * One file rather than the whole tree plus one, because
   * {@link scanVocabularies} decides per file - the four pieces must be
   * in one module - so the two runs cannot differ, and re-walking `src/`
   * once per shape costs a second each for an identical answer.
   */
  function unregisteredWith(intruder: SourceFile): string[] {
    return scanVocabularies([intruder])
      .filter((row) => !REGISTERED.has(row.name))
      .map((row) => row.name);
  }

  const OBJECT = 'export const ZZ = Object.freeze({\n  a: "a",\n  b: "b",\n} as const);\n';
  const DERIVED = "export type Zz = (typeof ZZ)[keyof typeof ZZ];\n";
  const FROZEN_LIST = "export const ZZS: ReadonlyArray<Zz> = Object.freeze([ZZ.a, ZZ.b]);\n";
  const GUARD =
    "export function isZz(value: unknown): value is Zz {\n" +
    "  return typeof value === 'string' && (ZZS as ReadonlyArray<string>).includes(value);\n}\n";

  /**
   * Every source shape the four pieces can arrive in. Each must be
   * enrolled on its own: these are the forms a contributor reaches for
   * without thinking, and a scan that stops matching one fails here by
   * name rather than reporting a quietly smaller population.
   */
  const INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    ["an array-literal membership list", OBJECT + DERIVED + FROZEN_LIST + GUARD],
    [
      "a multi-line Object.values membership list",
      OBJECT +
        DERIVED +
        "export const ZZS: ReadonlyArray<Zz> = Object.freeze(\n  Object.values(ZZ),\n);\n" +
        GUARD,
    ],
    [
      "an unfrozen membership list",
      OBJECT + DERIVED + "export const ZZS: ReadonlyArray<Zz> = [ZZ.a, ZZ.b];\n" + GUARD,
    ],
    [
      "an arrow-function guard",
      OBJECT +
        DERIVED +
        FROZEN_LIST +
        "export const isZz = (value: unknown): value is Zz =>\n" +
        "  typeof value === 'string' && (ZZS as ReadonlyArray<string>).includes(value);\n",
    ],
    [
      "single-quoted values",
      "export const ZZ = Object.freeze({\n  a: 'a',\n  b: 'b',\n} as const);\n" +
        DERIVED +
        FROZEN_LIST +
        GUARD,
    ],
    [
      "a brace inside a value and a brace inside a comment",
      'export const ZZ = Object.freeze({\n  // closes nothing: }\n  a: "a }",\n  b: "b",\n} as const);\n' +
        DERIVED +
        FROZEN_LIST +
        GUARD,
    ],
    ["a guard declared before the object it reads", GUARD + OBJECT + DERIVED + FROZEN_LIST],
    [
      "a vocabulary behind a regex literal holding an unpaired quote",
      'const QUOTED = /["]/;\nexport const ok = QUOTED.source;\n' +
        OBJECT +
        DERIVED +
        FROZEN_LIST +
        GUARD,
    ],
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new vocabulary written as ${shape} is reported unregistered`, () => {
      expect(unregisteredWith({ path: "src/core/zz-intruder.ts", text: source })).toEqual(["ZZ"]);
    });
  }

  test("the module the reviewer smuggled past this file is now reported", () => {
    // Reproduced from the review: a duplicate value, a member no value
    // declares, and a guard that accepts every string - three of the
    // defects `auditVocabulary` exists to catch. It scored 63 pass /
    // 0 fail here before the scan existed.
    const text =
      'export const ZZ_NEW_VOCAB = Object.freeze({\n  first: "same",\n  second: "same",\n} as const);\n' +
      "export type ZzNewVocab = (typeof ZZ_NEW_VOCAB)[keyof typeof ZZ_NEW_VOCAB];\n" +
      "export const ZZ_NEW_VOCABS: ReadonlyArray<string> = Object.freeze([\n" +
      '  ZZ_NEW_VOCAB.first,\n  "phantom",\n]);\n' +
      "export function isZzNewVocab(value: unknown): value is ZzNewVocab {\n" +
      "  return typeof value === 'string' && ZZ_NEW_VOCABS.length > 0;\n}\n";
    expect(unregisteredWith({ path: "src/core/zz-new-vocab.ts", text })).toEqual(["ZZ_NEW_VOCAB"]);
  });

  /**
   * Shapes that must stay OUT. A census that reports frozen objects which
   * are not vocabularies gets deleted, and each of these is a live idiom
   * in this tree - the second one by name.
   */
  const NON_VOCABULARY_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    [
      "a frozen object with no derived union type",
      'export const ZZ = Object.freeze({ a: "a" });\n' +
        "export const ZZS = Object.freeze(Object.values(ZZ));\n" +
        "export function isZz(value: unknown): boolean {\n" +
        "  return ZZS.includes(value as string);\n}\n",
    ],
    [
      "a curated ordering with no guard, as DREAM_STEP_RUNNABLE is",
      OBJECT + DERIVED + "export const ZZ_RUNNABLE: ReadonlyArray<Zz> = Object.freeze([ZZ.a]);\n",
    ],
    [
      "a frozen lookup whose values are not literals",
      "export const ZZ = Object.freeze({ a: readSourceTree, b: maskSource });\n" +
        DERIVED +
        "export const ZZS = Object.freeze(Object.values(ZZ));\n" +
        "export function isZz(value: unknown): boolean {\n" +
        "  return ZZS.includes(value as never);\n}\n",
    ],
    [
      "a guard that takes an already-narrowed string",
      OBJECT +
        DERIVED +
        FROZEN_LIST +
        "export function isZz(value: string): value is Zz {\n" +
        "  return (ZZS as ReadonlyArray<string>).includes(value);\n}\n",
    ],
  ]);

  for (const [shape, source] of NON_VOCABULARY_SHAPES) {
    test(`${shape} is not dragged into the population`, () => {
      expect(unregisteredWith({ path: "src/core/zz-intruder.ts", text: source })).toEqual([]);
    });
  }
});
