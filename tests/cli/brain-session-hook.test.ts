import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-session-hook-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  bootstrapBrain(vault);
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain session-hook", () => {
  test("captures stdin hook payload as JSON", async () => {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-session",
      prompt: "@osb feedback negative topic=cli-hook principle=capture-cli-hook",
    };

    const result = await runCli(["brain", "session-hook", "--json"], {
      env: env(),
      stdin: JSON.stringify(payload),
    });

    expect(result.returncode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.event).toBe("UserPromptSubmit");
    expect(body.signals_created).toBe(1);
    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.endsWith(".md")),
    ).toHaveLength(1);
  });

  test("dry-run reports marker capture without writing", async () => {
    const result = await runCli(["brain", "session-hook", "--dry-run", "--json"], {
      env: env(),
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "@osb feedback positive topic=dry-run principle=no-write",
      }),
    });

    expect(result.returncode).toBe(0);
    expect(JSON.parse(result.stdout).signals_created).toBe(0);
    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.endsWith(".md")),
    ).toHaveLength(0);
  });
});
