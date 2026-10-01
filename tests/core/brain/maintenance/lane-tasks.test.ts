/**
 * The one lane task builder both front doors (the CLI verb and the MCP
 * tool) call: the four built-ins in their registration order, then the
 * declared custom tasks when the master switch is on, with the config
 * errors passed through and every per-task safeguard built lazily.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLaneTasks } from "../../../../src/core/brain/maintenance/lane-tasks.ts";
import {
  LANE_TASK,
  LANE_TASKS,
  type LaneTask,
} from "../../../../src/core/brain/maintenance/lane.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { createSafeguard, SafeguardAbortError } from "../../../../src/core/brain/safeguard.ts";
import { MAINTENANCE_CUSTOM_TASKS_ENV } from "../../../../src/core/config.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";

const NOW = new Date("2026-06-05T03:30:00Z");

let dir: string;
let vault: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o2b-lane-tasks-"));
  vault = join(dir, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  savedEnv = process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
  delete process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[MAINTENANCE_CUSTOM_TASKS_ENV];
  else process.env[MAINTENANCE_CUSTOM_TASKS_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(lines: ReadonlyArray<string>): void {
  writeFileSync(configPath, `${[`vault: ${vault}`, ...lines].join("\n")}\n`);
}

function build(calls: LaneTask[] = [], signal?: AbortSignal) {
  return buildLaneTasks({
    vault,
    configPath,
    searchConfig: resolveSearchConfig({ vault, configPath }),
    now: NOW,
    forceCost: false,
    ...(signal !== undefined ? { signal } : {}),
    safeguardFor: (operation) => {
      calls.push(operation);
      return createSafeguard({ operation, timeoutMs: null });
    },
  });
}

/**
 * A config value for a command that writes the marker file at the absolute
 * path `marker`, portably: the Bun path quoted (it may hold a space), the
 * whole value wrapped in single quotes so the config reader does not strip
 * the double quotes the command starts and ends with.
 */
function touchCommand(marker: string): string {
  const target = marker.replaceAll("\\", "/");
  return `'"${process.execPath}" -e "require('node:fs').writeFileSync('${target}', 'ran')"'`;
}

describe("buildLaneTasks", () => {
  test("with the switch off the task names are exactly the built-ins, in order", () => {
    writeConfig(["maintenance_custom_a: echo a"]);
    const set = build();
    expect(set.taskNames).toEqual(LANE_TASKS);
    expect(set.tasks.map((t) => t.name)).toEqual([...LANE_TASKS]);
    expect(set.custom.enabled).toBe(false);
    expect(set.custom.declared).toBe(1);
    expect(set.reindex.task.name).toBe(LANE_TASK.reindex);
  });

  test("with the switch on, declared custom tasks follow the built-ins and errors pass through", () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      "maintenance_custom_b: echo b",
      "maintenance_custom_a: echo a",
      "maintenance_custom_Bad: echo bad",
    ]);
    const set = build();
    expect(set.taskNames).toEqual([...LANE_TASKS, "custom:a", "custom:b"]);
    expect(set.tasks.map((t) => t.name)).toEqual([...set.taskNames]);
    expect(set.custom.errors.length).toBe(1);
    expect(set.custom.errors[0]).toContain("maintenance_custom_Bad");
  });

  test("safeguardFor is called lazily, with the running task's operation, once per run", async () => {
    const calls: LaneTask[] = [];
    const set = build(calls);
    expect(calls).toEqual([]);
    const dream = set.tasks.find((t) => t.name === LANE_TASK.dream)!;
    await dream.run();
    expect(calls).toEqual([LANE_TASK.dream]);
    await dream.run();
    expect(calls).toEqual([LANE_TASK.dream, LANE_TASK.dream]);
  });

  test("a built custom task runs its command and returns no spend receipt", async () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      `maintenance_custom_a: ${touchCommand(join(dir, "a.txt"))}`,
    ]);
    const set = build();
    const custom = set.tasks.find((t) => t.name === "custom:a")!;
    const receipt = await custom.run();
    expect(receipt).toBeUndefined();
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(
      set.reindex.spendBlock([{ name: "custom:a", ok: true, duration_ms: 1 }]),
    ).toBeUndefined();
  });

  test("the lane's abort signal reaches the custom tasks it builds", async () => {
    writeConfig([
      "maintenance_custom_tasks: true",
      `maintenance_custom_a: ${touchCommand(join(dir, "aborted.txt"))}`,
    ]);
    const controller = new AbortController();
    controller.abort();
    const custom = build([], controller.signal).tasks.find((t) => t.name === "custom:a")!;
    const err = await custom.run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SafeguardAbortError);
    expect(existsSync(join(dir, "aborted.txt"))).toBe(false);
  });
});
