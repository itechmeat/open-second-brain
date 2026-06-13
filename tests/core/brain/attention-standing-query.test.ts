/**
 * Operator-editable standing-query attention layer (Knowledge Provenance
 * suite). Extends the existing attention-flows mechanism with a
 * `standing_query` action: an operator declares scope tokens in a flow doc and
 * the matching confirmed preferences always surface into the assembled
 * context. Structural (scope-token) selector - language-agnostic. A vault that
 * declares no standing_query is byte-identical to today.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { attentionFlowsDir } from "../../../src/core/brain/paths.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  evaluateAttentionFlow,
  listAttentionFlows,
} from "../../../src/core/brain/attention-flows.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-standing-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-standing-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeConfirmed(slug: string, scope?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `rule ${slug}`,
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-07-01T00:00:00Z",
    confirmed_at: "2026-06-02T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    ...(scope !== undefined ? { scope } : {}),
  });
}

function writeStandingFlow(scopes: string[]): void {
  writeFrontmatterAtomic(
    join(attentionFlowsDir(vault), "loops.md"),
    {
      kind: "brain-attention-flow",
      id: "loops",
      title: "Open loops",
      actions: ["standing_query"],
      standing_queries: scopes,
      status: "active",
    },
    "# Open loops",
    { overwrite: true },
  );
}

describe("standing_query attention action", () => {
  test("surfaces confirmed preferences whose scope the operator declared", () => {
    writeConfirmed("a", "commitment");
    writeConfirmed("b", "commitment");
    writeConfirmed("c", "writing");
    writeStandingFlow(["commitment"]);

    const evaluation = evaluateAttentionFlow(vault, "loops");
    const section = evaluation.sections.find((s) => s.action === "standing_query");
    expect(section).toBeDefined();
    expect(section?.items).toEqual(["pref-a (commitment)", "pref-b (commitment)"]);
  });

  test("the recipe parses the declared scope tokens", () => {
    writeStandingFlow(["commitment", "writing"]);
    const flow = listAttentionFlows(vault).find((f) => f.id === "loops");
    expect(flow?.standingQueryScopes).toEqual(["commitment", "writing"]);
  });

  test("the default flow declares no standing query (byte-identical default)", () => {
    // ensureDefaultAttentionFlows writes open-loops.md without standing_query.
    const flow = listAttentionFlows(vault).find((f) => f.id === "open-loops");
    expect(flow?.actions.includes("standing_query")).toBe(false);
    expect(flow?.standingQueryScopes).toEqual([]);
  });

  test("an empty declared scope set surfaces nothing", () => {
    writeConfirmed("a", "commitment");
    writeStandingFlow([]);
    const evaluation = evaluateAttentionFlow(vault, "loops");
    const section = evaluation.sections.find((s) => s.action === "standing_query");
    expect(section?.items).toEqual([]);
  });
});
