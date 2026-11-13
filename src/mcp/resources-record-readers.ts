/**
 * The record readers of the `osb://` surface (task 3.19): one
 * preference, one topic, one log day, each answered at the caller's
 * reach, with the topic and status markdown renderers and the topic
 * objection section. Split from `resources.ts`; dispatch happens
 * through that module's `readResource`.
 */

import { storeMemoryPageAt } from "../core/brain/memory-pages.ts";
import { logDayReader } from "../core/brain/log-days.ts";
import { vaultRelative } from "../core/path-safety.ts";
import { formatFrontmatter } from "../core/vault.ts";
import { readFileSync } from "node:fs";
import { listLogMarkdownFiles } from "../core/brain/log-jsonl.ts";
import {
  preferencePath,
  retiredPath,
  validateIsoDate,
  validateSlug,
  BRAIN_PREFERENCES_REL,
} from "../core/brain/paths.ts";
import { BrainNotFoundError, queryByPreference, queryByTopic } from "../core/brain/query.ts";
import { type ArtifactRefView } from "../core/brain/artifact-ref-view.ts";
import { logEntriesAtReach, recordRefs } from "../core/brain/log-events-at-reach.ts";
import {
  parseLogDayFile,
  renderLogDayHeader,
  renderLogEntryBlock,
  type ParseLogDayResult,
} from "../core/brain/log.ts";
import type { BrainPreference, BrainRetired } from "../core/brain/types.ts";
import { deliveryRelForBrainArtifact, signalDeliveryRel } from "./brain/reach-events.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { RequestView, ResourceContent, ResourceContext } from "./resources-shared.ts";
import { MIME_MARKDOWN, deliveryFor, notFound, readMarkdown } from "./resources-shared.ts";

export function readPreference(
  ctx: ResourceContext,
  uri: string,
  rawId: string,
  view: RequestView,
): ResourceContent {
  if (!rawId.trim()) {
    throw new MCPError(INVALID_PARAMS, `resource id must not be empty: ${uri}`);
  }
  // Accept `pref-foo`, `ret-foo`, or the bare slug. Strip the prefix
  // (if any) for `validateSlug` — that helper rejects `..` traversal
  // and other shape problems with a clear INVALID_PARAMS-shaped
  // message, which is a better diagnosis than a downstream
  // "not found" error. The prefixed form is then handed to
  // queryByPreference, which handles the active → retired fallback.
  const slug = rawId.startsWith("pref-")
    ? rawId.slice("pref-".length)
    : rawId.startsWith("ret-")
      ? rawId.slice("ret-".length)
      : rawId;
  try {
    validateSlug(slug);
  } catch (err) {
    throw new MCPError(INVALID_PARAMS, (err as Error).message);
  }
  const normalized =
    rawId.startsWith("pref-") || rawId.startsWith("ret-") ? rawId : `pref-${rawId}`;
  // Asked before the page is parsed: a withheld page that fails to parse
  // would otherwise answer with the parser's error, which names the page
  // an absent id never could.
  if (!view.refs.row(...recordRefs(normalized))) throw notFound(normalized);
  let result;
  try {
    result = queryByPreference(ctx.vault, normalized);
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      throw new MCPError(INTERNAL_ERROR, err.message);
    }
    throw err;
  }
  // queryByPreference returns the parsed object but not its path; we
  // re-derive the path from the resolved id so we can hand back the
  // raw markdown body (the resource contract is "give me the file",
  // not "give me a structured projection").
  const resolvedId = result.preference.id;
  const resolvedSlug = resolvedId.startsWith("pref-")
    ? resolvedId.slice("pref-".length)
    : resolvedId.slice("ret-".length);
  const filePath = resolvedId.startsWith("pref-")
    ? preferencePath(ctx.vault, resolvedSlug)
    : retiredPath(ctx.vault, resolvedSlug);
  // The whole file, `owner:` line and body prose included, is what this
  // reader hands back - so the ownership question is asked before the
  // read, not filtered out of the bytes afterwards.
  //
  // `normalized`, not `rawId`: the absent branch above rethrows what
  // `queryByPreference` threw, and that names the NORMALISED id. This
  // reader accepts the bare slug too, so echoing the raw one here made
  // `osb://preference/acme` answer "...for id 'acme'" when the page
  // existed and was withheld, against "...for id 'pref-acme'" when it did
  // not - the presence of the prefix a one-bit existence oracle over the
  // whole reserved population.
  if (!view.refs.visible(resolvedId)) throw notFound(normalized);
  // On a store-only machine the page is the one the fold rebuilds (task 2.10).
  const stored = storeMemoryPageAt(ctx.vault, vaultRelative(filePath, ctx.vault));
  const file =
    stored === null
      ? readMarkdown(uri, filePath)
      : { uri, mimeType: MIME_MARKDOWN, text: formatFrontmatter(...stored.read()) };
  return {
    ...file,
    // The whole file - frontmatter and body - is the delivery
    // (delivery-trust, lane A): fenced at remote reach through the
    // binding, named for the page's own derived provenance; local keeps
    // the bytes. The probe asks the RESOLVED page - the id the
    // active-to-retired fallback answered - never the caller's spelling.
    text: deliveryFor(ctx, view).shape(
      file.text,
      deliveryRelForBrainArtifact(ctx.vault, resolvedId),
    ),
  };
}

