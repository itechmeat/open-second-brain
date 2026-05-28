import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-source-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function seedQueryVault(): void {
  const sig = writeSignal(vault, {
    topic: "agent-query",
    signal: "positive",
    agent: "claude",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "agent-query",
  });
  writePreference(vault, {
    slug: "agent-query",
    topic: "agent-query",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-22T10:00:00Z",
    unconfirmed_until: "2026-06-05T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[${sig.id}]]`],
    confirmed_at: null,
  });
}

function seedDiffVault(): void {
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "claude",
    principle: "Both agents know this topic.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "shared-claude",
  });
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "codex",
    principle: "Codex also knows this topic.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "shared-codex",
  });
  writeSignal(vault, {
    topic: "codex-only",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-22T10:00:00Z",
    date: "2026-05-22",
    slug: "codex-only",
  });
}

describe("o2b brain agent-query", () => {
  test("--json prints the structured query result", async () => {
    seedQueryVault();

    const r = await runCli(
      ["brain", "agent-query", "--agent", "claude", "--json"],
      {
        env: env(),
      },
    );

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      mode: string;
      total_matched: number;
      summary: string;
    };
    expect(payload.mode).toBe("agent-query");
    expect(payload.total_matched).toBe(2);
    expect(payload.summary).toContain("claude: 2 contributions");
  });
});

describe("o2b brain agent-diff", () => {
  test("renders a text comparison summary", async () => {
    seedDiffVault();

    const r = await runCli(
      [
        "brain",
        "agent-diff",
        "--mode",
        "diff",
        "--agent",
        "claude",
        "--agent",
        "codex",
      ],
      { env: env() },
    );

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("agent diff: diff");
    expect(r.stdout).toContain("shared topics: shared-topic");
    expect(r.stdout).toContain("codex unique: codex-only");
  });
});
