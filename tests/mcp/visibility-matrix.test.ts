/**
 * The visibility axis of the tool-surface matrix
 * (private-is-not-a-suggestion, unit 9).
 *
 * `tests/mcp/agent-scope-matrix.test.ts` drives every tool in the live
 * table against a two-OWNER fixture. Its subject is ownership; its
 * fixture carries no `visibility:`-tagged page, it asserts nothing about
 * the MCP `_meta` response member, and it drives no federated caller. So
 * a page reserved against remote reads could have leaked through any of
 * the hundred-odd surfaces it sweeps and every one of its assertions
 * would still have been green.
 *
 * This is the second pass over the same enumeration - the recipes are
 * shared through `tests/helpers/tool-probe-catalogue.ts` rather than
 * copied, because a second copy of "what is the whole surface" is the
 * enumeration defect the first matrix was built to remove.
 *
 * ## A sibling file rather than a second axis in the first
 *
 * The design left this open, to be decided on whether the two axes could
 * share one fixture without either one's assertions becoming
 * conditional. They cannot. The owner matrix builds its contexts without
 * a transport reach, which resolves to the narrowest - so the moment its
 * fixture gained a reserved page, every owner assertion would have had to
 * say which reach it was asking at, and the gate-off half of its
 * differential would have been measuring two rules at once.
 *
 * ## The four channels, asserted in one place
 *
 * Every probe here goes through the real JSON-RPC `tools/call` path with
 * a progress token attached, and the assertion is made over the WHOLE
 * serialised response. That covers all four channels a marker could ride
 * out on in a single check: `structuredContent`, the rendered
 * `content[].text`, the error `message` a throw produces, and the `_meta`
 * member the progress refusal travels in - which no prior sweep looked
 * at, and which is a live channel on this transport.
 *
 * ## Two buckets, both executed
 *
 * A blanket "no tool may name a reserved page" would have been a claim
 * this wave does not deliver, and the first run of this file proved it:
 * twenty-eight recipes still named one. They belong to surfaces the
 * visibility registry classifies as EXCLUDED, and `search check` reports
 * that population to operators - so the honest shape is the same two
 * buckets the owner matrix uses, each with an executed claim:
 *
 *   - a tool the registry calls COVERED must withhold. That is the
 *     boundary, swept over every recipe those tools have.
 *   - every other recipe's verdict is MEASURED, in
 *     {@link STILL_NAMED_AT_REMOTE}, and asserted in BOTH directions. A
 *     recipe leaving that list is the wave that covered it; one joining
 *     it is a regression; and either way the diff says so rather than a
 *     count quietly moving.
 *
 * ## What this file does NOT establish, stated rather than implied
 *
 * The REACHABILITY half - that the fixture actually puts the marker in
 * front of a local caller, without which every `not.toContain` would be a
 * clean sweep over an empty fixture - is NOT per-recipe. The visibility
 * axis has no per-call classification of its own, and inventing two
 * hundred of them would be two hundred unexecuted labels.
 *
 * So it is measured instead, in two places. A named subset
 * ({@link RECIPES_REACHING_RESERVED_CONTENT}) is asserted recipe by
 * recipe, and {@link RECIPES_REACHING_RESERVED_AT_LOCAL} bounds how many
 * of ALL recipes reach the page at a reach that reaches it. That second
 * number is the honest size of this sweep's enforcement weight: most
 * recipes never touch the reserved page even locally, so most of the
 * remote assertions are coverage of the enumeration rather than of the
 * rule. Naming the subset without the count understated the gap by two
 * orders of magnitude, which a review found by measuring it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { addRecallSource } from "../../src/core/brain/portability/recall-sources.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { PROGRESS_META_KEY } from "../../src/mcp/progress.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import {
  VISIBILITY_SURFACE_CATEGORY,
  VISIBILITY_SURFACE_KIND,
  VISIBILITY_SURFACE_REGISTRY,
} from "../../src/core/search/visibility-surface-registry.ts";
import {
  NEUTRAL_SIGNAL_SLUG,
  PROBE,
  PROBE_ENTRIES,
  PROBE_TERMS,
  QUERY,
  SHARED_ID,
  SHARED_TITLE,
  SHARED_TOPIC,
  probeLabel,
  type ProbeCall,
  type ProbeEntry,
} from "../helpers/tool-probe-catalogue.ts";

/** HOME is pinned per file by convention; nothing pins it globally. */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-vis-matrix-home-"));

