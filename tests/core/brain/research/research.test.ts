/**
 * Parameterized research pipeline (Knowledge Provenance suite). N sources plus
 * an agent synthesis become one dated, cited report page; each finding cites
 * the source that flagged it. OSB runs no model and rejects any uncited claim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  writeResearchReport,
  ResearchValidationError,
} from "../../../../src/core/brain/research/research.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-13T18:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-research-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-research-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const INPUT = {
  title: "Restaking risk survey",
  sources: ["Articles/a.md", "Articles/b.md"],
  findings: [
    { statement: "Slashing risk compounds across AVSs", sources: ["Articles/a.md"] },
    {
      statement: "Withdrawal queues lengthen under stress",
      sources: ["Articles/a.md", "Articles/b.md"],
    },
  ],
};

describe("writeResearchReport", () => {
  test("writes a dated report page with per-finding citations and a Sources section", () => {
    const res = writeResearchReport(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.created).toBe(true);
    expect(res.findingCount).toBe(2);
    expect(res.reportPath).toContain("2026-06-13");

    const md = readFileSync(join(vault, res.reportPath), "utf8");
    expect(md).toContain("kind: brain-report");
    expect(md).toContain("# Restaking risk survey");
    expect(md).toContain("## Findings");
    expect(md).toContain("Slashing risk compounds across AVSs (cites: [[Articles/a.md]])");
    expect(md).toContain("## Sources");
    expect(md).toContain("[[Articles/b.md]]");
  });

  test("rejects a finding with no source (no uncited claims) and writes nothing", () => {
    const bad = {
      title: "x",
      sources: ["Articles/a.md"],
      findings: [{ statement: "unsupported claim", sources: [] }],
    };
    expect(() => writeResearchReport(vault, bad, { agent: "claude", now: NOW })).toThrow(
      ResearchValidationError,
    );
  });

  test("rejects a finding citing a source that was not consulted", () => {
    const bad = {
      title: "x",
      sources: ["Articles/a.md"],
      findings: [{ statement: "claim", sources: ["Articles/ghost.md"] }],
    };
    expect(() => writeResearchReport(vault, bad, { agent: "claude", now: NOW })).toThrow(
      ResearchValidationError,
    );
  });

  test("is idempotent on date+title: a re-run rewrites the same report page", () => {
    const first = writeResearchReport(vault, INPUT, { agent: "claude", now: NOW });
    const second = writeResearchReport(vault, INPUT, { agent: "claude", now: LATER });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reportPath).toBe(first.reportPath);
  });
});
