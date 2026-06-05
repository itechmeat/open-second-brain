/**
 * Timezone presentation wiring (t_2ccadc6a): with `timezone:` in the
 * plugin config, the brief-family JSON envelopes (daily, weekly,
 * monthly, morning, timeline) gain additive `timezone` + `local_time`
 * fields; without it, output stays byte-identical to 0.45.0. Storage
 * timestamps inside every envelope remain canonical UTC.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-tz-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "VAULT_TIMEZONE", "VAULT_DIR"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enableTimezone(tz: string): void {
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\ntimezone: ${tz}\n`);
}

test("daily brief JSON gains timezone + local_time when configured", async () => {
  enableTimezone("Europe/Berlin");
  const r = await runCli(["brain", "daily", "--date", "2026-06-05", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(parsed["timezone"]).toBe("Europe/Berlin");
  expect(String(parsed["local_time"])).toMatch(/[+-]\d{2}:\d{2}$/);
  // Stored window stays canonical UTC.
  expect(JSON.stringify(parsed["window"])).toContain("Z");
});

test("without a configured timezone the envelope carries no local fields", async () => {
  const r = await runCli(["brain", "daily", "--date", "2026-06-05", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  expect(parsed["timezone"]).toBeUndefined();
  expect(parsed["local_time"]).toBeUndefined();
});

test("weekly, monthly, and timeline envelopes localize the same way", async () => {
  enableTimezone("Asia/Tokyo");
  const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };
  const results = await Promise.all(
    [
      ["brain", "weekly", "--week-end", "2026-06-05", "--vault", vault, "--json"],
      ["brain", "monthly", "--month", "2026-06", "--vault", vault, "--json"],
      ["brain", "timeline", "--vault", vault, "--json"],
    ].map((argv) => runCli(argv, { env })),
  );
  for (const r of results) {
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["timezone"]).toBe("Asia/Tokyo");
    expect(String(parsed["local_time"])).toContain("+09:00");
  }
});
