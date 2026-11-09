/**
 * Reader parity of the operator surfaces (task 2.10, design D14): doctor,
 * status, health, hygiene, trust and the lint and graph readers give the
 * same answer on a switched machine, where the memory records live in the
 * store only, as on an unswitched machine holding the same records as
 * legacy pages. A guard below fails when a reader answers "nothing" on a
 * switched machine that has data, the inventory's top reader risk.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  collectAllBasenames,
  readAllPreferenceRecords,
  readAllRetiredRecords,
} from "../../../src/core/brain/doctor/records.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { STORE_CLOCK_AHEAD_CODE } from "../../../src/core/brain/doctor/store-check.ts";
import { computeSemanticHealth } from "../../../src/core/brain/doctor/semantic-health-check.ts";
import { resolveArtifactRef } from "../../../src/core/brain/artifact-ref-resolve.ts";
import { buildBacklinkIndex } from "../../../src/core/brain/backlinks.ts";
import { buildForgetPlan } from "../../../src/core/brain/governance/forget-plan.ts";
import { collectDriftedSlugs } from "../../../src/core/brain/health/remediation.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { buildAliasIndex } from "../../../src/core/brain/link-graph/alias-index.ts";
import { buildConceptCluster } from "../../../src/core/brain/link-graph/concept-cluster.ts";
import { auditMoc } from "../../../src/core/brain/link-graph/moc-audit.ts";
import { findUnlinkedMentions } from "../../../src/core/brain/link-graph/unlinked-mentions.ts";
import { buildOperatorSnapshot } from "../../../src/core/brain/operator-snapshot.ts";
import { loadBrainConfig, resolveTemporal } from "../../../src/core/brain/policy.ts";
import { buildRetentionReview } from "../../../src/core/brain/retention.ts";
import { buildSchemaReport } from "../../../src/core/brain/schema-report.ts";
import { auditStaleDependencies } from "../../../src/core/brain/stale-dependency.ts";
import { computeBrainStatus } from "../../../src/core/brain/status.ts";
import { buildTimelineIndex } from "../../../src/core/brain/temporal/build-index.ts";
import { findStaleEntries } from "../../../src/core/brain/temporal/stale-watch.ts";
import { computeTokenFootprint } from "../../../src/core/brain/token-footprint.ts";
import { computeVerificationDelta } from "../../../src/core/brain/trust/compute-verification-delta.ts";
import { computeVaultVitals } from "../../../src/core/brain/vitals.ts";
import { adviseUnroutableCapture } from "../../../src/core/brain/write-advisory.ts";
import type { DreamRunSummary } from "../../../src/core/brain/dream.ts";
import { vaultDelta } from "../../../src/core/discipline/vault-delta.ts";
import { emitDecisionModelCall } from "../../../src/core/decision-model/record.ts";
import { buildPairVerdictSamples } from "../../../src/core/decision-model/reports/pair-verdict.ts";
import {
  FIXTURE_IDS,
  FIXTURE_NOW,
  mintedId,
  withMemoryFixture,
  switchDevice,
  withMemoryFixtureAsync,
  type MemoryMode,
} from "./fixtures/memory-twins.ts";

type Reader = (vault: string) => unknown;

/**
 * Doctor codes the fixture's pinned instant raises, not a reader: the
 * switched twin's records carry the wall clock of the run that wrote them,
 * the legacy twin holds none, and the doctor judges at FIXTURE_NOW. Once
 * the wall clock is more than the drift bound past FIXTURE_NOW, the
 * switched twin alone reports its records as ahead of "now" (the check
 * itself is covered by the store-check tests).
 */
const FIXTURE_CLOCK_CODES: ReadonlySet<string> = new Set([STORE_CLOCK_AHEAD_CODE]);

/**
 * Doctor codes that tell the two machines apart by design, not by a
 * reader: `migration-available` is reported only while a machine still
 * keeps the legacy tree, and `delivery-provenance-unknown` counts vault
 * pages, which a switched machine's memory records no longer are.
 */
const MODE_CODES: ReadonlySet<string> = new Set([
  "migration-available",
  "delivery-provenance-unknown",
]);

