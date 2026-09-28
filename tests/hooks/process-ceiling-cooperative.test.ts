/**
 * The hook ceiling reaches synchronous work (issue #195).
 *
 * `armProcessCeiling` is a timer, and a timer cannot fire while the event
 * loop is blocked by synchronous I/O - which is what the signal dedup walk
 * is. `ceilingSafeguard` hands that work the same deadline as a cooperative
 * checkpoint. These tests drive a synthetic slow walk (a clock that advances
 * one second per reading) through the real lifecycle capture and assert
 * that it stops at a file boundary without writing, and that under budget
 * the capture is unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ceilingSafeguard, HOOK_CEILING_OPERATION } from "../../hooks/lib/process-ceiling.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { SafeguardTimeoutError } from "../../src/core/brain/safeguard.ts";
import { captureSessionLifecycleEvent } from "../../src/core/brain/session-lifecycle.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

const NOW = new Date("2026-06-02T10:00:00Z");
const MARKER_PROMPT =
  '@osb feedback positive topic=ceiling-check principle="stop the walk before the host does"';

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ceiling-coop-"));
  bootstrapBrain(vault);
  for (let i = 0; i < 40; i++) {
    writeSignal(vault, {
      topic: `history-${i}`,
      signal: "positive",
      agent: "claude",
      principle: `Historical principle ${i}`,
      created_at: "2026-05-01T10:00:00Z",
      date: "2026-05-01",
      slug: `history-${i}`,
      dedup_hash: `h-${i}`,
    });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** A clock that advances one second per reading: every file costs a second. */
function slowClock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

function inboxCount(): number {
  const dir = brainDirs(vault).inbox;
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.startsWith("sig-")).length;
}

function markerEvent(): Record<string, unknown> {
  return { hook_event_name: "UserPromptSubmit", session_id: "s-1", prompt: MARKER_PROMPT };
}

describe("ceilingSafeguard", () => {
  test("is silent under budget and throws at the first checkpoint past it", () => {
    let t = 0;
    const guard = ceilingSafeguard(3_000, () => t);
    t = 2_999;
    guard.checkpoint();
    t = 3_001;
    expect(() => guard.checkpoint()).toThrow(SafeguardTimeoutError);
    expect(guard.operation).toBe(HOOK_CEILING_OPERATION);
  });
});

describe("the lifecycle capture under the cooperative ceiling", () => {
  test("a slow dedup walk stops at a file boundary and writes nothing", async () => {
    const before = inboxCount();
    await expect(
      captureSessionLifecycleEvent(vault, markerEvent(), {
        agent: "claude",
        now: NOW,
        safeguard: ceilingSafeguard(8_000, slowClock()),
      }),
    ).rejects.toThrow(SafeguardTimeoutError);
    expect(inboxCount()).toBe(before);
  });

  test("under budget the capture is unchanged", async () => {
    const before = inboxCount();
    const result = await captureSessionLifecycleEvent(vault, markerEvent(), {
      agent: "claude",
      now: NOW,
      safeguard: ceilingSafeguard(60_000),
    });
    expect(result.signals_created).toBe(1);
    expect(inboxCount()).toBe(before + 1);
  });
});
