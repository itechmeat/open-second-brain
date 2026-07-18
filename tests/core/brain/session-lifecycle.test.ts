import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-lifecycle-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("captureSessionLifecycleEvent", () => {
  test("writes prompt markers immediately and dedupes repeats", async () => {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: '@osb feedback positive topic=lifecycle principle="capture prompt markers"',
    };

    const first = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-05-30T10:00:00Z"),
    });
    const second = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-05-30T10:00:01Z"),
    });

    expect(first.event).toBe("UserPromptSubmit");
    expect(first.signals_created).toBe(1);
    expect(first.signals_deduped).toBe(0);
    expect(first.audit_path).toContain("session-lifecycle");
    expect(first.log_path).toContain("Brain/log/2026-05-30.md");
    expect(second.signals_created).toBe(0);
    expect(second.signals_deduped).toBe(1);

    const signalFiles = readdirSync(join(vault, "Brain", "inbox")).filter((name) =>
      name.endsWith(".md"),
    );
    expect(signalFiles).toHaveLength(1);
    const signal = parseSignal(join(vault, "Brain", "inbox", signalFiles[0]!));
    expect(signal.topic).toBe("lifecycle");
    expect(signal.source_type).toBe("session");
    expect(signal.session_ref).toBe("session:session-1#UserPromptSubmit");
  });

  test("captures only feedback markers, ignoring loop and set kinds", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-kinds",
        prompt: [
          "@osb feedback positive topic=only-feedback principle=p",
          "@osb loop follow up on vendor id=vendor",
          "@osb set note=Roadmap field=completion value=65",
        ].join("\n"),
      },
      { agent: "tester", now: new Date("2026-05-30T10:20:00Z") },
    );
    expect(result.signals_created).toBe(1);
    const signalFiles = readdirSync(join(vault, "Brain", "inbox")).filter((name) =>
      name.endsWith(".md"),
    );
    expect(signalFiles).toHaveLength(1);
    const signal = parseSignal(join(vault, "Brain", "inbox", signalFiles[0]!));
    expect(signal.topic).toBe("only-feedback");
  });

  test("replays brain_feedback tool input through the same signal boundary", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "PostToolUse",
        session_id: "session-2",
        tool_name: "brain_feedback",
        tool_input: {
          topic: "tool-feedback",
          signal: "negative",
          principle: "capture feedback tool calls",
          raw: "from hook payload",
        },
      },
      { agent: "tester", now: new Date("2026-05-30T10:05:00Z") },
    );

    expect(result.signals_created).toBe(1);
    expect(result.tool_replays).toBe(1);
  });

  test("records malformed payloads without throwing", async () => {
    const result = await captureSessionLifecycleEvent(vault, null, {
      agent: "tester",
      now: new Date("2026-05-30T10:10:00Z"),
    });

    expect(result.event).toBe("unknown");
    expect(result.malformed).toBe(1);
    expect(result.signals_created).toBe(0);
    expect(result.audit_path).toContain("session-lifecycle");
  });

  test.each(["SessionStart", "Stop", "SessionEnd"])(
    "records %s as lifecycle-only observation",
    async (event) => {
      const result = await captureSessionLifecycleEvent(
        vault,
        { hook_event_name: event, session_id: "session-lifecycle-only" },
        { agent: "tester", now: new Date("2026-05-30T10:15:00Z") },
      );

      expect(result.event).toBe(event);
      expect(result.signals_created).toBe(0);
      expect(result.signals_deduped).toBe(0);
      expect(result.log_path).toContain("Brain/log/2026-05-30.md");
    },
  );
});
