/**
 * CLI verbs of the advisory decision-model uses (issue #213, Parts 5 and
 * 6): `o2b brain tension verify` and `o2b brain label <path> --suggest`,
 * off and enforced against a loopback fake server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoteContradictionFinding } from "../../src/core/brain/health/contradiction.ts";
import { persistTension } from "../../src/core/brain/tensions.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import { choiceReply } from "../helpers/fake-choice-decision.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../helpers/fake-decision-provider.ts";
import { runCli } from "../helpers/run-cli.ts";

const KEY_VAR = "O2B_TEST_DECISION_CLI_KEY";
let server: FakeSystemOne;
let tmp: string;
let vault: string;
let configPath: string;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dm-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\nschema:\n  labels:\n    - priority=low\n    - priority=high\n",
  );
  writeFileSync(join(vault, "notes", "a.md"), "Always use tabs.\n");
  writeFileSync(join(vault, "notes", "b.md"), "Never use tabs.\n");
  const finding: NoteContradictionFinding = {
    aId: "notes/a.md",
    bId: "notes/b.md",
    subject: "tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "Always use tabs.",
    bQuote: "Never use tabs.",
    action: "ask_user",
  };
  persistTension(vault, finding, { agent: "tester" });
  server.requests.length = 0;
  server.setReply((req) => ({
    json: choiceReply(req, (_id, options) =>
      options.includes("contradicts")
        ? { choice: "contradicts", p: 0.9 }
        : { choice: "high", p: 0.9 },
    ),
  }));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(uses: string | null): void {
  const lines = [`vault: ${vault}`, "agent_name: tester"];
  if (uses !== null) {
    lines.push(
      'decision_model_enabled: "true"',
      "decision_model_provider: compatible",
      "decision_model_threshold_profile: jev-1.13",
      "decision_model_id: fake-model-1",
      `decision_model_env_key: ${KEY_VAR}`,
      `decision_model_base_url: ${server.url}`,
      `decision_model_uses: "${uses}"`,
    );
  }
  writeFileSync(configPath, `${lines.join("\n")}\n`);
}

const env = (key: boolean) => ({
  OPEN_SECOND_BRAIN_CONFIG: configPath,
  VAULT_AGENT_NAME: "",
  ...(key ? { [KEY_VAR]: FAKE_DECISION_KEY } : {}),
});

describe("o2b brain tension verify", () => {
  test("off: unavailable, no request", async () => {
    writeConfig(null);
    const r = await runCli(["brain", "tension", "verify", "--config", configPath, "--json"], {
      env: env(true),
    });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.available).toBe(false);
    expect(out.reason).toBe("decision_model_off");
    expect(out.tensions).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });

  test("enforce: the verdict on each unresolved tension", async () => {
    writeConfig("tension:enforce");
    const r = await runCli(["brain", "tension", "verify", "--config", configPath, "--json"], {
      env: env(true),
    });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.mode).toBe("enforce");
    expect(out.tensions[0].decision_model.verdict).toBe("contradicts");
    expect(server.requests).toHaveLength(1);
  });
});

describe("o2b brain label --suggest", () => {
  test("enabled without the key: unavailable, no request", async () => {
    writeConfig("labels:enforce");
    const r = await runCli(["brain", "label", "notes/a.md", "--suggest", "--json"], {
      env: env(false),
    });
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      available: false,
      reason: "decision_model_off",
      path: "notes/a.md",
    });
    expect(server.requests).toHaveLength(0);
  });

  test("enforce: suggestions, and the note is not written", async () => {
    writeConfig("labels:enforce");
    const before = readFileSync(join(vault, "notes", "a.md"), "utf8");
    const r = await runCli(["brain", "label", "notes/a.md", "--suggest", "--json"], {
      env: env(true),
    });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.dimensions[0].dimension).toBe("priority");
    expect(out.dimensions[0].suggestion).toBe("high");
    expect(readFileSync(join(vault, "notes", "a.md"), "utf8")).toBe(before);
  });
});
