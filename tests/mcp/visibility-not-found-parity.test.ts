/**
 * Root C: a withheld read answers exactly as an absent one
 * (private-is-not-a-suggestion, unit 5).
 *
 * The third root is the pair of primitives that take a caller-supplied
 * KEY rather than a query: a chunk id (`expandHit`) and a Brain artifact
 * id (the templated `osb://` resources). Both hand back a page's path,
 * title and body, and neither ever consulted `visibility:`.
 *
 * What this file pins is not only that the page is withheld but that the
 * REFUSAL is indistinguishable from the answer an absent key produces.
 * A distinguishable refusal is an existence oracle over exactly the
 * population the boundary exists to hide, and both key spaces are
 * enumerable: a chunk id is a sequential integer, and a preference id is
 * `pref-<topic-slug>`.
 *
 * The reachability half is not optional. A probe that never saw the
 * marker at local reach would be a clean sweep over an empty fixture.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { expandHit } from "../../src/core/search/cards.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { search } from "../../src/core/search/search.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { readResource, type ResourceContext } from "../../src/mcp/resources.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

/** HOME is pinned per file by convention; nothing pins it globally. */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-vis-parity-home-"));

/** Appears only inside artifacts carrying the reserved token. */
const MARKER = "zzreservedmarkerzz";
const LOG_DATE = "2026-05-04";
const SHARED_TOPIC = "shared";
/** The topic whose only rule is the reserved preference. */
const RESERVED_TOPIC = `${MARKER}-topic`;
const QUERY = "lattice widgets";

let vault: string;
let dbPath: string;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vis-parity-vault-"));
  dbPath = join(mkdtempSync(join(tmpdir(), "o2b-vis-parity-db-")), "brain.sqlite");
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  makePref(SHARED_TOPIC);
  makePref(`${MARKER}-r`, RESERVED_TOPIC);
  reserve(`pref-${MARKER}-r`);
  // The reserved preference links the shared one, so a backlinks read the
  // caller IS entitled to fans out to a reserved source artifact.
  const path = join(brainDirs(vault).preferences, `pref-${MARKER}-r.md`);
  writeFileSync(path, `${readFileSync(path, "utf8")}\nSee [[pref-${SHARED_TOPIC}]].\n`);
  appendLogEvent(
    vault,
    {
      timestamp: `${LOG_DATE}T00:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        path: `Brain/preferences/pref-${MARKER}-r.md`,
        preference: `[[pref-${MARKER}-r]]`,
        result: "applied",
      },
    },
    { deviceId: "" },
  );
  // A vault page for the chunk-id half, and an ordinary one beside it so
  // the query has something to match either way.
  writeFileSync(join(vault, "open.md"), `# Open\n\nshared ${QUERY} here`);
  writeFileSync(
    join(vault, `${MARKER}.md`),
    `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n# ${MARKER}\n\nclassified ${QUERY} here`,
  );
  await indexVault(makeConfig({ vault, dbPath }));
});

function makePref(slug: string, topic?: string): void {
  writePreference(vault, {
    slug,
    topic: topic ?? slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
  });
}

/** Add the reserved token to an existing preference's frontmatter. */
function reserve(id: string): void {
  const path = join(brainDirs(vault).preferences, `${id}.md`);
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error(`no frontmatter block in ${path}`);
  writeFileSync(
    path,
    `${text.slice(0, end)}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]${text.slice(end)}`,
  );
}