/**
 * The string this probe hunts for. It appears ONLY inside artifacts that
 * carry the reserved visibility token - in their ids, paths, topics,
 * titles and body prose - so one `not.toContain` catches every field a
 * surface might name one of them in.
 */
const RESERVED_MARKER = "zzreservedmarkerzz";

/** The UTC day the fixture's log event lands on. */
const LOG_EVENT_DATE = "2026-05-04";

/** Wall-clock ceiling for one probe; two entries do real work first. */
const PROBE_TIMEOUT_MS = 30_000;

const TOOLS = buildToolTable("full");

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vis-matrix-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  mkdirSync(join(vault, "notes"), { recursive: true });
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  await seedReservedFixture();
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makePref(
  slug: string,
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
    ...overrides,
  });
}

/** Add frontmatter lines and a body to an artifact already on disk. */
function patchArtifact(rel: string, frontmatter: ReadonlyArray<string>, body: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  expect(close, `${rel} has no frontmatter block`).toBeGreaterThan(0);
  const head = frontmatter.length === 0 ? "" : `\n${frontmatter.join("\n")}`;
  const tail = body.length === 0 ? "" : `\n${body}\n`;
  writeFileSync(abs, text.slice(0, close) + head + text.slice(close) + tail);
}

/** The frontmatter line that reserves a page against remote reads. */
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

/**
 * The reserved-page fixture: the same artifact SHAPES the owner matrix
 * seeds, tagged with the reserved visibility token instead of an `owner:`.
 *
 * The evidence signal is deliberately neutral-named and untagged, for the
 * same reason it is ownerless there: a marker inside a shared artifact
 * would make every assertion below a claim about something the caller is
 * entitled to read.
 */
