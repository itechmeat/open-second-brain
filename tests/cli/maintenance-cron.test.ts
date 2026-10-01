/**
 * The maintenance lane recipe printed by
 * `o2b brain maintenance run --cron-template`.
 *
 * The lane is the cron entry point for the heavy passes, and a scheduler
 * runs it without the operator's shell environment, so the recipe has to
 * carry everything the lane needs on the command line: the vault, and the
 * window and zone when the operator gave them. It also has to keep the
 * lane's exit code - a gate skip exits 0 and should cost a cron mail
 * nothing, while any other exit is a verdict someone must read.
 *
 * Rendering is pure text: the last case lists a vault tree before and
 * after and requires them to be the same.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CronTemplateError, renderCronRecipe } from "../../src/cli/cron-recipe.ts";
import {
  DEFAULT_MAINTENANCE_INTERVAL,
  MAINTENANCE_CRON_NAME,
  MAINTENANCE_RECIPE,
  renderMaintenanceCronTemplate,
} from "../../src/cli/maintenance-cron.ts";

/** The heredoc body: the script exactly as the operator's host will run it. */
function scriptBody(out: string): string {
  const open = out.indexOf("<<'OSBEOF'\n");
  const close = out.indexOf("\nOSBEOF\n", open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return out.slice(open + "<<'OSBEOF'\n".length, close + 1);
}

describe("renderMaintenanceCronTemplate", () => {
  test("names the lane job and renders the hourly default", () => {
    expect(MAINTENANCE_CRON_NAME).toBe("osb-maintenance");
    expect(DEFAULT_MAINTENANCE_INTERVAL).toBe("1h");
    const out = renderMaintenanceCronTemplate("1h", { vault: "/v" });
    expect(out).toContain("# interval: 1 hours");
    expect(out).toContain("0 */1 * * *    ~/.local/bin/osb-maintenance.sh");
    expect(out).toContain("cat >~/.local/bin/osb-maintenance.sh <<'OSBEOF'");
    expect(out).toContain("  --name osb-maintenance \\");
    expect(out).toContain("(when Hermes owns the schedule)");
  });

  test("the script runs the lane against the baked-in vault as JSON", () => {
    const body = scriptBody(renderMaintenanceCronTemplate("1h", { vault: "/v" }));
    expect(body).toContain("o2b brain maintenance run --vault '/v' --json");
    expect(body).not.toContain("--window");
    expect(body).not.toContain("--tz");
  });

  test("the window and the zone reach the command only when given", () => {
    const both = scriptBody(
      renderMaintenanceCronTemplate("1h", { vault: "/v", window: "3-5", tz: "Europe/Berlin" }),
    );
    expect(both).toContain(
      "o2b brain maintenance run --vault '/v' --window 3-5 --tz Europe/Berlin --json",
    );
    const windowOnly = scriptBody(
      renderMaintenanceCronTemplate("1h", { vault: "/v", window: "22-6" }),
    );
    expect(windowOnly).toContain("o2b brain maintenance run --vault '/v' --window 22-6 --json");
  });

  test("a vault with a single quote stays one shell word", () => {
    const body = scriptBody(renderMaintenanceCronTemplate("1h", { vault: "/srv/it's vault" }));
    expect(body).toContain("--vault '/srv/it'\\''s vault' --json");
  });

  test("a window or zone that is not a plain token is refused, not pasted into shell", () => {
    for (const window of ["25-3", "3-5; rm -rf ~", "3"]) {
      expect(() => renderMaintenanceCronTemplate("1h", { vault: "/v", window })).toThrow(
        CronTemplateError,
      );
    }
    expect(() =>
      renderMaintenanceCronTemplate("1h", { vault: "/v", window: "3-5", tz: "$(id)" }),
    ).toThrow(CronTemplateError);
  });

  test("the script is silent on exit 0 and passes any other exit through with its JSON", () => {
    const body = scriptBody(renderMaintenanceCronTemplate("1h", { vault: "/v" }));
    expect(body).toContain("status=0");
    expect(body).toContain("--json) || status=$?");
    expect(body).toContain('if [ "$status" -ne 0 ]; then');
    expect(body).toContain('  printf "%s\\n" "$out"');
    expect(body).toContain('  exit "$status"');
    // Nothing prints on the success path.
    const success = body.slice(body.indexOf("fi\n", body.indexOf('if [ "$status"')));
    expect(success).not.toContain("printf");
  });

  test("the script survives a non-zero exit under set -e", () => {
    // Under `set -e` a bare `out=$(...)` that exits non-zero ends the script
    // before the exit can be reported; the `|| status=$?` form is what keeps
    // the verdict readable.
    const body = scriptBody(renderMaintenanceCronTemplate("1h", { vault: "/v" }));
    expect(body).toContain("set -euo pipefail");
    expect(body).not.toMatch(/^out=\$\([^)]*\)$/mu);
  });

  test("the verify footer points at the lane status", () => {
    const out = renderMaintenanceCronTemplate("1h", { vault: "/v" });
    expect(out).toContain("# After install, verify with: o2b brain maintenance status");
  });

  test("the binary override reaches the script and the footer", () => {
    const out = renderMaintenanceCronTemplate("1h", { vault: "/v", o2bBin: "/opt/o2b" });
    expect(out).toContain("/opt/o2b brain maintenance run --vault '/v' --json");
    expect(out).toContain("# After install, verify with: /opt/o2b brain maintenance status");
  });

  test("the cron format is the shared kernel's rendering of this spec", () => {
    expect(renderMaintenanceCronTemplate("1h", { vault: "/v" })).toBe(
      renderCronRecipe(MAINTENANCE_RECIPE, "1h", { vault: "/v" }),
    );
    expect(renderMaintenanceCronTemplate("1h", { vault: "/v", format: "cron" })).toBe(
      renderMaintenanceCronTemplate("1h", { vault: "/v" }),
    );
  });

  test("the systemd format prints a timer on the same cadence with the same script", () => {
    const cron = renderMaintenanceCronTemplate("1h", { vault: "/v" });
    const systemd = renderMaintenanceCronTemplate("1h", { vault: "/v", format: "systemd" });
    expect(systemd).toContain("OnUnitActiveSec=1h");
    expect(systemd).toContain("systemctl --user enable --now osb-maintenance.timer");
    expect(systemd).not.toContain("hermes cron create");
    expect(scriptBody(systemd)).toBe(scriptBody(cron));
  });

  test("an interval cron cannot express is refused", () => {
    expect(() => renderMaintenanceCronTemplate("30s", { vault: "/v" })).toThrow(CronTemplateError);
    expect(() => renderMaintenanceCronTemplate("90d", { vault: "/v", format: "systemd" })).toThrow(
      CronTemplateError,
    );
  });
});

/** Every path under `root`, recursively, as a sorted list. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(root, "");
  return out.toSorted();
}

describe("rendering writes nothing", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-maintenance-cron-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a vault tree is unchanged by both formats", () => {
    const vault = join(tmp, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(join(vault, "Brain", "note.md"), "# note\n");
    const before = listTree(tmp);
    renderMaintenanceCronTemplate("1h", { vault });
    renderMaintenanceCronTemplate("6h", { vault, format: "systemd" });
    expect(listTree(tmp)).toEqual(before);
  });
});
