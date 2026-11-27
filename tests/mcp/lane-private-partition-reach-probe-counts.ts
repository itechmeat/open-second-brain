/**
 * The shared-only list-count comparison of the read and write probes
 * (change `lane-reach-residuals`, package 18, design R14).
 *
 * For every list or count call a probe makes below local reach on its
 * store with `private` entries, a twin store holding only the fixture's
 * `shared` records answers the same call at local reach, and every count,
 * total and list length of the remote answer must equal the twin's: an
 * answer below local reach counts what the caller may read, as a machine
 * that holds only `shared` would. A mismatch fails, naming the call and
 * the field.
 *
 * A call that may differ on purpose is listed in {@link MAY_DIFFER} with
 * its reason. The list is written here, before the comparison, so a
 * difference is either a reason on this list or a finding. A call whose
 * answer depends on the reach itself (the same shared-only store answers
 * it differently below and at local reach) is compared with the twin
 * below local reach instead, so its counts are still checked against a
 * store with no `private` entry.
 */

/** Why a call's counts may differ from the shared-only twin's at local reach, and what they are compared with. */
export interface MayDiffer {
  readonly reason: string;
  /** `below-local-reach`: compared with the shared-only twin below local reach; `none`: not compared. */
  readonly compare: "below-local-reach" | "none";
}

/**
 * The calls that may differ, keyed `<tool> <verb>` (the verb as the probe
 * labels it), or `<tool> <verb> <field path>` for one field. A key covers
 * every call and field it is a prefix of.
 */
export const MAY_DIFFER: Readonly<Record<string, MayDiffer>> = {
  "second_brain_query (no verb)": {
    compare: "below-local-reach",
    reason:
      "pages are listed and counted at the transport's reach (`src/mcp/tools.ts:261`): a vault page reserved against remote reads (the fixture's `visibility: private` note) is not counted below local reach on any store",
  },
  "brain_brief morning": {
    compare: "below-local-reach",
    reason:
      "the trigger and open-decision sections are the operator queue, rendered at local reach only (`src/mcp/brain/brief-view-tools.ts:119`)",
  },
  "brain_brief today recent_activity": {
    compare: "none",
    reason:
      "recent activity counts the log events of the run's own earlier calls in a moving window: it varies from run to run on one store, so it counts no record of the fixture",
  },
  "brain_brief today totals.recentActivityTotal": {
    compare: "none",
    reason: "the total of the recent activity above",
  },
  "brain_analytics attention_flows": {
    compare: "none",
    reason:
      "the private store holds the default flow in `private` (the fixture raises it), and a local list seeds the default flow on a store that holds none, so no shared-only store answers without it",
  },
  "brain_procedural_graph hints": {
    compare: "none",
    reason:
      "the fixture's rejection of a drafted name is held in `private` in the private store and in `shared` in the twin, and the learn that runs on every partition drafts the name again only beside a rejection it may act on, so the hints differ by that one name (taking the rejection out of the twin moves the difference to the pending list instead)",
  },
  "second_brain_status (no verb)": {
    compare: "below-local-reach",
    reason:
      "the twin's own calls at local reach generate the machine's install key on first use (`src/core/config.ts:769`), so its configuration lists one key more than a store only called below local reach",
  },
  "brain_event_trace (no verb)": {
    compare: "below-local-reach",
    reason:
      "measured: the twin answers it with one event more at local reach than below it on the same store, and the private store's answer equals the twin's below local reach",
  },
  "brain_agent_query (no verb)": {
    compare: "below-local-reach",
    reason:
      "contributions are read through the caller's reach view (`src/mcp/brain/query-agent-tools.ts:59`): the twin at local reach also counts its write-session log row, which the twin below local reach does not, and the private store's answer equals the twin's below local reach",
  },
  "brain_eval (no verb)": {
    compare: "below-local-reach",
    reason:
      "retrieval at local reach also searches the store's own rows and notes the rows its scope drops (`src/core/search/pipeline/assemble.ts:546`)",
  },
  "brain_file_context (no verb)": {
    compare: "below-local-reach",
    reason:
      "retrieval at local reach also searches the store's own rows and notes the rows its scope drops (`src/core/search/pipeline/assemble.ts:546`)",
  },
};

