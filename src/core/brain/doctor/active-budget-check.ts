/**
 * The injection-budget watermark over `Brain/active.md`.
 *
 * One question: is the rendered active memory about to lose content at
 * inject time, and which sections would relieve it.
 */

import { existsSync } from "node:fs";

import { parseFrontmatter } from "../../vault.ts";
import { computeActiveBudgetPressure } from "../active-budget-pressure.ts";
import { brainActivePath } from "../paths.ts";
import { INJECT_BUDGET_CHARS_DEFAULT } from "../policy.ts";
import type { DoctorCheck } from "./check.ts";

/**
 * `active-budget-pressure` (C4, context-pack-economics-observability):
 * proactive watermark over `Brain/active.md`. Reads the rendered body,
 * measures its fill-rate against the SessionStart injection byte budget
 * (`active.inject_budget_chars`, else the default), and - only when
 * pressure crosses the warn threshold - emits ONE warning naming the
 * ranked eviction candidates an operator could archive to relieve it.
 *
 * "Empty output = healthy": a healthy or missing active.md produces no
 * warning. The candidates are SUGGESTIONS surfaced for the operator /
 * dream; nothing here mutates the vault - the reactive truncation in
 * `active-budget.ts` is the only thing that ever drops content, and it
 * does so at render time, not here.
 */
export const activeBudgetPressureCheck: DoctorCheck = {
  failSoft: true,
  run({ vault, config }, { issues }) {
    const path = brainActivePath(vault);
    if (!existsSync(path)) return;
    let body: string;
    try {
      [, body] = parseFrontmatter(path);
    } catch {
      // A corrupted active.md is a derived-view problem the dream loop
      // rewrites; not this probe's concern.
      return;
    }
    const budget = config?.active?.inject_budget_chars ?? INJECT_BUDGET_CHARS_DEFAULT;
    const pressure = computeActiveBudgetPressure(body.trim(), budget);
    if (pressure.status === "healthy") return; // quiet on healthy vaults

    const pct = Math.round(pressure.fillRate * 100);
    const ranked = pressure.candidates
      .map((c) => `${c.sectionKey.replace(/^## /, "")} (${c.bytes}B)`)
      .join(", ");
    const suggestion =
      pressure.candidates.length > 0
        ? ` Archive candidates, highest-priority-to-drop first: ${ranked}.`
        : " No stale sections to archive - trim the confirmed rule set instead.";
    issues.push({
      severity: "warning",
      code: "active-budget-pressure",
      path,
      message:
        `active.md is at ${pct}% of the ${budget}-char injection budget (${pressure.status}).` +
        " Content will be dropped at inject time once it overflows." +
        suggestion,
    });
  },
};
