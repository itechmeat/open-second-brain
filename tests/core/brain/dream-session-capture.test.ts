/**
 * A dream session is never captured (change `dream-launched-agent`,
 * design D2; spec "The session is kept apart": "No capture", "A later
 * import"; task 1.1): the live seam records nothing in a process that
 * carries the marker, and both seams ignore a transcript whose first
 * user message begins with the session line, while one that only quotes
 * the line later is captured as before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DREAM_RUN_ENV,
  dreamSessionLine,
} from "../../../src/core/brain/dream-queue/dream-session.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";

const NOW = new Date("2026-06-02T10:00:00Z");
const LINE = dreamSessionLine("0b0c3a2e-1111-4222-8333-444455556666");
const MARKER_PROMPT =
  '@osb feedback positive topic=dream-capture principle="capture only what passed the boundary"';

let root: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-dream-capture-"));
  vault = join(root, "vault");
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function inboxSignals(): string[] {
  const dir = brainDirs(vault).inbox;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("sig-"));
}

function transcript(name: string, userTexts: string[]): string {
  const lines = [
    ...userTexts.map((text, i) =>
      JSON.stringify({
        type: "user",
        parentUuid: i === 0 ? null : `u-${i - 1}`,
        sessionId: "s-fixture",
        entrypoint: "cli",
        uuid: `u-${i}`,
        timestamp: "2026-06-02T09:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ),
  ];
  const path = join(root, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("the live seam", () => {
  test("records nothing in a process with the marker", async () => {
    const before = process.env[DREAM_RUN_ENV];
    process.env[DREAM_RUN_ENV] = "0b0c3a2e-1111-4222-8333-444455556666";
    try {
      const result = await captureSessionLifecycleEvent(
        vault,
        { hook_event_name: "UserPromptSubmit", session_id: "s-dream", prompt: MARKER_PROMPT },
        { agent: "tester", now: NOW },
      );
      expect(result.boundary_decision).toBe("ignore");
      expect(result.signals_created).toBe(0);
      expect(result.audit_path).toBeUndefined();
      expect(result.log_path).toBeUndefined();
      expect(inboxSignals()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env[DREAM_RUN_ENV];
      else process.env[DREAM_RUN_ENV] = before;
    }
  });

  test("ignores a prompt that begins with the session line", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-dream",
        prompt: `${LINE}\n${MARKER_PROMPT}`,
      },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("ignore");
    expect(inboxSignals()).toEqual([]);
  });

  test("ignores an event whose transcript's first user message is the session line", async () => {
    const path = transcript("dream.jsonl", [`${LINE}\nCall dream_work_take.`, MARKER_PROMPT]);
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-dream",
        transcript_path: path,
        prompt: MARKER_PROMPT,
      },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("ignore");
    expect(inboxSignals()).toEqual([]);
  });

  test("captures a session that only quotes the line later", async () => {
    const path = transcript("quote.jsonl", ["hello", `see ${LINE}`]);
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-normal",
        transcript_path: path,
        prompt: MARKER_PROMPT,
      },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("capture");
    expect(result.signals_created).toBe(1);
  });
});

describe("the batch import", () => {
  test("skips a transcript whose first user message is the session line", async () => {
    const path = transcript("dream.jsonl", [
      `${LINE}\nCall dream_work_take.`,
      "the project site is https://techmeat.dev",
    ]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("ignore");
    expect(result.turns_scanned).toBe(0);
    expect(result.facts_extracted).toBe(0);
  });

  test("imports one that only quotes the line later", async () => {
    const path = transcript("quote.jsonl", [
      "the project site is https://techmeat.dev",
      `see ${LINE}`,
    ]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("capture");
    expect(result.facts_extracted).toBe(1);
  });
});
