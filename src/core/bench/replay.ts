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
 * This is the suite that makes the surfacing gate SCOREABLE: the gate's
 * structural half fails open by design, but the graded admission key
 * (`surfacing-key.ts`) is a measured bound, and sweeping it - the
 * shipped calibration against a permissive one, via the run's
 * `recallFloor` - is what measures whether the bound discriminates. See
 * `failure-modes.ts` for the caveat this closes.
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
 */
export function replayToBenchFixture(replay: ReplayFixture): BenchFixture {
  const questions: BenchQuestion[] = replay.prompts.map((prompt) => ({
    id: prompt.id,
    category: "proactive_recall",
    prompt: prompt.text,
    expect_inject: prompt.expectInject,
  }));
  // Validate through the canonical parser so a converted fixture is
  // guaranteed to be exactly what runMemoryBench accepts.
  return parseBenchFixture({
    name: replay.name,
    ...(replay.description !== undefined ? { description: replay.description } : {}),
    notes: replay.notes.map((note) => ({ path: note.path, body: note.body })),
    continuity: [],
    questions,
  });
}

/** The registry loader: a committed replay fixture file to a BenchFixture. */
export function loadReplayBenchFixture(path: string): BenchFixture {
  return replayToBenchFixture(loadReplayFixture(path));
}
