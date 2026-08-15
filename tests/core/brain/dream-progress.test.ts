/**
 * A consolidation pass reports while it runs (nothing-runs-unwatched, U1).
 *
 * Before this, `dream` produced its first observable output after it had
 * already finished, so a caller could not tell a slow pass from a hung
 * one. The properties pinned here are the ones that make the stream worth
 * having: it starts, it advances, it terminates, and a run that changed
 * nothing terminates too - an idempotent rerun is the common case, and an
 * unterminated stream would make it look like a pass that died in
 * planning.
 *
 * The last test is the load-bearing one for the rest of the release: a
 * pass with no sink attached must be byte-identical to the previous
 * release. Absence of an observer is not a feature flag.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  PROGRESS_KIND,
  PROGRESS_REASON,
  type ProgressEvent,
} from "../../../src/core/brain/progress.ts";
import {
  createSafeguard,
  OPERATION,
  SafeguardAbortError,
} from "../../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { digestVaultFiles, digestVaultTree } from "../../helpers/vault-digest.ts";

let vault: string;
let configHome: string;
let configPath: string;

const NOW = new Date("2026-05-23T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-progress-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-progress-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Three same-sign signals on one topic: enough to plan a promotion. */
function seedPromotion(topic = "progress-topic"): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Prefer the ${topic} approach`,
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

function record(): { events: ProgressEvent[]; sink: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

describe("dream progress", () => {
  test("a changing run starts, advances through its stages, and finishes", () => {
    seedPromotion();
    const { events, sink } = record();

    dream(vault, { now: NOW, onProgress: sink });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.operation === OPERATION.dream)).toBe(true);
    expect(events[0]?.kind).toBe(PROGRESS_KIND.started);
    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.finished);

    // Every stage the pass declares must actually be entered, in order,
    // or the stream is describing a pass that did not happen.
    const started = events.filter((e) => e.kind === PROGRESS_KIND.started).map((e) => e.stage);
    expect(started).toEqual(["scan", "plan", "apply", "log", "finalize"]);
  });

  test("a no-op rerun still terminates its stream", () => {
    seedPromotion();
    dream(vault, { now: NOW });

    const { events, sink } = record();
    dream(vault, { now: NOW, onProgress: sink });

    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.finished);
  });

  test("a dry run reports progress and still writes nothing", () => {
    seedPromotion();
    const before = digestVaultTree(vault);

    const { events, sink } = record();
    dream(vault, { now: NOW, dryRun: true, onProgress: sink });

    expect(events.at(-1)?.kind).toBe(PROGRESS_KIND.finished);
    expect(digestVaultTree(vault)).toEqual(before);
  });

  test("attaching an observer changes nothing the pass writes", () => {
    // Compared against a COPY of the same seeded vault rather than a
    // second bootstrap: a freshly bootstrapped vault carries its own
    // identity and its own root path inside `Brain/vault-id.json` and
    // `Brain/_BRAIN.md`, so two independent vaults differ before either
    // pass runs. The copy makes the comparison legitimate - identical
    // bytes in, so any difference out belongs to the observer.
    seedPromotion();
    const observed = mkdtempSync(join(tmpdir(), "o2b-dream-progress-b-"));
    try {
      cpSync(vault, observed, { recursive: true });

      const silent = dream(vault, { now: NOW });
      const { events, sink } = record();
      const watched = dream(observed, { now: NOW, onProgress: sink });

      expect(events.length).toBeGreaterThan(0);
      expect(watched.changed).toBe(silent.changed);
      // Two exclusions, each for a reason that predates this unit and is
      // not about the observer:
      //   - the pre-run archive is a tar, and a tar carries the mtimes of
      //     the tree it was taken from, which the harness wrote at two
      //     different instants;
      //   - the workrun journal stamps `new Date().toISOString()` per
      //     line even when the caller injected a clock, because it is
      //     forensic evidence of when the pass really ran.
      // Everything else the pass authored is compared.
      const EXCLUDED_PREFIXES = ["Brain/.snapshots/", "Brain/log/dream-runs/"];
      const authored = (root: string): Map<string, string> => {
        const kept = new Map<string, string>();
        for (const [path, digest] of digestVaultFiles(root)) {
          if (!EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) kept.set(path, digest);
        }
        return kept;
      };
      expect(authored(observed)).toEqual(authored(vault));
    } finally {
      rmSync(observed, { recursive: true, force: true });
    }
  });

  test("a pre-aborted signal stops the pass and says so on the stream", () => {
    // SafeguardAbortError was unreachable in production before this
    // release: the class, the signal field and the abort-beats-deadline
    // priority were all written, and no call site passed a signal. This
    // is the test that proves the wiring, and it does it without racing a
    // real interrupt against a sub-second pass.
    seedPromotion();
    const controller = new AbortController();
    controller.abort();
    const { events, sink } = record();

    expect(() =>
      dream(vault, {
        now: NOW,
        onProgress: sink,
        safeguard: createSafeguard({ operation: OPERATION.dream, signal: controller.signal }),
      }),
    ).toThrow(SafeguardAbortError);

    // The stream must end with a stop, not simply end: a caller cannot
    // otherwise tell a cancelled pass from a crashed or hung one.
    expect(events.at(-1)).toMatchObject({
      kind: PROGRESS_KIND.stopped,
      reason: PROGRESS_REASON.aborted,
    });
  });

  test("a sink that throws does not fail the pass, and does not vanish either", () => {
    seedPromotion();
    let calls = 0;
    const summary = dream(vault, {
      now: NOW,
      onProgress: () => {
        calls += 1;
        throw new Error("stream closed");
      },
    });
    expect(summary.changed).toBe(true);
    // Detached after the first failure: a stream that fails on the first
    // tick would otherwise fail on every one.
    expect(calls).toBe(1);
    expect(summary.warnings.map((w) => w.code)).toContain("progress-sink-failed");
  });
});