export function readTopic(
  ctx: ResourceContext,
  uri: string,
  rawSlug: string,
  view: RequestView,
): ResourceContent {
  if (!rawSlug.trim()) {
    throw new MCPError(INVALID_PARAMS, `topic slug must not be empty: ${uri}`);
  }
  validateSlug(rawSlug);
  let result;
  try {
    // The scope reaches the SELECTION, not the result: a topic resolves
    // to one preference and several may carry it, so filtering afterwards
    // would report the topic as having no rule whenever another owner's
    // preference happened to sort first.
    result = queryByTopic(ctx.vault, rawSlug, {
      ownerScope: view.ownerScope,
      transportReach: view.reach,
    });
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      throw new MCPError(INTERNAL_ERROR, err.message);
    }
    throw err;
  }
  // The two remaining owner-bearing streams, filtered before the
  // renderer sees them: each signal row names its id and its author, and
  // the log rows are the same events `brain_event_trace` filters. A
  // topic whose ONLY rule is one this caller may not see is reported as
  // a topic with no rule, not as a topic that refused - the renderer
  // already has that shape for a topic that never reached promotion.
  const scoped = Object.freeze({
    ...result,
    signals: view.refs.keep(result.signals, (s) => [s.id]),
    all_log_events: logEntriesAtReach(view.refs, result.all_log_events),
  });
  // The synthesis is composed from spans shaped at the page each span
  // quotes (delivery-trust, lane A): the body under the governing
  // preference page's provenance - a topic with no current rule probes
  // the page that would hold it, the absent-page fail-closed answer -
  // and the objection block under the page ITS text quotes, because the
  // strongest objection may quote an agent-authored counter-signal
  // whose page is not the page that decided the body's treatment.
  const delivery = deliveryFor(ctx, view);
  const preferenceRel = result.preference
    ? deliveryRelForBrainArtifact(ctx.vault, result.preference.id)
    : `${BRAIN_PREFERENCES_REL}/pref-${rawSlug}.md`;
  const objection = topicObjectionSection(ctx.vault, scoped);
  let text: string;
  if (objection.rel === null) {
    // The block quotes the governing preference itself (or no page at
    // all): one document, one probe. The trailing newline keeps the
    // unfenced bytes identical to the pre-shaping document.
    text = delivery.shape(
      `${renderTopicMarkdown(rawSlug, scoped)}\n${objection.text}\n`,
      preferenceRel,
    );
  } else {
    text =
      `${delivery.shape(renderTopicMarkdown(rawSlug, scoped), preferenceRel)}\n` +
      `${delivery.shape(objection.text, objection.rel)}\n`;
  }
  return { uri, mimeType: MIME_MARKDOWN, text };
}

