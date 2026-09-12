/**
 * Every tool in the live table, with the arguments that DRIVE each of its
 * code paths - the one enumeration two isolation axes share.
 *
 * It was `tests/mcp/agent-scope-matrix.test.ts`'s alone until a second
 * axis needed it. `tests/mcp/visibility-matrix.test.ts` asks a different
 * question of the same surface - may a caller at this transport reach see
 * this page, rather than may this owner see this artifact - and a second
 * copy of the recipes would have been a second answer to "what is the
 * whole surface", which is precisely the enumeration defect the owner
 * matrix was built to remove.
 *
 * What lives here is the INVOCATION: the tool name, the arguments each of
 * its code paths needs, and the fixture constants those arguments quote.
 * The owner-axis CLASSIFICATION ({@link REASON} and the two buckets it
 * sorts calls into) lives here too, because a reason is per-call and the
 * calls are here; the visibility axis carries its own classification in
 * its own file rather than borrowing this one's.
 *
 * Data and pure helpers only - no `test()`, no fixture seeding, no
 * `beforeEach`. A test file importing another test file would run that
 * file's suite twice.
 */

import { runHygieneScan } from "../../src/core/brain/hygiene/scan.ts";
import { scanTriggers } from "../../src/core/brain/triggers/scan.ts";
import { transitionTrigger } from "../../src/core/brain/triggers/store.ts";

export const OWNER_A = "agent-a";
export const OWNER_B = "agent-b";
export const QUERY = "lattice widgets";
/** Probe path whose derived query terms appear verbatim in every note. */
export const PROBE = "lattice.md";
export const PROBE_TERMS = `${PROBE} lattice`;

/**
 * The string the isolation probe hunts for.
 *
 * It appears ONLY inside artifacts owned by {@link OWNER_A} - in their
 * ids, their paths, their topics, their titles and their body prose - so
 * one `not.toContain` catches every channel a surface might use to name
 * one of them, without the probe having to know which field carried it.
 */
export const CROSS_OWNER_MARKER = "secretmarkerzz";

/** The UTC day the fixture's log event lands on; `brain_event_trace` selects by date. */
export const LOG_EVENT_DATE = "2026-05-04";

/** Shared hub the fixture's MOC audit is driven against. */
export const HUB_ID = "pref-hub";
/** Shared preference every owner-A artifact references, and the probe's link target. */
export const SHARED_ID = "pref-shared";
/** Title of {@link SHARED_ID}; the term `brain_unlinked_mentions` matches on. */
export const SHARED_TITLE = "Shared Pref";
/**
 * Topic of {@link SHARED_ID}, and deliberately ALSO the topic of one
 * owner-A preference.
 *
 * A `topic:` argument is a fan-out: `buildBeliefEvolution` resolves it to
 * every `pref-`/`ret-` page carrying that topic, so a caller naming a
 * topic it is entitled to still reaches preferences it is not. Probing
 * that with a marker-bearing topic would prove nothing - the marker
 * would be the caller's own argument echoed back.
 */
export const SHARED_TOPIC = "shared";
/** Slug of the ownerless signal that evidences the owner-A preference. */
export const NEUTRAL_SIGNAL_SLUG = "neutral-probe-signal";

/** How a surface learns which agent is asking. */
export const SCOPE_SOURCE = Object.freeze({
  /** An explicit `agent_scope` input argument. */
  argument: "argument",
  /** `ServerContext.agentName`, for a surface that takes no arguments. */
  serverIdentity: "server-identity",
} as const);

export type ScopeSource = (typeof SCOPE_SOURCE)[keyof typeof SCOPE_SOURCE];

export interface ScopedSurface {
  readonly name: string;
  readonly source: ScopeSource;
  /**
   * True when isolation is behind `integrity.owner_scope_delivery`.
   * Preference-backed surfaces are gated (their scope may be defaulted
   * from the server identity, which would narrow a vault that never
   * opted in). Search-backed surfaces are not: their scope only ever
   * arrives as an explicit per-call argument, so honouring it cannot
   * narrow anything the caller did not ask to narrow.
   */
  readonly gated: boolean;
}

