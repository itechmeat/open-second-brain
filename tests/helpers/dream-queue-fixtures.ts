/**
 * Test helper: fixture operations of the dream work queue over the
 * records of a temp store (task 3.1), registered through the public
 * registry call. `register` returns the removal; call it in `finally`.
 *
 *  - `fixture-closed`: a closed answer, `"yes"` or `"no"`.
 *  - `fixture-text`: a text answer, any non-empty text.
 *
 * Each item's input is controlled per subject through `inputs` (a subject
 * mapped to `null` is gone; an absent subject keeps the item's input).
 * `apply` writes one `fixture-effect` record per item, idempotently: a
 * second call finds the record and writes nothing.
 */
import { appendRecord } from "../../src/core/store/appender.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import {
  registerDreamWorkOperation,
  type DreamWorkContext,
  type DreamWorkOperation,
} from "../../src/core/brain/dream-queue/operations.ts";
import { dreamWorkInputHash } from "../../src/core/brain/dream-queue/records.ts";
import type { DreamWorkItem } from "../../src/core/brain/dream-queue/fold.ts";

export const FIXTURE_CLOSED = "fixture-closed";
export const FIXTURE_TEXT = "fixture-text";
export const FIXTURE_EFFECT_KIND = "fixture-effect";

export interface FixtureOperations {
  /** Subject -> the input it holds now (`null`: the subject is gone). */
  readonly inputs: Map<string, unknown>;
  /** Subjects whose latest input read is temporarily incomplete. */
  readonly unavailable: Set<string>;
  /** How many times `apply` ran, and how many effect records it wrote. */
  readonly calls: { apply: number; writes: number };
  /** Remove both operations from the registry. */
  unregister(): void;
}

function effects(context: DreamWorkContext, item: DreamWorkItem): string[] {
  if (!context.store.partitions.has(item.partition)) return [];
  return readStreamRecords(context.store.root, item.partition, { stream: "events" })
    .records.filter((r) => r.kind === FIXTURE_EFFECT_KIND && r.body["item"] === item.id)
    .map((r) => r.id);
}

export function registerFixtureOperations(
  closedPredecessor: "cancel" | "release" = "cancel",
): FixtureOperations {
  const inputs = new Map<string, unknown>();
  const unavailable = new Set<string>();
  const calls = { apply: 0, writes: 0 };
  const base = (name: string, validate: DreamWorkOperation["validate"]): DreamWorkOperation => ({
    name,
    closedPredecessor,
    validate,
    currentInput: (item) => {
      if (unavailable.has(item.body.subject)) {
        return { unavailable: true, input_hash: item.body.input_hash };
      }
      if (!inputs.has(item.body.subject)) return { input_hash: item.body.input_hash };
      const now = inputs.get(item.body.subject);
      return now === null ? null : { input_hash: dreamWorkInputHash(now), payload: { now } };
    },
    apply: (item, _answer, context) => {
      calls.apply += 1;
      const existing = effects(context, item);
      if (existing.length > 0) return existing;
      calls.writes += 1;
      return [
        appendRecord(context.store, {
          partition: item.partition,
          stream: "events",
          kind: FIXTURE_EFFECT_KIND,
          agent: "fixture",
          body: { item: item.id },
        }).record.id,
      ];
    },
  });
  const removals = [
    registerDreamWorkOperation(
      base(FIXTURE_CLOSED, (answer) =>
        answer.value === "yes" || answer.value === "no" ? null : "the value must be yes or no",
      ),
    ),
    registerDreamWorkOperation(
      base(FIXTURE_TEXT, (answer) =>
        typeof answer.text === "string" && answer.text.trim() !== "" ? null : "the text is empty",
      ),
    ),
  ];
  return {
    inputs,
    unavailable,
    calls,
    unregister: () => {
      for (const remove of removals) remove();
    },
  };
}
