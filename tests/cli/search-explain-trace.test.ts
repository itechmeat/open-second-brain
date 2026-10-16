/**
 * `o2b search --explain` serializes the retrieval decision trace and the
 * memory trust assessment (what-the-index-already-knew, task F).
 *
 * Both receipts are built on every gated search and no CLI projection
 * read them. The flag-off bytes are proved identical against the SAME
 * outcome object rendered twice, so the comparison measures the flag and
 * nothing else - no second search, no clock drift, no tolerance.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonForOutcome, renderOutcomeHuman } from "../../src/cli/search/outcome-render.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import {
  RETRIEVAL_TRACE_NOT_MERGED,
  RETRIEVAL_TRACE_UNAVAILABLE_AND_NOT_MERGED,
  RETRIEVAL_TRACE_UNAVAILABLE,
  type ExplainRequest,
} from "../../src/core/search/explain-envelope.ts";
import {
  RETRIEVAL_TRUST_REFUSAL_LANE,
  type RetrievalTrustRefusal,
} from "../../src/core/brain/trust/retrieval-receipts.ts";
import type { BrainSearchResult, SearchOutcome } from "../../src/core/search/types.ts";
import { runCli } from "../helpers/run-cli.ts";

const QUERY = "widget calibration";

/** Single-vault explain: the flag on, no cross-vault union, gate engaged. */
const EXPLAIN_ON: ExplainRequest = Object.freeze({
  explain: true,
  crossVault: false,
  trustGateEnabled: true,
});

/** The same flag over a cross-vault union, whose receipts are not merged. */
const EXPLAIN_ON_GLOBAL: ExplainRequest = Object.freeze({
  explain: true,
  crossVault: true,
  trustGateEnabled: true,
});

const RESULT: BrainSearchResult = Object.freeze({
  documentId: 1,
  chunkId: 1,
  path: "notes/clean.md",
  title: "Clean",
  content: "The widget calibration routine runs daily.",
  startLine: 1,
  endLine: 9,
  score: 1.5,
  keywordScore: 1.5,
  semanticScore: 0,
  linkBoost: 0,
  recencyBoost: 0,
  searchType: "keyword" as const,
  reasons: Object.freeze(["keyword: 1.50"]),
});

const TRACE = Object.freeze({
  evaluated: 2,
  surfaced: 1,
  excluded: 1,
  exclusions: Object.freeze([
    Object.freeze({
      document_id: 2,
      chunk_id: 2,
      path: "notes/quarantined.md",
      reasons: Object.freeze(["trust_gate:self_approval_quarantine"]),
    }),
  ]),
});

const ASSESSMENT = Object.freeze({
  evaluated: 2,
  surfaced: 1,
  quarantined: 1,
  reason_counts: Object.freeze({ "trust_gate:self_approval_quarantine": 1 }),
});

/** With receipts (the trust gate ran) or without (the gate is off). */
function outcome(withReceipts: boolean): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([RESULT]),
    warnings: Object.freeze([]),
    total: 2,
    // Neutral match quality: this test weighs the receipts, not the match,
    // and 1 is what the coverage report yields with no term mass to weigh.
    idfWeightedCoverage: 1,
    ...(withReceipts ? { retrievalDecisionTrace: TRACE, memoryTrustAssessment: ASSESSMENT } : {}),
  });
}

