/**
 * Per-row event-time on batch remember/import (A2 / t_7526e8d3).
 *
 * Backfilling an old session log used to stamp every derived signal with
 * the import wall-clock, corrupting recency-based reconciliation. This
 * suite locks the historically-faithful behaviour:
 *
 *   - With `preserveEventTime`, each signal carries its turn's ORIGINAL
 *     timestamp in `created_at` / `recorded_at` / `valid_from`.
 *   - A turn with no / unparseable / future-dated timestamp falls back to
 *     `now` deterministically (never mints a future-dated or epoch signal).
 *   - Without the flag, output is byte-identical to the wall-clock path.
 *
 * It also exercises the additive `WriteSignalInput` bi-temporal slots that
 * the read-side (`readBiTemporal`) already parses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import {
  parseSignal,
  writeSignal,
  type WriteSignalInput,
} from "../../../../src/core/brain/signal.ts";
import { isoSecond } from "../../../../src/core/brain/time.ts";
import type { BrainSignal } from "../../../../src/core/brain/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-event-time-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a one-turn claude-format session with an `@osb` marker. */
function claudeSession(opts: { topic: string; principle: string; timestamp?: string }): string {
  const line: Record<string, unknown> = {
    parentUuid: null,
    sessionId: "s",
    entrypoint: "sdk-cli",
    type: "user",
    message: {
      role: "user",
      content: `@osb feedback positive topic=${opts.topic} principle="${opts.principle}"`,
    },
    uuid: "u1",
  };
  if (opts.timestamp !== undefined) line["timestamp"] = opts.timestamp;
  return JSON.stringify(line) + "\n";
}

function writeFixture(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

/** Parse the single signal the import produced. */
function onlySignal(vault: string): { sig: BrainSignal; file: string } {
  const inbox = brainDirs(vault).inbox;
  const files = readdirSync(inbox).filter((n) => n.startsWith("sig-") && n.endsWith(".md"));
  expect(files.length).toBe(1);
  const file = files[0]!;
  return { sig: parseSignal(join(inbox, file)), file };
}

const NOW = new Date("2026-07-07T12:00:00Z");

describe("importSession — per-row event-time (preserveEventTime)", () => {
  test("backfills created_at/recorded_at/valid_from with the turn's ORIGINAL timestamp", async () => {
    const fixture = writeFixture(
      "old.jsonl",
      claudeSession({
        topic: "evttime",
        principle: "stamp the original event time",
        timestamp: "2020-03-15T08:30:00Z",
      }),
    );

    const res = await importSession(tmp, fixture, {
      agent: "test",
      now: NOW,
      preserveEventTime: true,
    });
    expect(res.signals_created).toBe(1);

    const { sig, file } = onlySignal(tmp);
    expect(sig.created_at).toBe("2020-03-15T08:30:00Z");
    expect(sig.recorded_at).toBe("2020-03-15T08:30:00Z");
    expect(sig.valid_from).toBe("2020-03-15T08:30:00Z");
    // The filename calendar day reflects the event, not the import moment.
    expect(file.startsWith("sig-2020-03-15")).toBe(true);
  });

  test("a turn with NO timestamp falls back to now (backward-compatible)", async () => {
    const fixture = writeFixture(
      "no-ts.jsonl",
      claudeSession({ topic: "evttime", principle: "fall back to now when absent" }),
    );

    const res = await importSession(tmp, fixture, {
      agent: "test",
      now: NOW,
      preserveEventTime: true,
    });
    expect(res.signals_created).toBe(1);

    const { sig } = onlySignal(tmp);
    expect(sig.created_at).toBe(isoSecond(NOW));
    expect(sig.recorded_at).toBeUndefined();
    expect(sig.valid_from).toBeUndefined();
  });

  test("a FUTURE-dated turn timestamp falls back to now (never mints a future signal)", async () => {
    const fixture = writeFixture(
      "future.jsonl",
      claudeSession({
        topic: "evttime",
        principle: "clamp future dated turns",
        timestamp: "2099-01-01T00:00:00Z",
      }),
    );

    const res = await importSession(tmp, fixture, {
      agent: "test",
      now: NOW,
      preserveEventTime: true,
    });
    expect(res.signals_created).toBe(1);

    const { sig } = onlySignal(tmp);
    expect(sig.created_at).toBe(isoSecond(NOW));
    expect(sig.recorded_at).toBeUndefined();
    expect(sig.valid_from).toBeUndefined();
  });

  test("an UNPARSEABLE turn timestamp falls back to now (no throw)", async () => {
    const fixture = writeFixture(
      "bad-ts.jsonl",
      claudeSession({
        topic: "evttime",
        principle: "fall back to now when unparseable",
        timestamp: "not-a-timestamp",
      }),
    );

    const res = await importSession(tmp, fixture, {
      agent: "test",
      now: NOW,
      preserveEventTime: true,
    });
    expect(res.signals_created).toBe(1);

    const { sig } = onlySignal(tmp);
    expect(sig.created_at).toBe(isoSecond(NOW));
    expect(sig.recorded_at).toBeUndefined();
    expect(sig.valid_from).toBeUndefined();
  });

  test("without preserveEventTime, the wall-clock path is byte-identical (no event-time fields)", async () => {
    const fixture = writeFixture(
      "default.jsonl",
      claudeSession({
        topic: "evttime",
        principle: "ignore turn time by default",
        timestamp: "2020-03-15T08:30:00Z",
      }),
    );

    const res = await importSession(tmp, fixture, { agent: "test", now: NOW });
    expect(res.signals_created).toBe(1);

    const { sig } = onlySignal(tmp);
    // The old turn time is ignored entirely — stamped with the import clock.
    expect(sig.created_at).toBe(isoSecond(NOW));
    expect(sig.recorded_at).toBeUndefined();
    expect(sig.valid_from).toBeUndefined();
  });
});

describe("writeSignal — additive bi-temporal event-time slots", () => {
  const base: WriteSignalInput = {
    topic: "evttime",
    signal: "positive",
    agent: "test",
    principle: "carry the original event time",
    created_at: "2020-03-15T08:30:00Z",
    date: "2020-03-15",
    slug: "evttime",
  };

  test("valid_from + recorded_at flow into frontmatter the read-side parses", () => {
    const { path } = writeSignal(tmp, {
      ...base,
      valid_from: "2020-03-15T08:30:00Z",
      recorded_at: "2020-03-15T08:30:00Z",
    });
    const sig = parseSignal(path);
    expect(sig.valid_from).toBe("2020-03-15T08:30:00Z");
    expect(sig.recorded_at).toBe("2020-03-15T08:30:00Z");
  });

  test("absent slots leave the file free of event-time keys (byte-identity guard)", () => {
    const { path } = writeSignal(tmp, base);
    const sig = parseSignal(path);
    expect(sig.valid_from).toBeUndefined();
    expect(sig.recorded_at).toBeUndefined();
  });
});
