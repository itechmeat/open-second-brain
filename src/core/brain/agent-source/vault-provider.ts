import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { BrainLogEntry } from "../log.ts";
import { readAllLogEntries } from "../query.ts";
import { brainDirs } from "../paths.ts";
import { parsePreference, parseRetired } from "../preference.ts";
import { parseSignal } from "../signal.ts";
import type { BrainPreference, BrainRetired, BrainSignal } from "../types.ts";
import { normaliseWikilinkTarget } from "../wikilink.ts";
import type { AgentSourceContribution, AgentSourceProvider } from "./types.ts";

const PROVIDER_ID = "vault";

export const vaultAgentSourceProvider: AgentSourceProvider = Object.freeze({
  id: PROVIDER_ID,
  label: "Brain vault provenance",
  collect(vault: string): ReadonlyArray<AgentSourceContribution> {
    return collectVaultContributions(vault);
  },
});

function collectVaultContributions(
  vault: string,
): ReadonlyArray<AgentSourceContribution> {
  const dirs = brainDirs(vault);
  const signals = collectSignals(dirs.inbox, dirs.processed);
  const signalAgentById = new Map(
    signals.map((signal) => [signal.id, signal.agent]),
  );

  const contributions: AgentSourceContribution[] = [];
  for (const signal of signals) {
    contributions.push(signalContribution(signal));
  }
  for (const preference of collectPreferences(dirs.preferences, dirs.retired)) {
    contributions.push(preferenceContribution(preference, signalAgentById));
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
  return Object.freeze(contributions.map((c) => Object.freeze(c)));
}

function collectSignals(...dirs: string[]): BrainSignal[] {
  const signals: BrainSignal[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith("sig-") ||
        !entry.name.endsWith(".md")
      ) {
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

function collectPreferences(
  preferencesDir: string,
  retiredDir: string,
): Array<BrainPreference | BrainRetired> {
  return [
    ...collectPreferenceDir(preferencesDir, "pref-"),
    ...collectPreferenceDir(retiredDir, "ret-"),
  ];
}

function collectPreferenceDir(
  dir: string,
  prefix: "pref-" | "ret-",
): Array<BrainPreference | BrainRetired> {
  if (!existsSync(dir)) return [];
  const out: Array<BrainPreference | BrainRetired> = [];
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".md")
    ) {
      continue;
    }
    const path = join(dir, entry.name);
    try {
      out.push(prefix === "pref-" ? parsePreference(path) : parseRetired(path));
    } catch {
      continue;
    }
  }
  return out;
}

function signalContribution(signal: BrainSignal): AgentSourceContribution {
  return Object.freeze({
    provider_id: PROVIDER_ID,
    kind: "signal",
    id: signal.id,
    agents: Object.freeze([signal.agent]),
    timestamp: signal.created_at,
    topic: signal.topic,
    ...(signal.scope !== undefined ? { scope: signal.scope } : {}),
    title: signal.topic,
    text: [signal.topic, signal.signal, signal.principle, signal.raw ?? ""]
      .join("\n")
      .trim(),
    data: Object.freeze({
      signal: signal.signal,
      principle: signal.principle,
      ...(signal.source !== undefined ? { source: [...signal.source] } : {}),
      ...(signal.source_type !== undefined
        ? { source_type: signal.source_type }
        : {}),
      ...(signal.session_ref !== undefined
        ? { session_ref: signal.session_ref }
        : {}),
    }),
  });
}

function preferenceContribution(
  preference: BrainPreference | BrainRetired,
  signalAgentById: ReadonlyMap<string, string>,
): AgentSourceContribution {
  const agents = new Set<string>();
  for (const evidence of preference.evidenced_by) {
    const id = normaliseWikilinkTarget(evidence);
    if (!id) continue;
    const agent = signalAgentById.get(id);
    if (agent !== undefined) agents.add(agent);
  }
  return Object.freeze({
    provider_id: PROVIDER_ID,
    kind: "preference",
    id: preference.id,
    agents: Object.freeze([...agents].toSorted()),
    timestamp:
      preference.kind === "brain-retired"
        ? preference.retired_at
        : preference.created_at,
    topic: preference.topic,
    ...(preference.scope !== undefined ? { scope: preference.scope } : {}),
    title: preference.topic,
    text: [preference.topic, preference.status, preference.principle].join(
      "\n",
    ),
    data: Object.freeze({
      status: preference.status,
      principle: preference.principle,
      evidenced_by: [...preference.evidenced_by],
      applied_count: preference.applied_count,
      violated_count: preference.violated_count,
      last_evidence_at: preference.last_evidence_at,
      confidence: preference.confidence,
    }),
  });
}

function logContribution(entry: BrainLogEntry): AgentSourceContribution | null {
  const agents = entry.agent ? [entry.agent] : [];
  if (agents.length === 0) return null;
  return Object.freeze({
    provider_id: PROVIDER_ID,
    kind: "log",
    id: `${entry.timestamp}:${entry.eventType}`,
    agents: Object.freeze(agents),
    timestamp: entry.timestamp,
    topic: logTopic(entry),
    title: entry.eventType,
    text: logText(entry),
    data: Object.freeze({
      event_type: entry.eventType,
      body: cloneLogBody(entry.body),
    }),
  });
}

function logTopic(entry: BrainLogEntry): string | undefined {
  const topic = entry.body["topic"];
  return typeof topic === "string" && topic.trim().length > 0
    ? topic
    : undefined;
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
