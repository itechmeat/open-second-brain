/**
 * Owner-scope isolation regression matrix (context-integrity-gates,
 * Unit A / Task 8).
 *
 * Before this wave, `isOwnerVisible` — the vault's ONLY isolation rule —
 * had two callers, and every other content-returning MCP surface
 * bypassed it. The defect was not any single missing filter; it was that
 * nothing enumerated the surfaces, so each new one silently opted out.
 *
 * This file is that enumeration. Every tool in the table is classified
 * exactly once, and the three buckets are asserted to partition the tool
 * table exactly — in BOTH directions. A new tool therefore fails this
 * test until someone classifies it, and a removed tool fails it until
 * someone deletes the entry. That is the mechanism; the per-surface
 * assertions below are what it protects.
 *
 * ## What the partition was worth on its own (a-label-is-not-a-boundary, U3)
 *
 * Nothing. `SCOPED_SURFACES` carried behavioural tests; the other two
 * buckets carried a name and, in one of them, a prose reason nothing
 * read. A sweep against a two-owner vault under
 * `integrity.owner_scope_delivery: fail` found TEN classified-as-safe
 * tools returning another owner's artifact ids, paths, titles and body
 * prose. A bucket whose membership claim is never executed is a label,
 * and the release this unit belongs to is about what a label is worth.
 *
 * So both unasserted buckets now carry `{name, args, reason}`: the
 * arguments that DRIVE the tool, and a written reason for the
 * classification. {@link assertProbeEntry} refuses an entry without
 * them at module load, and {@link ProbeEntry} refuses one at
 * `bun run typecheck`, so the bucket cannot regrow as a bare name list.
 * Every entry is then driven against one two-owner fixture and its
 * response — or the message it threw — is asserted to carry no marker
 * unique to the other owner's artifacts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig, search } from "../../src/core/search/index.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { brainActivePath, brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { regenerateActive } from "../../src/core/brain/active.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { runHygieneScan } from "../../src/core/brain/hygiene/scan.ts";
import { scanTriggers } from "../../src/core/brain/triggers/scan.ts";
import { transitionTrigger } from "../../src/core/brain/triggers/store.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { OWNER_SCOPE_REFUSAL } from "../../src/mcp/owner-scope-refusal.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

/**
 * HOME is pinned for THIS file, and nothing pins it globally.
 *
 * `resolveDeviceId`, `resolveAgentName` and the profile writer all fall
 * back to the operator's real `~/.config/open-second-brain/config.yaml`
 * when a call supplies no explicit config path, and the isolation probe
 * below drives every writer in the tool table. A global pin would hide
 * the config-reading behaviour other suites exist to exercise, so the
 * file that needs the pin sets it - at module scope, which runs before
 * any test body and before any of these tools is ever called.
 */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-home-"));

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const QUERY = "lattice widgets";
/** Probe path whose derived query terms appear verbatim in every note. */
const PROBE = "lattice.md";
const PROBE_TERMS = `${PROBE} lattice`;

/**
 * The string the isolation probe hunts for.
 *
 * It appears ONLY inside artifacts owned by {@link OWNER_A} - in their
 * ids, their paths, their topics, their titles and their body prose - so
 * one `not.toContain` catches every channel a surface might use to name
 * one of them, without the probe having to know which field carried it.
 */
const CROSS_OWNER_MARKER = "secretmarkerzz";

/** The UTC day the fixture's log event lands on; `brain_event_trace` selects by date. */
const LOG_EVENT_DATE = "2026-05-04";

/** Shared hub the fixture's MOC audit is driven against. */
const HUB_ID = "pref-hub";
/** Shared preference every owner-A artifact references, and the probe's link target. */
const SHARED_ID = "pref-shared";
/** Title of {@link SHARED_ID}; the term `brain_unlinked_mentions` matches on. */
const SHARED_TITLE = "Shared Pref";
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
const SHARED_TOPIC = "shared";
/** Slug of the ownerless signal that evidences the owner-A preference. */
const NEUTRAL_SIGNAL_SLUG = "neutral-probe-signal";

/** How a surface learns which agent is asking. */
const SCOPE_SOURCE = Object.freeze({
  /** An explicit `agent_scope` input argument. */
  argument: "argument",
  /** `ServerContext.agentName`, for a surface that takes no arguments. */
  serverIdentity: "server-identity",
} as const);

type ScopeSource = (typeof SCOPE_SOURCE)[keyof typeof SCOPE_SOURCE];

