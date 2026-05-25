/**
 * Task 1: Temporal atoms + config block.
 *
 * Asserts the atom layer of `src/core/brain/temporal/`:
 *   - `BRAIN_TEMPORAL_DEFAULTS` exposes the five documented slots.
 *   - `resolveTemporal(cfg)` returns a fully-populated struct.
 *   - The `temporal:` config block parses, validates, and supplies
 *     forward-compat warnings for unknown sub-keys.
 *   - `TemporalEvent` and `TimelineIndex` are exported from the
 *     subsystem entry point.
 */

import { describe, expect, test } from "bun:test";

import {
  BrainConfigError,
  parseBrainYaml,
  validateBrainConfigDetailed,
} from "../../../../src/core/brain/policy.ts";
import {
  BRAIN_TEMPORAL_DEFAULTS,
  resolveTemporal,
} from "../../../../src/core/brain/policy.ts";
import type {
  TemporalEvent,
  TimelineIndex,
} from "../../../../src/core/brain/temporal/types.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("BRAIN_TEMPORAL_DEFAULTS", () => {
  test("documents the five threshold defaults", () => {
    expect(BRAIN_TEMPORAL_DEFAULTS.stale_pref_days).toBe(90);
    expect(BRAIN_TEMPORAL_DEFAULTS.stale_signal_days).toBe(30);
    expect(BRAIN_TEMPORAL_DEFAULTS.stale_log_days).toBe(180);
    expect(BRAIN_TEMPORAL_DEFAULTS.weekly_start_dow).toBe(1);
    expect(BRAIN_TEMPORAL_DEFAULTS.daily_window_offset_hours).toBe(0);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(BRAIN_TEMPORAL_DEFAULTS)).toBe(true);
  });
});

describe("temporal config block", () => {
  test("absent block - cfg.temporal undefined; resolveTemporal returns defaults", () => {
    const { config } = validate(HEAD);
    expect(config.temporal).toBeUndefined();
    expect(resolveTemporal(config)).toEqual(BRAIN_TEMPORAL_DEFAULTS);
  });

  test("present with all five fields - loaded fully", () => {
    const { config } = validate(
      HEAD +
        `temporal:\n` +
        `  stale_pref_days: 45\n` +
        `  stale_signal_days: 14\n` +
        `  stale_log_days: 365\n` +
        `  weekly_start_dow: 7\n` +
        `  daily_window_offset_hours: -3\n`,
    );
    expect(config.temporal).toEqual({
      stale_pref_days: 45,
      stale_signal_days: 14,
      stale_log_days: 365,
      weekly_start_dow: 7,
      daily_window_offset_hours: -3,
    });
    expect(resolveTemporal(config).weekly_start_dow).toBe(7);
  });

  test("partial block - missing fields fall back to defaults", () => {
    const { config } = validate(
      HEAD + `temporal:\n  stale_pref_days: 60\n`,
    );
    expect(config.temporal?.stale_pref_days).toBe(60);
    const resolved = resolveTemporal(config);
    expect(resolved.stale_pref_days).toBe(60);
    expect(resolved.stale_signal_days).toBe(
      BRAIN_TEMPORAL_DEFAULTS.stale_signal_days,
    );
    expect(resolved.weekly_start_dow).toBe(
      BRAIN_TEMPORAL_DEFAULTS.weekly_start_dow,
    );
  });

  test("stale_pref_days: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  stale_pref_days: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("stale_pref_days: negative rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  stale_pref_days: -1\n`),
    ).toThrow(BrainConfigError);
  });

  test("stale_pref_days: non-integer rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  stale_pref_days: 2.5\n`),
    ).toThrow(BrainConfigError);
  });

  test("stale_signal_days: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  stale_signal_days: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("stale_log_days: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  stale_log_days: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("weekly_start_dow: 0 rejected (must be 1..7 ISO-8601)", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  weekly_start_dow: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("weekly_start_dow: 8 rejected (must be 1..7 ISO-8601)", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  weekly_start_dow: 8\n`),
    ).toThrow(BrainConfigError);
  });

  test("weekly_start_dow: non-integer rejected", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  weekly_start_dow: 3.5\n`),
    ).toThrow(BrainConfigError);
  });

  test("daily_window_offset_hours: -23 accepted (lower bound)", () => {
    const { config } = validate(
      HEAD + `temporal:\n  daily_window_offset_hours: -23\n`,
    );
    expect(config.temporal?.daily_window_offset_hours).toBe(-23);
  });

  test("daily_window_offset_hours: 23 accepted (upper bound)", () => {
    const { config } = validate(
      HEAD + `temporal:\n  daily_window_offset_hours: 23\n`,
    );
    expect(config.temporal?.daily_window_offset_hours).toBe(23);
  });

  test("daily_window_offset_hours: -24 rejected (out of range)", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  daily_window_offset_hours: -24\n`),
    ).toThrow(BrainConfigError);
  });

  test("daily_window_offset_hours: 24 rejected (out of range)", () => {
    expect(() =>
      validate(HEAD + `temporal:\n  daily_window_offset_hours: 24\n`),
    ).toThrow(BrainConfigError);
  });

  test("non-object temporal block rejected", () => {
    expect(() => validate(HEAD + `temporal: "nope"\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("unknown sub-key warns but does not throw", () => {
    const { config, warnings } = validate(
      HEAD +
        `temporal:\n  stale_pref_days: 90\n  unknown_slot: 7\n`,
    );
    expect(config.temporal?.stale_pref_days).toBe(90);
    expect(
      warnings.some((w) =>
        w.message.includes("temporal.unknown_slot"),
      ),
    ).toBe(true);
  });
});

describe("TemporalEvent + TimelineIndex shapes", () => {
  test("TemporalEvent type is exported with the expected slot set", () => {
    // Compile-time check via assignment. The shape must accept the
    // documented superset of optional slots without TS errors.
    const ev: TemporalEvent = Object.freeze({
      at: "2026-05-25T10:00:00Z",
      kind: "feedback",
      source: Object.freeze({
        path: "Brain/log/2026-05-25.jsonl",
        line: 1,
      }),
      prefId: "pref-foo",
      topic: "foo",
      result: "applied",
      artifact: "src/cli/main.ts",
      transitionFrom: "unconfirmed",
      transitionTo: "confirmed",
      reason: "promoted by dream",
      text: "release shipped",
      validFrom: "2026-05-01T00:00:00Z",
      validUntil: "2026-06-01T00:00:00Z",
      recordedAt: "2026-05-25T10:00:00Z",
    });
    expect(ev.kind).toBe("feedback");
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test("TimelineIndex type is exported with the expected slot set", () => {
    const idx: TimelineIndex = Object.freeze({
      events: Object.freeze([] as ReadonlyArray<TemporalEvent>),
      eventsByKind: Object.freeze({}),
      eventsByPrefId: Object.freeze({}),
      eventsByTopic: Object.freeze({}),
      window: Object.freeze({
        since: "1970-01-01T00:00:00Z",
        until: "2026-05-25T23:59:59Z",
      }),
    });
    expect(idx.events.length).toBe(0);
    expect(idx.window.since).toBe("1970-01-01T00:00:00Z");
    expect(Object.isFrozen(idx)).toBe(true);
  });
});
