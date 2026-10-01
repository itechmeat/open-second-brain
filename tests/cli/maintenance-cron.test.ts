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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CronTemplateError } from "../../src/cli/cron-recipe.ts";
import {
  DEFAULT_MAINTENANCE_INTERVAL,
  MAINTENANCE_CRON_NAME,
  maintenanceCronName,
  parseWindowBounds,
  renderMaintenanceCronTemplate,
} from "../../src/cli/maintenance-cron.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

/** The heredoc body: the script exactly as the operator's host will run it. */
function scriptBody(out: string): string {
  const open = out.indexOf("<<'OSBEOF'\n");
  const close = out.indexOf("\nOSBEOF\n", open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return out.slice(open + "<<'OSBEOF'\n".length, close + 1);
}

/** The job name for `vault`, after proving every recipe section carries it. */
function namesIn(vault: string): string {
  const name = maintenanceCronName(vault);
  const cron = renderMaintenanceCronTemplate("1h", { vault });
  const systemd = renderMaintenanceCronTemplate("1h", { vault, format: "systemd" });
  expect(cron).toContain(`cat >~/.local/bin/${name}.sh <<'OSBEOF'`);
  expect(cron).toContain(`  --name ${name} \\`);
  expect(systemd).toContain(`${name}.service`);
  expect(systemd).toContain(`${name}.timer`);
  return name;
}

describe("renderMaintenanceCronTemplate", () => {
  test("names the lane job and renders the hourly default", () => {
    expect(MAINTENANCE_CRON_NAME).toBe("osb-maintenance");
    expect(DEFAULT_MAINTENANCE_INTERVAL).toBe("1h");
    const name = maintenanceCronName("/v");
    expect(name).toMatch(/^osb-maintenance-[0-9a-f]{8}$/u);
    const out = renderMaintenanceCronTemplate("1h", { vault: "/v" });
    expect(out).toContain("# interval: 1 hours");
    expect(out).toContain(`0 */1 * * *    ~/.local/bin/${name}.sh`);
    expect(out).toContain(`cat >~/.local/bin/${name}.sh <<'OSBEOF'`);
    expect(out).toContain(`  --name ${name} \\`);
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
    for (const tz of ["$(id)", "--force"]) {
      expect(() => renderMaintenanceCronTemplate("1h", { vault: "/v", window: "3-5", tz })).toThrow(
        CronTemplateError,
      );
    }
  });

  test("a zone the runtime does not know is refused by name", () => {
    expect(() =>
      renderMaintenanceCronTemplate("1h", { vault: "/v", window: "3-5", tz: "Mars/Base" }),
    ).toThrow(/unknown time zone: "Mars\/Base"/u);
    for (const tz of ["Europe/Berlin", "Etc/GMT+3", "UTC"]) {
      expect(renderMaintenanceCronTemplate("1h", { vault: "/v", window: "3-5", tz })).toContain(
        `--tz ${tz} --json`,
      );
    }
  });

  test("a vault path with a line break is refused by name in both formats", () => {
    for (const vault of ["/v\nOSBEOF", "/v\rx"]) {
      for (const format of ["cron", "systemd"] as const) {
        expect(() => renderMaintenanceCronTemplate("1h", { vault, format })).toThrow(
          /vault path must not contain a line break/u,
        );
      }
    }
  });

  test.skipIf(IS_WINDOWS)(
    "the script is silent on exit 0 and passes any other exit through with its JSON",
    () => {
      // Run the rendered script for real against a stub o2b that prints a
      // verdict and exits with the code the case asks for.
      const dir = mkdtempSync(join(tmpdir(), "o2b-maint-cron-run-"));
      try {
        const stub = join(dir, "o2b-stub");
        writeFileSync(stub, '#!/bin/sh\nprintf \'{"x":1}\\n\'\nexit "$STUB_EXIT"\n');
        chmodSync(stub, 0o755);
        const script = join(dir, "run.sh");
        writeFileSync(
          script,
          scriptBody(renderMaintenanceCronTemplate("1h", { vault: "/v", o2bBin: stub })),
        );
        const run = (code: string) =>
          Bun.spawnSync(["bash", script], {
            env: { PATH: process.env["PATH"] ?? "", HOME: dir, STUB_EXIT: code },
          });
        const quiet = run("0");
        expect(quiet.exitCode).toBe(0);
        expect(quiet.stdout.toString()).toBe("");
        const failed = run("3");
        expect(failed.exitCode).toBe(3);
        expect(failed.stdout.toString()).toBe('{"x":1}\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("the verify footer points at the lane status of the baked-in vault", () => {
    const out = renderMaintenanceCronTemplate("1h", { vault: "/srv/it's vault" });
    expect(out).toContain(
      "# After install, verify with: o2b brain maintenance status --vault '/srv/it'\\''s vault'",
    );
  });

  test("the binary override reaches the script and the footer", () => {
    const out = renderMaintenanceCronTemplate("1h", { vault: "/v", o2bBin: "/opt/o2b" });
    expect(out).toContain("/opt/o2b brain maintenance run --vault '/v' --json");
    expect(out).toContain(
      "# After install, verify with: /opt/o2b brain maintenance status --vault '/v'",
    );
  });

  test("two vaults get different job names; the same vault always gets the same one", () => {
    expect(namesIn("/a")).not.toBe(namesIn("/b"));
    expect(namesIn("/a")).toBe(namesIn("/a"));
    expect(renderMaintenanceCronTemplate("1h", { vault: "/a" })).toBe(
      renderMaintenanceCronTemplate("1h", { vault: "/a" }),
    );
  });

  test("an explicit cron format renders the default recipe", () => {
    expect(renderMaintenanceCronTemplate("1h", { vault: "/v", format: "cron" })).toBe(
      renderMaintenanceCronTemplate("1h", { vault: "/v" }),
    );
  });

  test("the systemd format prints a timer on the same cadence with the same script", () => {
    const cron = renderMaintenanceCronTemplate("1h", { vault: "/v" });
    const systemd = renderMaintenanceCronTemplate("1h", { vault: "/v", format: "systemd" });
    expect(systemd).toContain("OnUnitActiveSec=1h");
    expect(systemd).toContain(`systemctl --user enable --now ${maintenanceCronName("/v")}.timer`);
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

describe("parseWindowBounds", () => {
  test("reads H-H bounds and refuses any other shape or an hour above 23", () => {
    expect(parseWindowBounds("22-6")).toEqual({ startHour: 22, endHour: 6 });
    expect(parseWindowBounds("0-23")).toEqual({ startHour: 0, endHour: 23 });
    for (const raw of ["24-3", "3-24", "3", "3-5x", " 3-5", "a-b"]) {
      expect(parseWindowBounds(raw)).toBeNull();
    }
  });
});

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
