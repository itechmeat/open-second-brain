/**
 * The ownership boundary, on the OTHER protocol verb
 * (a-label-is-not-a-boundary, U3).
 *
 * `tests/mcp/agent-scope-matrix.test.ts` enumerates `tools/*` and drives
 * every entry against a two-owner fixture. Its population is the tool
 * table, so nothing in it ever issued a `resources/read` - and
 * `src/mcp/resources.ts` contained no reference to `agentName`,
 * `ownerScope` or `gatedOwnerScopeView` at all. Under the same
 * `integrity.owner_scope_delivery: fail` that made `brain_query`
 * withhold a preference, `resources/read osb://preference/<id>` returned
 * that preference's file in full: frontmatter, `owner:` line and body
 * prose. A boundary one verb honours and its neighbour ignores is not a
 * boundary.
 *
 * This file is that verb's probe. It drives every templated resource
 * that reaches owner-taggable content, as the OTHER owner, and asserts
 * the same two things the tool matrix does: the marker is reachable with
 * the gate off, and absent with it on. The reachability half is not
 * optional - a resource probe that never saw the marker unscoped would
 * be the "clean sweep over an empty fixture" the tool matrix exists to
 * prevent.
 */

import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { readResource, type ResourceContext } from "../../src/mcp/resources.ts";
import { pinHome, tempDirs } from "../helpers/temp-dir.ts";

const mkTemp = tempDirs();

/** HOME is pinned per file by convention; nothing pins it globally. */
pinHome("o2b-resources-scope-home-");

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
/** Appears only inside artifacts owned by {@link OWNER_A}. */
const MARKER = "secretmarkerzz";
const LOG_DATE = "2026-05-04";

let vault: string;