export function readLog(
  ctx: ResourceContext,
  uri: string,
  rawDate: string,
  view: RequestView,
): ResourceContent {
  validateIsoDate(rawDate);
  // Per-device shards (Memory Integrity Suite): a day's human view can
  // span several markdown files. The legacy single file is returned
  // verbatim (byte-identical to pre-shard behaviour); multiple shards
  // are concatenated in shard order.
  // A store-only machine has no day pages (task 2.10): the day is
  // rendered from its `log-event` records, in the shape a page has.
  const log = logDayReader(ctx.vault);
  if (log.stored) {
    // Filtered first: a day whose every event the caller may not see reads
    // as a day with none, never as an empty page (no existence oracle).
    const entries = logEntriesAtReach(view.refs, log.day(rawDate).entries);
    if (entries.length === 0) {
      throw new MCPError(INTERNAL_ERROR, `no log events for date '${rawDate}'`);
    }
    const blocks = entries.map((e) => renderLogEntryBlock(e).trimEnd());
    const text = [renderLogDayHeader(rawDate).trimEnd(), ...blocks].join(LOG_BLOCK_SEPARATOR);
    return { uri, mimeType: MIME_MARKDOWN, text: `${text}\n` };
  }
  const files = listLogMarkdownFiles(ctx.vault).filter((f) => f.date === rawDate);
  if (files.length === 0) {
    throw new MCPError(INTERNAL_ERROR, `no log file for date '${rawDate}'`);
  }
  const shard = (f: { path: string }): string =>
    shardAtReach(readFileSync(f.path, "utf8"), view.refs, () =>
      parseLogDayFile(ctx.vault, rawDate, f.path),
    );
  // The single-shard read stays verbatim (trailing newline included), so
  // a vault with the gate off is byte-identical to the pre-filter shape.
  if (files.length === 1) return { uri, mimeType: MIME_MARKDOWN, text: shard(files[0]!) };
  return { uri, mimeType: MIME_MARKDOWN, text: files.map((f) => shard(f).trimEnd()).join("\n\n") };
}

/** Start of one rendered log event: `## <time> — <kind>`. */
export const LOG_EVENT_HEADING = "\n## ";

/** The blank line {@link appendLogEvent} keeps between a shard's blocks. */
export const LOG_BLOCK_SEPARATOR = "\n\n";

/**
 * One shard as a caller behind `view` may read it: the frontmatter and
 * day heading verbatim, then the entries the Brain log event rule keeps
 * ({@link logEntriesAtReach}), each rendered as the appender writes it.
 * A shared dream keeps its readable transitions, and a retired record is
 * judged under each of its spellings, so the shard reads as it would in a
 * vault that never logged the withheld record.
 *
 * A shard is shared by construction - it is named by date and carries no
 * `owner:` - but its CONTENTS name preferences by id and by path, which
 * is why the events are filtered rather than the page.
 *
 * A block the parser cannot read is not served below local reach: what
 * it names cannot be judged, so it fails closed.
 */
export function shardAtReach(
  markdown: string,
  view: ArtifactRefView,
  parse: () => ParseLogDayResult,
): string {
  if (view.filtersNothing) return markdown;
  const firstEvent = markdown.indexOf(LOG_EVENT_HEADING);
  const head = firstEvent < 0 ? markdown : markdown.slice(0, firstEvent);
  const blocks = logEntriesAtReach(view, parse().entries).map((e) =>
    renderLogEntryBlock(e).trimEnd(),
  );
  return [head.trimEnd(), ...blocks].join(LOG_BLOCK_SEPARATOR) + "\n";
}

