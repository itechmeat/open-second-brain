/**
 * The rule a feedback call would meet, judged below local reach (change
 * `lane-private-partition-reach`, the write rule).
 *
 * A feedback call writes a signal, a log line and, when forced, a confirmed
 * rule under the topic's slug. A rule held in `private` under that slug (or
 * under the slug an older release gave the topic) refuses the call with the
 * fixed answer before the first of those writes.
 */

import { existsSync } from "node:fs";

import { preferencePathOf } from "../../core/brain/paths.ts";
import { isPrivatePageFile } from "../../core/store/private-page.ts";
import {
  judgesFromStore,
  storePreferenceIdIsKnownPrivate,
} from "../../core/store/store-privacy.ts";

/**
 * Whether the rule at `slug` is held in `private`: by the store's fold on a
 * store-only machine, by the rule page's own marker on an unswitched one
 * (where a rule with no page is no rule).
 */
export function preferenceSlugHeldInPrivate(
  vault: string | null,
  slug: string,
  configPath?: string,
): boolean {
  if (vault === null || judgesFromStore(vault, configPath)) {
    return storePreferenceIdIsKnownPrivate(`pref-${slug}`, configPath);
  }
  const path = preferencePathOf(vault, slug);
  return existsSync(path) && isPrivatePageFile(path);
}
