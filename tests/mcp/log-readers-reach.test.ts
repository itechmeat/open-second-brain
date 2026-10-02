/**
 * The readers of the Brain log answer at the caller's reach.
 *
 * The daily log names preference ids, retired ids and evidence artifacts
 * in its event bodies. Below local reach the log page itself is not
 * served by a generic page reader (search), and every reader that renders
 * log events (analytics timeline, belief evolution, concept synthesis,
 * the today dashboard, the digest view, the event trace, backlinks and the
 * doctor) answers as if a record the caller cannot read had never been
 * logged: an event naming one is dropped, and a dream is kept while one
 * of its transitions is readable, showing only those.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts. A server with no
 * reach minted is a remote caller; each row also carries a local control
 * proving the reserved record is there to hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_SLUG,
  reachServer,
  type ReachLogFixture as Fixture,
  RETIRED_SLUG,
  SHARED_SLUG,
} from "../helpers/reach-log-fixture.ts";

/** Relative ages ("1h ago") and durations, which tick between the two builds. */
const AGE_RE = /\b\d+(?:ms|s|m|h|d)\b/g;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-log-readers-reach-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate);
}

async function call(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<unknown> {
  const result = (await reachServer(f, reach).callTool(tool, args)) as Record<string, unknown>;
  return result["structuredContent"] ?? result;
}

/** Vault paths, handles, instants and ages replaced. */
function normalise(f: Fixture, value: unknown): string {
  return maskVolatile(f, value).replace(AGE_RE, "<AGE>");
}

/** The remote answers of both vaults, normalised, plus vault A's local answer. */
async function abRow(
  tool: string,
  args: (f: Fixture) => Record<string, unknown>,
  prepare: (f: Fixture) => Promise<void> = async () => {},
): Promise<{ withheld: string; absent: string; local: string }> {
  const a = fixture(true);
  const b = fixture(false);
  await prepare(a);
  await prepare(b);
  return {
    withheld: normalise(a, await call(a, tool, args(a))),
    absent: normalise(b, await call(b, tool, args(b))),
    local: normalise(a, await call(a, tool, args(a), TRANSPORT_REACH.local)),
  };
}

async function indexed(f: Fixture): Promise<void> {
  await indexVault(resolveSearchConfig({ vault: f.vault, configPath: f.configPath }), {
    force: true,
  });
}

/** The page paths a search answer names, sorted (scores depend on the corpus). */
function searchPaths(normalised: string): ReadonlyArray<string> {
  const results = (JSON.parse(normalised) as { results?: ReadonlyArray<{ path: string }> }).results;
  return (results ?? []).map((r) => r.path).toSorted();
}

describe("brain_search does not serve the daily log below local reach", () => {
  for (const word of [PRIVATE_SLUG, RETIRED_SLUG]) {
    test(`query '${word}' answers remotely as if the record was never logged`, async () => {
      const row = await abRow("brain_search", () => ({ query: word }), indexed);
      expect(row.withheld).toBe(row.absent);
      // Control: a local caller still finds the log page naming the record.
      expect(row.local).toContain("Brain/log/");
      expect(row.local).toContain(word);
    });
  }

  test("query 'rule' names the same pages remotely and the log page only locally", async () => {
    const row = await abRow("brain_search", () => ({ query: "rule" }), indexed);
    expect(searchPaths(row.withheld)).toEqual(searchPaths(row.absent));
    expect(row.withheld).not.toContain("Brain/log/");
    expect(row.withheld).not.toContain(PRIVATE_SLUG);
    expect(row.withheld).not.toContain(RETIRED_SLUG);
    expect(searchPaths(row.local).some((p) => p.startsWith("Brain/log/"))).toBe(true);
  });
});

/** Every row below: the remote answers agree, and the local control names the record. */
async function expectAnswersAsAbsent(
  tool: string,
  args: (f: Fixture) => Record<string, unknown>,
  localNames: ReadonlyArray<string>,
  prepare?: (f: Fixture) => Promise<void>,
): Promise<{ withheld: string; local: string }> {
  const row = await abRow(tool, args, prepare);
  expect(row.withheld).toBe(row.absent);
  // A row whose own argument names the record echoes it as its target.
  const named = JSON.stringify(args({ date: "" } as Fixture));
  for (const slug of [PRIVATE_SLUG, RETIRED_SLUG]) {
    if (!named.includes(slug)) expect(row.withheld).not.toContain(slug);
  }
  for (const name of localNames) expect(row.local).toContain(name);
  return row;
}

describe("brain_analytics answers at the caller's reach", () => {
  test("view=timeline with no filter", async () => {
    const row = await expectAnswersAsAbsent("brain_analytics", () => ({ view: "timeline" }), [
      `pref-${PRIVATE_SLUG}`,
      `ret-${RETIRED_SLUG}`,
      `Notes/${PRIVATE_SLUG}-violated`,
    ]);
    // Not vacuous: the public preference's evidence and the shared dream are listed.
    expect(row.withheld).toContain(`Notes/${SHARED_SLUG}-applied`);
    expect(row.withheld).toContain(BRAIN_LOG_EVENT_KIND.dream);
  });

  test("view=timeline since a date", async () => {
    await expectAnswersAsAbsent("brain_analytics", (f) => ({ view: "timeline", since: f.date }), [
      `pref-${PRIVATE_SLUG}`,
    ]);
  });

  test("view=timeline for the reserved preference's own id", async () => {
    await expectAnswersAsAbsent(
      "brain_analytics",
      () => ({ view: "timeline", pref_id: `pref-${PRIVATE_SLUG}` }),
      [`Notes/${PRIVATE_SLUG}-applied`],
    );
  });

  for (const args of [
    { view: "belief_evolution", pref_id: `pref-${PRIVATE_SLUG}` },
    { view: "belief_evolution", topic: PRIVATE_SLUG },
  ]) {
    test(`view=belief_evolution ${JSON.stringify(args)}`, async () => {
      await expectAnswersAsAbsent("brain_analytics", () => args, [`Notes/${PRIVATE_SLUG}-`]);
    });
  }

  test("view=belief_evolution for the retired record under its pref- spelling", async () => {
    await expectAnswersAsAbsent(
      "brain_analytics",
      () => ({ view: "belief_evolution", pref_id: `pref-${RETIRED_SLUG}` }),
      [`[[pref-${RETIRED_SLUG}|rule]]`],
    );
  });

  test("view=belief_evolution for the public preference keeps its rows", async () => {
    const row = await expectAnswersAsAbsent(
      "brain_analytics",
      () => ({ view: "belief_evolution", pref_id: `pref-${SHARED_SLUG}` }),
      [`Notes/${SHARED_SLUG}-applied`],
    );
    expect(row.withheld).toContain(`Notes/${SHARED_SLUG}-applied`);
  });

  for (const id of [`pref-${PRIVATE_SLUG}`, `pref-${RETIRED_SLUG}`]) {
    test(`view=concept_synthesis id=${id}`, async () => {
      const row = await expectAnswersAsAbsent(
        "brain_analytics",
        () => ({ view: "concept_synthesis", id, include_unlinked: true }),
        ["linkers", "log-"],
      );
      expect(JSON.parse(row.withheld)).toMatchObject({ linkers: [], unlinked_mentions: [] });
    });
  }
});

describe("brain_brief view=today answers at the caller's reach", () => {
  test("the recent activity names no reserved record and counts only what it shows", async () => {
    const row = await expectAnswersAsAbsent("brain_brief", () => ({ view: "today" }), [
      `pref=pref-${PRIVATE_SLUG}`,
      "confirmed=2",
    ]);
    expect(row.withheld).toContain(`artifact=Notes/${SHARED_SLUG}-applied`);
    expect(row.withheld).toContain("confirmed=1");
  });

  test("a limit counts after the filter, not before", async () => {
    await expectAnswersAsAbsent("brain_brief", () => ({ view: "today", limit: 2 }), [
      `pref-${PRIVATE_SLUG}`,
    ]);
  });
});

describe("a dream shared with a reserved record is kept, showing only readable transitions", () => {
  test("brain_brief view=digest counts the shared dream for its public transition", async () => {
    const row = await expectAnswersAsAbsent(
      "brain_brief",
      () => ({ view: "digest", format: "json" }),
      [`pref-${PRIVATE_SLUG}`],
    );
    // Not vacuous: the agent summary counts the public evidence and the shared dream.
    const digest = JSON.parse((JSON.parse(row.withheld) as { content: string }).content) as {
      agent_summary: ReadonlyArray<{ total_events: number }>;
    };
    expect(digest.agent_summary.map((a) => a.total_events)).toEqual([2]);
  });

  for (const args of [
    {},
    { kind: BRAIN_LOG_EVENT_KIND.dream },
    { kind: BRAIN_LOG_EVENT_KIND.applyEvidence },
  ]) {
    test(`brain_event_trace ${JSON.stringify(args)}`, async () => {
      const row = await expectAnswersAsAbsent(
        "brain_event_trace",
        (f) => ({ date: f.date, ...args }),
        [
          args.kind === BRAIN_LOG_EVENT_KIND.applyEvidence
            ? `Notes/${PRIVATE_SLUG}-`
            : PRIVATE_SLUG,
        ],
      );
      expect(row.withheld).toContain(`pref-${SHARED_SLUG}`);
    });
  }
});

/** A readable preference page that contests `contested` by id. */
function contester(f: Fixture, slug: string, contested: string): void {
  writeFileSync(
    join(f.vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      `topic: ${slug}`,
      `principle: Rule ${slug}.`,
      `contradicts: [${contested}]`,
      "---",
      "",
      "Contests a rule.",
      "",
    ].join("\n"),
  );
}

describe("brain_claims answers at the caller's reach", () => {
  for (const operation of ["current", "history"]) {
    test(`operation=${operation} lists no reserved record and counts only what it lists`, async () => {
      const row = await expectAnswersAsAbsent("brain_claims", () => ({ operation }), [
        `pref-${PRIVATE_SLUG}`,
      ]);
      expect(row.withheld).toContain(`pref-${SHARED_SLUG}`);
    });
  }

  test("a claim contesting a retired reserved record is dropped, as one contesting a reserved record is", async () => {
    const f = fixture(true);
    contester(f, "contests-retired", `pref-${RETIRED_SLUG}`);
    contester(f, "contests-reserved", `pref-${PRIVATE_SLUG}`);
    const remote = normalise(f, await call(f, "brain_claims", { operation: "history" }));
    const local = normalise(
      f,
      await call(f, "brain_claims", { operation: "history" }, TRANSPORT_REACH.local),
    );
    expect(remote).toContain(`pref-${SHARED_SLUG}`);
    expect(remote).not.toContain("contests-reserved");
    expect(remote).not.toContain("contests-retired");
    // Control: a local caller lists both contesting claims.
    expect(local).toContain("contests-reserved");
    expect(local).toContain("contests-retired");
  });
});

/** The doctor's broken-backlinks findings in one normalised answer. */
function brokenBacklinks(normalised: string): ReadonlyArray<{ code: string }> {
  return (JSON.parse(normalised) as { warnings: ReadonlyArray<{ code: string }> }).warnings.filter(
    (w) => w.code === "broken-backlinks",
  );
}

describe("a retired record is judged under its pref- spelling too", () => {
  test("brain_backlinks id=pref-bygone answers as an absent page", async () => {
    await expectAnswersAsAbsent("brain_backlinks", () => ({ id: `pref-${RETIRED_SLUG}` }), [
      "log-dream",
    ]);
  });

  for (const args of [{ kind: BRAIN_LOG_EVENT_KIND.applyEvidence }, {}]) {
    test(`brain_event_trace ${JSON.stringify(args)} drops evidence on the retired record`, async () => {
      const row = await expectAnswersAsAbsent(
        "brain_event_trace",
        (f) => ({ date: f.date, ...args }),
        [`Notes/${RETIRED_SLUG}-applied`],
      );
      expect(row.withheld).toContain(`Notes/${SHARED_SLUG}-applied`);
    });
  }

  test("brain_doctor names no broken backlink to the retired record", async () => {
    // Only the broken-backlinks findings are compared: the orphan-evidence
    // findings name evidence artifacts by basename and are outside this row.
    const row = await abRow("brain_doctor", () => ({}));
    expect(brokenBacklinks(row.withheld)).toEqual(brokenBacklinks(row.absent));
    expect(JSON.stringify(brokenBacklinks(row.withheld))).not.toContain(RETIRED_SLUG);
    expect(JSON.stringify(brokenBacklinks(row.local))).toContain(`[[pref-${RETIRED_SLUG}]]`);
  });
});