async function seedReservedFixture(): Promise<void> {
  const reserved = `${RESERVED_MARKER}-r`;
  const reservedOnSharedTopic = `${RESERVED_MARKER}-r2`;

  writeSignal(vault, {
    topic: NEUTRAL_SIGNAL_SLUG,
    signal: "positive",
    agent: "agent-a",
    principle: "principle for the neutral evidence signal",
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug: NEUTRAL_SIGNAL_SLUG,
    source: [`[[${SHARED_ID}]]`],
  });

  makePref("shared");
  makePref("hub");
  makePref(reserved, { evidenced_by: [`[[sig-2026-05-01-${NEUTRAL_SIGNAL_SLUG}]]`] });
  makePref(reservedOnSharedTopic, { topic: SHARED_TOPIC });

  patchArtifact(`Brain/preferences/${SHARED_ID}.md`, [`title: ${SHARED_TITLE}`], "");
  patchArtifact(
    `Brain/preferences/pref-${reserved}.md`,
    [RESERVE_LINE, `supersedes: "[[${SHARED_ID}]]"`],
    `See [[${SHARED_ID}]]. Also ${SHARED_TITLE} ${RESERVED_MARKER} here.`,
  );
  patchArtifact(`Brain/preferences/pref-${reservedOnSharedTopic}.md`, [RESERVE_LINE], "");
  patchArtifact(
    "Brain/preferences/pref-hub.md",
    [],
    `Hub. [[pref-${reserved}]] [[${SHARED_ID}]] [[missing-shared-member]]`,
  );

  writeFileSync(
    join(brainDirs(vault).retired, `ret-${RESERVED_MARKER}-r.md`),
    [
      "---",
      "kind: brain-retired",
      `id: ret-${RESERVED_MARKER}-r`,
      RESERVE_LINE,
      "created_at: 2026-05-01T00:00:00Z",
      "tags: []",
      `topic: ${RESERVED_MARKER}-r`,
      "principle: retired principle",
      "provenance: observed",
      "retired_at: 2026-05-03T00:00:00Z",
      `retired_by: "[[${SHARED_ID}]]"`,
      "retired_reason: superseded-by-context",
      "_status: retired",
      "_evidenced_by: []",
      "---",
      "",
      `See [[${SHARED_ID}]] and ${SHARED_TITLE} ${RESERVED_MARKER}.`,
      "",
    ].join("\n"),
  );

  writeFileSync(join(vault, "notes", "shared.md"), `# Shared\n\n${QUERY} ${PROBE_TERMS} shared\n`);
  writeFileSync(
    join(vault, "notes", `${RESERVED_MARKER}-r.md`),
    `---\n${RESERVE_LINE}\n---\n\n${QUERY} ${PROBE_TERMS} [[missing-${RESERVED_MARKER}-target]]\n`,
  );

  for (const slug of [reserved, reservedOnSharedTopic]) {
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

  await indexVault(resolveSearchConfig({ vault, configPath }), { force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipes the owner matrix drives per-surface rather than through the
// shared probe, spelled here so this axis covers the whole table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fourteen surfaces `SCOPED_SURFACES` names.
 *
 * The owner matrix drives them through bespoke behavioural tests rather
 * than through its probe list, so the shared catalogue carries no recipes
 * for them. It carries the OTHER ninety-nine, which is why they are not
 * repeated here.
 */
const SCOPED_CALLS: ReadonlyArray<ProbeEntry> = [
  { name: "brain_context", calls: [{ args: {}, reason: "no-argument session bootstrap" }] },
  {
    name: "brain_context_pack",
    calls: [{ args: { max_tokens: 4000 }, reason: "packs Brain artifacts into a budget" }],
  },
  {
    name: "brain_pre_compress_pack",
    calls: [{ args: { top_k: 10 }, reason: "packs the pre-compression carry-over" }],
  },
  {
    name: "brain_anticipatory_context",
    calls: [{ args: { session_id: "sess-1" }, reason: "predicts the next turn's context" }],
  },
  {
    name: "brain_brief",
    calls: [{ args: { view: "morning" }, reason: "the session-start summary view" }],
  },
  {
    name: "brain_retrieval_plan",
    calls: [{ args: { question: QUERY }, reason: "plans retrieval for one question" }],
  },
  {
    name: "brain_query",
    calls: [
      { args: { topic: SHARED_TOPIC }, reason: "a topic fans out to every preference on it" },
      { args: { since: "2026-05-01" }, reason: "a log window names the artifacts it touched" },
    ],
  },
  { name: "brain_search", calls: [{ args: { query: QUERY }, reason: "the ranked search root" }] },
  {
    name: "brain_search_expand",
    calls: [
      {
        args: reservedChunkArgs,
        label: "chunk_id=reserved",
        reason: "the key-addressed drill-down over a reserved page's own chunk",
      },
    ],
  },
  {
    name: "brain_file_context",
    calls: [{ args: { file_path: PROBE }, reason: "prior work for a file about to be read" }],
  },
  {
    name: "brain_deep_synthesis",
    calls: [{ args: { topic: QUERY }, reason: "synthesises over the matched notes" }],
  },
  {
    name: "brain_search_by_source",
    calls: [{ args: { source_file: PROBE }, reason: "traces every page derived from one source" }],
  },
  { name: "second_brain_query", calls: [{ args: {}, reason: "the vault page listing" }] },
  { name: "brain_agent_query", calls: [{ args: {}, reason: "the provenance roster" }] },
];

/**
 * `brain_search_expand` arguments naming a chunk of the RESERVED page.
 *
 * A literal id would select nothing and the probe would go green over a
 * drill-down that never touched the page - the "clean sweep over an empty
 * fixture" the owner matrix's own recipes exist to prevent. The id is
 * read at local reach, which is the only reach that can produce it.
 */
function reservedChunkArgs(vaultDir: string): Record<string, unknown> {
  const chunkId = reservedChunkId(vaultDir);
  return { chunk_id: chunkId };
}

let cachedChunkId: { readonly vault: string; readonly id: number } | null = null;

function reservedChunkId(vaultDir: string): number {
  if (cachedChunkId !== null && cachedChunkId.vault === vaultDir) return cachedChunkId.id;
  // Resolved synchronously off the index the fixture just built: the
  // reserved note is the only one carrying the marker in its path.
  const config = resolveSearchConfig({ vault: vaultDir, configPath });
  const db = new Database(config.dbPath, { readonly: true });
  try {
    const row = db
      .query<{ id: number }, [string]>(
        "SELECT c.id AS id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path LIKE ?1 ORDER BY c.id LIMIT 1",
      )
      .get(`%${RESERVED_MARKER}%`);
    if (row === undefined || row === null) {
      throw new Error("the reserved page produced no chunk");
    }
    cachedChunkId = { vault: vaultDir, id: row.id };
    return row.id;
  } finally {
    db.close();
  }
}

/** Every recipe this axis drives: the shared ninety-nine plus the fourteen. */
const ALL_ENTRIES: ReadonlyArray<ProbeEntry> = [...PROBE_ENTRIES, ...SCOPED_CALLS];

// ─────────────────────────────────────────────────────────────────────────────
// The mechanism
// ─────────────────────────────────────────────────────────────────────────────

test("the visibility matrix drives every tool exactly once", () => {
  const named = ALL_ENTRIES.map((e) => e.name);
  expect(new Set(named).size).toBe(named.length);
  // Both directions: a NEW tool fails until it is driven here, and a
  // REMOVED one fails until its entry goes.
  expect(named.toSorted()).toEqual(TOOLS.map((t) => t.name).toSorted());
});

/**
 * Drive one tool through the real `tools/call` path at `reach`, with a
 * progress token attached, and return the whole serialised response.
 *
 * The token is what makes the `_meta` channel live: this server is built
 * without a notification sink, so a request carrying one is answered with
 * a refusal that rides in `result._meta` - a member no prior sweep looked
 * at, and one more place a marker could have travelled.
 */
async function drive(
  reach: TransportReach,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new MCPServer({ vault, configPath }, { reach });
  const response = await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "tools/call",
    params: { name, arguments: args, _meta: { progressToken: "probe-token" } },
  });
  return JSON.stringify(response);
}

/** Resolve a recipe's arguments against the seeded fixture. */
function probeArgs(recipe: ProbeCall): Record<string, unknown> {
  return typeof recipe.args === "function" ? recipe.args(vault) : recipe.args;
}

/**
 * The recipes hand-verified to put the marker in front of a LOCAL caller.
 *
 * Without these the sweep below could be clean because the fixture never
 * reached the reserved page. They are the non-vacuity anchor, and the
 * limit of that anchor is stated in the module docblock: it is a named
 * subset, not a per-recipe derivation.
 */
const RECIPES_REACHING_RESERVED_CONTENT: ReadonlyArray<{
  readonly name: string;
  readonly args: Record<string, unknown>;
}> = [
  { name: "brain_search", args: { query: QUERY, visibility: [REMOTE_DENY_VISIBILITY_TOKEN] } },
  { name: "brain_query", args: { since: "2026-05-01" } },
  { name: "brain_backlinks", args: { id: SHARED_ID } },
  { name: "second_brain_query", args: {} },
];

for (const probe of RECIPES_REACHING_RESERVED_CONTENT) {
  test(`${probe.name}: the fixture reaches the reserved page at local reach`, async () => {
    expect(await drive(TRANSPORT_REACH.local, probe.name, probe.args)).toContain(RESERVED_MARKER);
  });
}

/**
 * The surfaces the visibility registry classifies as COVERED: a read root
 * reaches their content, so the reserved token is enforced on them and
 * this probe holds them to it.
 */
const COVERED_TOOLS: ReadonlySet<string> = new Set(
  VISIBILITY_SURFACE_REGISTRY.filter(
    (e) =>
      e.kind === VISIBILITY_SURFACE_KIND.mcpTool &&
      e.category === VISIBILITY_SURFACE_CATEGORY.covered,
  ).map((e) => e.surface),
);

/**
 * The recipes that STILL name a reserved page at remote reach, measured.
 *
 * Every one of them belongs to a tool the registry classifies as
 * excluded, and `search check` reports that population to operators in
 * the honesty finding. Pinning them here as an EQUALITY - asserted in
 * both directions - is what turns "some surfaces are not covered yet"
 * from prose into a number that cannot move without somebody deciding it
 * should. A surface leaving this list is the wave that covered it; a
 * surface joining it is a regression, and either way the diff says so.
 *
 * The list is per RECIPE rather than per tool because a tool is not one
 * classification: `brain_trigger operation=scan` names the pages it
 * queued and `brain_trigger operation=terminal` does not.
 */
const STILL_NAMED_AT_REMOTE: ReadonlySet<string> = new Set([
  "brain_agent_diff mode=browse",
  "brain_agent_diff mode=diff",
  "brain_agent_diff mode=map",
  "brain_agent_query",
  "brain_analytics view=belief_evolution",
  "brain_analytics view=concept_synthesis",
  "brain_analytics view=timeline",
  "brain_anticipatory_context",
  "brain_brief view=morning",
  "brain_claims operation=at",
  "brain_claims operation=current",
  "brain_claims operation=history",
  "brain_context",
  "brain_context_pack",
  "brain_design_note",
  "brain_doctor",
  "brain_doctor #1",
  "brain_doctor #2",
  "brain_event_trace",
  "brain_idea_discovery",
  "brain_pre_compress_pack",
  "brain_retention",
  "brain_scaffold_stub action=list",
  "brain_stale_scan",
  "brain_trigger operation=history",
  "brain_trigger operation=list",
  "brain_trigger operation=scan",
  "brain_unlinked_mentions",
]);

/**
 * How many recipes the fixture actually puts the reserved page in front
 * of, at a reach that reaches it - MEASURED, not claimed.
 *
 * Without this, the `not.toContain` sweep below could be green because
 * the fixture never reached the page on those recipes, and a reader
 * counting green test names would read a per-tool proof into a clean
 * sweep over an empty fixture. A named subset used to be the whole
 * anchor; a review measured the gap and found it two orders of magnitude
 * wider than the four recipes named, so the gap is a number this file
 * takes rather than a caveat it writes.
 *
 * Both bounds are asserted. The floor is the non-vacuity claim; the
 * ceiling is what stops the number drifting up unremarked, because a
 * recipe joining the reaching set is a recipe whose remote half just
 * became load-bearing and should be read as such in the diff.
 */
const RECIPES_REACHING_RESERVED_AT_LOCAL = { min: 25, max: 45 } as const;

/** Recipes observed to reach it, accumulated as the sweep below runs. */
let recipesReachingAtLocal = 0;
/** Recipes the sweep actually drove, so a filtered run cannot read as a measurement. */
let recipesMeasuredAtLocal = 0;

test("every recipe still naming a reserved page belongs to a surface the registry excludes", () => {
  const covered = [...STILL_NAMED_AT_REMOTE].filter((label) =>
    COVERED_TOOLS.has(label.split(" ")[0] ?? label),
  );
  // A covered surface in this list would be the registry claiming a
  // boundary this probe just watched it fail.
  expect(covered.toSorted()).toEqual([]);
});

for (const entry of ALL_ENTRIES) {
  for (const [index, recipe] of entry.calls.entries()) {
    const label = probeLabel(entry.name, recipe, index);
    const mustWithhold = COVERED_TOOLS.has(entry.name) || !STILL_NAMED_AT_REMOTE.has(label);
    test(
      `${label}: ${mustWithhold ? "names no reserved page at remote reach" : "still names one, and the registry says so"}`,
      async () => {
        const response = await drive(TRANSPORT_REACH.remote, entry.name, probeArgs(recipe));
        if (mustWithhold) {
          expect(response, `${label} at remote reach`).not.toContain(RESERVED_MARKER);
        } else {
          // The other direction of the equality: a recipe that stopped
          // naming it has been covered, and this list has to say so.
          expect(response, `${label} no longer names a reserved page`).toContain(RESERVED_MARKER);
        }
        // The reachability half, taken on this recipe's own fresh fixture
        // and AFTER the assertion above, so the measurement cannot change
        // what the sweep saw. Counted here rather than in a loop of its
        // own because several recipes WRITE to the fixture, and a second
        // pass over one vault would be measuring the vault they left.
        const local = await drive(TRANSPORT_REACH.local, entry.name, probeArgs(recipe));
        recipesMeasuredAtLocal += 1;
        if (local.includes(RESERVED_MARKER)) recipesReachingAtLocal += 1;
      },
      PROBE_TIMEOUT_MS,
    );
  }
}

test("the sweep's non-vacuity is measured, not assumed", () => {
  // The counter is only meaningful if the sweep above actually ran, so
  // that is asserted first: under a name filter this fails by saying the
  // sweep was skipped rather than by reporting a bound nobody measured.
  const recipeCount = ALL_ENTRIES.reduce((n, entry) => n + entry.calls.length, 0);
  expect(recipesMeasuredAtLocal, "the sweep did not run, so nothing was measured").toBe(
    recipeCount,
  );
  expect(recipesReachingAtLocal).toBeGreaterThanOrEqual(RECIPES_REACHING_RESERVED_AT_LOCAL.min);
  expect(recipesReachingAtLocal).toBeLessThanOrEqual(RECIPES_REACHING_RESERVED_AT_LOCAL.max);
});

// ─────────────────────────────────────────────────────────────────────────────
// The federated caller shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The union over several vaults is a different caller SHAPE, not a
 * different rule - `searchAcrossVaults` spreads the caller's options onto
 * every origin, so each leg carries the reach the transport minted. That
 * is exactly the kind of claim that is true until someone adds an origin
 * loop that rebuilds its options, so it is executed rather than asserted
 * in a comment.
 */
test("a federated caller is bound by the same rule on every origin", async () => {
  const external = join(tmp, "external-vault");
  mkdirSync(join(external, "Brain"), { recursive: true });
  mkdirSync(join(external, "notes"), { recursive: true });
  writeFileSync(
    join(external, "notes", `${RESERVED_MARKER}-external.md`),
    `---\n${RESERVE_LINE}\n---\n\n${QUERY} ${PROBE_TERMS} external\n`,
  );
  writeFileSync(
    join(external, "notes", "external-shared.md"),
    `# External\n\n${QUERY} ${PROBE_TERMS} external shared\n`,
  );
  await indexVault(resolveSearchConfig({ vault: external, configPath }), { force: true });
  addRecallSource(configPath, vault, "team", external);

  const args = { query: QUERY, global: true, visibility: [REMOTE_DENY_VISIBILITY_TOKEN] };
  // The union must reach the foreign origin at all, or the assertion
  // below is clean because nothing federated.
  const local = await drive(TRANSPORT_REACH.local, "brain_search", args);
  expect(local).toContain("external-shared.md");
  expect(local).toContain(RESERVED_MARKER);

  expect(await drive(TRANSPORT_REACH.remote, "brain_search", args)).not.toContain(RESERVED_MARKER);
});

test("the _meta channel is live on these probes, so the sweep covers it", async () => {
  // The refusal proves the member is populated. A sweep that asserted
  // over an envelope with no `_meta` would be covering a channel that was
  // never there.
  //
  // Asserted on the RESULT rather than by searching the serialised
  // envelope for the string: every probe sends `params._meta.progressToken`
  // itself, so a substring check matched the request the probe made and
  // would have stayed green over an empty or absent `result._meta` - the
  // exact retirement it exists to catch.
  const response = await drive(TRANSPORT_REACH.remote, "brain_search", { query: QUERY });
  const meta = (JSON.parse(response) as { result?: { _meta?: Record<string, unknown> } }).result
    ?._meta;
  expect(meta, "result._meta is where a reserved name could ride out").toBeDefined();
  expect(Object.keys(meta!)).toContain(PROGRESS_META_KEY);
});
