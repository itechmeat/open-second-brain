import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { processedSignalPath, signalPath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let root: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-retention-cli-"));
  vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
  configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  writeSignal(vault, {
    topic: "discarded-signal",
    signal: "negative",
    agent: "test",
    principle: "old one-off signal",
    created_at: "2026-04-01T00:00:00Z",
    date: "2026-04-01",
    slug: "discarded-signal",
  });
  renameSync(
    signalPath(vault, "2026-04-01", "discarded-signal"),
    processedSignalPath(vault, "2026-04-01", "discarded-signal"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("o2b brain retention", () => {
  test("prints JSON retention recommendations", async () => {
    const result = await runCli(
      ["brain", "retention", "--json", "--now", "2026-05-28T00:00:00Z"],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
      },
    );
    expect(result.returncode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: { prune: number } };
    expect(payload.summary.prune).toBe(1);
  });

  test("rejects malformed --now", async () => {
    const result = await runCli(["brain", "retention", "--now", "not-a-date"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("invalid --now");
  });
});
