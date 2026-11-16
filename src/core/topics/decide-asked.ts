/**
 * The decide pass's "asked" set (design D20): the subjects whose answer
 * wrote nothing, so the next pass does not ask them again and the
 * records behind them get their turn.
 *
 * Only `human_readable` has a stored verdict for an answer that changes
 * nothing (a kept note). A routine kind, a `none` route or resolution, a
 * milestone that is not done and every answer below its threshold leave
 * no trace in the store, and the store's format stays as it is: this
 * set is device-local, beside the store's other device-local state
 * (`<state>/open-second-brain/stores/<store id>/decide-asked.json`), and
 * only the view writer's machine runs the pass. An entry is keyed by the
 * use, the subject, the use's question version, the answering model and
 * the mode the answer came in: a new question text or another model asks
 * again, and an answer given in `shadow` is asked again once the use is
 * in `enforce`, so it can act. An answer that acts is not entered - its
 * record settles the subject, and a write that did not land (a raced
 * plan) is asked again. The one answer that acts without a record, an
 * enforce `none` route (it keeps the record free for grouping on the pass
 * it is given), is entered with its verdict, which later passes apply
 * again without asking. Entries whose subject left the pass's window
 * (eight weeks) are pruned on load. The set is saved when the pass ends,
 * a failed pass included. Best-effort: an unreadable file is
 * an empty set and a failed save asks again next pass; two passes that
 * save at once can lose entries, which only repeats a question.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedDecisionModelConfig } from "../decision-model/config-types.ts";
import { decisionModelModeFor } from "../decision-model/config.ts";
import type { DecisionModelUse } from "../decision-model/contract.ts";
import { resolvedProviderEntries } from "../decision-model/provider-entries.ts";
import { TOPIC_USE_QUESTION_VERSION, type TopicUse } from "../decision-model/questions-topics.ts";
import { atomicWriteText } from "../fs-atomic.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { TopicVerdictBody } from "./verdicts.ts";

/** The file name of the set in the store's device-local directory. */
export const DECIDE_ASKED_FILE = "decide-asked.json";

/** One entry: the subject's time (for pruning) and, for an acting answer, its verdict. */
interface AskedEntry {
  readonly at: number;
  readonly verdict?: TopicVerdictBody;
}

export interface AskedSet {
  /** Whether `use` asked about `subject` under its current question version, a model of the chain and its mode. */
  has(use: TopicUse, subject: string): boolean;
  /** The verdict stored with the entry {@link has} finds, when it has one. */
  verdict(use: TopicUse, subject: string): TopicVerdictBody | undefined;
  /** Enter an answer that wrote nothing; `at` is the subject's time, for pruning. */
  add(
    use: TopicUse,
    subject: string,
    answered: { readonly model: string | null; readonly mode: string },
    at: number,
    verdict?: TopicVerdictBody,
  ): void;
  /** Write the set back when it changed. Never throws. */
  save(): void;
}

function keyOf(use: string, subject: string, version: number, model: string, mode: string): string {
  return JSON.stringify([use, subject, version, model, mode]);
}

/** The set for `store`, pruned to entries newer than `oldestAt`. */
export function loadAskedSet(
  store: StoreHandle,
  cfg: ResolvedDecisionModelConfig,
  oldestAt: number,
): AskedSet {
  const path = join(store.deviceStateDir, DECIDE_ASKED_FILE);
  const entries = new Map<string, AskedEntry>();
  let changed = false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { asked?: unknown };
    const asked = parsed.asked;
    if (typeof asked === "object" && asked !== null) {
      for (const [key, raw] of Object.entries(asked as Record<string, unknown>)) {
        const entry = raw as Partial<AskedEntry> | null;
        const at = entry?.at;
        if (typeof at !== "number" || !Number.isFinite(at)) continue;
        if (at < oldestAt) {
          changed = true;
          continue;
        }
        entries.set(key, {
          at,
          ...(typeof entry?.verdict === "object" && entry.verdict !== null
            ? { verdict: entry.verdict }
            : {}),
        });
      }
    }
  } catch {
    // No file yet, or an unreadable one: an empty set.
  }
  const models = resolvedProviderEntries(cfg).map((entry) => entry.model ?? "");
  const find = (use: TopicUse, subject: string): AskedEntry | undefined => {
    const mode = decisionModelModeFor(cfg, use as DecisionModelUse);
    const version = TOPIC_USE_QUESTION_VERSION[use];
    for (const model of models) {
      const entry = entries.get(keyOf(use, subject, version, model, mode));
      if (entry !== undefined) return entry;
    }
    return undefined;
  };
  return {
    has: (use, subject) => find(use, subject) !== undefined,
    verdict: (use, subject) => find(use, subject)?.verdict,
    add(use, subject, answered, at, verdict) {
      const key = keyOf(
        use,
        subject,
        TOPIC_USE_QUESTION_VERSION[use],
        answered.model ?? "",
        answered.mode,
      );
      entries.set(key, { at, ...(verdict !== undefined ? { verdict } : {}) });
      changed = true;
    },
    save() {
      if (!changed) return;
      try {
        mkdirSync(store.deviceStateDir, { recursive: true });
        const asked = Object.fromEntries(entries);
        atomicWriteText(path, `${JSON.stringify({ v: 1, asked })}\n`);
        changed = false;
      } catch {
        // Best-effort: the next pass asks again.
      }
    },
  };
}