beforeEach(() => {
  vault = mkTemp("o2b-resources-scope-vault-");
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  makePref("shared");
  makePref(`${MARKER}-a`, OWNER_A);
  // The owner-A preference also carries the SHARED topic, so a topic
  // resource the caller is entitled to still fans out to it.
  makePref(`${MARKER}-a2`, OWNER_A, "shared");
  writeFileSync(
    join(brainDirs(vault).preferences, `pref-${MARKER}-a.md`),
    `${readPref(`pref-${MARKER}-a`)}\nSee [[pref-shared]].\n`,
  );
  appendLogEvent(
    vault,
    {
      timestamp: `${LOG_DATE}T00:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        path: `Brain/preferences/pref-${MARKER}-a.md`,
        preference: `[[pref-${MARKER}-a]]`,
        result: "applied",
      },
    },
    { deviceId: "" },
  );
});

function readPref(id: string): string {
  return readFileSync(join(brainDirs(vault).preferences, `${id}.md`), "utf8");
}

function makePref(slug: string, owner?: string, topic?: string): void {
  writePreference(vault, {
    slug,
    topic: topic ?? slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    ...(owner !== undefined ? { owner } : {}),
  });
}

function setGate(mode: string): void {
  atomicWriteFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${mode}\n`,
  );
}

/** The `## Actions` section of a digest render: its heading through the next. */
function actionsSection(digest: string): string {
  const start = digest.indexOf("\n## Actions");
  if (start === -1) return "";
  const rest = digest.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** Read one resource AS `agentName`, folding a refusal into the answer. */
function read(uri: string, agentName: string = OWNER_B): string {
  const ctx: ResourceContext = { vault, agentName };
  try {
    return readResource(ctx, uri).text;
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Every templated resource that reaches owner-taggable content, with the
 * URI that reaches it.
 *
 * `osb://preference/<id>` names the hidden artifact directly; the other
 * three name something the caller is entitled to and reach the hidden
 * one through a fan-out - a shared topic, a shared link target, a shared
 * log day - which is the shape a caller cannot be refused for asking.
 */
const OWNER_BEARING_URIS: ReadonlyArray<{ uri: string; why: string }> = [
  { uri: "osb://topic/shared", why: "a topic fans out to every preference carrying it" },
  { uri: "osb://backlinks/pref-shared", why: "every backlink names its source artifact" },
  { uri: `osb://log/${LOG_DATE}`, why: "a log event names the preference it was about" },
];

for (const { uri, why } of OWNER_BEARING_URIS) {
  test(`${uri}: reaches owner content and withholds it under the gate`, () => {
    setGate(GATE_MODE.off);
    expect(read(uri), `${uri} unscoped (${why})`).toContain(MARKER);

    setGate(GATE_MODE.fail);
    expect(read(uri), `${uri} scoped (${why})`).not.toContain(MARKER);
  });

  test(`${uri}: its own owner still reads it`, () => {
    setGate(GATE_MODE.fail);
    expect(read(uri, OWNER_A)).toContain(MARKER);
  });
}

/**
 * `osb://preference/{id}` is probed on its own: the caller NAMES the
 * hidden id, so the refusal echoes it back and a marker check over the
 * whole response would be measuring the caller's own argument. What must
 * not travel is the page.
 */
test("osb://preference returns the page unscoped and none of it under the gate", () => {
  setGate(GATE_MODE.off);
  const unscoped = read(`osb://preference/pref-${MARKER}-a`);
  expect(unscoped).toContain(`owner: ${OWNER_A}`);
  expect(unscoped).toContain(`principle for ${MARKER}-a`);

  setGate(GATE_MODE.fail);
  const scoped = read(`osb://preference/pref-${MARKER}-a`);
  expect(scoped).not.toContain(`owner: ${OWNER_A}`);
  expect(scoped).not.toContain(`principle for ${MARKER}-a`);

  // Its own owner still reads it in full.
  expect(read(`osb://preference/pref-${MARKER}-a`, OWNER_A)).toContain(`principle for ${MARKER}-a`);
});

/**
 * A withheld preference answers exactly as an absent one does.
 *
 * A distinguishable refusal is an existence oracle over the population
 * the gate exists to hide, and preference ids are guessable - they are
 * `pref-<topic-slug>`.
 */
test("a withheld preference resource is reported as an absent one", () => {
  setGate(GATE_MODE.fail);
  const withheld = read(`osb://preference/pref-${MARKER}-a`);
  const absent = read("osb://preference/pref-never-existed");
  expect(withheld).toStartWith("threw:");
  expect(withheld.replace(`${MARKER}-a`, "never-existed")).toBe(absent);
});

test("the shared half of every resource still travels under the gate", () => {
  setGate(GATE_MODE.fail);
  expect(read("osb://topic/shared")).toContain("pref-shared");
  expect(read("osb://preference/pref-shared")).toContain("principle for shared");
  expect(read(`osb://log/${LOG_DATE}`)).toContain(LOG_DATE);
});

/**
 * With the gate off, the resources surface is byte-identical to what it
 * served before any of this existed.
 */
test("gate off leaves every resource unfiltered", () => {
  setGate(GATE_MODE.off);
  for (const { uri } of OWNER_BEARING_URIS) expect(read(uri)).toContain(MARKER);
});

/**
 * The digest resource renders its maintenance actions from a vault-wide
 * scan, so an owned page past the stale-stable cap can reach this
 * surface through `actions` long after it stopped appearing in any
 * windowed section. The scope is threaded into the render itself (the
 * way `osb://preferences/active` does), so the row is judged like the
 * sections beside it.
 *
 * The fixture separates the two halves: an ownerless, in-window
 * preference keeps the windowed sections non-empty (the shared half must
 * keep travelling), while the marked page is dated far enough back to be
 * stale on any run date and confirmed. Its `## Actions` lifecycle row is
 * the row under test, so the assertions below check THAT row in THAT
 * section - a marker check over the whole render would pass on the
 * fixture's windowed sections alone and prove nothing about Actions.
 */
test("osb://digest/latest: the actions section carries the ownership rule too", () => {
  const now = new Date();
  writePreference(vault, {
    slug: "digest-window-active",
    topic: "digest-window-active",
    principle: "principle for digest-window-active",
    created_at: now.toISOString(),
    unconfirmed_until: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    status: BRAIN_PREFERENCE_STATUS.unconfirmed,
    evidenced_by: ["[[sig-digest-window-active]]"],
  });
  writePreference(vault, {
    slug: `${MARKER}-stale`,
    topic: `${MARKER}-stale`,
    principle: `principle for ${MARKER}-stale`,
    created_at: "2024-01-01T00:00:00Z",
    unconfirmed_until: "2024-01-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2024-01-01-${MARKER}]]`],
    confirmed_at: "2024-01-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2024-01-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    owner: OWNER_A,
  });

  setGate(GATE_MODE.off);
  const unscoped = read("osb://digest/latest");
  expect(unscoped).toContain("digest-window-active");
  expect(unscoped).toContain(MARKER);
  // The row under test, in the section under test: a lifecycle action row
  // naming the marked page. The fixture can surface the marked page
  // elsewhere too (its applied_count feeds a windowed section), so only
  // this pins the Actions surface.
  const unscopedActions = actionsSection(unscoped);
  const row = unscopedActions.split("\n").find((line) => line.includes(`pref-${MARKER}-stale`));
  expect(row, `an Actions row must name the marked page:\n${unscopedActions}`).toBeDefined();
  expect(row).toMatch(/^- \[lifecycle\] impact \d+ — /);

  setGate(GATE_MODE.fail);
  const scoped = read("osb://digest/latest");
  // The shared half still travels, so the marker's absence is the
  // ownership rule and not an empty digest.
  expect(scoped).toContain("digest-window-active");
  expect(scoped).not.toContain(MARKER);
  // And within the section under test: it still renders, the ownerless
  // stale page's row still travels in it, and the marked page's row is
  // the one withheld.
  const scopedActions = actionsSection(scoped);
  expect(scopedActions).toContain("pref-shared");
  expect(scopedActions).not.toContain(`pref-${MARKER}-stale`);

  // Its own owner still reads the maintenance suggestion.
  expect(read("osb://digest/latest", OWNER_A)).toContain(MARKER);
});