/** Every reader the parity covers: name, how to call it, and its answer on the fixture. */
const READERS: ReadonlyArray<readonly [string, Reader]> = [
  [
    "doctor/records readAllPreferenceRecords",
    (vault) =>
      readAllPreferenceRecords(vault)
        .map((r) => ({ path: r.path, pref: r.pref }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
  ],
  [
    "doctor/records readAllRetiredRecords",
    (vault) => readAllRetiredRecords(vault).map((r) => ({ path: r.path, retired: r.retired })),
  ],
  [
    "doctor/records collectAllBasenames",
    (vault) => [...collectAllBasenames(vault)].filter((n) => /^(pref|ret|sig)-/.test(n)).toSorted(),
  ],
  [
    "doctor issues",
    (vault) => {
      const result = runDoctor(vault, { now: FIXTURE_NOW });
      return {
        issues: [...result.errors, ...result.warnings]
          .filter((i) => !MODE_CODES.has(i.code) && !FIXTURE_CLOCK_CODES.has(i.code))
          .map((i) => `${i.severity} ${i.code} ${i.path ?? ""} ${i.message}`)
          .toSorted(),
        uncertain: (result.uncertain ?? [])
          .filter((u) => !MODE_CODES.has(u.code))
          .map((u) => JSON.stringify(u))
          .toSorted(),
      };
    },
  ],
  ["status computeBrainStatus", (vault) => computeBrainStatus(vault, { now: FIXTURE_NOW })],
  [
    "token-footprint computeTokenFootprint (files and tokens per category)",
    (vault) =>
      computeTokenFootprint(vault)
        .byCategory.filter((c) => c.name !== "log" && c.name !== "other")
        // Token estimates count characters, and signal ids (in signal pages
        // and in the preferences evidenced by them) carry the mint tag once
        // switched: the categories compare by file count.
        .map((c) => ({ name: c.name, files: c.files })),
  ],
  [
    "trust computeVerificationDelta",
    (vault) =>
      computeVerificationDelta(vault, {
        confirmed: [FIXTURE_IDS.prefTabs, "pref-gone"],
        new_unconfirmed: [FIXTURE_IDS.prefNaming],
        retired: [{ id: FIXTURE_IDS.retired }, { id: "ret-naming" }],
      } as unknown as DreamRunSummary),
  ],
  ["vitals computeVaultVitals", (vault) => computeVaultVitals(vault)],
  [
    "write-advisory adviseUnroutableCapture",
    (vault) => adviseUnroutableCapture(vault, { agent: "claude", now: FIXTURE_NOW }),
  ],
  [
    "hygiene runHygieneScan (dedup, usefulness)",
    (vault) =>
      runHygieneScan(vault, {
        now: new Date("2027-06-01T00:00:00Z"),
        detectors: ["dedup", "usefulness"],
      }).findings.map((f) => f.id),
  ],
  ["remediation collectDriftedSlugs", (vault) => collectDriftedSlugs(vault)],
  [
    "retention buildRetentionReview",
    (vault) => buildRetentionReview(vault, { now: FIXTURE_NOW }).recommendations,
  ],
  [
    "schema-report buildSchemaReport",
    (vault) => {
      const { generated_at: _generated, ...report } = buildSchemaReport(vault) as unknown as Record<
        string,
        unknown
      >;
      return report;
    },
  ],
  [
    "stale-watch findStaleEntries",
    (vault) => {
      const now = new Date("2027-12-01T00:00:00Z");
      const found = findStaleEntries(
        buildTimelineIndex(vault),
        vault,
        resolveTemporal(loadBrainConfig(vault)),
        { now },
      ) as unknown as Record<string, unknown>;
      // The log files are not memory records: the log moves to the store
      // with its own readers.
      const { generatedAt: _generated, staleLogFiles: _logs, ...rest } = found;
      // The legacy side lists in directory order; the order is not the answer.
      return Object.fromEntries(
        Object.entries(rest).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
            : value,
        ]),
      );
    },
  ],
  [
    "discipline vaultDelta",
    // The wall clock, not FIXTURE_NOW: the legacy twin counts its pages by
    // file mtime, which is when the fixture wrote them.
    (vault) =>
      vaultDelta(vault, {
        startUtc: new Date(Date.now() - 3_600_000),
        endUtc: new Date(Date.now() + 3_600_000),
      }),
  ],
  [
    "backlinks buildBacklinkIndex",
    (vault) => {
      const index = buildBacklinkIndex(vault);
      return [...index.entries()]
        .map(([target, refs]) => [target, refs.map((r) => `${r.source}:${r.field}`).toSorted()])
        .toSorted();
    },
  ],
  ["alias-index buildAliasIndex", (vault) => [...buildAliasIndex(vault).entries()].toSorted()],
  [
    "forget-plan buildForgetPlan",
    (vault) => {
      const entries = buildForgetPlan(vault, { source: "rinciple" }).entries;
      // The memory records compare entry for entry. The log is named per
      // shard file on one machine and per day on the other, and the
      // compiled digests are vault files only while unswitched.
      return {
        memory: entries
          .filter((e) => e.kind !== "log" && e.kind !== "other")
          .map(({ sha256: _sha, ...entry }) => entry),
        log: entries.some((e) => e.kind === "log"),
      };
    },
  ],
  [
    "artifact-ref-resolve resolveArtifactRef",
    (vault) =>
      [FIXTURE_IDS.prefTabs, FIXTURE_IDS.retired, FIXTURE_IDS.consumed, FIXTURE_IDS.tabs].map(
        (id) => resolveArtifactRef(vault, mintedId(vault, id)),
      ),
  ],
  [
    "stale-dependency auditStaleDependencies",
    (vault) => {
      const report = auditStaleDependencies(vault, { now: FIXTURE_NOW }) as unknown as Record<
        string,
        unknown
      >;
      return report["states"] ?? report;
    },
  ],
  [
    "link-graph auditMoc (hub with prose links)",
    (vault) => {
      try {
        const { generatedAt: _generated, ...report } = auditMoc(vault, FIXTURE_IDS.prefImported, {
          minOutboundLinks: 3,
          minLinkRatio: 0.05,
        }) as unknown as Record<string, unknown>;
        return report;
      } catch (err) {
        // With no records the hub is absent: an answer, not a crash.
        return { error: (err as Error).message };
      }
    },
  ],
  [
    "link-graph buildConceptCluster",
    (vault) => {
      const { generatedAt: _generated, ...cluster } = buildConceptCluster(
        vault,
        FIXTURE_IDS.prefNaming,
        { includeUnlinked: true },
      ) as unknown as Record<string, unknown>;
      return cluster;
    },
  ],
  [
    "link-graph findUnlinkedMentions",
    (vault) => findUnlinkedMentions(vault, FIXTURE_IDS.prefNaming),
  ],
  [
    "decision-model buildPairVerdictSamples (preference outcomes)",
    (vault) => {
      // The recorded dedup verdicts are the report's input; the decision
      // model's call record is the existing seam the report tests use.
      emitDecisionModelCall(vault, {
        use: "dedup",
        mode: "shadow",
        provider: "fake",
        model: "m",
        calibrated: true,
        questionCount: 3,
        candidateCount: 3,
        inputPriceUsdPerMtok: null,
        latencyMs: 1,
        outcome: "ok",
        details: {
          pair_kind: "preference",
          pairs: [
            { id: "f1", a: "pref-tabs", b: "pref-gone", verdict: "same", probability: 0.95 },
            { id: "f2", a: "pref-tabs", b: "pref-naming", verdict: "different", probability: 0.9 },
            { id: "f3", a: "pref-tabs", b: "pref-absent", verdict: "same", probability: 0.8 },
          ],
        },
      });
      return buildPairVerdictSamples(vault, "dedup")
        .samples.map((sample) => `${sample.verdict}:${sample.outcome}`)
        .toSorted();
    },
  ],
  [
    "semantic-health computeSemanticHealth",
    (vault) => computeSemanticHealth(vault, { now: FIXTURE_NOW }),
  ],
];

