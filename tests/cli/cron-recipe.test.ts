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
  parseRecipeFormat,
  RECIPE_FORMATS,
  renderCronRecipe,
  renderSystemdTimer,
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

/**
 * The synthetic spec rendered at 30m, captured BEFORE the header and the
 * script section were extracted into a helper shared with the systemd
 * renderer. The extraction is only correct if the cron path changed by
 * zero bytes, and only a pinned string can say so.
 */
const PINNED_CRON_30M =
  "# ----------------------------------------------------------------------\n# Synthetic Suite - probe recipe\n# interval: 30 minutes\n#\n# Pick ONE of the three paths below. The watchdog script is the\n# common piece; both crontab and Hermes-cron rely on it.\n# ----------------------------------------------------------------------\n\n\n## 1. Watchdog script - save to ~/.local/bin/probe-runner.sh\n##    probe note line\n\ncat >~/.local/bin/probe-runner.sh <<'OSBEOF'\n#!/usr/bin/env bash\nprobe_body_marker o2b\nOSBEOF\nchmod +x ~/.local/bin/probe-runner.sh\n\n\n## 2. Native crontab - open 'crontab -e' and append:\n\n*/30 * * * *    ~/.local/bin/probe-runner.sh\n\n\n## 3. Hermes cron (probe scheduler note):\n\nhermes cron create \\\n  --name probe-job \\\n  --schedule '*/30 * * * *' \\\n  --command \"$HOME/.local/bin/probe-runner.sh\" \\\n  --no-agent\n\n\n# ----------------------------------------------------------------------\n# After install, verify with: o2b probe-verify --now\n# ----------------------------------------------------------------------\n";

/** The watchdog section: from its heading through the chmod that closes it. */
function scriptSection(out: string): string {
  const start = out.indexOf("## 1. Watchdog script - save to ");
  const chmod = out.indexOf("chmod +x ", start);
  const end = out.indexOf("\n", chmod) + 1;
  expect(start).toBeGreaterThan(-1);
  expect(chmod).toBeGreaterThan(start);
  return out.slice(start, end);
}

/** The message a throwing render produced, so two renderers can be compared. */
function refusal(render: () => string): string {
  try {
    render();
  } catch (err) {
    expect(err).toBeInstanceOf(CronTemplateError);
    return (err as Error).message;
  }
  throw new Error("expected a CronTemplateError, got a rendered recipe");
}

describe("renderCronRecipe is unchanged by the systemd sibling", () => {
  test("the synthetic spec renders byte for byte as before the extraction", () => {
    expect(renderCronRecipe(SPEC, "30m", {})).toBe(PINNED_CRON_30M);
  });
});

describe("renderSystemdTimer", () => {
  const UNIT_DIR = "~/.config/systemd/user/";

  test("carries the same script section as the cron recipe", () => {
    const systemd = renderSystemdTimer(SPEC, "30m", {});
    expect(scriptSection(systemd)).toBe(scriptSection(renderCronRecipe(SPEC, "30m", {})));
  });

  test("names the service and timer pair and the commands that enable it", () => {
    const out = renderSystemdTimer(SPEC, "30m", {});
    for (const needle of [
      `${UNIT_DIR}${SENTINEL.cronName}.service`,
      `${UNIT_DIR}${SENTINEL.cronName}.timer`,
      "OnUnitActiveSec=30m",
      "OnBootSec=",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SENTINEL.cronName}.timer`,
      "loginctl enable-linger",
      `# After install, verify with: o2b ${SENTINEL.verify}`,
    ]) {
      expect(`${needle} present: ${out.includes(needle)}`).toBe(`${needle} present: true`);
    }
  });

  test("the monotonic timer carries no Persistent= line", () => {
    // systemd honours Persistent= on OnCalendar= timers only; on this
    // OnBootSec=/OnUnitActiveSec= timer it would claim a catch-up that
    // never happens.
    expect(renderSystemdTimer(SPEC, "30m", {})).not.toContain("Persistent=");
  });

  test("the service runs the script through the systemd home specifier", () => {
    // ExecStart= does not expand a tilde, so the path must reach systemd in
    // the %h form it resolves itself.
    const out = renderSystemdTimer(SPEC, "30m", {});
    expect(out).toContain(`ExecStart=%h/.local/bin/${SENTINEL.scriptStem}.sh`);
    expect(out).not.toContain("ExecStart=~/");
  });

  test("prints no crontab line and no Hermes scheduler", () => {
    const out = renderSystemdTimer(SPEC, "30m", {});
    expect(out).not.toContain("*/30 * * * *");
    expect(out).not.toContain("crontab -e");
    expect(out).not.toContain("hermes cron create");
  });

  test("the interval reaches the timer in the unit systemd reads natively", () => {
    expect(renderSystemdTimer(SPEC, "6h", {})).toContain("OnUnitActiveSec=6h\n");
    expect(renderSystemdTimer(SPEC, "1d", {})).toContain("OnUnitActiveSec=1d\n");
    expect(renderSystemdTimer(SPEC, " 15 m ", {})).toContain("OnUnitActiveSec=15m\n");
  });

  test("refuses every interval the cron renderer refuses, with the same message", () => {
    for (const interval of ["90m", "30s", "24h", "28d", "nonsense"]) {
      expect(refusal(() => renderSystemdTimer(SPEC, interval, {}))).toBe(
        refusal(() => renderCronRecipe(SPEC, interval, {})),
      );
    }
  });

  test("the binary override reaches both builders", () => {
    const out = renderSystemdTimer(SPEC, "30m", { o2bBin: "/opt/probe/o2b" });
    expect(out).toContain(`${SENTINEL.bodyMarker} /opt/probe/o2b`);
    expect(out).toContain(`# After install, verify with: /opt/probe/o2b ${SENTINEL.verify}`);
  });
});

describe("parseRecipeFormat", () => {
  test("the formats are cron and systemd, cron first", () => {
    expect([...RECIPE_FORMATS]).toEqual(["cron", "systemd"]);
  });

  test("no flag means cron; systemd passes through", () => {
    expect(parseRecipeFormat(undefined)).toBe("cron");
    expect(parseRecipeFormat("cron")).toBe("cron");
    expect(parseRecipeFormat("systemd")).toBe("systemd");
  });

  test("an unknown format is refused by name, naming both formats", () => {
    const message = refusal(() => parseRecipeFormat("launchd"));
    expect(message).toBe('unknown recipe format "launchd": expected cron or systemd');
  });
});
