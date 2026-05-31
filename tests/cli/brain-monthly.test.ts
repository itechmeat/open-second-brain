import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-monthly-cli-"));
  vault = join(root, "vault");
  mkdirSync(brainDirs(vault).log, { recursive: true });
  configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  appendLogEvent(vault, {
    timestamp: "2026-05-10T10:00:00Z",
    eventType: BRAIN_LOG_EVENT_KIND.feedback,
    body: { topic: "monthly", sign: "positive", agent: "test" },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("o2b brain monthly", () => {
  test("prints JSON monthly review", async () => {
    const result = await runCli(["brain", "monthly", "--json", "--month", "2026-05"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(result.returncode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      month: string;
      summary: { events: number };
    };
    expect(payload.month).toBe("2026-05");
    expect(payload.summary.events).toBe(1);
  });

  test("rejects malformed --month", async () => {
    const result = await runCli(["brain", "monthly", "--month", "2026-13"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("YYYY-MM");
  });
});