function answers(mode: MemoryMode, seed = true): Map<string, unknown> {
  return withMemoryFixture(
    mode,
    (env) => {
      if (mode === "switched") {
        // The switched machine wrote no memory page.
        expect(
          existsSync(join(env.vault, "Brain", "preferences", `${FIXTURE_IDS.prefTabs}.md`)),
        ).toBe(false);
      }
      return new Map(READERS.map(([name, read]) => [name, read(env.vault)]));
    },
    { seed },
  );
}

async function snapshotCounts(mode: MemoryMode, seed = true): Promise<unknown> {
  return withMemoryFixtureAsync(
    mode,
    async (env) => (await buildOperatorSnapshot(env.vault, { now: FIXTURE_NOW })).counts,
    { seed },
  );
}

// Built in beforeAll, not at collection time: the preload's per-test
// resets have run, and a fixture failure names a test instead of failing
// the file load.
let legacy: Map<string, unknown>;
let switched: Map<string, unknown>;
let switchedEmpty: Map<string, unknown>;
beforeAll(() => {
  legacy = answers("legacy");
  switched = answers("switched");
  switchedEmpty = answers("switched", false);
});

describe("operator readers on a switched machine", () => {
  for (const [name] of READERS) {
    test(`${name} answers as on an unswitched machine`, () => {
      expect(switched.get(name)).toEqual(legacy.get(name));
    });

    test(`${name} is not empty on a switched machine that has data`, () => {
      // The fixture gives every reader data, so the guard always holds
      // something: an empty unswitched answer is a fixture gap, not a pass.
      expect(isEmptyAnswer(legacy.get(name))).toBe(false);
      expect(isEmptyAnswer(switched.get(name))).toBe(false);
      // The guard can tell: with no records the same reader is empty or differs.
      expect(switchedEmpty.get(name)).not.toEqual(switched.get(name));
    });
  }
});