/** Read one resource at `reach`, folding a refusal into the answer. */
function read(uri: string, reach: TransportReach): string {
  const ctx: ResourceContext = { vault, reach };
  try {
    return readResource(ctx, uri).text;
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Every templated resource that fans out to a reserved artifact from a
 * key the caller IS entitled to name - the shape a caller cannot be
 * refused for asking, so the page has to disappear from the answer
 * instead.
 */
const FAN_OUT_URIS: ReadonlyArray<{ readonly uri: string; readonly why: string }> = [
  { uri: `osb://backlinks/pref-${SHARED_TOPIC}`, why: "a backlink names its source artifact" },
  { uri: `osb://log/${LOG_DATE}`, why: "a log event names the preference it was about" },
];

describe("templated osb:// resources", () => {
  for (const { uri, why } of FAN_OUT_URIS) {
    test(`${uri}: reaches the reserved artifact locally and withholds it remotely`, () => {
      expect(read(uri, TRANSPORT_REACH.local), `${uri} local (${why})`).toContain(MARKER);
      expect(read(uri, TRANSPORT_REACH.remote), `${uri} remote (${why})`).not.toContain(MARKER);
    });
  }

  test("osb://topic renders the reserved rule locally and not remotely", () => {
    // A topic whose only rule is reserved reads, at remote reach, as a
    // topic with no rule - the shape the renderer already has for a topic
    // that never reached promotion - rather than as a topic that refused.
    const uri = `osb://topic/${RESERVED_TOPIC}`;
    expect(read(uri, TRANSPORT_REACH.local)).toContain(`principle for ${MARKER}-r`);
    expect(read(uri, TRANSPORT_REACH.remote)).not.toContain(`principle for ${MARKER}-r`);
  });

  test("osb://preference returns the page locally and none of it remotely", () => {
    const local = read(`osb://preference/pref-${MARKER}-r`, TRANSPORT_REACH.local);
    expect(local).toContain(`principle for ${MARKER}-r`);
    const remote = read(`osb://preference/pref-${MARKER}-r`, TRANSPORT_REACH.remote);
    expect(remote).not.toContain(`principle for ${MARKER}-r`);
  });

  test("a withheld preference is reported byte for byte as an absent one", () => {
    const withheld = read(`osb://preference/pref-${MARKER}-r`, TRANSPORT_REACH.remote);
    const absent = read("osb://preference/pref-never-existed", TRANSPORT_REACH.remote);
    expect(withheld).toStartWith("threw:");
    // The id each message echoes is the caller's own argument, so the
    // comparison is made over the message with that argument removed.
    expect(withheld.replace(`pref-${MARKER}-r`, "ID")).toBe(
      absent.replace("pref-never-existed", "ID"),
    );
  });

  test("the BARE SLUG key shape has the same parity as the prefixed one", () => {
    // The reader accepts `pref-foo`, `ret-foo` and the bare slug, so the
    // key space a caller enumerates is the bare one too. The absent
    // branch echoes the NORMALISED id (`queryByPreference` was handed
    // it); the withheld branch echoed the raw one, so the presence of the
    // `pref-` prefix in the message answered "does this page exist" over
    // exactly the reserved population.
    const withheld = read(`osb://preference/${MARKER}-r`, TRANSPORT_REACH.remote);
    const absent = read("osb://preference/never-existed", TRANSPORT_REACH.remote);
    expect(withheld).toStartWith("threw:");
    expect(withheld.replace(`pref-${MARKER}-r`, "ID")).toBe(
      absent.replace("pref-never-existed", "ID"),
    );
  });
});

/**
 * `brain_query mode=preference` over the same key space, through the tool
 * rather than the resource. Preference ids are `pref-<slug>` and a slug
 * is a topic name, so this is the most guessable key surface the boundary
 * has.
 */
describe("brain_query mode=preference", () => {
  const brainQuery = (): ToolDefinition => BRAIN_TOOLS.find((t) => t.name === "brain_query")!;

  const ask = async (preference: string, reach: TransportReach): Promise<string> => {
    const ctx: ServerContext = { vault, reach, configPath: null, repoRoot: null };
    try {
      await brainQuery().handler(ctx, { preference });
      return "returned";
    } catch (err) {
      return `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  test("a withheld preference is refused with the message an absent one produces", async () => {
    const withheld = await ask(`pref-${MARKER}-r`, TRANSPORT_REACH.remote);
    const absent = await ask("pref-never-existed", TRANSPORT_REACH.remote);
    expect(withheld).toStartWith("threw:");
    // Only the caller's own argument may differ between the two.
    expect(withheld.replace(`pref-${MARKER}-r`, "ID")).toBe(
      absent.replace("pref-never-existed", "ID"),
    );
  });

  test("the same preference is returned at local reach", async () => {
    expect(await ask(`pref-${MARKER}-r`, TRANSPORT_REACH.local)).toBe("returned");
  });
});

describe("the by-chunk-id drill-down", () => {
  async function reservedChunkId(): Promise<number> {
    const outcome = await search(makeConfig({ vault, dbPath }), {
      query: QUERY,
      limit: 20,
      // The page declares a visibility token, so the caller's own scope
      // has to name it before the reach question is even reached.
      visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
      transportReach: TRANSPORT_REACH.local,
    });
    const hit = outcome.results.find((r) => r.path === `${MARKER}.md`);
    if (hit === undefined) throw new Error("the reserved page was not indexed");
    return hit.chunkId;
  }

  test("hydrates the reserved page at local reach", async () => {
    const result = await expandHit(makeConfig({ vault, dbPath }), {
      chunkId: await reservedChunkId(),
      transportReach: TRANSPORT_REACH.local,
    });
    expect(result.note.path).toBe(`${MARKER}.md`);
  });

  test("refuses it at remote reach with the absent-chunk message", async () => {
    const chunkId = await reservedChunkId();
    const refused = await expandHit(makeConfig({ vault, dbPath }), {
      chunkId,
      transportReach: TRANSPORT_REACH.remote,
    }).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
    // The absent id is a chunk id no document can have, so the two
    // messages differ only in the caller's own argument.
    const absent = await expandHit(makeConfig({ vault, dbPath }), {
      chunkId: Number.MAX_SAFE_INTEGER,
      transportReach: TRANSPORT_REACH.remote,
    }).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
    expect(refused).not.toBeNull();
    expect(refused).toBe(`chunk not found: ${chunkId}`);
    expect(absent).toBe(`chunk not found: ${Number.MAX_SAFE_INTEGER}`);
  });

  test("still hydrates an ordinary page at remote reach", async () => {
    const outcome = await search(makeConfig({ vault, dbPath }), {
      query: QUERY,
      limit: 20,
      transportReach: TRANSPORT_REACH.remote,
    });
    const hit = outcome.results.find((r) => r.path === "open.md");
    if (hit === undefined) throw new Error("the ordinary page was not indexed");
    const result = await expandHit(makeConfig({ vault, dbPath }), {
      chunkId: hit.chunkId,
      transportReach: TRANSPORT_REACH.remote,
    });
    expect(result.note.path).toBe("open.md");
  });
});
