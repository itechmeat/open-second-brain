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
    // Say what the tier will actually do, from the computed fields: only
    // a candidate whose tiered form is smaller than the section itself
    // can be helped by the headline tier. When no candidate compacts
    // (every non-guard section is already at or below the top-N) or none
    // exists at all (the keep-guard content alone overflows), promising
    // a headline reduction would overpromise - the overflow simply
    // drops or trims at inject time.
    const tierClause = pressure.candidates.some((c) => c.tieredBytes < c.bytes)
      ? " Once it overflows, oversized sections are first reduced to headlines at" +
        " inject time; only what still overflows is dropped."
      : " Once it overflows, headlines cannot help and the overflow drops or" +
        " trims at inject time as before.";
    issues.push({
      severity: "warning",
      code: "active-budget-pressure",
      path,
      message:
        `active.md is at ${pct}% of the ${budget}-char injection budget (${pressure.status}).` +
        tierClause +
        suggestion,
    });
  },
};
