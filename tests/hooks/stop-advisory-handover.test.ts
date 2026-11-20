import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HANDOVER_MAX_AGE_MS,
  HANDOVER_MAX_ENTRIES,
  stopAdvisoryHandoverDir,
  stopEventKey,
  takeStopAdvisories,
  writeStopAdvisoryHandover,
} from "../../hooks/lib/stop-advisory-handover.ts";
import { stateRootDir } from "../../src/core/platform-dirs.ts";

afterEach(() => rmSync(stopAdvisoryHandoverDir(), { recursive: true, force: true }));

const PAYLOAD = {
  hook_event_name: "Stop",
  session_id: "sess-handover",
  prompt_id: "prompt-a",
  stop_hook_active: false,
  last_assistant_message: "done",
};

describe("the Stop event key", () => {
  test("one event, one key; another prompt or answer, another key; no session, no key", () => {
    const key = stopEventKey(PAYLOAD);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(stopEventKey({ ...PAYLOAD })).toBe(key);
    expect(stopEventKey({ ...PAYLOAD, prompt_id: "prompt-b" })).not.toBe(key);
    expect(stopEventKey({ ...PAYLOAD, last_assistant_message: "other" })).not.toBe(key);
    expect(stopEventKey({ ...PAYLOAD, session_id: undefined })).toBeNull();
  });
});

describe("the hand-over directory", () => {
  test("lives in the device-local state root, outside every vault", () => {
    expect(stopAdvisoryHandoverDir()).toBe(join(stateRootDir(), "stop-advisories"));
  });

  test("a write drops leftovers past the age limit and keeps the count bounded", () => {
    const dir = stopAdvisoryHandoverDir();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "0".repeat(32) + "-stop-log-guardrail.json");
    writeFileSync(old, '{"advisory":null}\n');
    const past = (Date.now() - HANDOVER_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    for (let i = 0; i < HANDOVER_MAX_ENTRIES + 5; i++) {
      writeFileSync(join(dir, `${String(i).padStart(32, "1")}-delivered`), "");
    }
    expect(writeStopAdvisoryHandover(PAYLOAD, "answer-quote-check", "text")).toBe(true);
    const names = readdirSync(dir);
    expect(names).not.toContain(old.slice(dir.length + 1));
    // The cap applies before the new file lands, so at most one past it.
    expect(names.length).toBeLessThanOrEqual(HANDOVER_MAX_ENTRIES + 1);
    expect(names).toContain(`${stopEventKey(PAYLOAD)}-answer-quote-check.json`);
  });
});

describe("taking the advisories of one event", () => {
  test("returns them in producer order, skips the empty ones, removes every file, then returns nothing", () => {
    writeStopAdvisoryHandover(PAYLOAD, "hygiene-digest", "digest");
    writeStopAdvisoryHandover(PAYLOAD, "answer-quote-check", null);
    writeStopAdvisoryHandover(PAYLOAD, "stop-log-guardrail", "nudge");
    const expected = ["stop-log-guardrail", "answer-quote-check", "hygiene-digest"] as const;
    expect(takeStopAdvisories(PAYLOAD, expected, 0)).toEqual(["nudge", "digest"]);
    expect(readdirSync(stopAdvisoryHandoverDir()).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect(takeStopAdvisories(PAYLOAD, expected, 0)).toEqual([]);
  });

  test("another event's hand-over is never taken", () => {
    writeStopAdvisoryHandover({ ...PAYLOAD, prompt_id: "prompt-b" }, "stop-log-guardrail", "x");
    expect(takeStopAdvisories(PAYLOAD, ["stop-log-guardrail"], 0)).toEqual([]);
    expect(
      takeStopAdvisories({ ...PAYLOAD, prompt_id: "prompt-b" }, ["stop-log-guardrail"], 0),
    ).toEqual(["x"]);
  });
});
