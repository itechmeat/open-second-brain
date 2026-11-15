/**
 * What the brief and the digest ask the user about topics (spec `topics`
 * "Quiet topic", "Two topics look the same"; task 3.4): the merge
 * proposals and the quiet topics of the configured store, read for the
 * caller of the work running now (a caller below local reach is asked
 * only about shared topics), and their Markdown section. Nothing is
 * written: a proposal is applied only when the user confirms it with the
 * topic tool.
 */

import { SETTING_TOPIC_QUIET_DAYS } from "../store/constants.ts";
import { settingValue } from "../store/fold-settings.ts";
import { sharedSettingsOf } from "./settings.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { reviewTopics, type TopicReview } from "./plan.ts";
import { readTopicsOf } from "./read.ts";
import type { TopicFold } from "./fold.ts";
import { plainText } from "../view/pages.ts";

export interface TopicReviewRead {
  readonly review: TopicReview;
  readonly fold: TopicFold;
}

/** The review of the store the machine config at `configPath` names; `null` without one. */
export function readTopicReview(nowMs: number, configPath?: string): TopicReviewRead | null {
  const store = configuredStore(configPath);
  if (store === null || !store.partitions.has("shared")) return null;
  const { fold, unreadable } = readTopicsOf(store);
  // A fold over a partial read may miss topics: nothing is asked from it.
  if (unreadable.length > 0) return null;
  const quietDays = settingValue(sharedSettingsOf(store), SETTING_TOPIC_QUIET_DAYS) as number;
  return { review: reviewTopics(fold, nowMs, quietDays), fold };
}

/** The `## Topics` section of a digest or brief; empty when there is nothing to ask. */
export function renderTopicReview(read: TopicReviewRead | null): string {
  if (read === null) return "";
  const { review, fold } = read;
  if (review.merges.length === 0 && review.quiet.length === 0) return "";
  // One line per title: a title is caller text and must not open a new block.
  const title = (id: string): string => plainText(fold.topics.get(id)?.title ?? id);
  const lines = ["## Topics", ""];
  for (const merge of review.merges) {
    const [a, b] = merge.topics;
    lines.push(
      `- These topics look like one: "${title(a)}" and "${title(b)}". To merge them: ` +
        `\`o2b topic merge ${b} --into ${a}\`.`,
    );
  }
  for (const quiet of review.quiet) {
    lines.push(
      `- "${title(quiet.topic)}" has had no news for ${quiet.days} days. Keep it, put it on hold, ` +
        `mark it done or close it: \`o2b topic status ${quiet.topic} <active|on-hold|done|closed>\`.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
