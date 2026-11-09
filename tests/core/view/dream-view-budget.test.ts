/**
 * The view render at the end of a dream pass runs inside a time budget,
 * like the session-start hook: pages the budget does not reach are
 * deferred to the next pass, and the dream summary counts them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { VIEW_DREAM_BUDGET_MS } from "../../../src/core/view/constants.ts";
import {
  makeAutoViewEnv,
  makeLegacyDreamVault,
  seedWriterStore,
  type AutoViewEnv,
} from "./fixtures/auto-env.ts";

let env: AutoViewEnv;
let view: string;
let vault: string;

beforeEach(() => {
  env = makeAutoViewEnv("osb-view-dream-budget-");
  view = env.view;
  vault = makeLegacyDreamVault(env.parent);
  seedWriterStore(env.root);
});

afterEach(() => env.cleanup());

describe("the view render of a dream pass", () => {
  test("has a default budget well under a minute-scale pass", () => {
    expect(VIEW_DREAM_BUDGET_MS).toBeGreaterThan(0);
    expect(VIEW_DREAM_BUDGET_MS).toBeLessThan(60_000);
  });

  test("defers the pages a spent budget does not reach, counts them, and renders them next pass", () => {
    // The first pass after the claim only waits (the writer's catch-up).
    expect(dream(vault).view?.status).toBe("waiting-for-claim");

    const spent = dream(vault, { viewBudgetMs: -1 }).view;
    expect(spent?.status).toBe("rendered");
    expect(spent?.deferred).toBeGreaterThan(0);
    expect(spent?.summary).toContain(`${spent?.deferred} deferred to the next pass`);
    expect(existsSync(join(view, "about-me.md"))).toBe(false);

    // An explicit budget no machine can spend: a slow runner must not
    // defer pages on the real clock and fail "renders them next pass".
    const next = dream(vault, { viewBudgetMs: 10 * 60_000 }).view;
    expect(next?.status).toBe("rendered");
    expect(next?.deferred).toBe(0);
    expect(existsSync(join(view, "about-me.md"))).toBe(true);
  });
});
