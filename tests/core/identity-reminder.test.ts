import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  __TEMPLATE_PATH_FOR_TESTS,
  buildReminder,
  loadReminderTemplate,
} from "../../src/core/identity-reminder.ts";

describe("template", () => {
  test("template file exists at the resolved path", () => {
    expect(existsSync(__TEMPLATE_PATH_FOR_TESTS)).toBe(true);
  });

  test("template contains {agent} placeholders (at least two)", () => {
    const text = loadReminderTemplate();
    const occurrences = (text.match(/\{agent\}/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("template references event_log_append", () => {
    expect(loadReminderTemplate()).toContain("event_log_append");
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
