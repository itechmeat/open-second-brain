/**
 * Lesson-promotion counts through the EXISTING status plumbing
 * (t_1e952e43, task C3).
 *
 * The MCP surface stays report-only by design: no new tool name is
 * registered anywhere, and the `second_brain_status` payload carries the
 * approvals counts because they live in the brain status snapshot that
 * tool already returns. The frozen tool-name parity set in
 * `tests/mcp/mcp.test.ts` stays untouched - this file only asserts the
 * negative (no lessons-shaped tool name appears) so a later lane cannot
 * add one silently either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { computeContentHash } from "../../src/core/brain/content-hash.ts";
import {
  lessonsApprovalsPath,
  recordLessonApproval,
} from "../../src/core/brain/lessons-promotion.ts";
import { parsePreference, writePreference } from "../../src/core/brain/preference.ts";
import { preferencePath } from "../../src/core/brain/paths.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { RULES_BLOCK_ID } from "../../src/core/install/rules-block.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const PRINCIPLE = "Always run the full test suite before merging";

let tmp: string;
let vault: string;
let ctx: ServerContext;

const statusTool = findTool(buildToolTable(), "second_brain_status");

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-lessons-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: t\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedPreference(slug: string, principle: string = PRINCIPLE): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    scope: "backend",
    created_at: "2026-05-01T00:00:00Z",
    confirmed_at: "2026-05-02T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-05-10T00:00:00Z",
    confidence: "high",
  } as Parameters<typeof writePreference>[1]);
}

function approve(prefId: string, principle: string = PRINCIPLE): void {
  // The hash pins the text AS PERSISTED, not the fixture constant: the
  // writer may normalise the body, and the operator approves the file's
  // content. Read it back through the same parser the promotion kernel
  // uses, exactly as the approve verb does.
  const slug = prefId.replace(/^pref-/, "");
  const persisted = parsePreference(preferencePath(vault, slug));
  void principle;
  recordLessonApproval(vault, {
    prefId,
    decision: "approved",
    decidedAt: "2026-05-15T00:00:00Z",
    decidedBy: "yes-flag",
    approvedContentHash: computeContentHash(persisted.principle, persisted.scope),
    targets: ["AGENTS.md"],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  });
}

interface LessonsCounts {
  readonly approved: number;
  readonly denied: number;
  readonly stale: number;
}

async function statusLessonsCounts(): Promise<LessonsCounts> {
  const payload = (await statusTool.handler(ctx, {})) as Record<string, unknown>;
  const brain = payload["brain"] as { lessons: LessonsCounts };
  return brain.lessons;
}

describe("lesson promotion counts over the status plumbing", () => {
  test("the counts match the ledger plus derived staleness, with no new tool", async () => {
    seedPreference("mcp-fresh");
    approve("pref-mcp-fresh");
    seedPreference("mcp-stale");
    approve("pref-mcp-stale");
    // The operator amends the approved text: the pinned hash goes stale.
    // The edit replaces the PERSISTED principle bytes, so it cannot be
    // defeated by the writer's normalisation of the fixture constant,
    // and it avoids writePreference, which refuses an existing file.
    const stalePath = preferencePath(vault, "mcp-stale");
    const stalePref = parsePreference(stalePath);
    writeFileSync(
      stalePath,
      readFileSync(stalePath, "utf8").replace(
        stalePref.principle,
        `${stalePref.principle} amended`,
      ),
    );
    seedPreference("mcp-denied");
    recordLessonApproval(vault, {
      prefId: "pref-mcp-denied",
      decision: "denied",
      decidedAt: "2026-05-16T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash("another principle", "backend"),
      targets: [],
      blockId: RULES_BLOCK_ID.lessons,
      lastPromotedAt: null,
    });

    expect(await statusLessonsCounts()).toEqual({ approved: 2, denied: 1, stale: 1 });
  });

  test("a brain with no ledger answers zero counts", async () => {
    expect(await statusLessonsCounts()).toEqual({ approved: 0, denied: 0, stale: 0 });
  });

  test("a damaged ledger surfaces a generalized read_error with no machine path", async () => {
    // The raw error messages embed the ledger's absolute path; the MCP
    // payload must not. The snapshot names the file and the failure
    // class; doctor is the surface that names the cause.
    mkdirSync(dirname(lessonsApprovalsPath(vault)), { recursive: true });
    writeFileSync(lessonsApprovalsPath(vault), "{ not json at all");
    const payload = (await statusTool.handler(ctx, {})) as {
      brain: { lessons: { approved: number; read_error?: string } };
    };
    const lessons = payload.brain.lessons;
    expect(lessons.approved).toBe(0);
    const readError = lessons.read_error ?? "";
    expect(readError.length).toBeGreaterThan(0);
    expect(readError).toContain("lessons-approvals.json");
    expect(readError.includes(vault)).toBe(false);
    expect(readError.includes(tmp)).toBe(false);
    expect(readError.includes("/")).toBe(false);
  });

  test("no lessons-shaped tool name is registered anywhere", () => {
    const names = buildToolTable().map((tool) => tool.name);
    expect(names.some((name) => /lesson/i.test(name))).toBe(false);
  });
});
