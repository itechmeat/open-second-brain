/**
 * Surfacing-replay bench suite (t_107a3249, lane C).
 *
 * Replays a recorded prompt sequence (a committed session fixture or a
 * vault's own `session_turn` records, both via `replay-fixture.ts`)
 * through the SHIPPED decision core over the disposable fixture vault,
 * and scores every decision with the same
 * {@link scoreProactiveRecall} denominations the proactive-recall suite
 * uses: a silent miss is `know_to_ask`, a spoke-when-nothing-to-say is
 * `false_fire`, and the two rates share one denominator so an
 * always-inject gate can never hide.
 *
 * Scope, stated plainly: this is a FLOOR-CALIBRATION suite. It drives
 * the shipped decision core directly, so the bound it measures is the
 * graded admission key (`surfacing-key.ts`) - sweeping the shipped
 * calibration against a permissive one, via the run's `recallFloor`, is
 * what shows whether that bound discriminates. The gate's STRUCTURAL
 * short-circuits (`duplicate`, `slash_command`, `shell_command`,
 * `empty`) are exercised for recorded prompts: conversion carries each
 * prompt's recorded previous prompt as `previous_prompt`, and the
 * proactive-recall arm runs `evaluateSurfacingGate` ahead of the
 * decision core, exactly as the transports do. See `failure-modes.ts`
 * for what the scorer denominates.
 *
 * Rides the suite registry and the existing phase pipeline unchanged:
 * conversion is a pure ReplayFixture -> BenchFixture whose questions are
 * `proactive_recall`, so checkpoint, resume, per-turn `injected_tokens`
 * and the abstain-costs-zero invariant all come from the one harness.
 */

import { parseBenchFixture } from "./fixture.ts";
import type { BenchFixture, BenchQuestion } from "./types.ts";
import { loadReplayFixture, type ReplayFixture } from "./replay-fixture.ts";

/**
 * Convert a replay fixture into the canonical bench fixture the unchanged
 * `runMemoryBench` consumes: every prompt becomes one `proactive_recall`
 * question carrying its expectation, and the session's notes become the
 * disposable vault the decisions retrieve against. No new category: the
 * pipeline's existing proactive-recall arm drives and scores the run.
 *
 * Empty notes survive conversion, matching the loader's own stance: a
 * recorded session with no ingested notes has nothing to materialize, so
 * its fixture carries the questions alone and the run judges them
 * against an empty vault. Each question carries the recorded previous
 * prompt as `previous_prompt`, so the run's structural gate sees the
 * same context the live hook saw.
 */
export function replayToBenchFixture(replay: ReplayFixture): BenchFixture {
  const questions: BenchQuestion[] = replay.prompts.map((prompt) => ({
    id: prompt.id,
    category: "proactive_recall",
    prompt: prompt.text,
    expect_inject: prompt.expectInject,
    ...(prompt.previousText !== null ? { previous_prompt: prompt.previousText } : {}),
  }));
  // Validate through the canonical parser so a converted fixture is
  // guaranteed to be exactly what runMemoryBench accepts. The empty-notes
  // relaxation is named at the parser, not smuggled past it: a session
  // with no ingested notes is questions-only by construction, and every
  // replay entry point (`parseReplayFixture`, the vault-record
  // conversion) may legitimately produce one.
  return parseBenchFixture(
    {
      name: replay.name,
      ...(replay.description !== undefined ? { description: replay.description } : {}),
      notes: replay.notes.map((note) => ({ path: note.path, body: note.body })),
      continuity: [],
      questions,
    },
    { allowEmptyNotes: true },
  );
}

/** The registry loader: a committed replay fixture file to a BenchFixture. */
export function loadReplayBenchFixture(path: string): BenchFixture {
  return replayToBenchFixture(loadReplayFixture(path));
}
