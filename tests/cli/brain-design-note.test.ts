/**
 * `o2b brain design-note` and `brain_design_note`
 * (salience-lifecycle-enrichment, unit 7, t_c87644b4). Claims pinned here:
 *
 *  1. The grounding phase's `--json` payload carries the three stores'
 *     matches, their counts, the NAMED empty stores, and one envelope.
 *  2. The commit phase's `--json` payload names the note and the single
 *     recommended alternative.
 *  3. A payload that does not recommend exactly one alternative exits 1
 *     with the refusal in `--json`, and writes nothing.
 *  4. A missing topic is a usage error (exit 2), and the verb has its own
 *     `--help`.
 *  5. The MCP tool answers over the same core, both phases, and the path
 *     it reports is vault-relative - no MCP response carries the
 *     absolute host path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordDecision } from "../../src/core/brain/decisions/record.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { runCli } from "../helpers/run-cli.ts";

const TOPIC = "vector index storage";
let tmp: string;
let vault: string;
let configPath: string;

function note(...flags: ReadonlyArray<boolean>): Record<string, unknown> {
  return {
    title: "Where the vector index lives",
    alternatives: flags.map((recommended, i) => ({
      name: `option-${i}`,
      approach: `Store the index with option-${i}.`,
      tradeoffs: "Write cost against read latency.",
      recommended,
    })),
  };
}

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "design-note", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-design-note-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  recordDecision(vault, {
    title: "Vector index storage location",
    chosen: "Keep the index outside the vault",
    assumption: "Sync clients must not replicate a binary index",
    reviewDate: "2027-01-01",
    agent: "tester",
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("the grounding phase --json carries counts, named empty stores and one envelope", async () => {
  const r = await run([TOPIC, "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    topic: string;
    target_path: string;
    grounding: {
      decisions: Array<{ title: string }>;
      counts: { tensions: number; decisions: number; truthSlots: number; conflicts: number };
      empty_stores: string[];
    };
    llm_step: { status: string; step: string; target_path: string };
  };
  expect(payload.ok).toBe(true);
  expect(payload.topic).toBe(TOPIC);
  expect(payload.grounding.decisions.map((d) => d.title)).toEqual([
    "Vector index storage location",
  ]);
  expect(payload.grounding.counts.decisions).toBe(1);
  // The decision store held something; the other two hold nothing at all
  // and say so by name.
  expect(payload.grounding.empty_stores.toSorted()).toEqual(["tensions", "truth"]);
  expect(payload.llm_step.status).toBe("needs-llm-step");
  expect(payload.llm_step.step).toBe("design-note");
  expect(payload.llm_step.target_path).toBe(payload.target_path);
});

test("the commit phase --json names the note and its one recommendation", async () => {
  const r = await run([TOPIC, "--payload", JSON.stringify(note(false, true)), "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    ok: boolean;
    path: string;
    recommended: string;
    alternative_count: number;
  };
  expect(payload.ok).toBe(true);
  expect(payload.recommended).toBe("option-1");
  expect(payload.alternative_count).toBe(2);
  expect(existsSync(payload.path)).toBe(true);
  expect(payload.path).toContain(join("Brain", "decisions"));
});

test("a payload recommending nothing exits 1, names the count, and writes nothing", async () => {
  const r = await run([TOPIC, "--payload", JSON.stringify(note(false, false)), "--json"]);
  expect(r.returncode).toBe(1);
  const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
  expect(payload.ok).toBe(false);
  expect(payload.message).toContain("exactly one");
  expect(payload.message).toContain("found 0 of 2");
});

test("a missing topic is a usage error", async () => {
  const r = await run([]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("o2b brain design-note");
});

test("--help prints the verb's own usage", async () => {
  const r = await runCli(["brain", "design-note", "--help"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  expect(r.stdout.startsWith("usage:")).toBe(true);
  expect(r.stdout).toContain("o2b brain design-note");
});

test("the MCP tool answers both phases over the same core", async () => {
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable("full"), "brain_design_note");

  const planned = (await tool.handler(ctx, { topic: TOPIC })) as {
    phase: string;
    grounding: { empty_stores: string[] };
    llm_step: { step: string };
  };
  expect(planned.phase).toBe("plan");
  expect(planned.llm_step.step).toBe("design-note");
  expect(planned.grounding.empty_stores.toSorted()).toEqual(["tensions", "truth"]);

  const committed = (await tool.handler(ctx, { topic: TOPIC, note: note(true) })) as {
    phase: string;
    recommended: string;
    path: string;
  };
  expect(committed.phase).toBe("commit");
  expect(committed.recommended).toBe("option-0");
  // Vault-relative on the MCP surface, and the response carries the host
  // path nowhere - an MCP payload lands in model context. The CLI keeps
  // the absolute path it has always printed; that one runs on the host.
  expect(committed.path).toMatch(/^Brain[/\\]decisions[/\\]/);
  expect(existsSync(join(vault, committed.path))).toBe(true);
  expect(JSON.stringify(committed)).not.toContain(vault);

  await expect(
    Promise.resolve(tool.handler(ctx, { topic: "another topic", note: note(true, true) })),
  ).rejects.toThrow("exactly one");
});

test("is a full-tier tool, absent from the writer surface", () => {
  expect(buildToolTable("full").find((t) => t.name === "brain_design_note")).toBeDefined();
  expect(buildToolTable("writer").find((t) => t.name === "brain_design_note")).toBeUndefined();
});
