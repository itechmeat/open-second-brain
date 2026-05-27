/**
 * Text renderers for `o2b brain query` results.
 *
 * Pure projection of the typed `queryByPreference` / `queryByTopic`
 * results plus log-entry arrays into stdout. JSON output uses the
 * raw shapes; this module only handles the human-readable variant.
 */

import type { BrainLogEntry } from "../../core/brain/log.ts";
import { queryByPreference, queryByTopic } from "../../core/brain/query.ts";
import { info, ok } from "../output.ts";

export function renderQueryPreferenceText(out: ReturnType<typeof queryByPreference>): void {
  const p = out.preference;
  ok(`id: ${p.id}`);
  ok(`topic: ${p.topic}`);
  if (p.scope) ok(`scope: ${p.scope}`);
  ok(`status: ${"status" in p ? p.status : "(unknown)"}`);
  ok(`principle: ${p.principle}`);
  if (out.evidence.length === 0) {
    ok("evidence: (none)");
    return;
  }
  ok("evidence:");
  for (const e of out.evidence) {
    const artifact = e.body["artifact"] ?? "(unknown)";
    const result = e.body["result"] ?? "(unknown)";
    info(`  - ${e.timestamp} ${result}: ${artifact}`);
  }
}

export function renderQueryTopicText(out: ReturnType<typeof queryByTopic>, topic: string): void {
  ok(`topic: ${topic}`);
  if (out.preference) {
    ok(`preference: ${out.preference.id}`);
  } else {
    ok("preference: (none)");
  }
  ok(`signals: ${out.signals.length}`);
  for (const s of out.signals) {
    info(`  - ${s.id} (${s.signal}, ${s.created_at})`);
  }
  ok(`log_events: ${out.all_log_events.length}`);
}

export function renderQueryLogText(entries: ReadonlyArray<BrainLogEntry>): void {
  ok(`entries: ${entries.length}`);
  for (const e of entries) {
    info(`  - ${e.timestamp} ${e.eventType}`);
  }
}
