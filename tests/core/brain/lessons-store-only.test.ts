/**
 * Lessons away from the legacy tree (task 2.10, design D14 items 1 and 7):
 * on a switched machine the approvals ledger lives in the device-local
 * machine state and no byte is written under the vault; with no vault at
 * all the digest is rendered from the store into the device-local cache,
 * and a restricted reader's render leaves out what it cannot see. The
 * unswitched cases live in `lessons-promotion.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import {
  lessonsApprovalsPath,
  readLessonApprovals,
  recordLessonApproval,
  type LessonApprovalRow,
} from "../../../src/core/brain/lessons-promotion.ts";
import {
  lessonsDigestPathForRead,
  renderLessonsForReader,
} from "../../../src/core/brain/lessons.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { RULES_BLOCK_ID } from "../../../src/core/install/rules-block.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function row(prefId: string): LessonApprovalRow {
  return {
    prefId,
    decision: "approved",
    decidedAt: "2026-05-10T00:00:00Z",
    decidedBy: "yes-flag",
    approvedContentHash: computeContentHash(`principle for ${prefId}`, "backend"),
    targets: ["AGENTS.md"],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  };
}

describe("lessons on a switched machine", () => {
  test("the approvals ledger round-trips outside the vault, writing no byte under it", () => {
    env = makeStoreEnv("osb-lessons-switched-");
    switchDevice(env.storeRoot);
    const before = digestVaultTree(env.vault);
    recordLessonApproval(env.vault, row("pref-a"));
    expect(readLessonApprovals(env.vault)).toEqual([row("pref-a")]);
    expect(lessonsApprovalsPath(env.vault).startsWith(env.vault)).toBe(false);
    expect(digestVaultTree(env.vault)).toBe(before);
  });
});

describe("lessons with no vault", () => {
  test("the digest renders into the device-local cache, and a reader sees only its pages", () => {
    env = makeStoreEnv("osb-lessons-novault-", { legacyTree: false, configureVault: false });
    for (const slug of ["seen", "hidden"]) {
      writePreference(null, {
        slug,
        topic: slug,
        principle: `Rule ${slug}.`,
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-02T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2026-11-02T00:00:00Z",
        evidenced_by: ["[[sig-x]]"],
        confidence_value: 0.9,
      });
      for (const artifact of ["[[a]]", "[[b]]"]) {
        appendApplyEvidence(null, {
          pref_id: `pref-${slug}`,
          artifact,
          result: "applied",
          agent: "t",
        });
      }
    }
    const path = lessonsDigestPathForRead(null);
    expect(path.startsWith(env.parent)).toBe(true);
    expect(path.startsWith(env.vault)).toBe(false);
    const shared = readFileSync(path, "utf8");
    expect(shared).toContain("pref-seen");
    expect(shared).toContain("pref-hidden");
    const narrowed = renderLessonsForReader(null, {
      readable: (rel) => !rel.includes("pref-hidden"),
    });
    expect(narrowed.document).toContain("pref-seen");
    expect(narrowed.document).not.toContain("pref-hidden");
  });
});
