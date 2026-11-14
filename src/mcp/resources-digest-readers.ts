/**
 * The compiled-digest readers of the `osb://` surface (task 3.19): the
 * active preferences, the lessons, the latest digest and the status
 * projection, with the status renderer and the vault-relative paths of
 * the two generated files the delivery binding names. Split from
 * `resources.ts`; dispatch happens through that module's `readResource`.
 */

import { existsSync } from "node:fs";
import {
  activeDigestPathForRead,
  readActiveForReader,
  regenerateActive,
} from "../core/brain/active.ts";
import {
  lessonsDigestPathForRead,
  regenerateLessons,
  renderLessonsForReader,
} from "../core/brain/lessons.ts";
import { renderDigest } from "../core/brain/digest.ts";
import {
  computeBrainStatus,
  MAINTENANCE_DEBT_STATUS,
  type BrainStatusSnapshot,
} from "../core/brain/status.ts";
import { BRAIN_ACTIVE_FILE, BRAIN_LESSONS_FILE, BRAIN_ROOT_REL } from "../core/brain/paths.ts";
import { TRANSPORT_REACH, resolvedTransportReach } from "../core/graph/transport-reach.ts";
import { INTERNAL_ERROR, MCPError } from "./protocol.ts";
import type { RequestView, ResourceContent, ResourceContext } from "./resources-shared.ts";
import { MIME_MARKDOWN, deliveryFor, readMarkdown } from "./resources-shared.ts";

/**
 * Vault-relative paths of the two generated digest files, the probes the
 * delivery binding names when one of them is what a reader delivers
 * (delivery-trust, lane A). The files are the system's own render, so
 * the derivation reads THEIR absence of stamps rather than guessing.
 */
export const ACTIVE_REL = `${BRAIN_ROOT_REL}/${BRAIN_ACTIVE_FILE}`;
export const LESSONS_REL = `${BRAIN_ROOT_REL}/${BRAIN_LESSONS_FILE}`;

export function readActive(ctx: ResourceContext, uri: string, view: RequestView): ResourceContent {
  // On a store-only machine the digest is rendered on demand into the
  // device-local cache (D14 item 7); a render failure is reported below.
  let path: string;
  try {
    path = activeDigestPathForRead(ctx.vault);
  } catch (err) {
    throw new MCPError(INTERNAL_ERROR, `active digest render failed: ${(err as Error).message}`);
  }
  // First read attempt: the file usually exists because dream
  // regenerates it. On a fresh vault that has never been dreamed, the
  // file may not exist yet — generate it on demand so the resource is
  // always meaningful. We do NOT auto-generate on every read (that
  // would shift expensive work onto a hot path); only on the first
  // read of a missing file.
  if (!existsSync(path)) {
    try {
      regenerateActive(ctx.vault);
    } catch (err) {
      throw new MCPError(
        INTERNAL_ERROR,
        `active-preferences digest not present and on-demand regeneration failed: ${(err as Error).message}`,
      );
    }
  }
  // The shared file is served as it is to a local reader with no owner
  // scope; any other reader gets the in-memory render, stamped with the
  // generation on disk (see `readActiveForReader`).
  const text = readActiveForReader(ctx.vault, {
    ...(view.refs.filtersNothing ? {} : { readable: view.refs.visible }),
    ...(view.ownerScope !== null ? { agentScope: view.ownerScope } : {}),
    restricted: view.reach !== TRANSPORT_REACH.local,
  });
  return {
    uri,
    mimeType: MIME_MARKDOWN,
    // The digest quotes stored principles (delivery-trust, lane A): the
    // delivery is fenced at remote reach, named for the generated file's
    // own absence of stamps - the system's render is not operator prose,
    // and the derivation says so rather than guessing authorship.
    text: deliveryFor(ctx, view).shape(text, ACTIVE_REL),
  };
}

export function readLessons(ctx: ResourceContext, uri: string, view: RequestView): ResourceContent {
  let path: string;
  try {
    path = lessonsDigestPathForRead(ctx.vault);
  } catch (err) {
    throw new MCPError(INTERNAL_ERROR, `lessons digest render failed: ${(err as Error).message}`);
  }
  // Same on-demand-on-first-miss policy as readActive: a fresh vault
  // that has never been dreamed has no lessons.md yet — generate it
  // once so the resource is always meaningful, but never on every read.
  if (!existsSync(path)) {
    try {
      regenerateLessons(ctx.vault);
    } catch (err) {
      throw new MCPError(
        INTERNAL_ERROR,
        `lessons digest not present and on-demand regeneration failed: ${(err as Error).message}`,
      );
    }
  }
  // A local reader with no owner scope is served the shared file as it
  // is; any other reader gets the digest rendered without the records it
  // cannot see, scored and stamped at the generation on disk. Either way
  // the delivered markdown is the lessons corpus quoting stored
  // principles (delivery-trust, lane A): fenced at remote reach, named
  // for the generated file's own absence of stamps.
  const delivery = deliveryFor(ctx, view);
  const text = view.refs.filtersNothing
    ? readMarkdown(uri, path).text
    : renderLessonsForReader(ctx.vault, {
        readable: view.refs.visible,
        ...(view.refs.withholdsPrivate === true ? { withholdsPrivate: true } : {}),
      }).document;
  return { uri, mimeType: MIME_MARKDOWN, text: delivery.shape(text, LESSONS_REL) };
}

