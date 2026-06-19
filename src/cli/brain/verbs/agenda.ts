/**
 * `o2b brain agenda` (t_f7b82ba4): deterministic agenda synthesis over
 * agent-provided calendar events. The agent fetches events (e.g. via the
 * google-workspace skill) and pipes a JSON array in; this verb returns
 * conflicts, free focus blocks, and external-organiser flags. Stateless:
 * no vault writes.
 */

import { readFileSync } from "node:fs";

import {
  synthesizeAgenda,
  type AgendaEventInput,
  type AgendaSnapshot,
} from "../../../core/brain/agenda.ts";
import { fail, normalizeFlagString, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain agenda --events <file|-> [--focus-min N] [--owner-domain D[,D2]] [--workday-start HH:MM --workday-end HH:MM] [--json]";

function readEvents(source: string): AgendaEventInput[] {
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--events is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  // Accept either a bare array or { events: [...] }.
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : null;
  if (arr === null) throw new Error("--events must be a JSON array of events (or {events: [...]})");
  return arr as AgendaEventInput[];
}

function snapshotJson(snapshot: AgendaSnapshot): Record<string, unknown> {
  return {
    counts: {
      events: snapshot.counts.events,
      conflicts: snapshot.counts.conflicts,
      focus_blocks: snapshot.counts.focusBlocks,
      external_organizers: snapshot.counts.externalOrganizers,
    },
    conflicts: snapshot.conflicts,
    focus_blocks: snapshot.focusBlocks,
    external_organizers: snapshot.externalOrganizers,
    events: snapshot.events.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      organizer: e.organizer,
    })),
  };
}

export async function cmdBrainAgenda(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    // Accepted but unused: agenda synthesis is stateless. Kept for
    // flag-parity with the other brain verbs so a passed --vault is
    // not a usage error.
    vault: { type: "string" },
    events: { type: "string" },
    "focus-min": { type: "string" },
    "owner-domain": { type: "string" },
    "workday-start": { type: "string" },
    "workday-end": { type: "string" },
    json: { type: "boolean" },
  });
  const eventsSource = normalizeFlagString(flags["events"]);
  if (eventsSource === null) return fail(USAGE);

  const focusRaw = normalizeFlagString(flags["focus-min"]);
  const focusMinMinutes = focusRaw === null ? 60 : Number.parseInt(focusRaw, 10);
  if (!Number.isFinite(focusMinMinutes) || focusMinMinutes < 1) {
    return fail("--focus-min must be a positive integer");
  }
  const ownerDomainRaw = normalizeFlagString(flags["owner-domain"]);
  const ownerDomains =
    ownerDomainRaw === null
      ? []
      : ownerDomainRaw
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
  const workdayStart = normalizeFlagString(flags["workday-start"]);
  const workdayEnd = normalizeFlagString(flags["workday-end"]);
  if ((workdayStart === null) !== (workdayEnd === null)) {
    return fail("--workday-start and --workday-end must be given together");
  }

  let snapshot: AgendaSnapshot;
  try {
    const events = readEvents(eventsSource);
    snapshot = synthesizeAgenda(events, {
      focusMinMinutes,
      ownerDomains,
      ...(workdayStart !== null ? { workdayStart, workdayEnd: workdayEnd! } : {}),
    });
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }

  const json = flags["json"] === true;
  if (json) {
    okJson({ ok: true, ...snapshotJson(snapshot) });
    return 0;
  }

  ok(
    `${snapshot.counts.events} events · ${snapshot.counts.conflicts} conflicts · ${snapshot.counts.focusBlocks} focus blocks · ${snapshot.counts.externalOrganizers} external organizers`,
  );
  for (const c of snapshot.conflicts) {
    ok(`  conflict: "${c.a.title}" ↔ "${c.b.title}" (${c.overlapMinutes}m overlap)`);
  }
  for (const f of snapshot.focusBlocks) {
    ok(`  focus: ${f.start} → ${f.end} (${f.minutes}m)`);
  }
  for (const x of snapshot.externalOrganizers) {
    ok(`  external: "${x.title}" organized by ${x.organizer} (${x.domain})`);
  }
  return 0;
}
