/**
 * Brain digest (design doc §8).
 *
 * Read-only renderer over Brain/log/ + Brain/preferences/ +
 * Brain/retired/. Default window: the last 24 hours, ending at
 * `opts.until ?? now`. Both Markdown and JSON outputs are supported;
 * the JSON form follows §8.2 verbatim so downstream consumers (Hermes
 * cron, CI scripts) can parse it without surprises.
 *
 * Sections, each rendered only when non-empty:
 *
 *   1. **New (unconfirmed, in trial)** — preferences with `status:
 *      unconfirmed` and `created_at` inside the window.
 *   2. **Confirmed** — preferences with `confirmed_at` inside the
 *      window.
 *   3. **Retired** — retired entries with `retired_at` inside the
 *      window.
 *   4. **Confidence shifts** — preferences whose confidence changed
 *      inside the window. The current Brain state does not carry an
 *      explicit `confidence_history`; the design accepts a graceful
 *      degradation here. We read `dream` log events: when their
 *      payload exposes a `confidence_shifts` (singular bullet) or
 *      `confidence_changes` sub-list, we parse those. If the payload
 *      is absent, the section is empty.
 *   5. **Contradictions** — events of kind `contradicted` or `dream`
 *      events emitting a `contradictions` sub-list. Same graceful
 *      degradation: empty when the payload is not produced.
 *
 * Empty window → one-line Markdown `Brain digest — <date>: no changes`
 * (or JSON with `summary.empty: true`). The function returns both the
 * rendered string and an `empty` flag so the CLI can implement
 * `--silent-if-empty` (exit 2) without re-parsing.
 *
 * The function is pure read. It does not mutate signals, preferences,
 * retired entries, the log, or the snapshots.
 */

import { readerRefView } from "./artifact-ref-view.ts";
import { closedCollectError } from "./maintenance/collect.ts";
import { renderPrefLink, type LinkOutputFormat } from "./wikilink.ts";
import { BRAIN_RETIRED_REASON } from "./types.ts";
import type {
  DigestData,
  DigestJson,
  RenderDigestOptions,
  RenderDigestResult,
} from "./digest-types.ts";
import { ONE_DAY_MS, collectDigestData } from "./digest-collect.ts";
import { isEmpty } from "./digest-analysis.ts";

export type {
  DigestFormat,
  RenderDigestOptions,
  RenderDigestResult,
  DigestJsonNewUnconfirmed,
  DigestJsonConfirmed,
  DigestJsonRetired,
  DigestJsonConfidenceShift,
  DigestJsonContradiction,
  DigestJsonTopApplied,
  DigestJsonTopReferenced,
  DigestJsonMostAppliedEntry,
  DigestJsonMostApplied,
  DigestJsonAgentSummary,
  DigestJsonMergeSuggestion,
  DigestJsonConnectionHealth,
  DigestJson,
} from "./digest-types.ts";

// ----- Entry point ----------------------------------------------------------