interface ScopedSurface {
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
const SCOPED_SURFACES: ReadonlyArray<ScopedSurface> = [
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
interface ProbeCall {
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
interface ProbeEntry {
  readonly name: string;
  readonly calls: ReadonlyArray<ProbeCall>;
}

/** A single-recipe entry, spelled without the array ceremony. */
function one(args: ProbeCall["args"], reason: string): ReadonlyArray<ProbeCall> {
  return [{ args, reason }];
}

/**
 * Shortest reason this file accepts. A one-word reason is the bare name
 * list with extra punctuation, so the floor is set above it.
 */
const REASON_MIN_CHARS = 24;

/**
 * Refuse an entry that carries no call recipes or no reason.
 *
 * `unknown` rather than {@link ProbeEntry}: the compiler already rejects
 * a bare name, and this is the second lock, for a `satisfies`-free cast
 * or a bucket built at runtime. It runs at module load over every entry,
 * so a nameless-args entry fails the whole file rather than one test.
 */
function assertProbeEntry(bucket: string, entry: unknown): ProbeEntry {
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
const REASON = Object.freeze({
  sessionLane:
    "session transcript lane: the records are keyed by session and turn, not by an " +
    "owner-taggable page, so `pageOwner` has no subject to read.",
  catalog:
    "a catalog of this server's own surface - the tool table, the skills manifest, the " +
    "preset list - answered without opening a vault page, so no page's owner is reachable.",
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
const REASONS_REACHING_OWNER_CONTENT: ReadonlySet<string> = new Set([REASON.ownerFiltered]);

/**
 * Measured shape of the probe, quoted in `docs/architecture.md`,
 * `docs/mcp.md` and the release notes. Equalities, not floors - see the
 * test that reads them.
 */
const PROBE_ENTRY_COUNT = 96;
const PROBE_RECIPE_COUNT = 220;
const PROBE_TWO_SIDED_COUNT = 31;

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
function triggerQueueArgs(
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
function hygieneApplyArgs(vault: string): Record<string, unknown> {
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
const UNSCOPED_CONTENT: ReadonlyArray<ProbeEntry> = [
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
const NON_CONTENT: ReadonlyArray<ProbeEntry> = [
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
const PROBE_ENTRIES: ReadonlyArray<ProbeEntry> = [
  ...UNSCOPED_CONTENT.map((e) => assertProbeEntry("UNSCOPED_CONTENT", e)),
  ...NON_CONTENT.map((e) => assertProbeEntry("NON_CONTENT", e)),
];

const TOOLS = buildToolTable("full");
const tool = (name: string): ToolDefinition => {
  const found = TOOLS.find((t) => t.name === name);
  expect(found, `no such tool: ${name}`).toBeDefined();
  return found!;
};

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${OWNER_B}\n`);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "owned-a.md"),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} owned by a\n`,
  );
  writeFileSync(join(vault, "notes", "shared.md"), `# Shared\n\n${QUERY} ${PROBE_TERMS} shared\n`);
  makePref("shared");
  makePref("owned-by-a", OWNER_A);
  ctx = { vault, configPath, repoRoot: null, agentName: OWNER_B };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function setGate(mode: string | null): void {
  const body = mode === null ? "" : `integrity:\n  owner_scope_delivery: ${mode}\n`;
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

function makePref(
  slug: string,
  owner?: string,
  overrides: Partial<Parameters<typeof writePreference>[1]> = {},
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
    ...overrides,
  });
}

/**
 * Invoke a tool AS `agentName`. Argument-scoped surfaces read the scope
 * from `args`; `brain_context` takes no arguments and can only read the
 * server identity, so the identity is varied alongside the argument and
 * each surface picks up whichever source it declares.
 */
async function call(
  name: string,
  args: Record<string, unknown>,
  agentName: string = OWNER_B,
): Promise<string> {
  return JSON.stringify(await tool(name).handler({ ...ctx, agentName }, args));
}

/** Vault-relative paths a listing surface returned. */
function pagePaths(result: { pages: Array<{ path: string }> }): string[] {
  return result.pages.map((p) => p.path);
}

/** Entry ids a source-trace surface returned. */
function entryIds(result: { entries: Array<{ id: string }> }): string[] {
  return result.entries.map((e) => e.id);
}

/** Contribution ids a provenance surface returned, sorted. */
function contributionIds(result: { contributions: Array<{ id: string }> }): string[] {
  return result.contributions.map((c) => c.id).toSorted();
}

// ----- the mechanism --------------------------------------------------------

test("the matrix classifies every tool exactly once", () => {
  const classified = [...SCOPED_SURFACES.map((s) => s.name), ...PROBE_ENTRIES.map((s) => s.name)];
  expect(new Set(classified).size).toBe(classified.length);

  const actual = TOOLS.map((t) => t.name).toSorted();
  // Both directions: a NEW tool fails until it is classified, and a
  // REMOVED tool fails until its entry is deleted.
  expect(classified.toSorted()).toEqual(actual);
});

test("the tool count is unchanged: an argument was added, never a tool", () => {
  expect(TOOLS.length).toBe(110);
});

test("every argument-scoped surface declares agent_scope in its input schema", () => {
  for (const surface of SCOPED_SURFACES) {
    const schema = tool(surface.name).inputSchema as {
      properties?: Record<string, unknown>;
    };
    const declared = Object.keys(schema.properties ?? {});
    if (surface.source === SCOPE_SOURCE.argument) {
      expect(declared, `${surface.name} must accept agent_scope`).toContain("agent_scope");
    } else {
      expect(declared, `${surface.name} takes no arguments`).toEqual([]);
    }
  }
});

test("brain_context keeps its no-argument contract and reads the server identity", () => {
  const schema = tool("brain_context").inputSchema as Record<string, unknown>;
  expect(schema["additionalProperties"]).toBe(false);
  expect(Object.keys((schema["properties"] ?? {}) as Record<string, unknown>)).toEqual([]);
});

// ----- gated preference-backed surfaces -------------------------------------

const GATED_CALLS: ReadonlyArray<{
  readonly name: string;
  readonly args: (scope: string | null) => Record<string, unknown>;
}> = [
  { name: "brain_context", args: () => ({}) },
  {
    name: "brain_context_pack",
    args: (s) => ({ max_tokens: 4000, ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_pre_compress_pack",
    args: (s) => ({ top_k: 10, ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_brief",
    args: (s) => ({ view: "morning", ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_anticipatory_context",
    args: (s) => ({ session_id: "sess-1", ...(s === null ? {} : { agent_scope: s }) }),
  },
];

for (const surface of GATED_CALLS) {
  test(`${surface.name}: gate off delivers every owner's memory`, async () => {
    setGate(GATE_MODE.off);
    expect(await call(surface.name, surface.args(OWNER_B), OWNER_B)).toContain("owned-by-a");
  });

  test(`${surface.name}: gate fail withholds another owner's memory`, async () => {
    setGate(GATE_MODE.fail);
    const out = await call(surface.name, surface.args(OWNER_B), OWNER_B);
    expect(out).not.toContain("owned-by-a");
    expect(out).toContain("shared");
  });

  test(`${surface.name}: gate fail keeps the owner's own memory`, async () => {
    setGate(GATE_MODE.fail);
    expect(await call(surface.name, surface.args(OWNER_A), OWNER_A)).toContain("owned-by-a");
  });
}

/**
 * A3: a per-request visibility filter must never drive a shared write.
 *
 * `brain_context` used to reach `regenerateActive(vault, { agentScope })`,
 * and `regenerateActive` WRITES `Brain/active.md`. Under `fail` a call from
 * agent-b therefore rewrote the shared file without agent-a's memories -
 * and `hooks/active-inject.ts` injects that same file into every agent's
 * SessionStart, while `resources.ts` regenerates it unscoped. The file
 * thrashed and an agent could lose its own memories from session start.
 */
test("brain_context scopes what it returns without narrowing active.md", async () => {
  setGate(GATE_MODE.fail);
  regenerateActive(vault);
  const activePath = brainActivePath(vault);
  const before = readFileSync(activePath, "utf8");
  expect(before).toContain("owned-by-a");

  const out = await call("brain_context", {}, OWNER_B);
  expect(out).not.toContain("owned-by-a");
  expect(out).toContain("shared");

  // The SHARED file is untouched: same bytes, still carrying every owner.
  expect(readFileSync(activePath, "utf8")).toBe(before);
});

test("brain_context creates active.md unscoped on a vault that has none", async () => {
  setGate(GATE_MODE.fail);
  const activePath = brainActivePath(vault);
  rmSync(activePath, { force: true });

  await call("brain_context", {}, OWNER_B);
  expect(readFileSync(activePath, "utf8")).toContain("owned-by-a");
});

/**
 * A6: `agent_scope` is declared once for the whole `brain_brief` tool, but
 * only two of its seven views thread it. The other five returned
 * preference ids (`weekly.retired[].prefId`, the operator dashboard's
 * ranked actions) to a caller that believed it was scoped. An argument a
 * tool accepts and silently ignores is exactly the failure mode this wave
 * exists to remove, so those views refuse it.
 */
test("brain_brief refuses agent_scope on the views that cannot honour it", async () => {
  const views = ["daily", "weekly", "monthly", "operator", "today"];
  const outcomes = await Promise.all(
    views.map((view) =>
      call("brain_brief", { view, agent_scope: OWNER_B }).then(
        () => null,
        (e: unknown) => (e as Error).message,
      ),
    ),
  );
  for (const [i, message] of outcomes.entries()) {
    expect(message, `view=${views[i]}`).toContain(
      `brain_brief view=${views[i]} cannot honour 'agent_scope'`,
    );
  }
});

test("brain_brief still serves those views without the argument", async () => {
  const served = await Promise.all(
    ["daily", "weekly", "monthly", "today"].map((view) => call("brain_brief", { view })),
  );
  for (const out of served) expect(typeof out).toBe("string");
});

/**
 * This test used to drive the same tool twice from ONE caller - `agent-b`
 * - naming `agent-a` once and itself once, and asserted that naming
 * `agent-a` returned MORE items. It passed, and what it pinned was the
 * leak: under `fail` the gate enforced the scope the caller asked for,
 * so a caller selected which owner's private memory it received
 * (a-label-is-not-a-boundary, U2). The count difference is still the
 * measurement, but each caller now names only itself, and the crossing
 * call is refused by name rather than counted.
 */
test("brain_retrieval_plan counts only the memories its caller may see", async () => {
  setGate(GATE_MODE.fail);
  const asA = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_A }, OWNER_A),
  );
  const asB = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_B }, OWNER_B),
  );
  expect(asA.allocation.item_count).toBeGreaterThan(asB.allocation.item_count);
});

test("brain_retrieval_plan refuses a caller that names another owner", async () => {
  setGate(GATE_MODE.fail);
  await expect(
    call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_A }, OWNER_B),
  ).rejects.toThrow(OWNER_SCOPE_REFUSAL.foreignOwner);
});

// ----- ungated search-backed surfaces ---------------------------------------

test("brain_search_expand refuses another owner's chunk as if it were absent", async () => {
  const config = resolveSearchConfig({ vault, configPath: ctx.configPath ?? undefined });
  const hit = (await search(config, { query: QUERY, limit: 20 })).results.find(
    (r) => r.path === "notes/owned-a.md",
  );
  expect(hit).toBeDefined();

  expect(await call("brain_search_expand", { chunk_id: hit!.chunkId })).toContain(
    "notes/owned-a.md",
  );
  await expect(
    call("brain_search_expand", { chunk_id: hit!.chunkId, agent_scope: OWNER_B }),
  ).rejects.toThrow(`chunk not found: ${hit!.chunkId}`);
});

test("second_brain_query excludes another owner's pages from the listing", async () => {
  const unscoped = JSON.parse(await call("second_brain_query", { limit: 500 }));
  const scoped = JSON.parse(await call("second_brain_query", { limit: 500, agent_scope: OWNER_B }));
  expect(pagePaths(unscoped)).toContain("notes/owned-a.md");
  expect(pagePaths(unscoped)).toContain("Brain/preferences/pref-owned-by-a.md");
  expect(pagePaths(scoped)).not.toContain("notes/owned-a.md");
  expect(pagePaths(scoped)).not.toContain("Brain/preferences/pref-owned-by-a.md");
  // The shared pages survive, and the reported total is the visible one -
  // a count that still included the hidden pages would leak their number.
  expect(pagePaths(scoped)).toContain("notes/shared.md");
  expect(scoped.total_pages).toBe(scoped.pages.length);
  expect(scoped.total_pages).toBeLessThan(unscoped.total_pages);
});

/**
 * A5/A8: the listing must fail CLOSED on an unreadable page, matching
 * `brain_search_by_source` and the ranked search path. Empty frontmatter
 * from a failed read is byte-indistinguishable from a genuinely ownerless
 * page, so without the walk's diagnostic sink an owner-tagged page becomes
 * shared the moment its file stops being readable.
 */
test("second_brain_query hides a page it cannot read from a scoped caller", async () => {
  const target = join(vault, "notes", "owned-a.md");
  chmodSync(target, 0o000);
  try {
    const scoped = JSON.parse(
      await call("second_brain_query", { limit: 500, agent_scope: OWNER_B }),
    );
    expect(pagePaths(scoped)).not.toContain("notes/owned-a.md");
    expect(pagePaths(scoped)).toContain("notes/shared.md");
  } finally {
    chmodSync(target, 0o644);
  }
});

test("brain_search_by_source excludes another owner's derived pages", async () => {
  const sourceFile = "sources/paper.md";
  const derived = join(vault, "Brain", "sources");
  mkdirSync(derived, { recursive: true });
  writeFileSync(
    join(derived, "src-owned-a.md"),
    `---\nid: src-owned-a\nowner: ${OWNER_A}\nsource_path: ${sourceFile}\n---\n\nderived for a\n`,
  );
  writeFileSync(
    join(derived, "src-shared.md"),
    `---\nid: src-shared\nsource_path: ${sourceFile}\n---\n\nderived for everyone\n`,
  );

  const unscoped = JSON.parse(await call("brain_search_by_source", { source_file: sourceFile }));
  const scoped = JSON.parse(
    await call("brain_search_by_source", { source_file: sourceFile, agent_scope: OWNER_B }),
  );
  expect(entryIds(unscoped).toSorted()).toEqual(["src-owned-a", "src-shared"]);
  expect(entryIds(scoped)).toEqual(["src-shared"]);
  expect(scoped.total).toBe(1);
});

test("brain_agent_query excludes another owner's preference contributions", async () => {
  // A preference contribution only surfaces once its evidence signals
  // exist, because the contribution's agents are read from them.
  for (const slug of ["shared", "owned-by-a"]) {
    writeSignal(vault, {
      topic: slug,
      signal: "positive",
      agent: "agent-x",
      principle: `principle for ${slug}`,
      created_at: "2026-05-01T00:00:00Z",
      date: "2026-05-01",
      slug,
    });
  }

  const unscoped = JSON.parse(await call("brain_agent_query", { kind: "preference" }));
  const scoped = JSON.parse(
    await call("brain_agent_query", { kind: "preference", agent_scope: OWNER_B }),
  );
  expect(contributionIds(unscoped)).toEqual(["pref-owned-by-a", "pref-shared"]);
  expect(contributionIds(scoped)).toEqual(["pref-shared"]);
  expect(scoped.total_matched).toBe(1);
});

/**
 * A5: the roster must be folded from the SAME filtered set the
 * contributions are. Built independently of the owner filter it reported
 * a correct `total_matched` beside an `available_agents` entry naming the
 * withheld preference's topic verbatim and counting it - which is the
 * existence leak the boundary exists to prevent.
 *
 * The evidence signal carries a DIFFERENT topic from the preference it
 * evidences, so the preference's topic can only reach the roster through
 * the preference contribution itself.
 */
test("brain_agent_query's roster names only what the caller may see", async () => {
  writeSignal(vault, {
    topic: "neutral-topic",
    signal: "positive",
    agent: "agent-y",
    principle: "principle for the neutral signal",
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug: "secret-pref",
  });
  makePref("secret-pref", OWNER_A);

  const rosterFor = (result: {
    available_agents: Array<{ id: string; topics: string[]; contribution_count: number }>;
  }): { topics: string[]; contribution_count: number } => {
    const entry = result.available_agents.find((a) => a.id === "agent-y");
    expect(entry).toBeDefined();
    return entry!;
  };

  const unscoped = rosterFor(JSON.parse(await call("brain_agent_query", {})));
  expect(unscoped.topics).toEqual(["neutral-topic", "secret-pref"]);
  expect(unscoped.contribution_count).toBe(2);

  const scoped = rosterFor(JSON.parse(await call("brain_agent_query", { agent_scope: OWNER_B })));
  expect(scoped.topics).toEqual(["neutral-topic"]);
  expect(scoped.contribution_count).toBe(1);
});

test("brain_file_context and brain_deep_synthesis exclude another owner's page", async () => {
  const cases = [
    { name: "brain_file_context", args: { file_path: join(vault, "notes", PROBE), min_bytes: 0 } },
    { name: "brain_deep_synthesis", args: { topic: QUERY } },
  ];
  // Both calls per case are issued together: they share no state, and a
  // sequential await here is only a slower way to reach the same result.
  const outcomes = await Promise.all(
    cases.map(async ({ name, args }) => ({
      name,
      unscoped: await call(name, args),
      scoped: await call(name, { ...args, agent_scope: OWNER_B }),
    })),
  );
  for (const { name, unscoped, scoped } of outcomes) {
    expect(unscoped, `${name} unscoped`).toContain("notes/owned-a.md");
    expect(scoped, `${name} scoped`).not.toContain("notes/owned-a.md");
    expect(scoped, `${name} scoped`).toContain("notes/shared.md");
  }
});

// ----- the isolation probe --------------------------------------------------

/**
 * Insert extra frontmatter lines and extra body text into an artifact the
 * shipped writer produced.
 *
 * The writers accept no `title` and no body, and the probe needs both: a
 * title is the only term `findUnlinkedMentions` matches on, and a body is
 * where `auditMoc` reads a hub's outbound cluster from. Patching the
 * writer's own output keeps every schema-owned field exactly as the
 * writer spelled it.
 */
function patchArtifact(rel: string, frontmatter: ReadonlyArray<string>, body: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  expect(close, `${rel} has no frontmatter block`).toBeGreaterThan(0);
  const head = frontmatter.length === 0 ? "" : `\n${frontmatter.join("\n")}`;
  const tail = body.length === 0 ? "" : `\n${body}\n`;
  writeFileSync(abs, text.slice(0, close) + head + text.slice(close) + tail);
}

/**
 * The two-owner fixture every {@link PROBE_ENTRIES} entry is driven
 * against.
 *
 * Additive to `beforeEach`, not a replacement for it: the per-surface
 * tests above pin exact ids and exact counts over the smaller vault, and
 * a fixture that grew under them would move those numbers for reasons
 * that have nothing to do with what they assert.
 *
 * Every artifact seeded here that belongs to {@link OWNER_A} carries
 * {@link CROSS_OWNER_MARKER} in its id, so a surface that names one -
 * as an id, a path, a topic, a title or a line of prose - fails the
 * probe without the probe having to know which field it used.
 *
 * The forced full index at the end is a precondition, not a habit:
 * `brain_scaffold_stub action=list` refuses on an incrementally-indexed
 * vault (`notes/scaffold-stub.ts` `partial_resolution`) and returns no
 * targets at all, which would read as a clean probe over a surface that
 * never ran.
 */
async function seedTwoOwnerFixture(): Promise<void> {
  const ownedPref = `${CROSS_OWNER_MARKER}-a`;
  const ownedPref2 = `${CROSS_OWNER_MARKER}-a2`;
  const ownedPrefOnSharedTopic = `${CROSS_OWNER_MARKER}-a3`;
  const ownedPrefDuplicate = `${CROSS_OWNER_MARKER}-a4`;

  // The evidence signal is deliberately NEUTRAL-named and ownerless: a
  // signal carries no `owner:` anywhere in this product (`signal.ts` has
  // no such field), so a marker inside one would be a marker inside a
  // SHARED artifact and every `not.toContain` below would be asserting
  // against something the caller is entitled to read.
  writeSignal(vault, {
    topic: NEUTRAL_SIGNAL_SLUG,
    signal: "positive",
    agent: OWNER_A,
    principle: "principle for the neutral evidence signal",
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug: NEUTRAL_SIGNAL_SLUG,
    source: [`[[${SHARED_ID}]]`],
  });

  // `applied_count: 0` is what the hygiene scan's usefulness detector
  // measures, and the finding it emits names the preference by id.
  const unused = { evidenced_by: [`[[sig-2026-05-01-${NEUTRAL_SIGNAL_SLUG}]]`], applied_count: 0 };
  makePref(ownedPref, OWNER_A, unused);
  makePref(ownedPref2, OWNER_A, { applied_count: 0 });
  // A THIRD owner-A preference carrying `ownedPref2`'s principle
  // verbatim, so the dedup detector nominates that pair for a MERGE -
  // the one hygiene action with an applier behind it. Without an
  // applicable finding, `mode=apply` returns nothing but opaque hashes
  // and the probe cannot see whether it wrote across the boundary.
  // Same TOPIC as well as the same principle: `findMergeCandidates`
  // buckets by `(topic, scope)` and only compares inside a bucket, so a
  // duplicate principle under a different topic is never nominated.
  makePref(ownedPrefDuplicate, OWNER_A, {
    applied_count: 0,
    topic: ownedPref2,
    principle: `principle for ${ownedPref2}`,
  });
  // Owner-A's preference on the SHARED topic: the artifact a topic
  // fan-out reaches without the caller ever naming it.
  makePref(ownedPrefOnSharedTopic, OWNER_A, { topic: SHARED_TOPIC });
  makePref("hub");

  // The shared preference gains the title the mention scanner matches on;
  // the owner-A preference gains a body that spells that title in raw
  // prose, which is the unlinked mention that must not cross.
  patchArtifact(`Brain/preferences/${SHARED_ID}.md`, [`title: ${SHARED_TITLE}`], "");
  patchArtifact(
    `Brain/preferences/pref-${ownedPref}.md`,
    [`supersedes: "[[${SHARED_ID}]]"`],
    `See [[${SHARED_ID}]]. Also ${SHARED_TITLE} ${CROSS_OWNER_MARKER} here.`,
  );
  // A shared hub whose outbound cluster names both owner-A members plus a
  // target that does not exist: `wellCovered`/`fragile` classify the two
  // that resolve, `candidateMissing` names the one that does not.
  patchArtifact(
    `Brain/preferences/${HUB_ID}.md`,
    [],
    `Hub. [[pref-${ownedPref}]] [[pref-${ownedPref2}]] [[${SHARED_ID}]] [[missing-shared-member]]`,
  );

  writeFileSync(
    join(brainDirs(vault).retired, `ret-${CROSS_OWNER_MARKER}-a.md`),
    [
      "---",
      "kind: brain-retired",
      `id: ret-${CROSS_OWNER_MARKER}-a`,
      `owner: ${OWNER_A}`,
      "created_at: 2026-05-01T00:00:00Z",
      "tags: []",
      `topic: ${CROSS_OWNER_MARKER}-a`,
      "principle: retired principle",
      "provenance: observed",
      "retired_at: 2026-05-03T00:00:00Z",
      `retired_by: "[[${SHARED_ID}]]"`,
      "retired_reason: superseded-by-context",
      "_status: retired",
      "_evidenced_by: []",
      "---",
      "",
      `See [[${SHARED_ID}]] and ${SHARED_TITLE} ${CROSS_OWNER_MARKER}.`,
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(vault, "notes", `${CROSS_OWNER_MARKER}-a.md`),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} [[missing-${CROSS_OWNER_MARKER}-target]]\n`,
  );

  for (const slug of [ownedPref, ownedPrefOnSharedTopic]) {
    appendLogEvent(
      vault,
      {
        timestamp: `${LOG_EVENT_DATE}T00:00:00Z`,
        eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
        body: {
          path: `Brain/preferences/pref-${slug}.md`,
          preference: `[[pref-${slug}]]`,
          result: "applied",
        },
      },
      { deviceId: "" },
    );
  }

  await indexVault(resolveSearchConfig({ vault, configPath: ctx.configPath ?? undefined }), {
    force: true,
  });
}

/**
 * Drive one recipe and return everything the caller would see.
 *
 * A thrown message counts: a refusal that quotes the artifact it choked
 * on discloses exactly as much as a successful response would, and this
 * repository has already shipped one of those (`schema_inspect view=lint`
 * naming a host path in its parse error).
 */
async function probeResponse(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    return await call(name, args, OWNER_B);
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Resolve a recipe's arguments against the seeded fixture. */
function probeArgs(recipe: ProbeCall): Record<string, unknown> {
  return typeof recipe.args === "function" ? recipe.args(vault) : recipe.args;
}

/**
 * A recipe's test name: the tool plus whatever selects the code path.
 *
 * Read off the recipe rather than hand-written, so a recipe added later
 * cannot be the one with a name that no longer matches its arguments.
 */
const DISPATCH_KEYS = ["mode", "view", "operation", "action", "op"] as const;

function probeLabel(name: string, recipe: ProbeCall, index: number): string {
  if (recipe.label !== undefined) return `${name} ${recipe.label}`;
  if (typeof recipe.args === "function") return `${name} #${index}`;
  for (const key of DISPATCH_KEYS) {
    const value = recipe.args[key];
    if (typeof value === "string") return `${name} ${key}=${value}`;
  }
  return index === 0 ? name : `${name} #${index}`;
}

test("the probe's own fixture puts the marker in front of an unscoped caller", async () => {
  setGate(GATE_MODE.off);
  await seedTwoOwnerFixture();
  // Without this, every `not.toContain` below would pass on a fixture that
  // simply never produced the rows - the failure mode recon named when it
  // said several clean sweeps were clean because the fixture was empty.
  expect(await probeResponse("brain_backlinks", { id: SHARED_ID })).toContain(CROSS_OWNER_MARKER);
});

/**
 * Wall-clock ceiling for one probe.
 *
 * Above bun's 5s default because two entries do real work before they can
 * answer - `brain_codegraph_report` walks the in-scope project and
 * `brain_review_candidates` runs a full dry-run consolidation pass - and
 * a probe that times out reports a leak that is not there.
 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * The differential: gate OFF versus gate FAIL, per recipe.
 *
 * A one-sided probe cannot fail. `off` discloses a SUPERSET of what
 * `fail` discloses, so a recipe that does not surface the marker
 * unscoped can never surface it scoped either - and a sweep of the
 * previous, one-recipe-per-tool version found 81 of 96 entries in
 * exactly that state, naming artifacts the fixture never created or
 * driving an empty lane. Every one of them read as a clean isolation
 * result over a call that was never isolating anything.
 *
 * So both directions are asserted, and which direction depends on the
 * recipe's own reason:
 *
 *   - {@link REASON.ownerFiltered} claims the call REACHES owner-taggable
 *     artifacts and filters them. Both halves are executed: the marker
 *     MUST appear with the gate off, and MUST NOT with the gate on. The
 *     first half is what stops the second from being vacuous.
 *   - every other reason in {@link REASON} claims the call cannot name
 *     an owner-private artifact at all - a session lane, an ownerless
 *     lane, a catalog, a caller-named artifact, a writer's echo, an
 *     aggregate with no per-artifact identity. That claim is executed
 *     directly: the marker must be absent even with the gate OFF, where
 *     nothing is hidden. A recipe that surfaces it there has a FALSE
 *     reason, and the fix is to filter the surface and move it to
 *     `ownerFiltered` - never to widen the reason.
 *
 * The exemption from the two-sided form is therefore an explicit,
 * enumerated set ({@link REASONS_REACHING_OWNER_CONTENT}) read off the
 * classification each recipe already carries, not a silence.
 *
 * `fail` runs FIRST so the isolation assertion sees the pristine
 * fixture: several recipes are writers, and the reachability half must
 * not be what decides whether the boundary held.
 */
for (const entry of PROBE_ENTRIES) {
  for (const [index, recipe] of entry.calls.entries()) {
    const label = probeLabel(entry.name, recipe, index);
    const reaches = REASONS_REACHING_OWNER_CONTENT.has(recipe.reason);
    test(
      `${label}: ${reaches ? "reaches owner content and withholds it" : "reaches no owner content"}`,
      async () => {
        await seedTwoOwnerFixture();

        setGate(GATE_MODE.fail);
        const scoped = await probeResponse(entry.name, probeArgs(recipe));
        expect(scoped, `${label} under fail\n${recipe.reason}`).not.toContain(CROSS_OWNER_MARKER);

        setGate(GATE_MODE.off);
        const unscoped = await probeResponse(entry.name, probeArgs(recipe));
        if (reaches) {
          expect(unscoped, `${label} under off\n${recipe.reason}`).toContain(CROSS_OWNER_MARKER);
        } else {
          expect(unscoped, `${label} under off\n${recipe.reason}`).not.toContain(
            CROSS_OWNER_MARKER,
          );
        }
      },
      PROBE_TIMEOUT_MS,
    );
  }
}

/**
 * F1: `apply` planned against the UNFILTERED report.
 *
 * The probe above catches the disclosure - the applier's `detail` names
 * both merged ids - but not the WRITE, which is the worse half: a caller
 * whose scan correctly returned nothing could still retire another
 * owner's preference by handing `apply` an id it had never been shown.
 * Finding ids are `sha256(sorted targets).slice(0, 12)`, so they are
 * derivable rather than secret and withholding them was never the
 * boundary.
 */
test("brain_hygiene apply cannot execute a finding the same caller's scan withheld", async () => {
  await seedTwoOwnerFixture();
  setGate(GATE_MODE.fail);

  const hidden = runHygieneScan(vault, { now: new Date() }).findings.filter((f) =>
    f.targets.some((t) => t.includes(CROSS_OWNER_MARKER)),
  );
  expect(hidden.length, "the fixture must produce findings over owner-A artifacts").toBeGreaterThan(
    0,
  );
  const ids = hidden.map((f) => f.id);

  const scan = JSON.parse(await call("brain_hygiene", { mode: "scan" }, OWNER_B));
  expect(JSON.stringify(scan)).not.toContain(CROSS_OWNER_MARKER);

  const applied = JSON.parse(await call("brain_hygiene", { mode: "apply", ids }, OWNER_B));
  expect(applied.applied).toEqual([]);
  expect(applied.changed).toBe(0);

  // The artifacts are still on disk, still owned, still unmerged.
  for (const slug of [`${CROSS_OWNER_MARKER}-a2`, `${CROSS_OWNER_MARKER}-a4`]) {
    expect(existsSync(join(vault, "Brain", "preferences", `pref-${slug}.md`))).toBe(true);
  }
});

/**
 * F1, second half: the dry run was an existence oracle.
 *
 * A hidden finding came back as `excluded_review:[id]` and an id nobody
 * ever issued came back as `unknown_ids:[id]`, so a caller could
 * enumerate the hidden population one derived id at a time without ever
 * being shown a finding. IDENTICAL TO ABSENT is the convention
 * `preferences-collect.ts` states; this is it, executed.
 */
test("a withheld hygiene finding id answers exactly as an id nobody issued", async () => {
  await seedTwoOwnerFixture();
  setGate(GATE_MODE.fail);

  const hiddenId = runHygieneScan(vault, { now: new Date() }).findings.find((f) =>
    f.targets.some((t) => t.includes(CROSS_OWNER_MARKER)),
  )!.id;
  const inventedId = "dedup:000000000000";

  const withheld = JSON.parse(
    await call("brain_hygiene", { mode: "apply", ids: [hiddenId], dry_run: true }, OWNER_B),
  );
  const absent = JSON.parse(
    await call("brain_hygiene", { mode: "apply", ids: [inventedId], dry_run: true }, OWNER_B),
  );

  expect(withheld.unknown_ids).toEqual([hiddenId]);
  expect(withheld.excluded_review).toEqual([]);
  // Same shape, same fields, same emptiness - only the echoed id differs.
  expect({ ...withheld, unknown_ids: [] }).toEqual({ ...absent, unknown_ids: [] });
});

/**
 * F3: the verdict was folded over findings the arrays no longer carried.
 *
 * `verdict: watch` beside four empty arrays tells the caller that a
 * hidden artifact tripped a detector - the existence leak with the
 * evidence removed.
 */
test("brain_health's verdict is folded over the findings it actually returns", async () => {
  await seedTwoOwnerFixture();

  setGate(GATE_MODE.off);
  const unscoped = JSON.parse(await call("brain_health", {}, OWNER_B));
  expect(unscoped.verdict).not.toBe("clean");
  expect(JSON.stringify(unscoped)).toContain(CROSS_OWNER_MARKER);

  setGate(GATE_MODE.fail);
  const scoped = JSON.parse(await call("brain_health", {}, OWNER_B));
  const named =
    scoped.contradictions.length + scoped.stale_claims.length + scoped.batch_inflation.length;
  if (named === 0 && scoped.concept_gaps.length === 0) {
    expect(scoped.verdict).toBe("clean");
  }
  expect(JSON.stringify(scoped)).not.toContain(CROSS_OWNER_MARKER);
});

/**
 * The probe's own shape, pinned as equalities.
 *
 * Three numbers are quoted outside this file - `docs/architecture.md`,
 * `docs/mcp.md` and the release notes all state how much of the tool
 * surface is really driven - and a number quoted in prose with nothing
 * keeping it true is the defect this whole release is about. The
 * two-sided count is the load-bearing one: it is how many recipes prove
 * their own reachability before asserting withholding, and the release
 * before this one shipped a probe where that number was effectively one.
 *
 * Raising any of these is ordinary; lowering the two-sided count means a
 * surface stopped being exercised, which is exactly the regression a
 * floor would have let through.
 */
test("the probe's population and its two-sided share are what the docs say", () => {
  const recipes = PROBE_ENTRIES.flatMap((entry) => entry.calls);
  const twoSided = recipes.filter((r) => REASONS_REACHING_OWNER_CONTENT.has(r.reason));
  expect(PROBE_ENTRIES.length).toBe(PROBE_ENTRY_COUNT);
  expect(recipes.length).toBe(PROBE_RECIPE_COUNT);
  expect(twoSided.length).toBe(PROBE_TWO_SIDED_COUNT);
});

test("a bucket entry without call recipes is refused", () => {
  expect(() => assertProbeEntry("NON_CONTENT", "brain_backlinks")).toThrow(
    "every entry must be a {name, calls} record",
  );
  expect(() => assertProbeEntry("NON_CONTENT", { name: "brain_backlinks", calls: [] })).toThrow(
    "has no 'calls'",
  );
  expect(() =>
    assertProbeEntry("NON_CONTENT", {
      name: "brain_backlinks",
      calls: [{ reason: REASON.ownerFiltered }],
    }),
  ).toThrow("has a call with no 'args'");
  expect(() =>
    assertProbeEntry("NON_CONTENT", {
      name: "brain_backlinks",
      calls: [{ args: {}, reason: "metadata" }],
    }),
  ).toThrow(`at least ${REASON_MIN_CHARS} characters`);
});
