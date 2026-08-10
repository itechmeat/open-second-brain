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
 */

import { describe, expect, test } from "bun:test";

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
]);

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