describe("o2b search --explain: retrieval receipts", () => {
  test("json: no trace keys when explain is off, even with receipts on the outcome", () => {
    const withGate = JSON.stringify(jsonForOutcome(outcome(true)));
    const withoutGate = JSON.stringify(jsonForOutcome(outcome(false)));

    // Byte identity: the receipts are invisible until the flag asks.
    expect(withGate).toBe(withoutGate);
    expect(withGate).not.toContain("retrieval_decision_trace");
    expect(withGate).not.toContain("memory_trust_assessment");
    expect(withGate).not.toContain("retrieval_trace_unavailable");
  });

  test("json: explain serializes both receipts", () => {
    const payload = jsonForOutcome(outcome(true), EXPLAIN_ON) as Record<string, unknown>;

    expect(payload["retrieval_decision_trace"]).toEqual(TRACE);
    expect(payload["memory_trust_assessment"]).toEqual(ASSESSMENT);
    expect("retrieval_trace_unavailable" in payload).toBe(false);
    // The rest of the payload is untouched: the explain keys are appended.
    const off = JSON.stringify(jsonForOutcome(outcome(true)));
    delete payload["retrieval_decision_trace"];
    delete payload["memory_trust_assessment"];
    expect(JSON.stringify(payload)).toBe(off);
  });

  test("json: explain with no receipts names why instead of going quiet", () => {
    const payload = jsonForOutcome(outcome(false), EXPLAIN_ON) as Record<string, unknown>;

    expect(payload["retrieval_trace_unavailable"]).toBe(RETRIEVAL_TRACE_UNAVAILABLE);
    expect("retrieval_decision_trace" in payload).toBe(false);
  });

  test("json: a cross-vault union gives its own reason, not the gate's", () => {
    // A union merges one search per origin and carries no receipts, so
    // reporting the gate state here would be a false diagnosis.
    const payload = jsonForOutcome(outcome(false), EXPLAIN_ON_GLOBAL) as Record<string, unknown>;

    expect(payload["retrieval_trace_unavailable"]).toBe(RETRIEVAL_TRACE_NOT_MERGED);
    expect(payload["retrieval_trace_unavailable"]).not.toBe(RETRIEVAL_TRACE_UNAVAILABLE);
  });

  test("json: when the gate is off AND the search is global, both are named", () => {
    // Naming only the union would send the operator to a single-vault
    // query that still produces nothing, because the gate is off there
    // too. Naming only the gate would promise a trace a union cannot
    // merge. The exit has to carry both or it is a dead end either way.
    const both: ExplainRequest = Object.freeze({
      explain: true,
      crossVault: true,
      trustGateEnabled: false,
    });
    const payload = jsonForOutcome(outcome(false), both) as Record<string, unknown>;
    const why = payload["retrieval_trace_unavailable"];

    expect(why).toBe(RETRIEVAL_TRACE_UNAVAILABLE_AND_NOT_MERGED);
    expect(why).not.toBe(RETRIEVAL_TRACE_NOT_MERGED);
    expect(why).not.toBe(RETRIEVAL_TRACE_UNAVAILABLE);
    // Both exits are actually spelled, not merely alluded to.
    expect(String(why)).toContain("search_trust_gate_enabled");
    expect(String(why)).toContain("single vault");
  });

  test("human: the transcript is byte-identical until --explain asks", () => {
    const off = renderOutcomeHuman(outcome(true), false, QUERY);
    expect(off).toBe(renderOutcomeHuman(outcome(false), false, QUERY));

    const on = renderOutcomeHuman(outcome(true), false, QUERY, EXPLAIN_ON);
    expect(on.startsWith(off)).toBe(true);
    expect(on).toContain("evaluated 2");
    expect(on).toContain("excluded 1");
    expect(on).toContain("notes/quarantined.md");
    expect(on).toContain("trust_gate:self_approval_quarantine");

    const unavailable = renderOutcomeHuman(outcome(false), false, QUERY, EXPLAIN_ON);
    expect(unavailable).toContain(RETRIEVAL_TRACE_UNAVAILABLE);
  });

  test("human: a shadow run names the mode and its measured refusals per lane", () => {
    // Shadow's whole purpose is that the would-be refusals are visible to
    // the operator deciding whether to promote the mode; the human
    // transcript is that operator's default surface. With nothing
    // excluded, the enforce-shaped lead line alone would read exactly
    // like a clean run.
    const poolRow: RetrievalTrustRefusal = Object.freeze({
      document_id: 2,
      chunk_id: 2,
      path: "notes/quarantined.md",
      reasons: Object.freeze(["trust_gate:self_approval_quarantine"]),
      lane: RETRIEVAL_TRUST_REFUSAL_LANE.pool,
    });
    const armRow: RetrievalTrustRefusal = Object.freeze({
      document_id: 6,
      chunk_id: 6,
      path: "notes/arm-reached.md",
      reasons: Object.freeze(["relational_arm:entity_contamination"]),
      lane: RETRIEVAL_TRUST_REFUSAL_LANE.arm,
    });
    const shadowTrace = {
      ...TRACE,
      excluded: 0,
      exclusions: [],
      mode: "shadow" as const,
      refused: 2,
      refusals: [poolRow, armRow],
    };
    const shadowAssessment = {
      ...ASSESSMENT,
      quarantined: 0,
      mode: "shadow" as const,
      refused: 2,
      refusals_by_lane: { arm: 1, pool: 1 },
      refused_reason_counts: {
        arm: { "relational_arm:entity_contamination": 1 },
        pool: { "trust_gate:self_approval_quarantine": 1 },
      },
    };
    const o: SearchOutcome = Object.freeze({
      results: Object.freeze([RESULT]),
      warnings: Object.freeze([]),
      total: 2,
      idfWeightedCoverage: 1,
      retrievalDecisionTrace: shadowTrace,
      memoryTrustAssessment: shadowAssessment,
    });
    const rendered = renderOutcomeHuman(o, false, QUERY, EXPLAIN_ON);

    // The mode, and the refusal counts split per lane, on the lead line.
    expect(rendered).toContain("mode shadow");
    expect(rendered).toContain("refused 2 (arm 1, pool 1)");
    // Each refusal as a row, the way exclusions print.
    expect(rendered).toContain("refused: notes/quarantined.md");
    expect(rendered).toContain("refused: notes/arm-reached.md");
    expect(rendered).toContain("relational_arm:entity_contamination");

    // An enforce run with an arm drop renders the same refusal rows but
    // no mode stamp.
    const enforceTrace = {
      ...TRACE,
      refused: 1,
      refusals: [armRow],
    };
    const enforceAssessment = {
      ...ASSESSMENT,
      refused: 1,
      refusals_by_lane: { arm: 1, pool: 0 },
      refused_reason_counts: { arm: { "relational_arm:entity_contamination": 1 }, pool: {} },
    };
    const enforceOutcome: SearchOutcome = Object.freeze({
      results: Object.freeze([RESULT]),
      warnings: Object.freeze([]),
      total: 2,
      idfWeightedCoverage: 1,
      retrievalDecisionTrace: enforceTrace,
      memoryTrustAssessment: enforceAssessment,
    });
    const enforceRendered = renderOutcomeHuman(enforceOutcome, false, QUERY, EXPLAIN_ON);
    expect(enforceRendered).toContain("refused 1 (arm 1, pool 0)");
    expect(enforceRendered).toContain("refused: notes/arm-reached.md");
    expect(enforceRendered).not.toContain("mode");
  });
});

