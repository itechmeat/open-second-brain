/**
 * Lessons promotion and the active-budget watermark on a switched vault
 * with no `Brain/` tree. Promotion read `Brain/preferences/` with
 * `readdirSync` (no candidates on a switched vault), the approval counts
 * parsed the preference file (every approval read as stale), and the
 * doctor's budget watermark looked for `Brain/active.md` (never ran).
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compiledDigestPath } from "../../../../src/core/brain/compiled-digest-path.ts";
import { computeContentHash } from "../../../../src/core/brain/content-hash.ts";
import { activeBudgetPressureCheck } from "../../../../src/core/brain/doctor/active-budget-check.ts";
import {
  gatherLessonsPromotionInputs,
  lessonApprovalCounts,
  recordLessonApproval,
} from "../../../../src/core/brain/lessons-promotion.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { RULES_BLOCK_ID } from "../../../../src/core/install/rules-block.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const PRINCIPLE = "Feed the otters before the herons.";

function seed(e: StoreEnv): void {
  writePreference(e.vault, {
    slug: "otters-first",
    topic: "otters-first",
    principle: PRINCIPLE,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
    confidence_value: 0.9,
  });
}

test("promotion reads the store's preferences and judges approvals against them", () => {
  env = makeStoreEnv("osb-lessons-store-", { legacyTree: false });
  seed(env);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const inputs = gatherLessonsPromotionInputs(env.vault);
  expect(inputs.preferences.map((p) => p.id)).toEqual(["pref-otters-first"]);

  const pref = inputs.preferences[0]!;
  recordLessonApproval(env.vault, {
    prefId: "pref-otters-first",
    decision: "approved",
    decidedAt: "2026-11-03T00:00:00Z",
    decidedBy: "yes-flag",
    approvedContentHash: computeContentHash(pref.principle, pref.scope),
    targets: ["AGENTS.md"],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  });
  expect(lessonApprovalCounts(env.vault)).toEqual({ approved: 1, denied: 0, stale: 0 });
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("the active-budget watermark reads the digest a switched vault keeps", () => {
  env = makeStoreEnv("osb-budget-store-", { legacyTree: false });
  const path = compiledDigestPath(env.vault, "active");
  mkdirSync(dirname(path), { recursive: true });
  const section = (name: string) =>
    `## ${name}\n\n${"- a rule line that takes room\n".repeat(40)}\n`;
  writeFileSync(
    path,
    `---\nkind: active\n---\n\n${section("Confirmed")}${section("Most-applied (30d)")}`,
  );

  const issues: Array<{ code: string }> = [];
  activeBudgetPressureCheck.run(
    { vault: env.vault, config: { active: { inject_budget_chars: 1000 } } } as never,
    { issues } as never,
  );
  expect(issues.map((i) => i.code)).toEqual(["active-budget-pressure"]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});
