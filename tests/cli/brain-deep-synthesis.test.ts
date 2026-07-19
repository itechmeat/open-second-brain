/**
 * `o2b brain deep-synthesis` CLI surface. The dossier's evidence loss
 * and confidence decomposition (t_40fa4e8d) must be visible on the
 * `--json` payload alongside the prior pre-S1 fields.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

function writeMd(relPath: string, content: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-deep-synth-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeMd(
    "Brain/notes/claim.md",
    [
      "---",
      "title: Claim",
      "contradicts: [[counter]]",
      "---",
      "# Claim",
      "",
      "Manticores hunt at dawn. See [[missing-study]] for details.",
    ].join("\n"),
  );
  writeMd(
    "Brain/notes/counter.md",
    "---\ntitle: Counter\n---\n# Counter\n\nManticores hunt strictly at night.",
  );
  writeMd(
    "Brain/notes/support.md",
    [
      "---",
      "title: Support",
      "related: [[claim]]",
      "---",
      "# Support",
      "",
      "Field observations of manticores corroborate the dawn pattern.",
    ].join("\n"),
  );
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("--json still carries the prior pre-S1 dossier fields", async () => {
  const r = await runCli(["brain", "deep-synthesis", "manticores", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    topic: string;
    checked: string[];
    notes: unknown[];
    contradictions: Array<{ path: string; target: string }>;
    gaps: Array<{ target: string }>;
    strongest_objection: { basis: string } | null;
  };
  expect(payload.ok).toBe(true);
  expect(payload.topic).toBe("manticores");
  expect(payload.checked).toContain("knowledge_gaps");
  expect(payload.contradictions[0]!.target).toBe("counter");
  expect(payload.gaps[0]!.target).toBe("missing-study");
  expect(payload.strongest_objection!.basis).toBe("contradiction");
});

test("--json exposes causal context, decomposed confidence, and exclusions (t_40fa4e8d)", async () => {
  const r = await runCli(["brain", "deep-synthesis", "manticores", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    findings: Array<{
      evidence: { path: string; kind: string; content_hash: string };
      title: string | null;
      causal_context: {
        relations: Array<{ relation: string; target: string }>;
        superseded_by: string | null;
        dangling_citations: number;
      };
      confidence: { support: number; opposition: number; freshness: number; coverage: number };
    }>;
    excluded_findings: Array<{ path: string; reason: string }>;
    excluded_finding_count: number;
  };
  expect(Array.isArray(payload.findings)).toBe(true);
  const claim = payload.findings.find((f) => f.evidence.path === "Brain/notes/claim.md");
  expect(claim).toBeDefined();
  expect(claim!.evidence.kind).toBe("note");
  expect(claim!.evidence.content_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(claim!.confidence.opposition).toBeGreaterThanOrEqual(1);
  expect(typeof claim!.confidence.support).toBe("number");
  expect(typeof claim!.confidence.freshness).toBe("number");
  expect(typeof claim!.confidence.coverage).toBe("number");
  expect(claim!.causal_context.dangling_citations).toBeGreaterThanOrEqual(1);
  expect(claim!.causal_context.relations.some((rel) => rel.relation === "contradicts")).toBe(true);
  expect(Array.isArray(payload.excluded_findings)).toBe(true);
  expect(typeof payload.excluded_finding_count).toBe("number");
  expect(payload.excluded_finding_count).toBe(payload.excluded_findings.length);
});