export function renderDigest(vault: string, opts: RenderDigestOptions = {}): RenderDigestResult {
  const format = opts.format ?? "markdown";
  const now = opts.now ?? new Date();
  const until = opts.until ?? now;
  const since = opts.since ?? new Date(until.getTime() - ONE_DAY_MS);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    throw new TypeError("renderDigest: `since` and `until` must be valid Dates");
  }
  if (since.getTime() > until.getTime()) {
    throw new RangeError(
      `renderDigest: since (${since.toISOString()}) is after until (${until.toISOString()})`,
    );
  }

  const collected = collectDigestData(
    vault,
    since,
    until,
    opts.agentScope,
    readerRefView(vault, opts.readable, opts.withholdsPrivate === true),
  );
  // A digest rendered for a reader below local reach (a `readable`
  // filter) names a failed scan without its raised message, which can
  // carry a host path.
  const data =
    opts.readable === undefined
      ? collected
      : { ...collected, collect_errors: collected.collect_errors.map(closedCollectError) };
  const empty = isEmpty(data);

  if (format === "json") {
    const payload: DigestJson = {
      schema_version: 1,
      generated_at: now.toISOString(),
      window: { since: since.toISOString(), until: until.toISOString() },
      summary: {
        new_unconfirmed_count: data.new_unconfirmed.length,
        confirmed_count: data.confirmed.length,
        retired_count: data.retired.length,
        confidence_shift_count: data.confidence_shifts.length,
        contradiction_count: data.contradictions.length,
        empty,
      },
      new_unconfirmed: data.new_unconfirmed,
      confirmed: data.confirmed,
      retired: data.retired,
      confidence_shifts: data.confidence_shifts,
      contradictions: data.contradictions,
      top_applied: data.top_applied,
      top_referenced: data.top_referenced,
      merge_suggestions: data.merge_suggestions,
      agent_summary: data.agent_summary,
      most_applied: data.most_applied,
      connection_health: data.connection_health,
      actions: data.actions,
      ...(data.collect_errors.length > 0
        ? {
            collect_errors: data.collect_errors.map((e) => ({
              scan: e.signal,
              message: e.message,
            })),
          }
        : {}),
      // Guarded: dreamSummary may arrive from an untyped JSON-RPC
      // boundary (or from a future caller that has not populated
      // every array). Optional-chain the inner length read.
      uncertain_count: opts.dreamSummary?.uncertain?.length ?? 0,
      quarantined_count: opts.dreamSummary?.quarantined?.length ?? 0,
      ...(opts.doctorResult?.trust_verdict !== undefined
        ? { trust_verdict: opts.doctorResult.trust_verdict }
        : {}),
    };
    return Object.freeze({
      content: JSON.stringify(payload, null, 2) + "\n",
      empty,
    });
  }

  // Markdown.
  const linkOutputFormat = opts.linkOutputFormat ?? "wikilink";
  const baseMd = empty
    ? renderEmptyMarkdown(until)
    : renderMarkdown(data, since, until, linkOutputFormat);
  const trustSection = renderTrustSection(opts.doctorResult, opts.dreamSummary);
  const content = trustSection ? `${baseMd}\n${trustSection}` : baseMd;
  return Object.freeze({ content, empty });
}

/**
 * Markdown `## Trust` section (v0.10.16). Rendered only when either
 * a doctor result or a dream summary is threaded through the digest
 * options - otherwise legacy output stays bit-identical.
 */
