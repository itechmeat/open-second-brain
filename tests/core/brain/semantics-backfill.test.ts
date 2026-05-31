import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { planSemanticsBackfill } from "../../../src/core/brain/semantics-backfill.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-semantics-backfill-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "writing",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    pinned: false,
    confidence: BRAIN_CONFIDENCE.low,
    ...overrides,
  };
}

function retire(slug: string, supersededBy?: string): string {
  const pref = writePreference(vault, basePref(slug));
  return moveToRetired(vault, pref.path, BRAIN_RETIRED_REASON.rebutted, {
    now: new Date("2026-06-01T00:00:00Z"),
    retired_by: "[[Brain/log/2026-06-01]]",
    ...(supersededBy !== undefined ? { superseded_by: supersededBy } : {}),
  }).path;
}

describe("planSemanticsBackfill", () => {
  test("proposes inverse superseded_by for active supersedes links", () => {
    const retiredPath = retire("old");
    writePreference(
      vault,
      basePref("new", {
        supersedes: "[[ret-old]]",
      }),
    );

    const plan = planSemanticsBackfill(vault);

    expect(plan.proposals).toEqual([
      {
        source_id: "ret-old",
        target_id: "pref-new",
        relation: "superseded_by",
        field: "superseded_by",
        value: "[[pref-new]]",
        reason: "active-supersedes-retired-missing-inverse",
        path: retiredPath,
      },
    ]);
    expect(readFileSync(retiredPath, "utf8")).not.toContain("superseded_by:");
  });

  test("does not propose when retired inverse already exists", () => {
    retire("old", "[[pref-new]]");
    writePreference(
      vault,
      basePref("new", {
        supersedes: "[[ret-old]]",
      }),
    );

    const plan = planSemanticsBackfill(vault);

    expect(plan.proposals).toEqual([]);
  });

  test("returns proposals in stable source-target order", () => {
    retire("z-old");
    retire("a-old");
    writePreference(vault, basePref("z-new", { supersedes: "[[ret-z-old]]" }));
    writePreference(vault, basePref("a-new", { supersedes: "[[ret-a-old]]" }));

    const plan = planSemanticsBackfill(vault);

    expect(plan.proposals.map((p) => `${p.source_id}->${p.target_id}`)).toEqual([
      "ret-a-old->pref-a-new",
      "ret-z-old->pref-z-new",
    ]);
  });
});
