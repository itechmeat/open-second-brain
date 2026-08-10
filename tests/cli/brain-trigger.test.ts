/**
 * `o2b brain trigger` (Workspace Insight Suite, t_cd1fee79; suppression
 * from silence-is-not-an-answer, U5).
 *
 * The verb had no CLI coverage at all, which is how a nested-ternary
 * verb map that routed every unrecognised verb to the `act` transition
 * survived unnoticed. These tests pin the JSON projection, the
 * suppressed summary, the usage string and the verb routing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

const CANDIDATE: InsightCandidate = {
  kind: "contradiction",
  urgency: "high",
  reason: "pref-a contradicts pref-b on the same scope",
  suggestedAction: "Review both preferences and retire one",
  sourceArtifacts: ["[[pref-a]]", "[[pref-b]]"],
  contextSnippets: [],
  cooldownKey: "contradiction:pref-a:pref-b",
};

interface TriggerJson {
  readonly id: string;
  readonly status: string;
  readonly occurrences: number;
  readonly last_seen_at: string;
  readonly suppressed_at: string | null;
  readonly suppressed_from: string | null;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-trigger-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function seed(overrides: Partial<InsightCandidate> = {}): string {
  const { created } = createTriggers(vault, [{ ...CANDIDATE, ...overrides }], { now: new Date() });
  return created[0]!.id;
}

async function listJson(): Promise<{ triggers: TriggerJson[]; suppressed: number }> {
  const out = await runCli(["brain", "trigger", "list", "--json"], { env: env() });
  expect(out.returncode).toBe(0);
  return JSON.parse(out.stdout) as { triggers: TriggerJson[]; suppressed: number };
}

describe("o2b brain trigger", () => {
  test("a bad verb prints the usage string naming every verb", async () => {
    const out = await runCli(["brain", "trigger", "explode"], { env: env() });
    expect(out.returncode).not.toBe(0);
    const usage = out.stdout + out.stderr;
    expect(usage).toContain("usage: o2b brain trigger");
    for (const verb of [
      "scan",
      "list",
      "ack",
      "dismiss",
      "act",
      "suppress",
      "unsuppress",
      "history",
    ]) {
      expect(usage).toContain(verb);
    }
  });

  test("list --json carries the suppression and recurrence fields", async () => {
    const id = seed();
    const listed = await listJson();
    expect(listed.triggers).toHaveLength(1);
    const record = listed.triggers[0]!;
    expect(record.id).toBe(id);
    expect(record.status).toBe("pending");
    expect(record.occurrences).toBe(1);
    expect(record.last_seen_at).toEqual(expect.any(String));
    expect(record.suppressed_at).toBeNull();
    expect(record.suppressed_from).toBeNull();
  });

  test("list reports how many triggers are silenced, in both output modes", async () => {
    const id = seed();
    seed({ cooldownKey: "contradiction:pref-c:pref-d" });
    expect((await listJson()).suppressed).toBe(0);

    const suppressed = await runCli(["brain", "trigger", "suppress", id], { env: env() });
    expect(suppressed.returncode).toBe(0);
    expect(suppressed.stdout).toContain("[suppressed]");

    const after = await listJson();
    expect(after.suppressed).toBe(1);
    // A suppressed trigger is terminal, so `list` no longer shows it.
    expect(after.triggers.map((t) => t.id)).not.toContain(id);

    const text = await runCli(["brain", "trigger", "list"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("suppressed: 1");
  });

  test("suppress then unsuppress restores the prior status through the CLI", async () => {
    const id = seed();
    await runCli(["brain", "trigger", "dismiss", id], { env: env() });
    await runCli(["brain", "trigger", "suppress", id], { env: env() });

    const history = await runCli(["brain", "trigger", "history", "--json"], { env: env() });
    const historyRecords = (JSON.parse(history.stdout) as { triggers: TriggerJson[] }).triggers;
    expect(historyRecords.map((t) => t.status)).toEqual(["suppressed"]);
    expect(historyRecords[0]!.suppressed_from).toBe("dismissed");

    const restored = await runCli(["brain", "trigger", "unsuppress", id, "--json"], { env: env() });
    expect(restored.returncode).toBe(0);
    const record = (JSON.parse(restored.stdout) as { trigger: TriggerJson }).trigger;
    expect(record.status).toBe("dismissed");
    expect(record.suppressed_at).toBeNull();
    expect((await listJson()).suppressed).toBe(0);
  });

  test("unsuppressing a trigger that is not suppressed fails naming its status", async () => {
    const id = seed();
    const out = await runCli(["brain", "trigger", "unsuppress", id], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stdout + out.stderr).toContain("pending");
  });

  test("each verb routes to its own transition", async () => {
    // The map this pins used to be a nested ternary whose fallback arm
    // was `act`, so any verb that was not `ack` or `dismiss` acted.
    const transitioned = await Promise.all(
      (["ack", "dismiss", "act"] as const).map(async (verb) => {
        const id = seed({ cooldownKey: `contradiction:${verb}` });
        const out = await runCli(["brain", "trigger", verb, id, "--json"], { env: env() });
        expect(out.returncode).toBe(0);
        return (JSON.parse(out.stdout) as { trigger: TriggerJson }).trigger.status;
      }),
    );
    expect(transitioned).toEqual(["acknowledged", "dismissed", "acted"]);
  });

  test("a transition verb without an id is a usage error", async () => {
    const out = await runCli(["brain", "trigger", "suppress"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stdout + out.stderr).toContain("requires a trigger id");
  });

  test("an unknown --status is rejected rather than silently ignored", async () => {
    seed();
    const out = await runCli(["brain", "trigger", "list", "--status", "nope"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stdout + out.stderr).toContain("unknown trigger status");
  });

  test("--status suppressed lists exactly the silenced triggers", async () => {
    const id = seed();
    seed({ cooldownKey: "contradiction:pref-c:pref-d" });
    await runCli(["brain", "trigger", "suppress", id], { env: env() });
    const out = await runCli(["brain", "trigger", "list", "--status", "suppressed", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { triggers: TriggerJson[] };
    expect(parsed.triggers.map((t) => t.id)).toEqual([id]);
  });
});
