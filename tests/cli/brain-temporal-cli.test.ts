/**
 * Task 9: CLI smoke tests for the five new temporal verbs.
 *
 * Asserts: each verb exits 0 with `--json` flag on a populated vault,
 * and that bad inputs surface as non-zero exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonl(date: string, events: ReadonlyArray<FixtureEvent>): void {
  const lines = events
    .map((e) => JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }))
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-temporal-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  writeJsonl("2026-05-20", [
    {
      timestamp: "2026-05-20T10:00:00Z",
      kind: "apply-evidence",
      body: {
        preference: "[[pref-foo|Rule]]",
        artifact: "[[src/a.ts]]",
        agent: "claude",
        result: "applied",
      },
    },
  ]);

  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-temporal-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b brain timeline", () => {
  test("--json on populated vault exits 0 with events array", async () => {
    const r = await runCli(["brain", "timeline", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload.events)).toBe(true);
  });

  test("--limit -3 surfaces as exit 1", async () => {
    const r = await runCli(["brain", "timeline", "--limit", "-3", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
  });
});

describe("o2b brain evolution", () => {
  test("--pref-id --json exits 0", async () => {
    const r = await runCli(["brain", "evolution", "--pref-id", "pref-foo", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.target).toEqual({ prefId: "pref-foo" });
  });

  test("missing --pref-id and --topic exits non-zero", async () => {
    const r = await runCli(["brain", "evolution", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
  });

  test("both --pref-id and --topic exits non-zero", async () => {
    const r = await runCli(
      ["brain", "evolution", "--pref-id", "pref-foo", "--topic", "foo", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).toBe(1);
  });
});

describe("o2b brain stale", () => {
  test("--json exits 0 with thresholds + arrays", async () => {
    const r = await runCli(["brain", "stale", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.thresholds).toBeDefined();
    expect(Array.isArray(payload.stalePreferences)).toBe(true);
  });
});

describe("o2b brain daily", () => {
  test("--date --json exits 0", async () => {
    const r = await runCli(["brain", "daily", "--date", "2026-05-20", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.date).toBe("2026-05-20");
  });
});

describe("o2b brain weekly", () => {
  test("--week-end --json exits 0", async () => {
    const r = await runCli(["brain", "weekly", "--week-end", "2026-05-25", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.windowEnd).toBe("2026-05-25T00:00:00Z");
  });
});
