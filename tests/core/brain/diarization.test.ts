/**
 * Subject diarization (t_28ba3fc4): assemble an entity's document set,
 * emit a profile skeleton plus one needs-llm-step envelope, and compute
 * a deterministic stated-vs-evidenced section, each line carrying the
 * shared evidence-identity type from deep-synthesis (t_40fa4e8d).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasEvidenceIdentity } from "../../../src/core/brain/deep-synthesis.ts";
import { diarize, DiarizationError } from "../../../src/core/brain/diarization.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";

let vault: string;
const NOW = new Date("2026-07-19T10:00:00Z");

function writeSourcePage(
  slug: string,
  body: string,
  dates: { created: string; updated: string },
): void {
  const dir = join(vault, "Brain", "sources");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      "---",
      "kind: brain-source",
      `source_path: ${slug}.txt`,
      "source_hash: deadbeef",
      `created_at: ${dates.created}`,
      `updated_at: ${dates.updated}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-diarize-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });

  // A subject with stated claims AND corroborating evidence.
  upsertEntity(vault, {
    category: "person",
    name: "Ada Lovelace",
    agent: "test",
    now: NOW,
    body: "Ada Lovelace designed an early programming method. Ada Lovelace collaborated with Charles Babbage on the analytical engine.",
  });
  // A subject with stated claims but NO corroborating evidence.
  upsertEntity(vault, {
    category: "person",
    name: "Grace Hopper",
    agent: "test",
    now: NOW,
    body: "Grace Hopper promoted machine-independent programming languages.",
  });
  // A subject that is evidenced but states nothing (empty registry body).
  upsertEntity(vault, {
    category: "person",
    name: "Alan Turing",
    agent: "test",
    now: NOW,
  });

  writeSourcePage("src-lecture", "Ada Lovelace attended a lecture on analytical engines.", {
    created: "2026-07-10T00:00:00Z",
    updated: "2026-07-10T00:00:00Z",
  });
  writeSourcePage("src-letters", "Ada Lovelace corresponded at length about computation.", {
    created: "2026-07-12T00:00:00Z",
    updated: "2026-07-15T00:00:00Z",
  });
  writeSourcePage("src-codebreak", "Alan Turing led the codebreaking effort at Bletchley Park.", {
    created: "2026-07-14T00:00:00Z",
    updated: "2026-07-14T00:00:00Z",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("stated claims corroborated by evidence carry frequency, recency, and identity", () => {
  const report = diarize(vault, { query: "Ada Lovelace" }, { now: NOW });
  expect(report.entityId).toContain("ent-person");
  expect(report.entityName).toBe("Ada Lovelace");

  const corroborated = report.statedVsEvidenced.filter((l) => l.kind === "stated_corroborated");
  expect(corroborated.length).toBeGreaterThanOrEqual(1);
  const line = corroborated[0]!;
  expect(line.evidenceFrequency).toBe(2); // two source pages mention her
  expect(line.lastEvidencedAt).toBe("2026-07-15T00:00:00Z"); // most recent update wins
  expect(hasEvidenceIdentity(line.evidence)).toBe(true);
  expect(line.evidence.kind).toBe("claim");

  // Every line carries a valid S1 evidence identity.
  for (const l of report.statedVsEvidenced) expect(hasEvidenceIdentity(l.evidence)).toBe(true);
});

test("stated but unevidenced claims report a zero-frequency gap", () => {
  const report = diarize(vault, { query: "Grace Hopper" }, { now: NOW });
  const unevidenced = report.statedVsEvidenced.filter((l) => l.kind === "stated_unevidenced");
  expect(unevidenced.length).toBeGreaterThanOrEqual(1);
  expect(unevidenced[0]!.evidenceFrequency).toBe(0);
  expect(unevidenced[0]!.lastEvidencedAt).toBeNull();
});

test("evidenced but unstated subjects surface the source pages as the gap", () => {
  const report = diarize(vault, { query: "Alan Turing" }, { now: NOW });
  const unstated = report.statedVsEvidenced.filter((l) => l.kind === "evidenced_unstated");
  expect(unstated.length).toBeGreaterThanOrEqual(1);
  expect(unstated[0]!.evidence.kind).toBe("source_page");
  expect(unstated[0]!.evidenceFrequency).toBeGreaterThanOrEqual(1);
});

test("the report emits a profile skeleton and exactly one needs-llm-step envelope", () => {
  const report = diarize(vault, { query: "Ada Lovelace" }, { now: NOW });
  expect(report.skeleton).toContain("kind: brain-profile");
  expect(report.skeleton).toContain("## Stated vs evidenced");
  // The prose is deferred, never generated inline.
  expect(report.skeleton).toContain("o2b:needs-llm-step");
  expect(report.llmStep.status).toBe("needs-llm-step");
  expect(report.llmStep.step).toBe("profile-prose");
  expect(report.llmStep.target_path).toContain(report.entityId);
  expect(report.llmStep.prompt.length).toBeGreaterThan(0);
});

test("the document set includes the entity plus every corroborating source", () => {
  const report = diarize(vault, { query: "Ada Lovelace" }, { now: NOW });
  const kinds = report.documentSet.map((d) => d.kind);
  expect(kinds).toContain("entity");
  expect(report.documentSet.filter((d) => d.kind === "source_page").length).toBe(2);
});

test("an unknown entity is a typed error", () => {
  expect(() => diarize(vault, { query: "Nobody At All" }, { now: NOW })).toThrow(DiarizationError);
});
