import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  __TEMPLATE_PATH_FOR_TESTS,
  __resetEnvWarnedOnceForTests,
  buildReminder,
  KNOWN_RUNTIME_TARGETS,
  loadReminderTemplate,
} from "../../src/core/identity-reminder.ts";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "identity-reminder",
);

function readFixture(target: string): string {
  return readFileSync(resolve(FIXTURE_DIR, `${target}.txt`), "utf8").trimEnd();
}

describe("template", () => {
  test("template file exists at the resolved path", () => {
    expect(existsSync(__TEMPLATE_PATH_FOR_TESTS)).toBe(true);
  });

  test("template contains {agent} placeholders (at least two)", () => {
    const text = loadReminderTemplate();
    const occurrences = (text.match(/\{agent\}/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("template references the three Brain writer tools (§32, v0.10.8)", () => {
    const body = loadReminderTemplate();
    expect(body).toContain("brain_feedback");
    expect(body).toContain("brain_apply_evidence");
    expect(body).toContain("brain_note");
    // event_log_append is retired across every runtime; the reminder
    // must not point agents at the dead surface.
    expect(body).not.toContain("event_log_append");
  });
});

describe("buildReminder", () => {
  test("substitutes every {agent} placeholder", () => {
    const out = buildReminder("hermes-vps-agent");
    expect(out).toContain("@hermes-vps-agent");
    expect(out).not.toContain("{agent}");
  });

  test("works for any string agent name", () => {
    expect(buildReminder("openclaw-main")).toContain("@openclaw-main");
    expect(buildReminder("x")).toContain("@x");
  });
});

describe("Python parity", () => {
  test("template file content has not drifted from what Python expects", () => {
    // Python shim reads templates/identity-reminder.txt directly. If the
    // file is renamed or its placeholder vocabulary changes, Python and
    // TypeScript would diverge silently. Assert the on-disk filename and
    // the placeholder name remain `{agent}` so that swapping in a different
    // marker requires editing both runtimes deliberately.
    const raw = readFileSync(__TEMPLATE_PATH_FOR_TESTS, "utf8");
    expect(raw).toMatch(/\{agent\}/);
    expect(__TEMPLATE_PATH_FOR_TESTS).toContain("templates/identity-reminder.txt");
  });
});

describe("buildReminder per-target resolution", () => {
  test("explicit target=hermes returns hermes template body", () => {
    const out = buildReminder("test-agent", "hermes");
    expect(out).toContain("Identity: @test-agent");
    expect(out).toContain("Hermes turns are short");
  });

  test("explicit target=openclaw returns openclaw template body", () => {
    const out = buildReminder("test-agent", "openclaw");
    expect(out).toContain("OpenClaw has no session boundary");
  });

  test("no target falls back to common template", () => {
    const out = buildReminder("test-agent");
    expect(out).toContain("Identity: @test-agent");
    expect(out).not.toContain("Hermes turns are short");
    expect(out).not.toContain("OpenClaw has no session boundary");
  });
});

describe("buildReminder fixture parity", () => {
  for (const target of KNOWN_RUNTIME_TARGETS) {
    test(`agent=test-agent target=${target} matches fixture`, () => {
      const expected = readFixture(target);
      const actual = buildReminder("test-agent", target);
      expect(actual).toBe(expected);
    });
  }
});

describe("buildReminder env-based resolution", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.O2B_TARGET;
    __resetEnvWarnedOnceForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.O2B_TARGET;
    else process.env.O2B_TARGET = savedEnv;
  });

  test("env O2B_TARGET=openclaw resolves to openclaw template", () => {
    process.env.O2B_TARGET = "openclaw";
    expect(buildReminder("test-agent")).toContain(
      "OpenClaw has no session boundary",
    );
  });

  test("explicit target beats env", () => {
    process.env.O2B_TARGET = "openclaw";
    expect(buildReminder("test-agent", "hermes")).toContain(
      "Hermes turns are short",
    );
  });

  test("unknown env value falls back to common template", () => {
    process.env.O2B_TARGET = "nonsense";
    const out = buildReminder("test-agent");
    expect(out).not.toContain("Hermes turns are short");
    expect(out).not.toContain("OpenClaw has no session boundary");
  });
});
