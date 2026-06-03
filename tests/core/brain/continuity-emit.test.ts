/**
 * Lazy gated telemetry emit kernel (Memory Observability Suite,
 * t_5d7aa7c5).
 *
 * The structural guarantee: "no consumer means no payload work". With
 * the gate off the payload thunk is never invoked and nothing reaches
 * the continuity store; a throwing thunk or write never fails the
 * primary operation (fail-open). Gated surfaces route through this one
 * helper instead of re-implementing the shape by convention.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitGatedTelemetry } from "../../../src/core/brain/continuity/emit.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";

let vault: string;

const CONTINUITY_DIR = ["Brain", "log", "continuity"];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-continuity-emit-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function continuityDir(): string {
  return join(vault, ...CONTINUITY_DIR);
}

function writePref(slug: string, principle: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    `---\nid: pref-${slug}\ntopic: ${slug}\nprinciple: ${principle}\n---\n\n${principle}\n`,
  );
}

/** Force every continuity append to throw: the store's directory path exists as a FILE. */
function blockContinuityWrites(): void {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(continuityDir(), "not a directory");
}

describe("emitGatedTelemetry", () => {
  test("gate off: the thunk is never invoked and null comes back", () => {
    let invoked = 0;
    for (const gate of [undefined, false, null]) {
      const result = emitGatedTelemetry(gate, () => {
        invoked++;
        return "never";
      });
      expect(result).toBeNull();
    }
    expect(invoked).toBe(0);
  });

  test("gate on: the gate value flows into the thunk and the result comes back", () => {
    const result = emitGatedTelemetry({ host: "cli" }, (gate) => `host=${gate.host}`);
    expect(result).toBe("host=cli");
    expect(emitGatedTelemetry(true, () => 42)).toBe(42);
  });

  test("a throwing thunk is swallowed: fail-open returns null", () => {
    const result = emitGatedTelemetry(true, () => {
      throw new Error("continuity store on fire");
    });
    expect(result).toBeNull();
  });
});

describe("no-consumer regression: gated surfaces stay silent with gates off", () => {
  test("packContext without receipt/telemetry options writes nothing to continuity", () => {
    writePref("alpha", "Always alpha");
    const report = packContext(vault, { maxTokens: 500 });
    expect(report.items.length).toBe(1);
    expect(existsSync(continuityDir())).toBe(false);
  });

  test("buildPreCompressPack without receipt/telemetry options writes nothing to continuity", () => {
    writePref("beta", "Always beta");
    const pack = buildPreCompressPack(vault, { topK: 3 });
    expect(pack.items.length).toBeGreaterThanOrEqual(0);
    expect(existsSync(continuityDir())).toBe(false);
  });

  test("session lifecycle capture with defaults writes zero continuity records", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "s-1", prompt: "hello world" },
      { agent: "test-agent" },
    );
    expect(result.event).toBe("UserPromptSubmit");
    expect(existsSync(continuityDir())).toBe(false);
  });
});

describe("fail-open: a broken continuity store never fails the primary operation", () => {
  test("packContext with telemetry requested still returns a pack, without telemetryId", () => {
    writePref("gamma", "Always gamma");
    blockContinuityWrites();
    const report = packContext(vault, {
      maxTokens: 500,
      telemetry: { host: "test" },
      receipt: { host: "test", trigger: "context_pack" },
    });
    expect(report.items.length).toBe(1);
    expect(report.telemetryId).toBeUndefined();
    expect(report.receiptId).toBeUndefined();
  });

  test("buildPreCompressPack with telemetry requested still returns a pack", () => {
    writePref("delta", "Always delta");
    blockContinuityWrites();
    const pack = buildPreCompressPack(vault, {
      topK: 3,
      telemetry: { host: "test" },
    });
    expect(pack.text.length).toBeGreaterThanOrEqual(0);
    expect(pack.telemetryId).toBeUndefined();
  });
});
