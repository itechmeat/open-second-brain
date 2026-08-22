/**
 * `o2b brain skill-proposals page-candidates | page-draft` and the
 * `brain_skill_proposals` operations behind them
 * (salience-lifecycle-enrichment, unit 4, t_abaec26b). Claims pinned here:
 *
 *  1. `page-candidates --json` carries the admitted pages with one envelope
 *     each and every skip with its reason.
 *  2. `page-draft --json` stages a pending proposal and says so.
 *  3. `page-draft` without a payload is a usage error, not a silent no-op.
 *  4. The MCP tool exposes the same two operations over the same core, and
 *     accept through it materializes the SKILL.md under the configured
 *     skills root.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { runCli } from "../helpers/run-cli.ts";

const PAGE = "notes/release-ritual.md";
const DRAFT = {
  name: "release-ritual",
  description: "Cut a release the way this vault says releases are cut.",
  triggers: ["release", "tag"],
  body: "1. Name the theme.\n2. Cut the branch.",
};

let tmp: string;
let vault: string;
let skillsRoot: string;
let configPath: string;

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "skill-proposals", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-skill-pages-"));
  vault = join(tmp, "vault");
  skillsRoot = join(tmp, "skills");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nskills_dir: ${skillsRoot}\n`);
  writeFileSync(
    join(vault, PAGE),
    [
      "---",
      "title: Release ritual",
      "tier: core",
      "_lifecycle: verified",
      "_confidence: high",
      "created_at: 2026-08-01T00:00:00Z",
      "---",
      "",
      "Name the theme, cut the branch, run the gates.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, "notes", "scratch.md"),
    ["---", "title: Scratch", "tier: peripheral", "---", "", "Nothing here.", ""].join("\n"),
  );
  appendContinuityRecord(vault, {
    kind: "recall_observed_use",
    createdAt: "2026-08-22T10:00:00Z",
    sourceRefs: [{ id: "reuse:release-ritual" }],
    payload: {
      session_id: "sess-reuse",
      entries: [
        { path: PAGE, verdict: "USED" },
        { path: PAGE, verdict: "USED" },
      ],
    },
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("page-candidates --json carries admitted envelopes and named skips", async () => {
  const r = await run(["page-candidates", "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    pages_scanned: number;
    admitted: Array<{ path: string; llm_step: { status: string; step: string } }>;
    skipped: Array<{ path: string; reason: string; detail: string }>;
  };
  expect(payload.pages_scanned).toBeGreaterThanOrEqual(2);
  expect(payload.admitted.map((a) => a.path)).toEqual([PAGE]);
  expect(payload.admitted[0]!.llm_step.status).toBe("needs-llm-step");
  expect(payload.admitted[0]!.llm_step.step).toBe("skill-page-draft");
  const scratch = payload.skipped.find((s) => s.path === "notes/scratch.md");
  expect(scratch?.reason).toBe("tier_below_core");
  expect(scratch?.detail.length).toBeGreaterThan(0);
});

test("page-draft --json stages a pending proposal inside the vault", async () => {
  const r = await run(["page-draft", PAGE, "--payload", JSON.stringify(DRAFT), "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as { outcome: string; slug: string; path: string };
  expect(payload.outcome).toBe("created");
  expect(payload.path.startsWith(join(vault, "Brain"))).toBe(true);
  expect(existsSync(join(skillsRoot, DRAFT.name, "SKILL.md"))).toBe(false);
});

test("page-draft without a payload is a usage error", async () => {
  const r = await run(["page-draft", PAGE]);
  expect(r.returncode).not.toBe(0);
  expect(r.stderr).toContain("--payload");
});

test("the MCP tool plans, drafts, and accepts into the configured skills root", async () => {
  const ctx: ServerContext = { vault, configPath, repoRoot: null };
  const tool = findTool(buildToolTable("full"), "brain_skill_proposals");

  const planned = (await tool.handler(ctx, { operation: "page_candidates" })) as {
    admitted: Array<{ path: string }>;
  };
  expect(planned.admitted.map((a) => a.path)).toEqual([PAGE]);

  const drafted = (await tool.handler(ctx, {
    operation: "page_draft",
    page: PAGE,
    draft: DRAFT,
  })) as { outcome: string; slug: string };
  expect(drafted.outcome).toBe("created");

  const accepted = (await tool.handler(ctx, {
    operation: "accept",
    slug: drafted.slug,
  })) as { status: string; skillPath?: string };
  expect(accepted.status).toBe("accepted");
  const skillFile = join(skillsRoot, DRAFT.name, "SKILL.md");
  expect(accepted.skillPath).toBe(skillFile);
  expect(readFileSync(skillFile, "utf8")).toContain(`name: ${DRAFT.name}`);
});
