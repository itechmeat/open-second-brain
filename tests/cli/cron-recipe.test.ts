/**
 * The shared cron-recipe kernel, exercised through a synthetic spec.
 *
 * Both real consumers pin their own rendered output, which proves what
 * they render but not what the kernel guarantees to ANY consumer. This
 * file renders a spec made of sentinels that appear nowhere else, so it
 * can assert two things the fixtures cannot:
 *
 *   - every field of the spec actually reaches the output, and reaches it
 *     in exactly one place - the script is written once, the cron job is
 *     named once, the verification is stated once;
 *   - every numbered section and the scheduler line are present, so a
 *     future recipe cannot quietly lose one. A recipe missing its crontab
 *     section still looks like a recipe.
 */

import { describe, expect, test } from "bun:test";

import {
  CronTemplateError,
  operatorScriptPath,
  renderCronRecipe,
  type CronRecipeSpec,
} from "../../src/cli/cron-recipe.ts";

/** Sentinels chosen so no two are a substring of another. */
const SENTINEL = Object.freeze({
  title: "Synthetic Suite - probe recipe",
  cronName: "probe-job",
  scriptStem: "probe-runner",
  note: "probe note line",
  schedulerNote: "(probe scheduler note)",
  bodyMarker: "probe_body_marker",
  verify: "probe-verify --now",
});

const SPEC: CronRecipeSpec = Object.freeze<CronRecipeSpec>({
  title: SENTINEL.title,
  cronName: SENTINEL.cronName,
  scriptPath: operatorScriptPath(SENTINEL.scriptStem),
  scriptNotes: Object.freeze([SENTINEL.note]),
  schedulerNote: SENTINEL.schedulerNote,
  buildScriptBody: ({ o2bBin }) => `#!/usr/bin/env bash\n${SENTINEL.bodyMarker} ${o2bBin}\n`,
  buildVerifyCommand: ({ o2bBin }) => `${o2bBin} ${SENTINEL.verify}`,
});

const SCRIPT_PATH = operatorScriptPath(SENTINEL.scriptStem);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderCronRecipe", () => {
  test("every spec field reaches the output", () => {
    const out = renderCronRecipe(SPEC, "30m", {});
    for (const value of [
      SENTINEL.title,
      SENTINEL.cronName,
      SCRIPT_PATH,
      SENTINEL.note,
      SENTINEL.schedulerNote,
      SENTINEL.bodyMarker,
      SENTINEL.verify,
    ]) {
      expect(`${value} present: ${out.includes(value)}`).toBe(`${value} present: true`);
    }
  });

  test("the cron job is named once, the script written once, the verify stated once", () => {
    const out = renderCronRecipe(SPEC, "30m", {});
    // The job name appears only where the scheduler is told it.
    expect(occurrences(out, SENTINEL.cronName)).toBe(1);
    // The script path appears in four places by design (section heading,
    // heredoc, chmod, crontab line) but is CREATED exactly once - a second
    // heredoc would silently overwrite the first.
    expect(occurrences(out, `cat >${SCRIPT_PATH} <<`)).toBe(1);
    expect(occurrences(out, SENTINEL.verify)).toBe(1);
  });

  test("every numbered section and the scheduler line are present", () => {
    const out = renderCronRecipe(SPEC, "30m", {});
    for (const section of [
      "## 1. Watchdog script - save to ",
      "## 2. Native crontab - open 'crontab -e' and append:",
      "## 3. Hermes cron ",
    ]) {
      expect(`${section} present: ${out.includes(section)}`).toBe(`${section} present: true`);
    }
    expect(out).toContain("hermes cron create \\");
    expect(out).toContain(`  --name ${SENTINEL.cronName} \\`);
    expect(out).toContain("  --no-agent");
    expect(out).toContain("# After install, verify with: ");
  });

  test("the interval is rendered as cron in both the crontab and the scheduler line", () => {
    const out = renderCronRecipe(SPEC, "6h", {});
    expect(out).toContain("# interval: 6 hours");
    expect(out).toContain(`0 */6 * * *    ${SCRIPT_PATH}`);
    expect(out).toContain("  --schedule '0 */6 * * *' \\");
  });

  test("the scheduler command uses the $HOME form the shell will expand", () => {
    // A quoted "~/..." argument is not tilde-expanded, so the scheduler
    // would store a path that resolves to nothing.
    const out = renderCronRecipe(SPEC, "30m", {});
    expect(out).toContain(`  --command "$HOME/.local/bin/${SENTINEL.scriptStem}.sh" \\`);
    expect(out).not.toContain(`  --command "~/`);
  });

  test("the binary override reaches both builders", () => {
    const out = renderCronRecipe(SPEC, "30m", { o2bBin: "/opt/probe/o2b" });
    expect(out).toContain(`${SENTINEL.bodyMarker} /opt/probe/o2b`);
    expect(out).toContain(`# After install, verify with: /opt/probe/o2b ${SENTINEL.verify}`);
  });

  test("an interval cron cannot express is refused, not rounded", () => {
    expect(() => renderCronRecipe(SPEC, "90m", {})).toThrow(CronTemplateError);
    expect(() => renderCronRecipe(SPEC, "nonsense", {})).toThrow(CronTemplateError);
  });
});
