import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-intent-review-cli-"));
  vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
  configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  for (let index = 0; index < 3; index++) {
    writeSignal(vault, {
      topic: "ready-topic",
      signal: "positive",
      agent: "test",
      principle: "ready topic principle",
      created_at: `2026-05-2${index + 1}T10:00:00Z`,
      date: `2026-05-2${index + 1}`,
      slug: `ready-topic-${index}`,
    });
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("o2b brain intent-review", () => {
  test("prints JSON intent review report", async () => {
    const result = await runCli(["brain", "intent-review", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(result.returncode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      reviews: Array<{ topic: string; decision: string }>;
    };
    expect(payload.reviews).toEqual([
      expect.objectContaining({
        topic: "ready-topic",
        decision: "ready_for_main_review",
      }),
    ]);
  });
});
