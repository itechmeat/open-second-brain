/**
 * The architecture scan reports while it walks (nothing-runs-unwatched,
 * U11).
 *
 * The walk is the longest thing this module does - measured at 388 ms of
 * a 396 ms run on this repository - and it used to say nothing until the
 * notes were already on disk. What is pinned here is what makes the
 * stream worth having: it starts at the walk, it advances once per
 * directory read, the render stage carries the denominator the walk
 * cannot have, and the run terminates. Plus the two properties that keep
 * the observer honest: a deadline stops the walk at a boundary, and a run
 * with a sink attached writes exactly what a run without one writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";
import { ARCHITECT_STAGE, scanProject } from "../../../src/core/brain/architect/scan.ts";
import {
  OPERATION,
  PROGRESS_KIND,
  PROGRESS_REASON,
  type ProgressEvent,
} from "../../../src/core/brain/progress.ts";
import { createSafeguard, SafeguardTimeoutError } from "../../../src/core/brain/safeguard.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

let tmp: string;
let project: string;

function seed(relPath: string, content = "// x\n"): void {
  const abs = join(project, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function freshVault(name: string): string {
  const vault = join(tmp, name);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  return vault;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-progress-"));
  project = join(tmp, "demo-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  seed("src/core/engine.ts");
  seed("src/core/deep/nested/util.ts");
  seed("src/cli/main.ts");
  seed("tests/engine.test.ts");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A clock that spends a second per reading, so the first checkpoint trips. */
function elapsingClock(): () => number {
  let millis = 0;
  return () => (millis += 1_000);
}

function record(): { events: ProgressEvent[]; sink: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

describe("architect progress", () => {
  test("a run starts at the walk, advances, and finishes", () => {
    const { events, sink } = record();

    generateArchDocs(freshVault("vault"), project, { onProgress: sink });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.operation === OPERATION.architect)).toBe(true);
    expect(events[0]?.kind).toBe(PROGRESS_KIND.started);
    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.finished);
    const started = events.filter((e) => e.kind === PROGRESS_KIND.started).map((e) => e.stage);
    expect(started).toEqual([ARCHITECT_STAGE.walk, ARCHITECT_STAGE.render]);
  });

  test("the walk counts without a denominator, the render stage has one", () => {
    const { events, sink } = record();

    // src/cli, src/core and one nested module: 3 notes, 2 of them modules.
    generateArchDocs(freshVault("vault"), project, { onProgress: sink });

    const walk = events.filter((e) => e.stage === ARCHITECT_STAGE.walk);
    const render = events.filter((e) => e.stage === ARCHITECT_STAGE.render);
    expect(walk.every((e) => e.total === undefined)).toBe(true);
    expect(walk.at(-1)?.completed).toBeGreaterThan(0);
    expect(render.every((e) => e.total === 3)).toBe(true);
    expect(render.at(-1)?.completed).toBe(3);
  });

  test("the scan stops at a boundary when the deadline has passed", () => {
    // A clock that jumps a second per reading: the budget is spent by
    // the FIRST directory read, so the walk stops at that boundary
    // rather than at the end of the tree.
    const safeguard = createSafeguard({
      operation: OPERATION.architect,
      timeoutMs: 10,
      now: elapsingClock(),
    });

    expect(() => scanProject(project, { safeguard })).toThrow(SafeguardTimeoutError);
  });

  test("a deadline that trips reports the stop on the stream and writes nothing", () => {
    const vault = freshVault("vault");
    const before = digestVaultTree(vault);
    const { events, sink } = record();
    const safeguard = createSafeguard({
      operation: OPERATION.architect,
      timeoutMs: 10,
      now: elapsingClock(),
    });

    expect(() => generateArchDocs(vault, project, { onProgress: sink, safeguard })).toThrow(
      SafeguardTimeoutError,
    );
    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.stopped);
    expect(events.at(-1)?.reason).toBe(PROGRESS_REASON.timedOut);
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("attaching an observer changes nothing the run writes", () => {
    const silent = freshVault("vault-silent");
    const watched = freshVault("vault-watched");

    const { events, sink } = record();
    generateArchDocs(silent, project);
    generateArchDocs(watched, project, { onProgress: sink });

    expect(events.length).toBeGreaterThan(0);
    // Whole-tree digests, not spot checks: an observer that changed one
    // byte anywhere in the vault would have to show up here.
    expect(digestVaultTree(watched)).toBe(digestVaultTree(silent));
  });

  test("a sink that throws does not fail the run, and does not vanish either", () => {
    let calls = 0;
    const res = generateArchDocs(freshVault("vault"), project, {
      onProgress: () => {
        calls += 1;
        throw new Error("stream closed");
      },
    });

    expect(res.created).toBeGreaterThan(0);
    // Detached after the first failure: a stream that fails on the first
    // tick would otherwise fail on every one.
    expect(calls).toBe(1);
    expect(res.progressFault).toBe("stream closed");
  });

  test("a scan watched on its own opens the walk and does not close the run", () => {
    // A bare scan is half a run: it reports the walk, and the terminator
    // belongs to whoever also renders. `runIndex` reports its walk the
    // same way, and `runEmbeddingPhase` reports the other half.
    const { events, sink } = record();

    scanProject(project, { onProgress: sink });

    expect(events[0]?.kind).toBe(PROGRESS_KIND.started);
    expect(events[0]?.stage).toBe(ARCHITECT_STAGE.walk);
    expect(events.every((e) => e.stage === ARCHITECT_STAGE.walk)).toBe(true);
    expect(events.some((e) => e.kind === PROGRESS_KIND.advanced)).toBe(true);
    expect(events.some((e) => e.kind === PROGRESS_KIND.finished)).toBe(false);
  });
});