export function renderTopicMarkdown(slug: string, result: ReturnType<typeof queryByTopic>): string {
  const lines: string[] = [];
  lines.push(`# Brain topic: ${slug}`);
  lines.push("");
  const pref = result.preference;
  if (pref) {
    if (pref.id.startsWith("ret-")) {
      const r = pref as BrainRetired;
      const date = r.retired_at.slice(0, 10);
      lines.push("## Retired preference (no current active)");
      lines.push("");
      lines.push(`- \`${r.id}\` — retired_reason: \`${r.retired_reason}\` on ${date}`);
      lines.push(`  - ${r.principle}`);
    } else {
      const p = pref as BrainPreference;
      lines.push("## Current preference");
      lines.push("");
      lines.push(`- \`${p.id}\` — status: \`${p.status}\`, confidence: \`${p.confidence}\``);
      lines.push(`  - ${p.principle}`);
    }
    lines.push("");
  }
  const sigs = result.signals;
  if (sigs.length > 0) {
    lines.push(`## Signals (${sigs.length})`);
    lines.push("");
    for (const s of sigs) {
      lines.push(`- \`${s.id}\` — ${s.signal} signal by ${s.agent} at ${s.created_at}`);
    }
    lines.push("");
  }
  const log = result.all_log_events;
  if (log.length > 0) {
    lines.push(`## Recent log entries (${log.length})`);
    lines.push("");
    for (const e of log) {
      lines.push(`- ${e.timestamp} — \`${e.eventType}\``);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

/**
 * The rendered "Strongest objection" section, and the page whose
 * provenance governs it: null rel when the block quotes the governing
 * preference itself (retired, quarantined, unconfirmed) or no page at
 * all, so the document's own probe covers it; the counter-signal's own
 * page when the block quotes a negative signal's principle - agent-
 * authored text from a DIFFERENT page than the preference that decided
 * the document's treatment, which brain_query's signal payloads shape
 * at the same page.
 */
export function topicObjectionSection(
  vault: string,
  result: ReturnType<typeof queryByTopic>,
): { readonly text: string; readonly rel: string | null } {
  const sentence = buildTopicObjection(vault, result);
  const text = `## Strongest objection\n\n- ${sentence.sentence}`;
  return { text, rel: sentence.rel };
}

/**
 * The single best-formed reason to distrust the topic's current
 * preference, by fixed priority: an already-retired rule > a
 * quarantined rule > a recorded negative counter-signal > an
 * unconfirmed rule still in its trial window, and a "no standing
 * objection" sentence when none applies. The rel names the page the
 * sentence quotes, for the section renderer to probe.
 */
export function buildTopicObjection(
  vault: string,
  result: ReturnType<typeof queryByTopic>,
): { readonly sentence: string; readonly rel: string | null } {
  const pref = result.preference;
  if (pref && pref.id.startsWith("ret-")) {
    const r = pref as BrainRetired;
    return {
      sentence: `This rule was already retired (\`${r.retired_reason}\`); adopting "${r.principle}" again would repeat a judgment the Brain has discarded.`,
      rel: null,
    };
  }
  if (pref) {
    const p = pref as BrainPreference;
    if (p.status === "quarantine") {
      return {
        sentence: `The rule "${p.principle}" is on probation — recent evidence has been dominantly negative, and a single further violation retires it.`,
        rel: null,
      };
    }
  }
  const negatives = result.signals
    .filter((s) => s.signal === "negative")
    .toSorted((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  if (negatives.length > 0) {
    const n = negatives[0]!;
    return {
      sentence: `A recorded counter-signal (\`${n.id}\`) argues against this: "${n.principle}". Treat the preference as contested.`,
      rel: signalDeliveryRel(vault, n.id),
    };
  }
  if (pref) {
    const p = pref as BrainPreference;
    if (p.status === "unconfirmed") {
      return {
        sentence: `The rule "${p.principle}" is unconfirmed — it has not yet earned applied evidence and may not survive its trial window (until ${p.unconfirmed_until.slice(0, 10)}).`,
        rel: null,
      };
    }
  }
  return {
    sentence:
      "No standing objection: the current preference is confirmed and faces no recorded counter-signal.",
    rel: null,
  };
}
