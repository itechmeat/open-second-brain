import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

/**
 * §32F (v0.10.8). The `o2b append-event` CLI verb stays as the human /
 * cron-job surface for the legacy Daily/ event log. The bug it fixes:
 * before v0.10.8 the resolver fell back to the literal `"agent"` when
 * `--as` and `VAULT_AGENT_NAME` were absent, even when the plugin
 * config carried an `agent_name`. Daily entries from cron-jobs
 * therefore showed up as `@agent` instead of the configured identity.
 */

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-append-event-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-append-event-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("o2b append-event identity resolution (§32F)", () => {
  test("uses config agent_name when --as and env are absent", async () => {
    writeFileSync(
      configPath,
      `vault: ${vault}\nagent_name: cli-test-bot\n`,
      "utf8",
    );

    const r = await runCli(["append-event", "hello world"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        VAULT_AGENT_NAME: "",
      },
    });

    expect(r.returncode).toBe(0);
    const dailyDir = join(vault, "Daily");
    expect(existsSync(dailyDir)).toBe(true);
    const files = readdirSync(dailyDir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(dailyDir, files[0]!), "utf8");
    expect(body).toContain("@cli-test-bot");
    expect(body).not.toContain("@agent ");
    expect(body).toContain("hello world");
  });

  test("--as wins over the config agent_name", async () => {
    writeFileSync(
      configPath,
      `vault: ${vault}\nagent_name: cli-test-bot\n`,
      "utf8",
    );

    const r = await runCli(
      ["append-event", "--as", "explicit-bot", "another line"],
      {
        env: {
          OPEN_SECOND_BRAIN_CONFIG: configPath,
          VAULT_AGENT_NAME: "",
        },
      },
    );

    expect(r.returncode).toBe(0);
    const dailyDir = join(vault, "Daily");
    const files = readdirSync(dailyDir);
    const body = readFileSync(join(dailyDir, files[0]!), "utf8");
    expect(body).toContain("@explicit-bot");
    expect(body).not.toContain("@cli-test-bot");
  });

  test("VAULT_AGENT_NAME env wins when --as is absent", async () => {
    writeFileSync(
      configPath,
      `vault: ${vault}\nagent_name: cli-test-bot\n`,
      "utf8",
    );

    const r = await runCli(["append-event", "env wins"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        VAULT_AGENT_NAME: "env-bot",
      },
    });

    expect(r.returncode).toBe(0);
    const dailyDir = join(vault, "Daily");
    const files = readdirSync(dailyDir);
    const body = readFileSync(join(dailyDir, files[0]!), "utf8");
    expect(body).toContain("@env-bot");
  });
});
