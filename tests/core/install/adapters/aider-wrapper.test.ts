import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  bracketAiderSession,
  isInterruptedExit,
  renderAiderSidecar,
  type AiderSpawnResult,
  type BracketAiderDeps,
} from "../../../../src/core/install/adapters/aider-wrapper.ts";
import { aiderAdapter } from "../../../../src/core/install/adapters/aider.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { extractPreCompactRecords } from "../../../../src/core/brain/pre-compact-extract.ts";
import { listContinuityRecords } from "../../../../src/core/brain/continuity/store.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-aiderwrap-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-aiderwrap-h-"));
});
afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function env(now = new Date("2026-07-07T12:00:00.000Z"), envVars: Record<string, string> = {}) {
  return { vault, home, cwd: home, env: envVars, now };
}

function applyOpts(overrides: Record<string, unknown> = {}) {
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
    ...overrides,
  };
}

const payload = buildPayload({ vault: "/v", agent_name: "claude-vps", timezone: "UTC" });

/** Deps that record phase ordering and let each test override behaviour. */
function makeDeps(
  over: Partial<BracketAiderDeps> & { exit?: AiderSpawnResult; transcript?: string } = {},
): { deps: BracketAiderDeps; log: string[]; persistInputs: unknown[] } {
  const log: string[] = [];
  const persistInputs: unknown[] = [];
  const exit = over.exit ?? { code: 0, signal: null };
  const transcript = over.transcript ?? "decision: adopt the wrapper\ncommitment: land E1\n";
  const deps: BracketAiderDeps = {
    loadContext:
      over.loadContext ??
      (() => {
        log.push("load");
        return join(vault, ".open-second-brain", "aider-context.md");
      }),
    spawnAider:
      over.spawnAider ??
      (async () => {
        log.push("spawn");
        return exit;
      }),
    captureTranscript: over.captureTranscript ?? (() => transcript),
    persist:
      over.persist ??
      ((input) => {
        log.push("persist");
        persistInputs.push(input);
        return extractPreCompactRecords(vault, input);
      }),
  };
  return { deps, log, persistInputs };
}

describe("aider session-bracketing wrapper", () => {
  test("load-half fires before Aider is spawned; persist-half fires after it exits", async () => {
    const { deps, log, persistInputs } = makeDeps();
    const result = await bracketAiderSession({ sessionId: "s1" }, deps);

    expect(log).toEqual(["load", "spawn", "persist"]);
    expect(result.phases).toEqual(["load", "spawn", "persist"]);
    // The load-half ran, then Aider, then the write-back persisted the session.
    expect(result.interrupted).toBe(false);
    expect((persistInputs[0] as { text: string }).text).toContain("decision: adopt the wrapper");
    // The captured session was persisted into the Brain (write-back closed).
    const records = listContinuityRecords(vault, { kind: "pre_compact_extract" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((r) => r.payload["extract_type"] === "decision")).toBe(true);
  });

  test("live load-half regenerates the sidecar each session start", async () => {
    // The real load-half writes a fresh sidecar (live), unlike the static
    // install-time snapshot. renderAiderSidecar is the shared source of truth.
    const content = renderAiderSidecar(env(), payload);
    expect(content).toContain("@claude-vps");
    expect(content).toContain(vault);
  });

  test("static sidecar fallback path stays byte-identical (adapter output unchanged)", () => {
    // The wrapper reuses the adapter's snapshot logic (DRY). The adapter's
    // written sidecar must equal the shared renderer's output byte-for-byte.
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    const sidecarPath = join(vault, ".open-second-brain", "aider-context.md");
    expect(existsSync(sidecarPath)).toBe(true);
    const written = readFileSync(sidecarPath, "utf8");
    expect(written).toBe(renderAiderSidecar(env(), payload));
  });

  test("interrupted session (non-zero exit) is captured honestly as interrupted", async () => {
    const { deps, persistInputs } = makeDeps({ exit: { code: 130, signal: null } });
    const result = await bracketAiderSession({ sessionId: "s-int" }, deps);

    expect(result.interrupted).toBe(true);
    expect((persistInputs[0] as { interrupted?: boolean }).interrupted).toBe(true);
    const records = listContinuityRecords(vault, { kind: "pre_compact_extract" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.payload["interrupted"] === true)).toBe(true);
  });

  test("interrupted session (signal) is captured honestly as interrupted", async () => {
    const { deps } = makeDeps({ exit: { code: null, signal: "SIGTERM" } });
    const result = await bracketAiderSession({ sessionId: "s-sig" }, deps);
    expect(result.interrupted).toBe(true);
  });

  test("clean exit persists without an interrupted flag (byte-identical continuity record)", async () => {
    const { deps, persistInputs } = makeDeps({ exit: { code: 0, signal: null } });
    await bracketAiderSession({ sessionId: "s-clean" }, deps);
    expect((persistInputs[0] as { interrupted?: boolean }).interrupted).toBeUndefined();
    const records = listContinuityRecords(vault, { kind: "pre_compact_extract" });
    expect(records.every((r) => r.payload["interrupted"] === undefined)).toBe(true);
  });

  test("an empty transcript persists nothing (no spurious records)", async () => {
    const { deps, log } = makeDeps({ transcript: "   \n  " });
    const result = await bracketAiderSession({ sessionId: "s-empty" }, deps);
    expect(log).toEqual(["load", "spawn"]);
    expect(result.persisted).toBeNull();
    expect(listContinuityRecords(vault, { kind: "pre_compact_extract" }).length).toBe(0);
  });

  test("isInterruptedExit: non-zero code or a signal is interrupted; clean zero is not", () => {
    expect(isInterruptedExit({ code: 0, signal: null })).toBe(false);
    expect(isInterruptedExit({ code: 1, signal: null })).toBe(true);
    expect(isInterruptedExit({ code: null, signal: "SIGINT" })).toBe(true);
    expect(isInterruptedExit({ code: null, signal: null })).toBe(true);
  });
});