export function readDigestLatest(
  ctx: ResourceContext,
  uri: string,
  view: RequestView,
): ResourceContent {
  const rendered = renderDigest(ctx.vault, {
    format: "markdown",
    ...(view.refs.filtersNothing ? {} : { readable: view.refs.visible }),
    ...(view.refs.withholdsPrivate === true ? { withholdsPrivate: true } : {}),
    // Ownership is pushed into the render's SELECTION as well as its
    // row filter, the way `readActive` does: `view.refs` already
    // carries the rule on the filter side, and the digest's
    // vault-wide sections (the maintenance actions) are scoped by the
    // render itself rather than by which rows an id happens to name.
    ...(view.ownerScope !== null ? { agentScope: view.ownerScope } : {}),
  });
  return {
    uri,
    mimeType: MIME_MARKDOWN,
    // The digest quotes stored principles (delivery-trust, lane A) in the
    // same render family as the active and lessons digests, so it shapes
    // through the same binding: fenced at remote reach, named for the
    // compiled-digest render's own absence of stamps - the system's voice
    // is not operator prose, and the derivation says so rather than
    // guessing authorship. The probe rel names that family's on-disk
    // member (BRAIN_COMPILED_DIGEST_RELS), whose generated page carries
    // no stamps, the exact probe readActive's render makes.
    text: deliveryFor(ctx, view).shape(rendered.content, ACTIVE_REL),
  };
}

export function readStatus(ctx: ResourceContext, uri: string): ResourceContent {
  const snapshot = computeBrainStatus(ctx.vault, {
    withholdsPrivate: resolvedTransportReach(ctx.reach) !== TRANSPORT_REACH.local,
  });
  return {
    uri,
    mimeType: MIME_MARKDOWN,
    text: renderStatusMarkdown(snapshot),
  };
}

/**
 * Render the topic-query result as a compact markdown document. Kept
 * here (not in `query.ts`) because the markdown shape is a
 * resource-surface concern; callers that want the structured form can
 * still invoke `queryByTopic` directly.
 */
export function renderStatusMarkdown(s: BrainStatusSnapshot): string {
  const lines: string[] = [];
  lines.push("# Brain status");
  lines.push("");
  if (!s.present) {
    lines.push("_Brain layer not present in this vault. Run `o2b brain init` first._");
    return lines.join("\n") + "\n";
  }
  lines.push("## Counts");
  lines.push("");
  lines.push(
    `- inbox: ${s.counts.inbox} (processed: ${s.counts.inbox_processed}, ` +
      `archived: ${s.counts.inbox_archived})`,
  );
  lines.push(`- preferences: ${s.counts.preferences}`);
  for (const [status, n] of Object.entries(s.counts.preferences_by_status).toSorted()) {
    lines.push(`  - ${status}: ${n}`);
  }
  lines.push(`- retired: ${s.counts.retired}`);
  lines.push(`- log days: ${s.counts.log_days}`);
  lines.push(`- snapshots: ${s.counts.snapshots}`);
  lines.push("");
  lines.push("## Activity");
  lines.push("");
  lines.push(`- last dream: ${s.last_dream_at ?? "_(never)_"}`);
  lines.push(`- last apply-evidence: ${s.last_apply_evidence_at ?? "_(never)_"}`);
  lines.push("");
  lines.push("## Maintenance debt");
  lines.push("");
  const debtCount = s.maintenance_debt.log_events_since_dream;
  const debtNoun = debtCount === 1 ? "log event" : "log events";
  if (s.maintenance_debt.status === MAINTENANCE_DEBT_STATUS.neverDreamed) {
    lines.push(`- never dreamed — ${debtCount} ${debtNoun} recorded since inception`);
  } else if (s.maintenance_debt.status === MAINTENANCE_DEBT_STATUS.undercounted) {
    // The figure is a floor: at least one shard in the window would not
    // read or would not parse. Printing it as a count would be the
    // partial walk presented as a total.
    lines.push(
      `- at least ${debtCount} ${debtNoun} since the last dream — a log shard could not be ` +
        "read in full, so this is a lower bound",
    );
  } else {
    lines.push(`- ${debtCount} ${debtNoun} since the last dream`);
  }
  lines.push("");
  if (s.sanity.signals_awaiting_dream > 0) {
    lines.push("## Sanity");
    lines.push("");
    lines.push(
      `- **${s.sanity.signals_awaiting_dream}** signal(s) in inbox/ predate the unconfirmed_window — run \`o2b brain dream\`.`,
    );
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}