/** The rule of {@link MAY_DIFFER} for one field of one call, if any. */
function ruleFor(call: string, path: string): MayDiffer | undefined {
  const field = `${call} ${path}`;
  const key = Object.keys(MAY_DIFFER)
    .filter(
      (k) =>
        field === k ||
        field.startsWith(`${k} `) ||
        field.startsWith(`${k}.`) ||
        call === k ||
        call.startsWith(`${k} `),
    )
    .toSorted((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : MAY_DIFFER[key];
}

/**
 * The read verbs that list or count rather than name one entry. A tool
 * with no verb counts as one when it reads ({@link isListOrCountCall}).
 */
export const LIST_COUNT_VERBS: ReadonlySet<string> = new Set([
  "list",
  "list_open",
  "summary",
  "aggregate",
  "collisions",
  "slots",
  "conflicts",
  "events",
  "hints",
  "history",
  "status",
  "usage",
  "scan",
  "morning",
  "daily",
  "weekly",
  "monthly",
  "operator",
  "digest",
  "today",
  "timeline",
  "attention_flows",
  "belief_evolution",
  "concept_synthesis",
  "gate_list",
  "gate_summary",
]);

/**
 * Whether a call of `tool` (its registry kind) with the probe's verb label
 * `verb` (`(no verb)`, `<verb>` or `<verb> <key>=<sub>`) lists or counts.
 */
export function isListOrCountCall(kind: string, verb: string): boolean {
  if (verb === "(no verb)") return kind === "read";
  return LIST_COUNT_VERBS.has(verb.split(" ")[0]!);
}

/** A numeric field that counts: its key names a count, a total or a size. */
const COUNT_KEY =
  /count|total|retrieved|pool|scanned|matched|hits|size|length|omitted|withheld|skipped|^n$|_n$/i;

/** The answer's structured payload, or null when it carries none. */
function payloadOf(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record["isError"] === true || "error" in record) return null;
  return record["structuredContent"] ?? null;
}

/**
 * The counts of an answer, by path: every array's length and every
 * count-named number, outside the elements of an array (an element's own
 * fields describe one entry, not the answer).
 */
export function countsOf(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      out.set(`${path}.length`, value.length);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      const at = path === "" ? key : `${path}.${key}`;
      if (typeof field === "number" && COUNT_KEY.test(key)) out.set(at, field);
      else walk(field, at);
    }
  };
  walk(payloadOf(text), "");
  return out;
}

/**
 * The fields where the remote answer's counts differ from the shared-only
 * twin's (`twin`, at local reach; `twinBelow`, below local reach, for a
 * field {@link MAY_DIFFER} compares there), as `<call> <path>: remote <n>,
 * twin <m>`. A field {@link MAY_DIFFER} does not compare, or one whose
 * twin answer is missing or carries no payload, is left out.
 */
export function countMismatches(
  call: string,
  remote: string,
  twin: string,
  twinBelow: string | undefined,
): string[] {
  const a = countsOf(remote);
  const local = countsOf(twin);
  const below = twinBelow === undefined ? new Map<string, number>() : countsOf(twinBelow);
  if (a.size === 0) return [];
  const out: string[] = [];
  for (const path of new Set([...a.keys(), ...local.keys(), ...below.keys()])) {
    const rule = ruleFor(call, path);
    if (rule?.compare === "none") continue;
    const other = rule?.compare === "below-local-reach" ? below : local;
    if (other.size === 0) continue;
    if (a.get(path) !== other.get(path)) {
      const side = rule?.compare === "below-local-reach" ? "twin below local reach" : "twin";
      out.push(
        `${call} ${path}: remote ${a.get(path) ?? "absent"}, ${side} ${other.get(path) ?? "absent"}`,
      );
    }
  }
  return out;
}
