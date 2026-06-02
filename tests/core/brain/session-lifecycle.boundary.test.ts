/**
 * Capture-boundary and fact-extraction wiring at the LIVE seam
 * (Memory Integrity Suite, t_0532ed5a + t_d0782ab2).
 *
 * Pipeline order is the contract: classify/suppress first, extract
 * second. Ignored sessions produce nothing but the audit row;
 * stateless sessions write no Brain state; suppressed messages never
 * reach marker or fact extraction; facts extract only from text that
 * passed the boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";

let vault: string;

const NOW = new Date("2026-06-02T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lifecycle-boundary-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function setSessionsPolicy(lines: string[]): void {
  const path = brainConfigPath(vault);
  atomicWriteFileSync(path, readFileSync(path, "utf8") + "\n" + lines.join("\n") + "\n");
}

function inboxSignals(): string[] {
  const dir = brainDirs(vault).inbox;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("sig-") && n.endsWith(".md"));
}

const MARKER_PROMPT =
  '@osb feedback positive topic=boundary-check principle="capture only what passed the boundary"';

describe("ignored sessions", () => {
  test("produce no signals, no lifecycle log, only the audit row", async () => {
    setSessionsPolicy(["sessions:", "  ignore_patterns:", '    - "cron-*"']);
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "cron-nightly", prompt: MARKER_PROMPT },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("ignore");
    expect(result.signals_created).toBe(0);
    expect(result.log_path).toBeUndefined();
    expect(result.audit_path).toContain("session-lifecycle");
    expect(inboxSignals()).toEqual([]);
    expect(existsSync(join(brainDirs(vault).log, "2026-06-02.md"))).toBe(false);
  });
});

describe("stateless sessions", () => {
  test("write no signals and no lifecycle log", async () => {
    setSessionsPolicy(["sessions:", "  stateless_patterns:", '    - "probe-*"']);
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "probe-7", prompt: MARKER_PROMPT },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("stateless");
    expect(result.signals_created).toBe(0);
    expect(result.log_path).toBeUndefined();
    expect(inboxSignals()).toEqual([]);
  });
});

describe("message suppression", () => {
  test("a suppressed prompt never reaches marker or fact extraction", async () => {
    setSessionsPolicy(["sessions:", "  ignore_message_patterns:", '    - "^.osb feedback"']);
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "real-session", prompt: MARKER_PROMPT },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("capture");
    expect(result.suppressed_messages).toBe(1);
    expect(result.signals_created).toBe(0);
    expect(inboxSignals()).toEqual([]);
    // The lifecycle log still records the event (the suppression is
    // counted, the content is not persisted).
    expect(result.log_path).toBeDefined();
  });
});

describe("unconfigured vault", () => {
  test("behaves exactly as before the boundary existed", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: MARKER_PROMPT },
      { agent: "tester", now: NOW },
    );
    expect(result.boundary_decision).toBe("capture");
    expect(result.suppressed_messages).toBe(0);
    expect(result.signals_created).toBe(1);
  });
});

describe("fact extraction at the live seam", () => {
  test("facts extract from a captured user prompt and dedupe on repeat", async () => {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "By the way, my name is Sergey and I prefer dark themes.",
    };
    const first = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: NOW,
    });
    expect(first.facts_extracted).toBe(2);
    expect(first.facts_deduped).toBe(0);
    const names = inboxSignals();
    expect(names.some((n) => n.includes("fact-identity"))).toBe(true);
    expect(names.some((n) => n.includes("fact-preference"))).toBe(true);

    const second = await captureSessionLifecycleEvent(vault, payload, {
      agent: "tester",
      now: new Date("2026-06-02T10:00:05Z"),
    });
    expect(second.facts_extracted).toBe(0);
    expect(second.facts_deduped).toBe(2);
  });

  test("extracted signals carry source_type extracted", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "my name is Sergey" },
      { agent: "tester", now: NOW },
    );
    const name = inboxSignals().find((n) => n.includes("fact-identity"))!;
    const sig = parseSignal(join(brainDirs(vault).inbox, name));
    expect(sig.source_type).toBe("extracted");
    expect(sig.principle).toContain("Sergey");
  });

  test("a fact naming a registered entity gets the canonical anchor", async () => {
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      aliases: ["the vault project"],
      agent: "tester",
      now: NOW,
    });
    await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: "I prefer the vault project release diagrams in blueprint style",
      },
      { agent: "tester", now: NOW },
    );
    const name = inboxSignals().find((n) => n.includes("fact-preference"))!;
    const raw = readFileSync(join(brainDirs(vault).inbox, name), "utf8");
    expect(raw).toContain("ent-projects-open-second-brain");
  });

  test("assistant-shaped events without prompt text extract nothing", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "Stop", session_id: "s1" },
      { agent: "tester", now: NOW },
    );
    expect(result.facts_extracted).toBe(0);
  });
});
