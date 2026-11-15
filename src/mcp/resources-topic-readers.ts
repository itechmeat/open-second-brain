/**
 * The topic reader of the `osb://` surface (task 3.5): `osb://topic/{id}`
 * answers one topic (design D8) by its id, as the page the human view
 * renders for it.
 *
 * Reach: a caller below local reach folds the `shared` partition alone,
 * so a private topic answers exactly as an absent one, and its existence
 * does not cross. An id the caller sees no topic for falls back to the
 * rule-topic reader (the alias of one minor version), as for any value. A
 * local caller also sees its private topics, which the human view never
 * shows.
 */

import { resolvedTransportReach, TRANSPORT_REACH } from "../core/graph/transport-reach.ts";
import { withPrivateWithheld } from "../core/store/caller-reach.ts";
import { runTopicAction, TopicActionError } from "../core/topics/actions.ts";
import { MIME_MARKDOWN, type ResourceContent, type ResourceContext } from "./resources-shared.ts";

/**
 * The topic page for `id`, or `null` when the caller sees no topic with
 * that id (absent, or private below local reach). Fenced below local
 * reach, as all agent-written stored text is.
 */
export function readTopicById(
  ctx: ResourceContext,
  uri: string,
  id: string,
): ResourceContent | null {
  const remote = resolvedTransportReach(ctx.reach) !== TRANSPORT_REACH.local;
  const configPath = ctx.configPath ?? undefined;
  try {
    const shown = withPrivateWithheld(remote, () =>
      runTopicAction({ action: "show", topic: id }, configPath !== undefined ? { configPath } : {}),
    );
    return { uri, mimeType: MIME_MARKDOWN, text: String(shown["page"]) };
  } catch (err) {
    if (err instanceof TopicActionError) return null;
    throw err;
  }
}
