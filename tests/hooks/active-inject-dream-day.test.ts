/**
 * The dream day check in the session start hook (change
 * `dream-session-trigger`, design D2 and D6): the hook's output is the
 * same when nothing is due and when a pass was started; the one note
 * rides the runtime notices, is printed alone when the payload is
 * otherwise empty, and is shown once a day. The hook runs in a child
 * process whose spawns are recorded and never run
 * (`fixtures/record-spawns-preload.ts`).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptyDreamTriggerRecord,
  writeDreamTriggerRecord,
} from "../../src/core/brain/dream-trigger/record.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { homeEnv } from "../helpers/platform.ts";
import { makeTriggerFixture, type TriggerFixture } from "../core/brain/dream-trigger/fixture.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "..", "..", "hooks", "active-inject.ts");
const PRELOAD = join(HERE, "fixtures", "record-spawns-preload.ts");

let f: TriggerFixture;

beforeEach(() => {
  f = makeTriggerFixture();
});

afterEach(() => {
  f.cleanup();
});

const today = (): string => new Date().toISOString().slice(0, 10);

let runs = 0;

async function runHook(auto: "true" | "false"): Promise<{ stdout: string; spawned: string[] }> {
  runs += 1;
  const spawnLog = join(f.tmp, `spawns-${runs}.log`);
  const proc = Bun.spawn(["bun", "--preload", PRELOAD, HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...homeEnv(join(f.tmp, "home")),
      OPEN_SECOND_BRAIN_CONFIG: f.configPath,
      [STORE_ROOT_ENV]: f.storeRoot,
      O2B_DEVICE_ID: "dev-a",
      OPEN_SECOND_BRAIN_DREAM_AUTO: auto,
      OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
      RECORD_SPAWNS_TO: spawnLog,
    },
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: "" });
  const spawned = existsSync(spawnLog)
    ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { stdout, spawned };
}

function context(stdout: string): string {
  if (stdout.trim() === "") return "";
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

const MINE = { device: "dev-a", agent: "claude", revision: null, mine: true };

describe("the dream day check at session start", () => {
  test("the output is unchanged when nothing is due", async () => {
    const off = await runHook("false");
    writeDreamTriggerRecord(f.recordPath, {
      ...emptyDreamTriggerRecord(f.storeRoot),
      owner: MINE,
      closed: true,
      day: today(),
    });
    const closed = await runHook("true");
    expect(closed.stdout).toBe(off.stdout);
    expect(closed.spawned).toEqual([]);
  });

  test("the output is unchanged when a pass was started, and the worker is started once", async () => {
    const off = await runHook("false");
    const started = await runHook("true");
    expect(started.stdout).toBe(off.stdout);
    const workers = started.spawned.filter((line) => line.includes('"dream","run","--claim"'));
    expect(workers).toHaveLength(1);
    // The claim stands, so the next session starts nothing.
    const again = await runHook("true");
    expect(again.spawned.filter((line) => line.includes('"dream","run"'))).toEqual([]);
  });

  test("a note rides the runtime notices, alone on an empty payload, once a day", async () => {
    // A vault with a Brain folder and no memory: the payload is otherwise empty.
    const vault = join(f.tmp, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(f.configPath, `vault: ${vault}\nagent_name: claude\n`);
    const off = await runHook("false");
    expect(context(off.stdout)).toBe("");
    const note = "Dream closed the day with work nothing on this machine answers: x.";
    writeDreamTriggerRecord(f.recordPath, {
      ...emptyDreamTriggerRecord(f.storeRoot),
      owner: MINE,
      closed: true,
      day: today(),
      note,
      line: { text: note, shown_day: null },
    });
    const first = await runHook("true");
    expect(context(first.stdout)).toBe(`Runtime notices:\n- [info] ${note}`);
    const second = await runHook("true");
    expect(second.stdout).toBe(off.stdout);
  });

  test("a note the session could not be given is shown by a later session of the day", async () => {
    // Standing rules larger than the whole host ceiling leave no room for
    // the notices block: the note is dropped from this session's payload.
    const vault = join(f.tmp, "vault");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      ["schema_version: 1", "active:", "  standing_rules_max_chars: 20000", ""].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "standing-rules.md"),
      Array.from({ length: 400 }, (_, i) => `- Standing rule ${i}: never skip the review.`).join(
        "\n",
      ),
    );
    writeFileSync(f.configPath, `vault: ${vault}\nagent_name: claude\n`);
    const note = "Dream closed the day with work nothing on this machine answers: x.";
    writeDreamTriggerRecord(f.recordPath, {
      ...emptyDreamTriggerRecord(f.storeRoot),
      owner: MINE,
      closed: true,
      day: today(),
      note,
      line: { text: note, shown_day: null },
    });
    const crowded = await runHook("true");
    expect(context(crowded.stdout)).toContain("Standing rule 0");
    expect(context(crowded.stdout)).not.toContain(note);
    expect(JSON.parse(readFileSync(f.recordPath, "utf8")).line).toEqual({
      text: note,
      shown_day: null,
    });
    // With room again, the next session of the day shows it.
    writeFileSync(join(vault, "Brain", "standing-rules.md"), "");
    const roomy = await runHook("true");
    expect(context(roomy.stdout)).toContain(note);
  });
});