describe("o2b search --explain end to end", () => {
  test("the flag reaches the payload and total reports the pre-truncation pool", async () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-cli-trace-vault-"));
    const configHome = mkdtempSync(join(tmpdir(), "o2b-cli-trace-cfg-"));
    try {
      mkdirSync(join(vault, "notes"), { recursive: true });
      writeFileSync(
        join(vault, "notes", "clean.md"),
        "---\ntitle: Clean\n---\n\n# Clean\n\nThe widget calibration routine runs daily.\n",
      );
      writeFileSync(
        join(vault, "notes", "clean-two.md"),
        "---\ntitle: Clean two\n---\n\n# Clean two\n\nThe widget calibration schedule is weekly.\n",
      );
      writeFileSync(
        join(vault, "notes", "quarantined.md"),
        "---\ntitle: Bad\nstatus: quarantine\n---\n\n# Bad\n\nThe widget calibration is unsafe.\n",
      );
      const configPath = join(configHome, "config.yaml");
      // The gate must EXCLUDE here, and the legacy boolean alone now
      // measures (shadow): enforcement is named explicitly.
      atomicWriteFileSync(
        configPath,
        `vault: ${vault}\nsearch_trust_gate_enabled: true\nsearch_trust_gate_mode: enforce\n`,
      );
      const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };

      const indexed = await runCli(["search", "index"], { env });
      expect(indexed.returncode).toBe(0);

      const plain = await runCli(["search", QUERY, "--json", "--limit", "1"], { env });
      expect(plain.returncode).toBe(0);
      const plainPayload = JSON.parse(plain.stdout) as Record<string, unknown>;
      expect("retrieval_decision_trace" in plainPayload).toBe(false);
      // One row returned out of a three-candidate pool, one of which the
      // gate excluded: total is the surviving pool, not the row count.
      expect((plainPayload["results"] as unknown[]).length).toBe(1);
      expect(plainPayload["total"]).toBe(2);

      const explained = await runCli(["search", QUERY, "--json", "--limit", "1", "--explain"], {
        env,
      });
      expect(explained.returncode).toBe(0);
      const payload = JSON.parse(explained.stdout) as {
        retrieval_decision_trace?: {
          evaluated: number;
          excluded: number;
          exclusions: Array<{ path: string }>;
        };
        memory_trust_assessment?: { quarantined: number };
      };
      expect(payload.retrieval_decision_trace!.evaluated).toBe(3);
      expect(payload.retrieval_decision_trace!.excluded).toBe(1);
      expect(payload.retrieval_decision_trace!.exclusions[0]!.path).toBe("notes/quarantined.md");
      expect(payload.memory_trust_assessment!.quarantined).toBe(1);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  test("a cross-vault union under an explicit mode does not claim the gate is off", async () => {
    // The mode alone runs the gate - the legacy boolean stays unset - so
    // the union's unavailable reason must diagnose ONLY the union: the
    // gate-off half of the combined reason would be a false diagnosis
    // here, and its enablement advice a dead end.
    const vault = mkdtempSync(join(tmpdir(), "o2b-cli-trace-mode-vault-"));
    const configHome = mkdtempSync(join(tmpdir(), "o2b-cli-trace-mode-cfg-"));
    try {
      mkdirSync(join(vault, "notes"), { recursive: true });
      writeFileSync(
        join(vault, "notes", "clean.md"),
        "---\ntitle: Clean\n---\n\n# Clean\n\nThe widget calibration routine runs daily.\n",
      );
      const configPath = join(configHome, "config.yaml");
      atomicWriteFileSync(configPath, `vault: ${vault}\nsearch_trust_gate_mode: enforce\n`);
      const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };

      const indexed = await runCli(["search", "index"], { env });
      expect(indexed.returncode).toBe(0);

      const explained = await runCli(["search", QUERY, "--json", "--global", "--explain"], { env });
      expect(explained.returncode).toBe(0);
      const payload = JSON.parse(explained.stdout) as { retrieval_trace_unavailable?: string };
      expect(payload.retrieval_trace_unavailable).toBe(RETRIEVAL_TRACE_NOT_MERGED);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});