describe("the fixture exercises the graph and remediation readers", () => {
  test("the hub audit, the mentions and the drift scan have something to report", () => {
    const moc = switched.get("link-graph auditMoc (hub with prose links)") as Record<
      string,
      unknown
    >;
    expect(moc["error"]).toBeUndefined();
    expect(JSON.stringify(moc)).toContain("pref-tabs");
    expect(JSON.stringify(switched.get("link-graph findUnlinkedMentions"))).toContain(
      FIXTURE_IDS.prefImported,
    );
    expect(switched.get("remediation collectDriftedSlugs")).toEqual(["drifted"]);
    expect(switched.get("decision-model buildPairVerdictSamples (preference outcomes)")).toEqual([
      "different:open",
      "same:merged",
      "same:missing",
    ]);
  });
});

describe("legacy pages left in place on a switched machine", () => {
  // D11a: the legacy tree stays, read-only, until every device switched.
  // A switched machine whose store holds nothing must not read those pages.
  const LEGACY_BLIND = [
    "doctor/records readAllPreferenceRecords",
    "doctor/records readAllRetiredRecords",
    "doctor/records collectAllBasenames",
    "status computeBrainStatus",
    "backlinks buildBacklinkIndex",
    "retention buildRetentionReview",
    "artifact-ref-resolve resolveArtifactRef",
  ];
  let afterSwitch: Map<string, unknown>;
  beforeAll(() => {
    afterSwitch = withMemoryFixture("legacy", (env) => {
      switchDevice(env);
      return new Map(
        READERS.filter(([name]) => LEGACY_BLIND.includes(name)).map(([name, read]) => [
          name,
          read(env.vault),
        ]),
      );
    });
  });
  for (const name of LEGACY_BLIND) {
    test(`${name} reads the store, not the legacy pages`, () => {
      expect(afterSwitch.get(name)).toEqual(switchedEmpty.get(name));
      expect(afterSwitch.get(name)).not.toEqual(legacy.get(name));
    });
  }
});

describe("operator snapshot on a switched machine", () => {
  test("counts the memory records as on an unswitched machine, and not as none", async () => {
    const fromLegacy = await snapshotCounts("legacy");
    const fromStore = await snapshotCounts("switched");
    expect(fromStore).toEqual(fromLegacy);
    expect(fromStore).not.toEqual(await snapshotCounts("switched", false));
  });
});

/**
 * Whether an answer holds no data: nothing, an empty collection, zero, an
 * empty string, or an object (or collection) whose every value is empty -
 * so `{ count: 0, items: [] }` is empty, not data.
 */
function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every(isEmptyAnswer);
  if (value instanceof Map) return [...value.values()].every(isEmptyAnswer);
  if (value instanceof Set) return [...value].every(isEmptyAnswer);
  if (typeof value === "object") return Object.values(value).every(isEmptyAnswer);
  return false;
}
