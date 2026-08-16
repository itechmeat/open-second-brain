import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { BrainLogEntry } from "../log.ts";
import { readAllLogEntries } from "../query.ts";
import { brainDirs } from "../paths.ts";
import { preferenceOwner } from "../owner-scoped-facts.ts";
import { parsePreference, parseRetired } from "../preference.ts";
import { parseSignal } from "../signal.ts";
import type { BrainPreference, BrainRetired, BrainSignal } from "../types.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import { deepFreeze } from "./freeze.ts";
import type { AgentSourceContribution, AgentSourceProvider } from "./types.ts";

const PROVIDER_ID = "vault";

export const vaultAgentSourceProvider: AgentSourceProvider = Object.freeze({
  id: PROVIDER_ID,
  label: "Brain vault provenance",
  collect(vault: string): ReadonlyArray<AgentSourceContribution> {
    return collectVaultContributions(vault);
  },
});

function collectVaultContributions(vault: string): ReadonlyArray<AgentSourceContribution> {
  const dirs = brainDirs(vault);
  const signals = collectSignals(dirs.inbox, dirs.processed);
  const signalAgentById = new Map(signals.map((signal) => [signal.id, signal.agent]));

  const contributions: AgentSourceContribution[] = [];
  for (const signal of signals) {
    contributions.push(signalContribution(signal));
  }
  for (const owned of collectPreferences(dirs.preferences, dirs.retired)) {
    contributions.push(preferenceContribution(owned, signalAgentById));
  }
  for (const entry of readAllLogEntries(vault)) {
    const contribution = logContribution(entry);
    if (contribution !== null) contributions.push(contribution);
  }
  contributions.sort((a, b) => {
    const byTimestamp = a.timestamp.localeCompare(b.timestamp);
    if (byTimestamp !== 0) return byTimestamp;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return a.id.localeCompare(b.id);
  });
  return deepFreeze(contributions);
}

function collectSignals(...dirs: string[]): BrainSignal[] {
  const signals: BrainSignal[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("sig-") || !entry.name.endsWith(".md")) {
        continue;
      }
      try {
        signals.push(parseSignal(join(dir, entry.name)));
      } catch {
        continue;
      }
    }
  }
  return signals;
}

/**
 * A parsed preference or retired record with the owner token its page
 * declares (context-integrity-gates, Unit A). Both kinds carry `owner`
 * since A7 made retirement KEEP ownership, so the token is read from the
 * parsed record and resolved through the one shared rule - no second
 * frontmatter read, and no way for the two kinds to disagree.
 */
interface OwnedRecord {
  readonly record: BrainPreference | BrainRetired;
  readonly owner: string | null;
}

function collectPreferences(preferencesDir: string, retiredDir: string): OwnedRecord[] {
  return [
    ...collectPreferenceDir(preferencesDir, "pref-"),
    ...collectPreferenceDir(retiredDir, "ret-"),
  ];
}

function collectPreferenceDir(dir: string, prefix: "pref-" | "ret-"): OwnedRecord[] {
  if (!existsSync(dir)) return [];
  const out: OwnedRecord[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".md")) {
      continue;
    }
    const path = join(dir, entry.name);
    try {
      const record = prefix === "pref-" ? parsePreference(path) : parseRetired(path);
      out.push({ record, owner: preferenceOwner(record) });
    } catch {
      continue;
    }
  }
  return out;
}

function signalContribution(signal: BrainSignal): AgentSourceContribution {
  return deepFreeze({
    provider_id: PROVIDER_ID,
    kind: "signal",
    id: signal.id,
    agents: Object.freeze([signal.agent]),
    timestamp: signal.created_at,
    topic: signal.topic,
    ...(signal.scope !== undefined ? { scope: signal.scope } : {}),
    // Attribution written by the shared-namespace mirror, surfaced here so
    // a shared vault's roster can say which vault a contribution came from
    // (a-label-is-not-a-boundary, U5).
    ...(signal.origin_vault !== undefined ? { origin_vault: signal.origin_vault } : {}),
    title: signal.topic,
    text: [signal.topic, signal.signal, signal.principle, signal.raw ?? ""].join("\n").trim(),
    data: {
      signal: signal.signal,
      principle: signal.principle,
      ...(signal.source !== undefined ? { source: [...signal.source] } : {}),
      ...(signal.source_type !== undefined ? { source_type: signal.source_type } : {}),
      ...(signal.session_ref !== undefined ? { session_ref: signal.session_ref } : {}),
    },
  });
}

function preferenceContribution(
  owned: OwnedRecord,
  signalAgentById: ReadonlyMap<string, string>,
): AgentSourceContribution {
  const preference = owned.record;
  const agents = new Set<string>();
  for (const evidence of preference.evidenced_by) {
    const id = normaliseWikilinkTarget(evidence);
    if (!id) continue;
    const agent = signalAgentById.get(id);
    if (agent !== undefined) agents.add(agent);
  }
  return deepFreeze({
    provider_id: PROVIDER_ID,
    kind: "preference",
    id: preference.id,
    agents: Object.freeze([...agents].toSorted()),
    timestamp: preference.kind === "brain-retired" ? preference.retired_at : preference.created_at,
    topic: preference.topic,
    ...(preference.scope !== undefined ? { scope: preference.scope } : {}),
    ...(owned.owner !== null ? { owner: owned.owner } : {}),
    title: preference.topic,
    text: [preference.topic, preference.status, preference.principle].join("\n"),
    data: {
      status: preference.status,
      principle: preference.principle,
      evidenced_by: [...preference.evidenced_by],
      applied_count: preference.applied_count,
      violated_count: preference.violated_count,
      last_evidence_at: preference.last_evidence_at,
      confidence: preference.confidence,
    },
  });
}

function logContribution(entry: BrainLogEntry): AgentSourceContribution | null {
  const agents = entry.agent ? [entry.agent] : [];
  if (agents.length === 0) return null;
  return deepFreeze({
    provider_id: PROVIDER_ID,
    kind: "log",
    id: `${entry.timestamp}:${entry.eventType}`,
    agents: Object.freeze(agents),
    timestamp: entry.timestamp,
    topic: logTopic(entry),
    title: entry.eventType,
    text: logText(entry),
    data: {
      event_type: entry.eventType,
      body: cloneLogBody(entry.body),
    },
  });
}

function logTopic(entry: BrainLogEntry): string | undefined {
  const topic = entry.body["topic"];
  return typeof topic === "string" && topic.trim().length > 0 ? topic : undefined;
}

function logText(entry: BrainLogEntry): string {
  const parts: string[] = [entry.eventType];
  for (const [key, value] of Object.entries(entry.body)) {
    if (Array.isArray(value)) {
      parts.push(`${key}: ${value.join(", ")}`);
    } else {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join("\n");
}

function cloneLogBody(
  body: Readonly<Record<string, string | ReadonlyArray<string>>>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      out[key] = value;
    } else {
      out[key] = [...value];
    }
  }
  return out;
}
