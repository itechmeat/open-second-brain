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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate, TriggerRecord } from "../../src/core/brain/triggers/types.ts";
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

function seedRecord(overrides: Partial<InsightCandidate> = {}): TriggerRecord {
  const { created } = createTriggers(vault, [{ ...CANDIDATE, ...overrides }], { now: new Date() });
  return created[0]!;
}

function seed(overrides: Partial<InsightCandidate> = {}): string {
  return seedRecord(overrides).id;
}

/** Seed one record and make a field of it unreadable, as a hand-edit would. */
function seedUnreadable(overrides: Partial<InsightCandidate> = {}): string {
  const { path } = seedRecord(overrides);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^occurrences: .*$/mu, "occurrences: many"),
    "utf8",
  );
  return path;
}

interface UnreadableJson {
  readonly path: string;
  readonly key: string | null;
  readonly error: string;
}

async function listJson(): Promise<{
  triggers: TriggerJson[];
  suppressed: number;
  unreadable: UnreadableJson[];
}> {
  const out = await runCli(["brain", "trigger", "list", "--json"], { env: env() });
  expect(out.returncode).toBe(0);
  return JSON.parse(out.stdout) as {
    triggers: TriggerJson[];
    suppressed: number;
    unreadable: UnreadableJson[];
  };
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
    // Sequential on purpose: an in-process CLI run swaps process.env, the
    // working directory and both output streams, so overlapping runs
    // restore each other’s saved state. runCli refuses to overlap now, and
    // this loop is what that refusal expects.
    const transitioned: string[] = [];
    for (const verb of ["ack", "dismiss", "act"] as const) {
      const id = seed({ cooldownKey: `contradiction:${verb}` });
      // The rule suggests Promise.all, which is exactly the overlap runCli
      // now refuses; see the comment above this loop.
      // eslint-disable-next-line no-await-in-loop
      const out = await runCli(["brain", "trigger", verb, id, "--json"], { env: env() });
      expect(out.returncode).toBe(0);
      transitioned.push((JSON.parse(out.stdout) as { trigger: TriggerJson }).trigger.status);
    }
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

  test("list reports an empty unreadable set on a healthy queue", async () => {
    seed();
    // Always present, so "none could not be read" is a statement the
    // output makes rather than something a caller has to assume.
    expect((await listJson()).unreadable).toEqual([]);
  });

  test("list names a record it could not read and still shows the healthy one", async () => {
    const healthy = seed();
    const brokenPath = seedUnreadable({ cooldownKey: "contradiction:pref-c:pref-d" });

    const listed = await listJson();
    expect(listed.triggers.map((t) => t.id)).toEqual([healthy]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]!.path).toBe(brokenPath);
    expect(listed.unreadable[0]!.key).toBe("occurrences");

    const text = await runCli(["brain", "trigger", "list"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("unreadable: 1");
    expect(text.stdout).toContain(brokenPath);
  });

  test("a corrupt record still leaves the healthy one suppressible", async () => {
    const healthy = seed();
    seedUnreadable({ cooldownKey: "contradiction:pref-c:pref-d" });
    const out = await runCli(["brain", "trigger", "suppress", healthy], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("[suppressed]");
  });

  test("the morning brief says the queue is unreadable instead of falling silent", async () => {
    seedUnreadable();
    const json = await runCli(["brain", "morning-brief", "--json"], { env: env() });
    expect(json.returncode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { triggers_unreadable?: UnreadableJson[] };
    expect(parsed.triggers_unreadable).toHaveLength(1);
    expect(parsed.triggers_unreadable![0]!.key).toBe("occurrences");

    const text = await runCli(["brain", "morning-brief"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("Unreadable triggers");
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