function renderTrustSection(
  doctor?: import("./doctor.ts").RunDoctorResult,
  dream?: import("./dream.ts").DreamRunSummary,
): string {
  if (doctor === undefined && dream === undefined) return "";
  const lines: string[] = ["## Trust", ""];
  if (doctor?.trust_verdict !== undefined) {
    lines.push(`- Verdict: **${doctor.trust_verdict}**`);
  }
  if (dream !== undefined) {
    lines.push(`- Uncertain: ${dream.uncertain.length}`);
    lines.push(`- Quarantined: ${dream.quarantined.length}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ----- Data collection ------------------------------------------------------

function renderEmptyMarkdown(until: Date): string {
  // Single-line collapse per §8 paragraph above the listing.
  const ymd = until.toISOString().slice(0, 10);
  return `Brain digest — ${ymd}: no changes\n`;
}

function renderMarkdown(
  data: DigestData,
  since: Date,
  until: Date,
  linkOutputFormat: LinkOutputFormat,
): string {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const windowHours = Math.round((until.getTime() - since.getTime()) / (60 * 60 * 1000));
  const lines: string[] = [];
  lines.push(
    `# Brain digest — ${untilIso.slice(0, 16)}Z (${windowHours}h)`,
    "",
    `Window: ${sinceIso} — ${untilIso}`,
    "",
  );

  if (data.new_unconfirmed.length > 0) {
    lines.push("## New (unconfirmed, in trial)", "");
    for (const item of data.new_unconfirmed) {
      const scope = item.scope ?? "—";
      const trialDay = item.unconfirmed_until.slice(0, 10);
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.signal_count} signals, trial ends ${trialDay}`,
      );
    }
    lines.push("");
  }
  if (data.confirmed.length > 0) {
    lines.push("## Confirmed", "");
    for (const item of data.confirmed) {
      const scope = item.scope ?? "—";
      const artifact = item.first_applied_artifact ?? "_(none)_";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, first applied in ${artifact}`,
      );
    }
    lines.push("");
  }
  if (data.retired.length > 0) {
    lines.push("## Retired", "");
    for (const item of data.retired) {
      const scope = item.scope ?? "—";
      const detail =
        item.reason === BRAIN_RETIRED_REASON.staleNoEvidence && item.days_stale !== null
          ? `${item.reason} (${item.days_stale} days)`
          : item.reason;
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${detail}`,
      );
    }
    lines.push("");
  }
  if (data.most_applied.entries.length > 0) {
    lines.push(
      `## Most-applied (${data.most_applied.window_days}d) (${data.most_applied.entries.length})`,
      "",
    );
    for (const item of data.most_applied.entries) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.applied_in_window} applied`,
      );
    }
    lines.push("");
  }
  if (data.agent_summary.length > 0) {
    lines.push(`## Agent summary (${data.agent_summary.length})`, "");
    for (const item of data.agent_summary) {
      const parts = [
        `**${item.agent}**`,
        `${item.total_events} events`,
        `(feedback: ${item.feedback_count}, apply: ${item.apply_evidence_count}, note: ${item.note_count})`,
      ];
      if (item.confirmed_attributed > 0) parts.push(`→ ${item.confirmed_attributed} confirmed`);
      if (item.retired_attributed > 0) parts.push(`→ ${item.retired_attributed} retired`);
      lines.push(`- ${parts.join(" ")}`);
    }
    lines.push("");
  }
  if (data.top_applied.length > 0) {
    lines.push(`## Top applied (${data.top_applied.length})`, "");
    for (const item of data.top_applied) {
      const scope = item.scope ?? "—";
      const stats = `applied: ${item.applied_count}, violated: ${item.violated_count}`;
      const tags = item.status === "quarantine" ? " [quarantine]" : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${stats}${tags}`,
      );
    }
    lines.push("");
  }
  if (data.top_referenced.length > 0) {
    lines.push(`## Top referenced (${data.top_referenced.length})`, "");
    for (const item of data.top_referenced) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.backlink_count} inbound`,
      );
    }
    lines.push("");
  }
  // Connection health is always rendered when vault has nodes — it
  // reflects vault-wide structural state, not windowed change.
  if (data.connection_health.total_nodes > 0) {
    const ch = data.connection_health;
    const pct = Math.round(ch.link_density * 100);
    lines.push(
      "## Connection health",
      "",
      `- Total nodes: ${ch.total_nodes}`,
      `- Linked (≥1 inbound): ${ch.linked_nodes}`,
      `- Orphans (0 inbound): ${ch.orphan_nodes}`,
      `- Mean backlinks: ${ch.mean_backlinks}`,
      `- Median backlinks: ${ch.median_backlinks}`,
      `- Link density: ${pct}%`,
      "",
    );
  }
  // Ranked maintenance actions (v0.10.15). Same window-independent
  // shape as connection-health: surface only when the scorer
  // returned anything, so empty vaults stay quiet.
  if (data.actions.length > 0) {
    lines.push(`## Actions (${data.actions.length})`, "");
    for (const a of data.actions) {
      lines.push(`- [${a.category}] impact ${a.impact} — ${a.title}`);
    }
    lines.push("");
  }
  if (data.merge_suggestions.length > 0) {
    lines.push(`## Merge suggestions (${data.merge_suggestions.length})`, "");
    for (const item of data.merge_suggestions) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.a, principle: item.principle_a, format: linkOutputFormat })}` +
          ` ≈ ${renderPrefLink({ id: item.b, principle: item.principle_b, format: linkOutputFormat })}` +
          ` — topic '${item.topic}', scope ${scope}, jaccard ${item.jaccard.toFixed(2)}`,
      );
    }
    lines.push("");
  }
  if (data.confidence_shifts.length > 0) {
    lines.push("## Confidence shifts", "");
    for (const item of data.confidence_shifts) {
      const stats =
        item.applied_count !== null && item.violated_count !== null
          ? ` (applied: ${item.applied_count}, violated: ${item.violated_count})`
          : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} ${item.from} → ${item.to}${stats}`,
      );
    }
    lines.push("");
  }
  if (data.contradictions.length > 0) {
    lines.push("## Contradictions", "");
    for (const item of data.contradictions) {
      const topic = item.topic ? ` (topic: ${item.topic})` : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${item.description}${topic}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}