/** Content-returning tools that consult the ownership rule. */
export const SCOPED_SURFACES: ReadonlyArray<ScopedSurface> = [
  { name: "brain_context", source: SCOPE_SOURCE.serverIdentity, gated: true },
  { name: "brain_context_pack", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_pre_compress_pack", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_anticipatory_context", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_brief", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_retrieval_plan", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_query", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_search", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_search_expand", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_file_context", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_deep_synthesis", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_search_by_source", source: SCOPE_SOURCE.argument, gated: false },
  { name: "second_brain_query", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_agent_query", source: SCOPE_SOURCE.argument, gated: false },
];

/**
 * One probe recipe: the arguments that DRIVE one mode / view / operation
 * of a tool against the two-owner fixture, and a written reason for the
 * classification THAT CALL carries.
 *
 * The reason lives on the call rather than on the tool because a tool is
 * not one classification. `brain_analytics view=concept_synthesis`
 * reaches another owner's body prose and `view=dedup` reaches an ingest
 * counter; one entry claiming one reason for both is the same
 * unexecuted label this file exists to remove, and it is how
 * `concept_synthesis` shipped unfiltered behind a green `view=timeline`.
 */

export interface ProbeCall {
  /**
   * Arguments the isolation probe calls the tool with, or a function of
   * the vault that computes them after the fixture is seeded.
   *
   * `{}` only where the tool's input schema declares no property the
   * probe needs, never as a stand-in for "I did not work out what
   * drives this one". The function form exists for the one recipe whose
   * arguments are derived from vault state - `brain_hygiene mode=apply`
   * selects findings by id, and a static id would drive a call that
   * matches nothing.
   */
  readonly args: Record<string, unknown> | ((vault: string) => Record<string, unknown>);
  /** Why THIS call sits in the bucket it sits in. */
  readonly reason: string;
  /**
   * Test-name suffix for a recipe whose arguments are computed, where
   * the dispatch key cannot be read off a literal record.
   */
  readonly label?: string;
}

/** One tool, and every call recipe the probe drives it with. */
export interface ProbeEntry {
  readonly name: string;
  readonly calls: ReadonlyArray<ProbeCall>;
}

/** A single-recipe entry, spelled without the array ceremony. */
export function one(args: ProbeCall["args"], reason: string): ReadonlyArray<ProbeCall> {
  return [{ args, reason }];
}

/**
 * Shortest reason this file accepts. A one-word reason is the bare name
 * list with extra punctuation, so the floor is set above it.
 */
export const REASON_MIN_CHARS = 24;

/**
 * Refuse an entry that carries no call recipes or no reason.
 *
 * `unknown` rather than {@link ProbeEntry}: the compiler already rejects
 * a bare name, and this is the second lock, for a `satisfies`-free cast
 * or a bucket built at runtime. It runs at module load over every entry,
 * so a nameless-args entry fails the whole file rather than one test.
 */
export function assertProbeEntry(bucket: string, entry: unknown): ProbeEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${bucket}: every entry must be a {name, calls} record`);
  }
  const row = entry as Partial<ProbeEntry>;
  if (typeof row.name !== "string" || row.name.length === 0) {
    throw new Error(`${bucket}: every entry must name a tool`);
  }
  if (!Array.isArray(row.calls) || row.calls.length === 0) {
    throw new Error(
      `${bucket}: ${row.name} has no 'calls'; a bucket entry the probe cannot call is a label`,
    );
  }
  for (const recipe of row.calls) {
    const shaped = recipe as Partial<ProbeCall>;
    const args = shaped.args;
    const argsOk =
      typeof args === "function" ||
      (typeof args === "object" && args !== null && !Array.isArray(args));
    if (!argsOk) {
      throw new Error(
        `${bucket}: ${row.name} has a call with no 'args'; a recipe the probe cannot call is a label`,
      );
    }
    if (typeof shaped.reason !== "string" || shaped.reason.trim().length < REASON_MIN_CHARS) {
      throw new Error(
        `${bucket}: ${row.name} needs a reason of at least ${REASON_MIN_CHARS} characters`,
      );
    }
  }
  return row as ProbeEntry;
}

/**
 * Reasons shared by more than one call, named once.
 *
 * The alternative - hundreds of hand-written sentences, most of them
 * saying the same thing in different words - is the natural-language
 * word list this repository forbids, and it would make two calls with
 * the same classification look like two different classifications.
 *
 * Each of these is a CLAIM the differential below executes. Every reason
 * except {@link REASON.ownerFiltered} asserts that the call cannot name
 * an owner-private artifact AT ALL, so the probe requires the marker to
 * be absent even with the gate OFF, where nothing is hidden. A call that
 * surfaces the marker unscoped has a false reason and fails here, which
 * is the difference between a classification and a label.
 */
export const REASON = Object.freeze({
  sessionLane:
    "session transcript lane: the records are keyed by session and turn, not by an " +
    "owner-taggable page, so `pageOwner` has no subject to read.",
  catalog:
    "a catalog of this server's own surface - the tool table, the skills manifest, the " +
    "preset list, the install's own wiring - answered without opening a vault page, so no " +
    "page's owner is reachable.",
  writerEcho:
    "a writer: the response echoes the artifact this very call created, planned or refused, " +
    "so the only ownership it can name is the one the caller supplied.",
  callerNamedArtifact:
    "answers only about the artifact the caller already named, and every response shape it " +
    "can produce is distinguishable from a refusal - so a filter here would announce the " +
    "existence of the page it is meant to hide.",
  ownerlessLane:
    "reads a lane that carries no `owner:` field at all - triggers, entities, decisions, " +
    "obligations, telemetry ledgers - so there is no ownership claim on disk to enforce.",
  aggregateOnly:
    "reports counts, rates and verdicts over the vault with no per-artifact identity in the " +
    "payload; a hidden page contributes to a number the caller cannot decompose.",
  ownerFiltered:
    "reaches owner-taggable artifacts and is filtered through the ownership rule before it " +
    "answers (a-label-is-not-a-boundary, U3); the probe below is what holds that true.",
  configuredCorpus:
    "operates on an operator-configured corpus outside `Brain/` - a dataset file, a source " +
    "directory, a codegraph index - which carries no page frontmatter to own.",
  signalCluster:
    "reads the pre-dream review over INBOX SIGNAL clusters. A signal carries no `owner:` " +
    "anywhere in this product, so every row here - a topic, a decision, a count - is a fold " +
    "over shared artifacts and names no owner-private page.",
  recompileLane:
    "plans a recompile of DERIVED pages whose sources moved (`Brain/sources`, `Brain/reports`). " +
    "The fixture holds no derived page, so this recipe reaches no owner-taggable content; the " +
    "gap is recorded rather than papered over with a recipe that cannot fail.",
  noteWriteLedger:
    "reads the `note-write` event ledger inside the Brain log. The rows are a write id, an " +
    "operation, a target PATH, two content digests and the agent that recorded them - no page " +
    "is ever opened, so there is no frontmatter for the ownership rule to read. The honest " +
    "half: a target path names a note file that MAY carry an `owner:`, and this surface " +
    "reports the path either way, so an owner-private note an agent wrote is discoverable by " +
    "path here. The gap is recorded rather than closed by reading every named page, which " +
    "would turn a log listing into a fan-out over the whole vault; the revert task is where " +
    "the ownership question is decided, because that is where a caller acts on a target " +
    "rather than reading that one exists.",
  noteRevertPlan:
    "plans what undoing the note writes a selector names WOULD do, and applies nothing - the " +
    "apply is CLI-only by design. It is the one recipe in this entry that opens page bytes: it " +
    "hashes each named target to decide whether the file drifted since the write it would undo. " +
    "What it PUBLISHES is a digest, a path, an action token and a refusal reason, never a byte " +
    "of the page, so an owner-private note reaches this surface as the same path the listing " +
    "beside it already reports and as nothing more.",
  signalAuthorship:
    "groups SIGNALS by the `agent:` that wrote them. A signal carries no `owner:` anywhere in " +
    "this product, so the agent column names the author of a SHARED artifact - the same fact " +
    "`brain_agent_query`'s roster publishes by design - and never an owner-private page.",
});

/**
 * The one reason that claims a call REACHES owner-bearing content.
 *
 * Named as a set rather than compared inline so the differential's
 * exemption is an explicit list of classifications, not a silence: every
 * other reason in {@link REASON} asserts unreachability, and the probe
 * holds it to that.
 */
export const REASONS_REACHING_OWNER_CONTENT: ReadonlySet<string> = new Set([REASON.ownerFiltered]);

/**
 * Measured shape of the probe, quoted in `docs/architecture.md`,
 * `docs/mcp.md` and the release notes. Equalities, not floors - see the
 * test that reads them.
 */
export const PROBE_ENTRY_COUNT = 101;
export const PROBE_RECIPE_COUNT = 231;
export const PROBE_TWO_SIDED_COUNT = 32;

/**
 * `brain_trigger` read arguments, with the queue populated first.
 *
 * `list` and `history` read what a PRIOR scan persisted, so against an
 * empty queue their isolation claim is untestable - the "clean sweep
 * over an empty fixture" this file exists to prevent. The scan is done
 * HERE rather than in {@link seedTwoOwnerFixture} because a populated
 * queue suppresses `brain_idea_discovery`: idea discovery skips
 * candidates already queued, so seeding globally would silently empty
 * that probe instead.
 *
 * `terminal` dismisses what the scan created, because `history` reports
 * only terminal records and `list` reports only non-terminal ones - one
 * queue state cannot exercise both. Each recipe gets its own vault, so
 * the two states never collide.
 */
export function triggerQueueArgs(
  operation: string,
  terminal = false,
): (vault: string) => Record<string, unknown> {
  return (vault: string) => {
    const now = new Date();
    const scan = scanTriggers(vault, { now });
    if (terminal) {
      for (const record of scan.created) transitionTrigger(vault, record.id, "dismiss", { now });
    }
    return { operation };
  };
}

/**
 * `brain_hygiene mode=apply` arguments, derived from a live scan.
 *
 * A finding id is `sha256(targets.sorted().join("\0")).slice(0, 12)`
 * (`hygiene/detectors/id.ts`) - derivable rather than secret, which is
 * why withholding it from the scan was never the boundary. A LITERAL id
 * in the recipe would select nothing and the probe would go green over
 * an apply that did nothing, which is exactly how this mode shipped
 * planning against the unfiltered report.
 */
export function hygieneApplyArgs(vault: string): Record<string, unknown> {
  return {
    mode: "apply",
    ids: runHygieneScan(vault, { now: new Date() }).findings.map((f) => f.id),
  };
}

/**
 * Tools that return vault content but are NOT owner-scoped after this
 * wave. Listed with a reason so the gap is recorded rather than
 * forgotten — this is the honest half of the matrix.
 */
export const UNSCOPED_CONTENT: ReadonlyArray<ProbeEntry> = [
  {
    name: "brain_writes",
    calls: [
      { args: { action: "list" }, reason: REASON.noteWriteLedger },
      { args: { action: "list", op: "update" }, reason: REASON.noteWriteLedger },
      {
        args: { action: "plan_revert", path: "notes/shared.md" },
        reason: REASON.noteRevertPlan,
      },
    ],
  },
  { name: "brain_session_grep", calls: one({ query: QUERY }, REASON.sessionLane) },
  { name: "brain_session_expand", calls: one({ id: "sess-probe:0" }, REASON.sessionLane) },
  {
    name: "brain_session_summary",
    calls: [
      { args: { operation: "list" }, reason: REASON.sessionLane },
      { args: { operation: "get", session_id: "sess-probe" }, reason: REASON.sessionLane },
      {
        args: { operation: "write", session_id: "sess-probe", request: "probe digest" },
        reason: REASON.sessionLane,
      },
    ],
  },
  {
    name: "brain_session_describe",
    calls: one({ session_id: "sess-probe" }, REASON.sessionLane),
  },
  {
    name: "brain_note_history",
    calls: one(
      { path: "notes/shared.md" },
      "git commit metadata (subjects, authors, dates) for a path the caller already names, " +
        "read from the repository rather than from page frontmatter. Every response shape it " +
        "can produce - no repo, no commits, N phases - is distinguishable from a refusal, so a " +
        "filter here would announce the existence of the page it is meant to hide while the " +
        "same history stays readable through git itself.",
    ),
  },
  {
    name: "brain_artifact_get",
    calls: one(
      { artifact_id: "art-never-issued" },
      "replays, by opaque id, a payload this process already returned to this caller - and " +
        "already filtered under whatever scope produced it. The stored envelope keeps no page " +
        "identity, so there is nothing left to re-apply the ownership rule to.",
    ),
  },
  {
    name: "brain_pre_compact_extract",
    calls: one(
      { session_id: "sess-probe", turn_start: 1, turn_end: 2, text: QUERY },
      "extracts from caller-supplied text, not the vault: every byte of the response is " +
        "derived from the `text` argument the caller passed in.",
    ),
  },
  {
    name: "brain_recall_gate",
    calls: one(
      { prompt: QUERY },
      "a verdict over a caller-supplied question - recall/skip and why - with no artifact " +
        "identity and no body prose in the payload.",
    ),
  },
];

/**
 * Everything else: metadata, analytics, maintenance, writers, catalog.
 *
 * A tool with several modes, views or operations carries one recipe per
 * mode, view or operation. One executed view is not an executed
 * classification, and the two leaks this file missed - `brain_hygiene
 * mode=apply` writing across the boundary, and three of
 * `brain_analytics`' five views returning another owner's prose - were
 * both hidden behind a single green recipe for a sibling mode.
 */
export const NON_CONTENT: ReadonlyArray<ProbeEntry> = [
  { name: "brain_agenda", calls: one({ events: [] }, REASON.writerEcho) },
  {
    name: "brain_agent_diff",
    calls: [
      { args: { mode: "browse" }, reason: REASON.ownerFiltered },
      { args: { mode: "search", query: CROSS_OWNER_MARKER }, reason: REASON.ownerFiltered },
      { args: { mode: "diff" }, reason: REASON.ownerFiltered },
      { args: { mode: "map" }, reason: REASON.ownerFiltered },
    ],
  },
  {
    name: "brain_analytics",
    calls: [
      { args: { view: "timeline" }, reason: REASON.ownerFiltered },
      { args: { view: "attention_flows", operation: "list" }, reason: REASON.ownerlessLane },
      // The topic is the SHARED one on purpose. A marker-bearing topic
      // would be the caller's own argument echoed back, which is not a
      // disclosure; the fixture instead gives an owner-A preference that
      // shared topic, so the fan-out from one topic to every preference
      // carrying it is what the probe measures.
      { args: { view: "belief_evolution", topic: SHARED_TOPIC }, reason: REASON.ownerFiltered },
      {
        args: { view: "concept_synthesis", id: SHARED_ID, include_unlinked: true },
        reason: REASON.ownerFiltered,
      },
      { args: { view: "dedup" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_append_note",
    calls: one({ path: "notes/shared.md", content: "probe append" }, REASON.writerEcho),
  },
  {
    name: "brain_apply_evidence",
    calls: one(
      { pref_id: "pref-shared", artifact: "[[notes/shared.md]]", result: "applied" },
      REASON.writerEcho,
    ),
  },
  { name: "brain_audit", calls: one({ pref_id: "pref-shared" }, REASON.callerNamedArtifact) },
  { name: "brain_backlinks", calls: one({ id: SHARED_ID }, REASON.ownerFiltered) },
  {
    name: "brain_benchmark",
    calls: one(
      { operation: "run", dataset: "datasets/probe-absent.jsonl" },
      REASON.configuredCorpus,
    ),
  },
  {
    name: "brain_bridges",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "discover" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "accept", source: "notes/shared.md", target: "notes/owned-a.md" },
        reason: REASON.ownerlessLane,
      },
      {
        args: { operation: "dismiss", source: "notes/shared.md", target: "notes/owned-a.md" },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_claims",
    calls: [
      { args: { operation: "current" }, reason: REASON.ownerFiltered },
      { args: { operation: "at", at: LOG_EVENT_DATE }, reason: REASON.ownerFiltered },
      { args: { operation: "history" }, reason: REASON.ownerFiltered },
      { args: { operation: "replaced", id: SHARED_ID }, reason: REASON.callerNamedArtifact },
      { args: { operation: "contests", id: SHARED_ID }, reason: REASON.callerNamedArtifact },
      { args: { operation: "rebuild" }, reason: REASON.aggregateOnly },
    ],
  },
  {
    name: "brain_clusters",
    calls: [
      { args: { operation: "list" }, reason: REASON.aggregateOnly },
      { args: { operation: "run" }, reason: REASON.ownerFiltered },
    ],
  },
  { name: "brain_codegraph_report", calls: one({}, REASON.configuredCorpus) },
  {
    name: "brain_context_pack_outcome",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "summary" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "post", sample_id: "probe-sample", first_pass_success: true },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_context_presets",
    calls: [
      { args: { operation: "show" }, reason: REASON.catalog },
      { args: { operation: "suggest" }, reason: REASON.catalog },
      { args: { operation: "diff" }, reason: REASON.catalog },
    ],
  },
  {
    name: "brain_context_receipts",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "summary" }, reason: REASON.ownerlessLane },
      { args: { operation: "show", id: "rcpt-probe-absent" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_create_note",
    calls: one({ path: "notes/probe-created.md" }, REASON.writerEcho),
  },
  {
    name: "brain_dead_ends",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "record", approach: "probe approach", reason: "probe reason" },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_decision",
    calls: [
      { args: { action: "list" }, reason: REASON.ownerlessLane },
      { args: { action: "show", id: "dec-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "history" }, reason: REASON.ownerlessLane },
      { args: { action: "recall" }, reason: REASON.ownerlessLane },
      { args: { action: "similar", id: "dec-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "compare", id: "dec-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "outcome", id: "dec-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "rate", id: "dec-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "record", title: "probe decision" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_delete_by_source",
    calls: one({ source_file: "sources/paper.md" }, REASON.writerEcho),
  },
  {
    name: "brain_derive_fact",
    calls: one(
      {
        slug: "probe-derived",
        topic: "probe",
        principle: "probe derived principle",
        premises: [`[[${SHARED_ID}]]`],
        level: "deduced",
      },
      REASON.writerEcho,
    ),
  },
  {
    name: "brain_design_note",
    calls: [
      // The grounding stores carry no `owner:`, but the plan envelope's
      // `link_candidates` names Brain artifact ids - so this recipe DOES
      // reach owner-taggable content and is filtered, rather than being
      // unable to name it.
      { args: { topic: "probe topic" }, reason: REASON.ownerFiltered },
      {
        args: {
          topic: "probe topic",
          note: {
            title: "Probe",
            alternatives: [
              {
                name: "only",
                approach: "probe approach",
                tradeoffs: "probe tradeoffs",
                recommended: true,
              },
            ],
          },
        },
        reason: REASON.writerEcho,
        label: "commit",
      },
    ],
  },
  { name: "brain_diarize", calls: one({ entity: "probe-entity" }, REASON.ownerlessLane) },
  {
    name: "brain_distill_source",
    calls: one({ source_path: "sources/paper.md", claims: ["probe claim"] }, REASON.writerEcho),
  },
  {
    name: "brain_doctor",
    calls: [
      { args: {}, reason: REASON.ownerFiltered },
      { args: { strict: true }, reason: REASON.ownerFiltered },
      { args: { repair: true }, reason: REASON.ownerFiltered },
    ],
  },
  {
    name: "brain_dream",
    calls: [
      { args: { action: "list" }, reason: REASON.aggregateOnly },
      { args: { action: "run", dry_run: true }, reason: REASON.ownerFiltered },
      { args: { action: "stage" }, reason: REASON.ownerFiltered },
      { args: { action: "validate", run_id: "run-probe-absent" }, reason: REASON.aggregateOnly },
      { args: { action: "apply", run_id: "run-probe-absent" }, reason: REASON.aggregateOnly },
      { args: { action: "discard", run_id: "run-probe-absent" }, reason: REASON.aggregateOnly },
      { args: { action: "retriage", run_id: "run-probe-absent" }, reason: REASON.aggregateOnly },
    ],
  },
  {
    name: "brain_entity",
    calls: [
      { args: { view: "list" }, reason: REASON.ownerlessLane },
      { args: { view: "get", query: "probe-entity" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_eval",
    calls: one({ dataset: "datasets/probe-absent.jsonl" }, REASON.configuredCorpus),
  },
  { name: "brain_event_trace", calls: one({ date: LOG_EVENT_DATE }, REASON.ownerFiltered) },
  {
    name: "brain_expire",
    calls: one(
      { id: `sig-2026-05-01-${NEUTRAL_SIGNAL_SLUG}`, expires: "2030-01-01" },
      REASON.callerNamedArtifact,
    ),
  },
  {
    name: "brain_extract_signals",
    calls: [
      { args: { session: "sess-probe" }, reason: REASON.sessionLane },
      {
        args: {
          session: "sess-probe",
          items: [
            {
              topic: "probe",
              signal: "positive",
              principle: "probe principle",
              confidence: 0.9,
            },
          ],
        },
        reason: REASON.writerEcho,
        label: "commit",
      },
    ],
  },
  {
    name: "brain_feedback",
    calls: one(
      { topic: "probe", signal: "positive", principle: "probe principle" },
      REASON.writerEcho,
    ),
  },
  { name: "brain_foresight", calls: one({}, REASON.aggregateOnly) },
  {
    name: "brain_generation_reports",
    calls: [
      { args: { action: "list" }, reason: REASON.ownerlessLane },
      { args: { action: "summary" }, reason: REASON.ownerlessLane },
      {
        args: {
          action: "record",
          handoff_kind: "context_pack",
          ref: "probe-ref",
          agent: OWNER_B,
          prompt: "probe prompt",
          enable: true,
        },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  { name: "brain_health", calls: one({}, REASON.ownerFiltered) },
  {
    name: "brain_hygiene",
    calls: [
      { args: { mode: "scan" }, reason: REASON.ownerFiltered },
      { args: { mode: "refresh", dry_run: true }, reason: REASON.recompileLane },
      // The ids come from a LIVE scan of the seeded fixture. A literal
      // id here would select nothing, and a recipe that selects nothing
      // is how `apply` kept a green probe while planning against the
      // unfiltered report and retiring another owner's preference.
      { args: hygieneApplyArgs, label: "mode=apply", reason: REASON.ownerFiltered },
    ],
  },
  { name: "brain_idea_discovery", calls: one({}, REASON.ownerFiltered) },
  { name: "brain_idea_lineage", calls: one({ id: SHARED_ID }, REASON.callerNamedArtifact) },
  {
    name: "brain_ingest_batch_plan",
    calls: one({ source_dir: "sources" }, REASON.configuredCorpus),
  },
  {
    name: "brain_ingest_source",
    calls: one(
      { source_path: "sources/paper.md", summary: "probe summary", entities: [] },
      REASON.writerEcho,
    ),
  },
  {
    name: "brain_intake_entities",
    calls: one({ entities: [], source: "sources/paper.md" }, REASON.writerEcho),
  },
  { name: "brain_intent_review", calls: one({}, REASON.signalCluster) },
  {
    name: "brain_intention",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "show" }, reason: REASON.ownerlessLane },
      { args: { operation: "set", text: "probe intention" }, reason: REASON.ownerlessLane },
      { args: { operation: "move", scope: "probe-scope" }, reason: REASON.ownerlessLane },
    ],
  },
  { name: "brain_knowledge_gaps", calls: one({}, REASON.aggregateOnly) },
  {
    name: "brain_labels",
    calls: [
      { args: { operation: "show", path: "notes/shared.md" }, reason: REASON.callerNamedArtifact },
      {
        args: {
          operation: "assign",
          path: "notes/shared.md",
          dimension: "probe",
          value: "probe",
        },
        reason: REASON.callerNamedArtifact,
      },
      {
        args: { operation: "remove", path: "notes/shared.md", dimension: "probe" },
        reason: REASON.callerNamedArtifact,
      },
    ],
  },
  {
    name: "brain_lifecycle",
    calls: [
      { args: { action: "curator" }, reason: REASON.aggregateOnly },
      { args: { action: "tip", id: SHARED_ID }, reason: REASON.callerNamedArtifact },
      {
        args: { action: "tombstone", path: "notes/shared.md", reason: "probe" },
        reason: REASON.writerEcho,
      },
      {
        args: {
          action: "supersede",
          predecessor: "notes/shared.md",
          successor: `[[${SHARED_ID}]]`,
          reason: "probe",
        },
        reason: REASON.writerEcho,
      },
      {
        args: {
          action: "temporal-replace",
          predecessor: "notes/shared.md",
          successor: "notes/renamed.md",
          at: LOG_EVENT_DATE,
        },
        reason: REASON.writerEcho,
      },
    ],
  },
  {
    name: "brain_maintenance",
    calls: [
      { args: { operation: "status" }, reason: REASON.aggregateOnly },
      { args: { operation: "run", force: true }, reason: REASON.aggregateOnly },
    ],
  },
  { name: "brain_mcp_landscape", calls: one({}, REASON.catalog) },
  {
    name: "brain_memory_bridge",
    calls: [
      { args: {}, reason: REASON.writerEcho },
      {
        args: { action: "add", target: "memory", content: "probe memory" },
        reason: REASON.writerEcho,
      },
      {
        args: { action: "replace", target: "memory", content: "probe memory" },
        reason: REASON.writerEcho,
      },
    ],
  },
  { name: "brain_moc_audit", calls: one({ id: HUB_ID }, REASON.ownerFiltered) },
  { name: "brain_note", calls: one({ text: "probe note" }, REASON.writerEcho) },
  {
    name: "brain_note_lifecycle",
    calls: [
      {
        args: { action: "rename", path: "notes/shared.md", to: "notes/renamed.md" },
        reason: REASON.writerEcho,
      },
      {
        args: { action: "move", path: "notes/shared.md", to: "notes/moved.md" },
        reason: REASON.writerEcho,
      },
      { args: { action: "archive", path: "notes/shared.md" }, reason: REASON.writerEcho },
      { args: { action: "delete", path: "notes/shared.md" }, reason: REASON.writerEcho },
    ],
  },
  {
    name: "brain_obligation",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "show", slug: "probe-obligation" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "add", title: "probe obligation", cadence: "weekly" },
        reason: REASON.ownerlessLane,
      },
      { args: { operation: "done", slug: "probe-obligation" }, reason: REASON.ownerlessLane },
      { args: { operation: "remove", slug: "probe-obligation" }, reason: REASON.ownerlessLane },
    ],
  },
  { name: "brain_observed_use", calls: one({ entries: [] }, REASON.writerEcho) },
  {
    name: "brain_pinned_context",
    calls: [
      { args: { operation: "read" }, reason: REASON.ownerlessLane },
      { args: { operation: "write", content: "probe pinned" }, reason: REASON.ownerlessLane },
      { args: { operation: "append", content: "probe pinned" }, reason: REASON.ownerlessLane },
      { args: { operation: "clear" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_procedural_graph",
    calls: [
      { args: { operation: "show" }, reason: REASON.ownerlessLane },
      { args: { operation: "rebuild" }, reason: REASON.ownerlessLane },
      { args: { operation: "hints" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_procedural_memory",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "reconcile" }, reason: REASON.ownerlessLane },
      { args: { operation: "mark_used", id: "proc-probe-absent" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "mark_outcome", id: "proc-probe-absent", outcome: "success" },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_recall_feedback",
    calls: one({ query: QUERY, result_path: "notes/shared.md", verdict: "up" }, REASON.writerEcho),
  },
  {
    name: "brain_recall_telemetry",
    calls: [
      { args: { operation: "summary" }, reason: REASON.ownerlessLane },
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "gate_list" }, reason: REASON.ownerlessLane },
      { args: { operation: "gate_summary" }, reason: REASON.ownerlessLane },
      { args: { operation: "observed_reuse" }, reason: REASON.ownerlessLane },
      { args: { operation: "cost" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_recurrence",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "show", content_hash: "probe-hash" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "learn", content_hash: "probe-hash", scope: "probe" },
        reason: REASON.ownerlessLane,
      },
      {
        args: { operation: "forget", content_hash: "probe-hash", scope: "probe" },
        reason: REASON.ownerlessLane,
      },
      { args: { operation: "purge_source", source_id: "probe" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_research_report",
    calls: one(
      { title: "probe report", sources: ["sources/paper.md"], findings: ["probe finding"] },
      REASON.writerEcho,
    ),
  },
  { name: "brain_retention", calls: one({}, REASON.ownerFiltered) },
  { name: "brain_review_candidates", calls: one({}, REASON.ownerFiltered) },
  {
    name: "brain_route_metrics",
    calls: [
      { args: { operation: "summary" }, reason: REASON.ownerlessLane },
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_scaffold_stub",
    calls: [
      { args: { action: "list" }, reason: REASON.ownerFiltered },
      // A neutral target: naming the marker here would be the caller's
      // own argument echoed back by the writer, not a disclosure.
      { args: { action: "write", target: "Projects/ProbeStub" }, reason: REASON.writerEcho },
    ],
  },
  {
    name: "brain_secrets",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "run", name: "probe-secret", command: ["true"] },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_session_checkpoint",
    calls: one({ session_id: "sess-probe" }, REASON.writerEcho),
  },
  {
    name: "brain_skill_proposals",
    calls: [
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      { args: { operation: "learn" }, reason: REASON.ownerlessLane },
      { args: { operation: "usage" }, reason: REASON.ownerlessLane },
      { args: { operation: "recover" }, reason: REASON.ownerlessLane },
      { args: { operation: "evidence", slug: "probe-proposal" }, reason: REASON.ownerlessLane },
      { args: { operation: "accept", slug: "probe-proposal" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "reject", slug: "probe-proposal", note: "probe" },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  { name: "brain_sources", calls: one({}, REASON.signalAuthorship) },
  { name: "brain_stale_scan", calls: one({}, REASON.ownerFiltered) },
  { name: "brain_status", calls: one({}, REASON.aggregateOnly) },
  { name: "brain_switch_vault", calls: one({ name: "probe-profile" }, REASON.writerEcho) },
  {
    name: "brain_tension",
    calls: [
      { args: { action: "list" }, reason: REASON.ownerlessLane },
      { args: { action: "detect" }, reason: REASON.ownerlessLane },
      { args: { action: "show", id: "tension-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "confirm", id: "tension-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "dismiss", id: "tension-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { action: "resolve", id: "tension-probe-absent" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_tiers",
    calls: [
      { args: { operation: "check" }, reason: REASON.aggregateOnly },
      { args: { operation: "restore", path: "notes/shared.md" }, reason: REASON.aggregateOnly },
      { args: { operation: "accept", path: "notes/shared.md" }, reason: REASON.aggregateOnly },
    ],
  },
  {
    name: "brain_token_impact",
    calls: [
      { args: { operation: "summary" }, reason: REASON.ownerlessLane },
      { args: { operation: "list" }, reason: REASON.ownerlessLane },
      {
        args: { operation: "record", baseline_tokens: 100, packed_tokens: 50 },
        reason: REASON.ownerlessLane,
      },
      { args: { operation: "outcome", outcome: "first_pass" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_trigger",
    calls: [
      { args: triggerQueueArgs("list"), label: "operation=list", reason: REASON.ownerFiltered },
      { args: { operation: "scan" }, reason: REASON.ownerFiltered },
      {
        args: triggerQueueArgs("history", true),
        label: "operation=history",
        reason: REASON.ownerFiltered,
      },
      { args: { operation: "acknowledge", id: "trg-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { operation: "dismiss", id: "trg-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { operation: "act", id: "trg-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { operation: "suppress", id: "trg-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { operation: "unsuppress", id: "trg-probe-absent" }, reason: REASON.ownerlessLane },
    ],
  },
  {
    name: "brain_truth",
    calls: [
      { args: { operation: "slots" }, reason: REASON.ownerlessLane },
      { args: { operation: "conflicts" }, reason: REASON.ownerlessLane },
      { args: { operation: "collisions" }, reason: REASON.ownerlessLane },
      { args: { operation: "aggregate" }, reason: REASON.ownerlessLane },
      {
        args: {
          operation: "ingest",
          entity: "probe-entity",
          aspect: "probe-aspect",
          value: "probe",
          source: "[[notes/shared.md]]",
        },
        reason: REASON.ownerlessLane,
      },
    ],
  },
  {
    name: "brain_tune",
    calls: [
      { args: { operation: "status" }, reason: REASON.aggregateOnly },
      { args: { operation: "reset" }, reason: REASON.aggregateOnly },
      { args: { operation: "run" }, reason: REASON.aggregateOnly },
    ],
  },
  { name: "brain_unlinked_mentions", calls: one({ id: SHARED_ID }, REASON.ownerFiltered) },
  {
    name: "brain_update_note",
    calls: one({ path: "notes/shared.md", content: "probe update" }, REASON.writerEcho),
  },
  { name: "brain_watchdog", calls: one({}, REASON.aggregateOnly) },
  { name: "brain_write_batch", calls: one({ operations: [] }, REASON.writerEcho) },
  {
    name: "brain_write_session",
    calls: [
      { args: { op: "list" }, reason: REASON.ownerlessLane },
      { args: { op: "status", session_id: "ws-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { op: "open", target: "Brain/probe-session.md" }, reason: REASON.ownerlessLane },
      {
        args: { op: "submit", session_id: "ws-probe-absent", text: "probe text" },
        reason: REASON.ownerlessLane,
      },
      { args: { op: "approve", session_id: "ws-probe-absent" }, reason: REASON.ownerlessLane },
      { args: { op: "abandon", session_id: "ws-probe-absent" }, reason: REASON.ownerlessLane },
    ],
  },
  { name: "get_skill", calls: one({ name: "open-second-brain" }, REASON.catalog) },
  { name: "list_skills", calls: one({}, REASON.catalog) },
  { name: "schema_apply_mutations", calls: one({ mutations: [] }, REASON.writerEcho) },
  {
    name: "schema_inspect",
    calls: [
      { args: { view: "stats" }, reason: REASON.aggregateOnly },
      { args: { view: "graph" }, reason: REASON.aggregateOnly },
      { args: { view: "lint" }, reason: REASON.aggregateOnly },
      { args: { view: "orphans" }, reason: REASON.aggregateOnly },
      { args: { view: "packs" }, reason: REASON.catalog },
      { args: { view: "active_pack" }, reason: REASON.catalog },
      { args: { view: "explain_type", type: "brain-preference" }, reason: REASON.catalog },
    ],
  },
  { name: "second_brain_capabilities", calls: one({}, REASON.catalog) },
  { name: "second_brain_status", calls: one({}, REASON.aggregateOnly) },
  {
    name: "second_brain_wiring",
    calls: [
      { args: { view: "projects" }, reason: REASON.catalog },
      { args: { view: "hosts" }, reason: REASON.catalog },
    ],
  },
  { name: "skills_attach", calls: one({ query: QUERY }, REASON.catalog) },
  { name: "tool_hydrate", calls: one({}, REASON.catalog) },
  { name: "vault_health", calls: one({}, REASON.aggregateOnly) },
];

/**
 * Every entry the isolation probe drives, checked at module load.
 *
 * Both unasserted buckets, in one list: `SCOPED_SURFACES` is excluded
 * because its members are already driven, per surface, by the fifteen
 * behavioural tests below.
 */
export const PROBE_ENTRIES: ReadonlyArray<ProbeEntry> = [
  ...UNSCOPED_CONTENT.map((e) => assertProbeEntry("UNSCOPED_CONTENT", e)),
  ...NON_CONTENT.map((e) => assertProbeEntry("NON_CONTENT", e)),
];

/**
 * A recipe's test name: the tool plus whatever selects the code path.
 *
 * Read off the recipe rather than hand-written, so a recipe added later
 * cannot be the one with a name that no longer matches its arguments.
 */
export const DISPATCH_KEYS = ["mode", "view", "operation", "action", "op"] as const;

export function probeLabel(name: string, recipe: ProbeCall, index: number): string {
  if (recipe.label !== undefined) return `${name} ${recipe.label}`;
  if (typeof recipe.args === "function") return `${name} #${index}`;
  for (const key of DISPATCH_KEYS) {
    const value = recipe.args[key];
    if (typeof value === "string") return `${name} ${key}=${value}`;
  }
  return index === 0 ? name : `${name} #${index}`;
}
