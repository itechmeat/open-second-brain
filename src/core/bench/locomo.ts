/**
 * LoCoMo benchmark suite adapter (Retrieval & Ranking Quality, t_8dabe2b0).
 *
 * LoCoMo (Long Conversational Memory) is a widely-cited long-conversation
 * memory benchmark. OSB already owns a staged bench harness
 * (ingest -> index -> retrieve -> evaluate -> report) with its own
 * MemoryBench-inspired categories; this module adds LoCoMo as an ADDITIVE,
 * parallel NAMED suite by converting a LoCoMo-shaped dataset into the
 * existing {@link BenchFixture} the unchanged `runMemoryBench` consumes.
 * OSB's six categories stay canonical; LoCoMo questions are expressed in
 * terms of them (single_hop / temporal / multi_evidence).
 *
 * Deterministic and network-free: the loader is pure over its input, the
 * run scores by deterministic substring / path containment, and the
 * optional LLM judge stays opt-in (`bench_judge_cmd`) - never the default.
 * No harness-mechanic change and no new dependency.
 */

import { readFileSync } from "node:fs";

import { parseBenchFixture } from "./fixture.ts";
import type { BenchCategory, BenchFixture, BenchQuestion } from "./types.ts";

export interface LocomoTurn {
  readonly speaker: string;
  readonly text: string;
  /** ISO-ish timestamp; normalised to canonical UTC for continuity. */
  readonly timestamp: string;
}

export interface LocomoSession {
  readonly session_id: string;
  readonly turns: ReadonlyArray<LocomoTurn>;
}

export interface LocomoQa {
  readonly id: string;
  readonly question: string;
  readonly answer?: string;
  /** LoCoMo category hint (e.g. "temporal", "multi-hop"); mapped below. */
  readonly category?: string;
  /** Session ids that hold the evidence for the answer. Non-empty. */
  readonly evidence_sessions: ReadonlyArray<string>;
}

export interface LocomoDataset {
  readonly name?: string;
  readonly sessions: ReadonlyArray<LocomoSession>;
  readonly qa: ReadonlyArray<LocomoQa>;
}

class LocomoParseError extends Error {}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LocomoParseError(`LoCoMo dataset: ${field} must be a non-empty string`);
  }
  return value;
}

/** Parse and validate a raw LoCoMo dataset. Fail-fast with a named error. */
export function parseLocomoDataset(raw: unknown): LocomoDataset {
  if (raw === null || typeof raw !== "object") {
    throw new LocomoParseError("LoCoMo dataset must be an object");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["sessions"]) || r["sessions"].length === 0) {
    throw new LocomoParseError("LoCoMo dataset needs a non-empty `sessions` array");
  }
  if (!Array.isArray(r["qa"]) || r["qa"].length === 0) {
    throw new LocomoParseError("LoCoMo dataset needs a non-empty `qa` array");
  }
  const sessions: LocomoSession[] = r["sessions"].map((s, i) => {
    if (s === null || typeof s !== "object") {
      throw new LocomoParseError(`sessions[${i}] must be an object`);
    }
    const sd = s as Record<string, unknown>;
    const sessionId = asString(sd["session_id"], `sessions[${i}].session_id`);
    if (!Array.isArray(sd["turns"]) || sd["turns"].length === 0) {
      throw new LocomoParseError(`sessions[${i}].turns must be a non-empty array`);
    }
    const turns: LocomoTurn[] = sd["turns"].map((t, j) => {
      if (t === null || typeof t !== "object") {
        throw new LocomoParseError(`sessions[${i}].turns[${j}] must be an object`);
      }
      const td = t as Record<string, unknown>;
      return {
        speaker: asString(td["speaker"], `sessions[${i}].turns[${j}].speaker`),
        text: asString(td["text"], `sessions[${i}].turns[${j}].text`),
        timestamp: asString(td["timestamp"], `sessions[${i}].turns[${j}].timestamp`),
      };
    });
    return { session_id: sessionId, turns };
  });
  const knownSessions = new Set(sessions.map((s) => s.session_id));
  const qa: LocomoQa[] = r["qa"].map((q, i) => {
    if (q === null || typeof q !== "object") {
      throw new LocomoParseError(`qa[${i}] must be an object`);
    }
    const qd = q as Record<string, unknown>;
    const evidence = qd["evidence_sessions"];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new LocomoParseError(`qa[${i}].evidence_sessions must be a non-empty array`);
    }
    const evidenceSessions = evidence.map((e, k) => {
      const sid = asString(e, `qa[${i}].evidence_sessions[${k}]`);
      if (!knownSessions.has(sid)) {
        throw new LocomoParseError(`qa[${i}] references unknown session '${sid}'`);
      }
      return sid;
    });
    return {
      id: asString(qd["id"], `qa[${i}].id`),
      question: asString(qd["question"], `qa[${i}].question`),
      ...(typeof qd["answer"] === "string" ? { answer: qd["answer"] } : {}),
      ...(typeof qd["category"] === "string" ? { category: qd["category"] } : {}),
      evidence_sessions: evidenceSessions,
    };
  });
  return {
    ...(typeof r["name"] === "string" ? { name: r["name"] } : {}),
    sessions,
    qa,
  };
}

/** Vault-relative note path for a LoCoMo session. */
function sessionNotePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `sessions/${safe}.md`;
}

/** Map a LoCoMo QA to one of OSB's canonical retrieval categories. */
function mapCategory(qa: LocomoQa): BenchCategory {
  if (qa.evidence_sessions.length > 1) return "multi_evidence";
  const hint = (qa.category ?? "").toLowerCase();
  if (hint.includes("temporal") || hint.includes("time")) return "temporal";
  return "single_hop";
}

/**
 * Convert a parsed LoCoMo dataset into an OSB {@link BenchFixture}, named
 * `locomo-<name>`. Sessions become evidence notes (and session_turn
 * continuity records); QA pairs become retrieval questions whose
 * `expected_paths` point at their evidence session notes and whose
 * `expected_text` is the declared answer (deterministic containment).
 */
export function locomoToBenchFixture(dataset: LocomoDataset): BenchFixture {
  const notes = dataset.sessions.map((s) => ({
    path: sessionNotePath(s.session_id),
    body:
      `# Session ${s.session_id}\n\n` + s.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
  }));
  const continuity = dataset.sessions.flatMap((s) =>
    s.turns.map((t) => ({
      kind: "session_turn" as const,
      created_at: new Date(t.timestamp).toISOString(),
      payload: { session_id: s.session_id, speaker: t.speaker, text: t.text },
    })),
  );
  const questions: BenchQuestion[] = dataset.qa.map((qa) => ({
    id: qa.id,
    category: mapCategory(qa),
    query: qa.question,
    top_k: 5,
    expected_paths: qa.evidence_sessions.map(sessionNotePath),
    ...(qa.answer ? { expected_text: qa.answer } : {}),
  }));
  const name = `locomo-${dataset.name ?? "suite"}`;
  // Validate through the canonical parser so a converted fixture is
  // guaranteed to be exactly what runMemoryBench accepts.
  return parseBenchFixture({ name, notes, continuity, questions });
}

/** Load a LoCoMo dataset file and convert it to a BenchFixture. */
export function loadLocomoFixture(path: string): BenchFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LocomoParseError(
      `LoCoMo dataset not readable JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return locomoToBenchFixture(parseLocomoDataset(raw));
}
