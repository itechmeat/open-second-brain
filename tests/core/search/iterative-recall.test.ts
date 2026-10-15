/**
 * Bounded iterative recall loop (recall-quality wave, lane A): the
 * single-fire second pass generalized into a bounded N-round driver.
 * With the opt-in knob on, gap-proposal rounds 2..N run deterministic
 * sub-query pulls over the same pool-merging discipline as round 2,
 * bounded by the round cap and the composite deadline; the extracted
 * marginal-value stop retires rounds that stop paying. Knob off (or the
 * request flag absent) the pipeline is byte-identical to the pre-change
 * one, including a mode-on-but-inert comparison.
 */

import { test, expect, beforeEach, afterEach, describe, setSystemTime } from "bun:test";

import {
  ITERATIVE_RECALL_MAX_ROUNDS_CAP,
  ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT,
  runIterativeRecall,
} from "../../../src/core/search/pipeline/iterative-recall.ts";
import { Store } from "../../../src/core/search/store.ts";
import { runFtsQueryDetailed } from "../../../src/core/search/fts.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import { pauseStateDigest } from "../../../src/core/search/decider-step.ts";
import { probeQueryCache } from "../../../src/core/search/pipeline/cache-slot.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { fakeCredential } from "../../helpers/fake-credentials.ts";
import type {
  ResolvedSearchConfig,
  StructuredRecallQueryDocument,
} from "../../../src/core/search/types.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

/** A round token shaped like the ones the loop mints; assembled from parts. */
const KNOB_OFF_TOKEN = fakeCredential("tok", "-knob-off");

/** Six common-term docs give warehouse/rotation a low IDF; the loop's floor stays honest. */
async function seed(): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    writeMd(vault, `Brain/notes/wh${i}.md`, `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`);
  }
  writeMd(
    vault,
    "Brain/notes/chandelier.md",
    "# Chandelier\n\nChandelier handoff log, east hall.\n",
  );
  writeMd(
    vault,
    "Brain/notes/candelabra.md",
    "# Candelabra\n\nCandelabra restoration notes, west hall.\n",
  );
  writeMd(vault, "Brain/notes/zircon.md", "# Zircon\n\nZircon inventory tag, north vault.\n");
  await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
}

/** A vault of 60 uniquely-termed docs, so pulls saturate the pool width before gaps close. */
async function seedWide(): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    writeMd(vault, `Brain/notes/wh${i}.md`, `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`);
  }
  for (let i = 1; i <= 60; i++) {
    const term = `relic${String(i).padStart(2, "0")}`;
    writeMd(vault, `Brain/notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
  }
  await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
}

/** The lex lane is pinned to the common terms, so first-pass pools miss every rare term. */
const structuredFor = (): StructuredRecallQueryDocument =>
  Object.freeze({
    intent: null,
    lex: Object.freeze({
      include: Object.freeze(["warehouse", "rotation"]) as ReadonlyArray<string>,
      exclude: Object.freeze([]) as ReadonlyArray<string>,
    }),
    vec: Object.freeze(["warehouse rotation"]) as ReadonlyArray<string>,
    hyde: Object.freeze([]) as ReadonlyArray<string>,
  });

function withIterative(config: ResolvedSearchConfig, maxRounds?: number): ResolvedSearchConfig {
  return {
    ...config,
    recall: {
      ...config.recall,
      iterativeRecallEnabled: true,
      ...(maxRounds !== undefined ? { iterativeRecallMaxRounds: maxRounds } : {}),
    },
  };
}

const COMMON = ["chandelier", "candelabra", "zircon"];

/**
 * Pin the wall clock for the byte-identity comparisons: the recency boost
 * reads Date.now() per call, so two searches a millisecond apart differ in
 * float noise that has nothing to do with the loop. One pinned instant is
 * the honest "same request" for a full serialized comparison.
 */
function withPinnedClock(run: () => Promise<void>): Promise<void> {
  const restored = Date.now();
  setSystemTime(restored);
  return run().finally(() => setSystemTime());
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("iterative-recall"));
});
afterEach(() => cleanup());

describe("iterative round driver over a seeded vault", () => {
  test("the knob off and the flag on leave the outcome byte-identical to the flag off", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const query = `warehouse rotation ${COMMON.join(" ")}`;
    const structured = structuredFor();
    await withPinnedClock(async () => {
      const plain = await search(config, { query, structuredQuery: structured });
      const flagged = await search(config, { query, structuredQuery: structured, iterative: true });
      expect(JSON.stringify(plain)).toBe(JSON.stringify(flagged));
    });
    const plain = await search(config, { query, structuredQuery: structured });
    expect(plain.results.map((r) => r.path)).not.toContain("Brain/notes/chandelier.md");
  });

  test("mode on with no gaps is inert and byte-identical to mode off", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const iterative = withIterative(config);
    const query = "warehouse rotation";
    await withPinnedClock(async () => {
      const off = await search(config, { query });
      const on = await search(iterative, { query, iterative: true });
      expect(JSON.stringify(off)).toBe(JSON.stringify(on));
    });
    const on = await search(iterative, { query, iterative: true });
    expect(on.results.length).toBeGreaterThan(0);
  });

  test("bounded rounds merge pools and recover chunks the first pass missed", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const outcome = await search(withIterative(config), {
      query: `warehouse rotation ${COMMON.join(" ")}`,
      structuredQuery: structuredFor(),
      iterative: true,
    });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/chandelier.md");
    expect(paths).toContain("Brain/notes/candelabra.md");
    expect(paths).toContain("Brain/notes/zircon.md");
  });

  test("the decider pause pool never names a page the reach rule withholds", async () => {
    // The private twin ranks into the seeded pool (it matches the query
    // terms better than its public sibling), so at local reach the pause
    // names it. At remote reach the same call must name no withheld
    // path: pool_ids is post-reach, so the gap between it and the trail
    // can never count a withheld match - the existence oracle
    // FilteredPool.preVisibility exists to close.
    await seed();
    writeMd(
      vault,
      "Brain/notes/private-chandelier.md",
      "---\nvisibility: private\n---\n\n# Private chandelier\n\nChandelier handoff log, sealed wing.\n",
    );
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    // Ghost terms the corpus never matches hold the weighted coverage
    // below the completeness threshold at both reaches, so the loop
    // always pauses instead of finishing coverage-complete.
    const query = `chandelier handoff wyrmshade velkriss`;
    const structured: StructuredRecallQueryDocument = Object.freeze({
      intent: null,
      lex: Object.freeze({
        include: Object.freeze(["chandelier", "handoff"]) as ReadonlyArray<string>,
        exclude: Object.freeze([]) as ReadonlyArray<string>,
      }),
      vec: Object.freeze(["chandelier handoff"]) as ReadonlyArray<string>,
      hyde: Object.freeze([]) as ReadonlyArray<string>,
    });

    const poolPathsAt = async (reach: (typeof TRANSPORT_REACH)["remote" | "local"]) => {
      const outcome = await search(withIterative(config), {
        query,
        structuredQuery: structured,
        iterative: true,
        transportReach: reach,
      });
      const plan = outcome.iterative;
      if (plan === undefined || plan.phase !== "needs-llm-step") {
        throw new Error(`expected a decider pause at reach ${reach}`);
      }
      const store = await Store.open(config, { mode: "read", loadVec: false });
      const paths = [...(await store.hydrateChunks([...plan.poolIds])).values()]
        .map((c) => c.path)
        .sort();
      store.close();
      return paths;
    };

    const localPaths = await poolPathsAt(TRANSPORT_REACH.local);
    expect(localPaths).toContain("Brain/notes/private-chandelier.md");

    const remotePaths = await poolPathsAt(TRANSPORT_REACH.remote);
    expect(remotePaths).not.toContain("Brain/notes/private-chandelier.md");
    // The filter removes exactly the withheld candidates; every path a
    // local pause may name is still eligible, and none appears twice.
    expect(new Set(remotePaths).size).toBe(remotePaths.length);
    expect(
      remotePaths.every((p) => localPaths.includes(p) || p === "Brain/notes/private-chandelier.md"),
    ).toBe(true);
  });

  test("a fully-formed commit with the knob off is refused by name", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const query = `warehouse rotation ${COMMON.join(" ")}`;
    const structured = structuredFor();
    let err: unknown = null;
    try {
      await search(config, {
        query,
        structuredQuery: structured,
        iterative: true,
        iterativeToken: KNOB_OFF_TOKEN,
        iterativePayload: { evidence: [1], subQueries: ["warehouse rotation"] },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).message).toContain("disabled by operator config");
  });

  test("round accounting counts only candidates the reach rule shows the caller", async () => {
    // The private twin matches the probed sub-query but is withheld at
    // remote reach: the decider round's `added` must count zero there,
    // so probing a withheld term returns no recovery signal - while the
    // same probe at local reach honestly reports the recovery.
    await seed();
    writeMd(
      vault,
      "Brain/notes/private-chandelier.md",
      "---\nvisibility: private\n---\n\n# Private chandelier\n\nSealed wing chandelier handoff notes.\n",
    );
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const query = `chandelier handoff wyrmshade velkriss`;
    const structured = structuredFor();
    // The token derives from query+round+pool, and both arms plan over
    // the same vault: a ghost term per arm keeps the two queries - and
    // so the two tokens - distinct.
    const run = async (
      transportReach: (typeof TRANSPORT_REACH)["remote" | "local"],
      ghost: string,
    ) => {
      const armQuery = `${query} ${ghost}`;
      const planBody = await search(withIterative(config), {
        query: armQuery,
        structuredQuery: structured,
        iterative: true,
        transportReach,
      });
      const plan = planBody.iterative;
      if (plan === undefined || plan.phase !== "needs-llm-step") {
        throw new Error(`expected a decider pause at reach ${transportReach}`);
      }
      return search(withIterative(config), {
        query: armQuery,
        structuredQuery: structured,
        iterative: true,
        transportReach,
        iterativeToken: plan.token,
        iterativePayload: { evidence: [plan.poolIds[0]!], subQueries: ["sealed wing"] },
      });
    };

    const remote = await run(TRANSPORT_REACH.remote, "wyrmshade");
    const remoteFinal = remote.iterative;
    if (remoteFinal === undefined || remoteFinal.phase !== "final") {
      throw new Error("expected a final marker at remote reach");
    }
    const deciderRoundRemote = remoteFinal.rounds.at(-1);
    expect(deciderRoundRemote?.author).toBe("decider");
    expect(deciderRoundRemote?.added).toBe(0);

    const local = await run(TRANSPORT_REACH.local, "velkriss");
    const localFinal = local.iterative;
    if (localFinal === undefined || localFinal.phase !== "final") {
      throw new Error("expected a final marker at local reach");
    }
    const deciderRoundLocal = localFinal.rounds.at(-1);
    expect(deciderRoundLocal?.author).toBe("decider");
    expect(deciderRoundLocal?.added).toBeGreaterThan(0);
  });

  test("a second plan call mints a fresh token after one commit spent the first", async () => {
    // The round token must name THIS plan call, not the query's pool: a
    // deterministic token hands every later plan for the same query the
    // already-spent marker, locking the caller (and any other agent asking
    // the same question) out of its decider round until the TTL expires.
    // With the cache on the stale plan row would keep serving the dead
    // token, so the second plan runs against a warm cache row on purpose.
    await seed();
    const config = makeConfig({
      vault,
      dbPath,
      maxHops: 0,
      mmrLambda: 1,
      twoPassEnabled: false,
      cacheEnabled: true,
    });
    const iterative = withIterative(config);
    const query = `warehouse rotation ${COMMON.join(" ")} wyrmshade velkriss`;
    const structured = structuredFor();
    const planArgs = { query, structuredQuery: structured, iterative: true, limit: 5 };
    const commitArgs = (token: string, evidence: number) => ({
      ...planArgs,
      iterativeToken: token,
      iterativePayload: { evidence: [evidence], subQueries: ["chandelier handoff"] },
    });
    const pauseOf = (outcome: Awaited<ReturnType<typeof search>>) => {
      const marker = outcome.iterative;
      if (marker === undefined || marker.phase !== "needs-llm-step") {
        throw new Error("expected a decider pause");
      }
      return marker;
    };

    const pause1 = pauseOf(await search(iterative, planArgs));
    const spent1 = await search(iterative, commitArgs(pause1.token, pause1.poolIds[0]!));
    expect(spent1.iterative?.phase).toBe("final");

    // The second plan for the SAME query over the SAME pool must carry a
    // token the first commit never touched.
    const pause2 = pauseOf(await search(iterative, planArgs));
    expect(pause2.token).not.toBe(pause1.token);
    expect(pause2.token).toMatch(/^drt-\d+-[0-9a-f]+$/);
    const spent2 = await search(iterative, commitArgs(pause2.token, pause2.poolIds[0]!));
    expect(spent2.iterative?.phase).toBe("final");
  });

  test("a commit replays the plan's recorded rounds even when its own clock runs slow", async () => {
    // The commit leg re-runs the deterministic rounds and expects to
    // arrive at the pause the plan recorded. The marginal-value stop is
    // fed elapsed time, so a replay on a loaded host retires a round the
    // plan itself ran and lands on a different state - the commit then
    // fails against a plan the caller answered honestly. With the plan's
    // recorded round count in the token's registry row, the replay runs
    // exactly that many rounds and skips its own clock's verdicts.
    for (let i = 1; i <= 6; i++) {
      writeMd(
        vault,
        `Brain/notes/wh${i}.md`,
        `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`,
      );
    }
    for (let i = 1; i <= 80; i++) {
      const term = `relic${String(i).padStart(2, "0")}`;
      writeMd(vault, `Brain/notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
    }
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const iterative = withIterative(config, 3);
    const ghosts = Array.from({ length: 30 }, (_, i) => `wyrm${String(i + 1).padStart(2, "0")}`);
    const query = `warehouse rotation ${Array.from({ length: 80 }, (_, i) => `relic${String(i + 1).padStart(2, "0")}`).join(" ")} ${ghosts.join(" ")}`;
    const structured = structuredFor();
    const plan = await search(iterative, { query, structuredQuery: structured, iterative: true });
    const pause = plan.iterative;
    if (pause === undefined || pause.phase !== "needs-llm-step") {
      throw new Error("expected a decider pause");
    }
    expect(pause.rounds.length).toBeGreaterThanOrEqual(2);

    // The replay's clock: every read a second and a half after the one
    // before, so the stop's elapsed term inflates until a slower replay
    // would retire the last partial round the plan ran.
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow.call(Date) + 1500 * ++ticks;
    let commit: Awaited<ReturnType<typeof search>>;
    try {
      commit = await search(iterative, {
        query,
        structuredQuery: structured,
        iterative: true,
        iterativeToken: pause.token,
        iterativePayload: { evidence: [pause.poolIds[0]], subQueries: ["relic01 relic02"] },
      });
    } finally {
      Date.now = realNow;
    }
    expect(Date.now).toBe(realNow);
    const final = commit.iterative;
    if (final === undefined || final.phase !== "final") {
      throw new Error(`expected a final marker, got ${pause.phase}`);
    }
    const deciderRound = final.rounds.at(-1);
    expect(deciderRound?.author).toBe("decider");
    expect(deciderRound?.round).toBe(pause.round);
  });

  test("a committed evidence id that would fall outside the limit reaches the results", async () => {
    // The decider's evidence selection was validated and then discarded:
    // the ranking never saw it, and a core-evidence chunk could fall out
    // of the top `limit`. The committed evidence ids must matter twice -
    // carried on the final marker, and given a deterministic preference
    // strong enough that one which would rank outside the limit window
    // still lands in the final results. The structured query excludes a
    // term (an ordinary caller shape), which widens the ranked pool past
    // the limit the way every filtered real call is - without it the
    // rank cap IS the limit and nothing outside the window ever reaches
    // the window cut to be pinned into it.
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const iterative = withIterative(config);
    const query = `warehouse rotation ${COMMON.join(" ")} wyrmshade velkriss`;
    const structured: StructuredRecallQueryDocument = Object.freeze({
      intent: null,
      lex: Object.freeze({
        include: Object.freeze(["warehouse", "rotation"]) as ReadonlyArray<string>,
        exclude: Object.freeze(["sealedwing"]) as ReadonlyArray<string>,
      }),
      vec: Object.freeze(["warehouse rotation"]) as ReadonlyArray<string>,
      hyde: Object.freeze([]) as ReadonlyArray<string>,
    });
    // limit 1: the plan's own window is the single top-ranked row, so
    // every OTHER pool id is evidence that would fall outside the limit.
    const plan = await search(iterative, {
      query,
      structuredQuery: structured,
      iterative: true,
      limit: 1,
    });
    const pause = plan.iterative;
    if (pause === undefined || pause.phase !== "needs-llm-step") {
      throw new Error("expected a decider pause");
    }
    const store = await Store.open(config, { mode: "read", loadVec: false });
    let evidenceId: number;
    let evidencePath: string;
    try {
      const hydrated = await store.hydrateChunks([...pause.poolIds]);
      const topPath = plan.results[0]?.path;
      const outside = [...hydrated.entries()].find(([, chunk]) => chunk.path !== topPath);
      if (outside === undefined) throw new Error("expected a pool id outside the plan window");
      evidenceId = outside[0];
      evidencePath = outside[1].path;
    } finally {
      await store.close();
    }
    const commit = await search(iterative, {
      query,
      structuredQuery: structured,
      iterative: true,
      limit: 1,
      iterativeToken: pause.token,
      iterativePayload: { evidence: [evidenceId], subQueries: ["chandelier handoff"] },
    });
    const final = commit.iterative;
    if (final === undefined || final.phase !== "final") {
      throw new Error("expected a final marker");
    }
    // The marker carries the pinned set ...
    expect(final.evidenceIds).toEqual([evidenceId]);
    // ... and the pinned id is IN the limit window, not ranked out of it.
    expect(commit.results.map((r) => r.path)).toEqual([evidencePath]);
  });

  test("an expired deadline degrades the looped search exactly like the plain one", async () => {
    await seed();
    const config = {
      ...makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false }),
      hybridDeadlineMs: 1,
    } as ResolvedSearchConfig;
    const query = `warehouse rotation ${COMMON.join(" ")}`;
    const structured = structuredFor();
    // Both runs see a clock 10 seconds past the 1 ms budget at every
    // deadline check, by construction: every Date.now read steps the
    // clock 10 s forward, and the stub is restored after. A constant
    // offset is not enough - the request resolves its start instant
    // through the same Date.now, so the offset cancels out and expiry
    // still raced real wall time; a run that reached the loop gate
    // within the same millisecond ran a loop round the plain run never
    // saw. Stepping on every read makes each check after the request's
    // own start read expired, independent of real time.
    const realNow = Date.now;
    const base = realNow.call(Date);
    let ticks = 0;
    Date.now = () => base + 10_000 * ++ticks;
    let off: Awaited<ReturnType<typeof search>>;
    let on: Awaited<ReturnType<typeof search>>;
    try {
      off = await search(config, { query, structuredQuery: structured });
      on = await search(withIterative(config), {
        query,
        structuredQuery: structured,
        iterative: true,
      });
    } finally {
      Date.now = realNow;
    }
    // Same keyword-only answer, same named degradation, and no loop round.
    expect(on.results.map((r) => r.path)).toEqual(off.results.map((r) => r.path));
    expect(on.warnings.some((w) => w.startsWith("hybrid deadline 1ms exceeded"))).toBe(true);
    // The trail is judged by its degradation vocabulary and the configured
    // budget, never by bytes: the hybrid-deadline degradation carries
    // `detail.elapsedMs`, measured wall time, so a byte-compare of two
    // trails pins scheduler jitter and flakes. Codes and budgetMs are the
    // deterministic content; `pool`/`retrieved` are pinned by the results
    // equality above.
    const degradedOf = (t: typeof on.retrievalTrail): Array<string> =>
      (t?.degraded ?? []).map((d) => {
        const budget = (d.detail as { budgetMs?: number } | undefined)?.budgetMs;
        return budget === undefined ? d.code : `${d.code}:${budget}`;
      });
    // Both runs name the expired budget. Which side also carries the
    // structural semantic-skip note depends on which deadline check
    // fires first inside the run - a diagnostics-order coin flip under
    // an always-expired clock - so the lists are compared as
    // vocabularies: the coin-flip note is dropped from both, the
    // deadline entry is required on both, and the remaining
    // vocabularies must agree as sets, never byte-for-byte nor in a
    // fixed subset direction.
    const STRUCTURED_SKIP_NOTE = "semantic-structured-lanes-skipped";
    const onDegraded = degradedOf(on.retrievalTrail).filter((d) => d !== STRUCTURED_SKIP_NOTE);
    const offDegraded = degradedOf(off.retrievalTrail).filter((d) => d !== STRUCTURED_SKIP_NOTE);
    expect(onDegraded).toContain("hybrid-deadline-exceeded:1");
    expect(offDegraded).toContain("hybrid-deadline-exceeded:1");
    expect(new Set(onDegraded)).toEqual(new Set(offDegraded));
    expect(onDegraded.length).toBeGreaterThan(0);
    // A deadline exit never mints a pause: the looped answer carries no
    // decider envelope, so the flag added nothing observable.
    expect(on.iterative).toBeUndefined();
    expect(pathsMissing(on, COMMON)).toBe(true);
  });

  test("a commit whose clock died before the loop block is refused by name", async () => {
    await seed();
    const config = {
      ...makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false }),
      hybridDeadlineMs: 5_000,
    } as ResolvedSearchConfig;
    const iterative = withIterative(config);
    // Ghost terms hold the coverage below the completeness threshold, so
    // the plan leg pauses with a token instead of finishing.
    const query = `chandelier handoff wyrmshade velkriss`;
    const structured: StructuredRecallQueryDocument = Object.freeze({
      intent: null,
      lex: Object.freeze({
        include: Object.freeze(["chandelier", "handoff"]) as ReadonlyArray<string>,
        exclude: Object.freeze([]) as ReadonlyArray<string>,
      }),
      vec: Object.freeze(["chandelier handoff"]) as ReadonlyArray<string>,
      hyde: Object.freeze([]) as ReadonlyArray<string>,
    });
    const plan = await search(iterative, { query, structuredQuery: structured, iterative: true });
    const pause = plan.iterative;
    if (pause === undefined || pause.phase !== "needs-llm-step") {
      throw new Error("expected a decider pause");
    }

    // The request clock cannot be pinned (a frozen Date.now() never
    // expires the deadline it just minted), so the clock is stepped
    // instead: the request-resolution read keeps the live instant - the
    // deadline is created with the full 5 s budget still ahead - and
    // every later read in the same call reports the budget long spent.
    // The commit then reaches the block with a dead clock, exactly the
    // state a slow caller's commit lands in.
    const realNow = Date.now;
    const base = realNow();
    let reads = 0;
    Date.now = () => (reads++ === 0 ? base : base + 60_000);
    let err: unknown = null;
    try {
      await search(iterative, {
        query,
        structuredQuery: structured,
        iterative: true,
        iterativeToken: pause.token,
        iterativePayload: { evidence: [0], subQueries: [query] },
      });
    } catch (e) {
      err = e;
    } finally {
      Date.now = realNow;
    }
    expect(Date.now).toBe(realNow);
    // Silence here would return a plain answer the caller would read as
    // its commit's outcome; the refusal is the named one.
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).message).toContain("no decider round is pending");
  });
});

function pathsMissing(
  outcome: { results: ReadonlyArray<{ path: string }> },
  rare: ReadonlyArray<string>,
): boolean {
  return rare.every((term) => !outcome.results.some((r) => r.path.includes(term)));
}

describe("runIterativeRecall (driver, over an open store)", () => {
  /**
   * 60 seeded relic docs plus 20 query-only ghost terms (in the query,
   * nowhere in the corpus): the relics are recoverable, the ghosts are
   * not, and their IDF mass holds the weighted coverage below the
   * completeness threshold no matter how many relics the loop recovers -
   * which is what lets these tests observe the cap and the marginal stop
   * rather than an early coverage-complete exit.
   */
  const GHOSTS = Array.from({ length: 20 }, (_, i) => `wyrm${String(i + 1).padStart(2, "0")}`);
  const wideQuery = () =>
    `warehouse rotation ${Array.from({ length: 60 }, (_, i) => `relic${String(i + 1).padStart(2, "0")}`).join(" ")} ${GHOSTS.join(" ")}`;

  /**
   * 80 recoverable relic docs plus 30 query-only ghost terms: round 2
   * saturates the pull width (50), round 3 recovers a partial yield (30)
   * that sits between the fast floor (0.25 of the top yield) and the
   * slow floor (up to 0.75), and round 4 recovers nothing - the exact
   * yield curve a slower replay's marginal-value stop retires early.
   */
  async function seedDivergence(): Promise<void> {
    for (let i = 1; i <= 6; i++) {
      writeMd(
        vault,
        `Brain/notes/wh${i}.md`,
        `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`,
      );
    }
    for (let i = 1; i <= 80; i++) {
      const term = `relic${String(i).padStart(2, "0")}`;
      writeMd(vault, `Brain/notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
    }
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
  }

  const divergenceQuery = () =>
    `warehouse rotation ${Array.from({ length: 80 }, (_, i) => `relic${String(i + 1).padStart(2, "0")}`).join(" ")} ${Array.from({ length: 30 }, (_, i) => `wyrm${String(i + 1).padStart(2, "0")}`).join(" ")}`;

  test("respects the round cap and merges each round's pulls into one pool", async () => {
    await seedWide();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const query = wideQuery();
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const chunkIds = new Set(base.hits.map((h) => h.chunkId));
      const loop = (maxRounds: number) =>
        runIterativeRecall({
          store,
          query,
          limit: 10,
          pathPrefix: undefined,
          timeRange: null,
          validityWindowFor: () => null,
          keywordHits: base.hits,
          chunkIds: new Set(chunkIds),
          ids: [...chunkIds],
          maxRounds,
          firstRoundNumber: 2,
          isExpired: () => false,
          nowMs: () => 0,
        });
      const one = loop(1);
      expect(one.rounds).toHaveLength(1);
      expect(one.stopReason).toBe("round_cap");
      const two = loop(2);
      expect(two.rounds).toHaveLength(2);
      // The ghosts keep the coverage below the completeness threshold, so
      // the second run stops because the cap said so, not because the
      // gaps closed.
      expect(two.stopReason).toBe("round_cap");
      // Each round only ever ADDS candidates.
      expect(two.ids.length).toBeGreaterThan(one.ids.length);
      expect(two.keywordHits.length).toBeGreaterThanOrEqual(one.keywordHits.length);
      for (const round of two.rounds) {
        expect(round.round).toBe(2 + two.rounds.indexOf(round));
        expect(round.author).toBe("deterministic");
        expect(round.added).toBeGreaterThan(0);
      }
    } finally {
      await store.close();
    }
  });

  test("the marginal-value stop retires rounds that stop paying", async () => {
    await seedWide();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const query = wideQuery();
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      // Round 2 saturates the pull width; round 3 recovers the relic tail,
      // a yield far below the 0.25 floor fraction of round 2's, so the
      // extracted stop retires round 4 even though ghosts keep the
      // coverage incomplete and the cap allows more rounds.
      const loop = runIterativeRecall({
        store,
        query,
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 4,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
      });
      expect(loop.stopReason).toBe("marginal_value");
      expect(loop.rounds).toHaveLength(2);
      expect(loop.lastCoverage).not.toBeNull();
      expect(loop.lastCoverage!.uncoveredRareTerms.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  test("a recorded replay runs the plan's rounds regardless of its own clock", async () => {
    await seedDivergence();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const query = divergenceQuery();
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const input = () => ({
        store,
        query,
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 3,
        firstRoundNumber: 2,
        isExpired: () => false,
      });
      // The plan leg on a fast host: saturate, partial, zero-yield - the
      // third round ran even though its yield was zero, and the pause
      // was minted over THAT state.
      const plan = runIterativeRecall({ ...input(), nowMs: () => 0 });
      expect(plan.rounds.map((r) => r.added)).toEqual([50, 30, 0]);
      expect(plan.stopReason).toBe("no_progress");
      expect(plan.pause).not.toBeNull();
      // The commit leg's replay on a slow host: its own marginal-value
      // verdict, fed the inflated elapsed term, would retire the third
      // round and arrive a round early. With the plan's recorded count
      // in the replay brief, it runs exactly that many rounds, skips its
      // own stop predicates, and lands on the pause state the registry
      // row digests.
      let ticks = 0;
      const replay = runIterativeRecall({
        ...input(),
        replayRounds: plan.rounds.length,
        nowMs: () => 1500 * ++ticks,
      });
      expect(replay.rounds.map((r) => r.added)).toEqual([50, 30, 0]);
      expect(replay.stopReason).toBe(plan.stopReason);
      expect(replay.pause?.round).toBe(plan.pause?.round);
      expect(pauseStateDigest(query, replay.pause!.round, replay.pause!.poolIds)).toBe(
        pauseStateDigest(query, plan.pause!.round, plan.pause!.poolIds),
      );
      // And the pool itself is the plan's, byte for byte.
      expect(replay.ids).toEqual(plan.ids);
    } finally {
      await store.close();
    }
  });

  test("a zero-yield round stops the loop as no progress", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const loop = runIterativeRecall({
        store,
        query: "warehouse rotation ghostterm",
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 3,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
      });
      expect(loop.rounds).toHaveLength(1);
      expect(loop.stopReason).toBe("no_progress");
    } finally {
      await store.close();
    }
  });

  test("a withheld first-pass candidate cannot close a rare term's gap at remote reach", async () => {
    // The private twin is the corpus's ONLY match for the rare term, and
    // the first pass ranked it in: the raw pool the loop receives carries
    // a withheld candidate, so coverage measured over the raw set would
    // close the term's gap the visible pool never closes - the loop could
    // end coverage-complete over a term the caller cannot see a single
    // candidate for. With a reach rule present, the pool is post-reach
    // from the first measurement on.
    await seed();
    writeMd(
      vault,
      "Brain/notes/private-wyrmshade.md",
      "---\nvisibility: private\n---\n\n# Wyrmshade\n\nWyrmshade inventory tag, sealed wing.\n",
    );
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const withheldIds = runFtsQueryDetailed(store, "wyrmshade", { limit: 10 })
        .hits.map((hit) => hit.chunkId)
        .filter(
          (id) => store.hydrateChunks([id]).get(id)?.path === "Brain/notes/private-wyrmshade.md",
        );
      expect(withheldIds.length).toBeGreaterThan(0);
      const pool = new Set([...base.hits.map((hit) => hit.chunkId), ...withheldIds]);
      const filterReachableIds = (ids: ReadonlyArray<number>): ReadonlyArray<number> =>
        ids.filter((id) => !withheldIds.includes(id));
      const loop = runIterativeRecall({
        store,
        query: "warehouse rotation wyrmshade",
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: pool,
        ids: [...pool],
        maxRounds: 3,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
        filterReachableIds,
      });
      // The rare term has no visible candidate anywhere in the corpus, so
      // the loop must not claim coverage over it: the stop is honest about
      // the pool's incompleteness and the term stays a reported gap.
      expect(loop.stopReason).not.toBe("coverage_complete");
      expect(loop.lastCoverage?.uncoveredRareTerms).toContain("wyrmshade");
      // No withheld candidate survives in the pool the loop reports.
      const poolPaths = [...store.hydrateChunks(loop.ids).values()].map((chunk) => chunk.path);
      expect(poolPaths).not.toContain("Brain/notes/private-wyrmshade.md");
    } finally {
      await store.close();
    }
  });

  test("a complete pool needs no round and an expired clock never starts one", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const base = runFtsQueryDetailed(store, "warehouse rotation", { limit: 10 });
      const complete = runIterativeRecall({
        store,
        query: "warehouse rotation",
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 3,
        firstRoundNumber: 2,
        isExpired: () => false,
        nowMs: () => 0,
      });
      expect(complete.rounds).toHaveLength(0);
      expect(complete.stopReason).toBe("coverage_complete");
      const expired = runIterativeRecall({
        store,
        query: "warehouse rotation chandelier",
        limit: 10,
        pathPrefix: undefined,
        timeRange: null,
        validityWindowFor: () => null,
        keywordHits: base.hits,
        chunkIds: new Set(base.hits.map((h) => h.chunkId)),
        ids: base.hits.map((h) => h.chunkId),
        maxRounds: 3,
        firstRoundNumber: 2,
        isExpired: () => true,
        nowMs: () => 0,
      });
      expect(expired.rounds).toHaveLength(0);
      expect(expired.stopReason).toBe("deadline");
    } finally {
      await store.close();
    }
  });
});

describe("iterative knob resolution", () => {
  test("defaults off and resolves the env pair, refusing an out-of-range cap by name", () => {
    const config = resolveSearchConfig({ vault });
    expect(config.recall.iterativeRecallEnabled ?? false).toBe(false);
    // Snapshot the twins themselves, not the whole env: keys this test
    // ADDS are absent from a whole-env snapshot, so a keys-of-saved
    // restore loop can never delete them and they leak into every later
    // file of a same-process directory run.
    const savedIterative = process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    const savedMaxRounds = process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"];
    try {
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = "true";
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"] = "4";
      const on = resolveSearchConfig({ vault });
      expect(on.recall.iterativeRecallEnabled).toBe(true);
      expect(on.recall.iterativeRecallMaxRounds).toBe(4);
      expect(ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT).toBe(2);
      expect(ITERATIVE_RECALL_MAX_ROUNDS_CAP).toBe(8);
      // The resolver refuses rather than clamps, like every knob bound.
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"] = "99";
      expect(() => resolveSearchConfig({ vault })).toThrow(/search_iterative_recall_max_rounds/);
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"] = "0";
      expect(() => resolveSearchConfig({ vault })).toThrow(/search_iterative_recall_max_rounds/);
    } finally {
      if (savedIterative === undefined) {
        delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
      } else {
        process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = savedIterative;
      }
      if (savedMaxRounds === undefined) {
        delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"];
      } else {
        process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE_MAX_ROUNDS"] = savedMaxRounds;
      }
    }
  });

  test("the plan-leg cache key names the round cap, so a raised cap re-keys plans", async () => {
    // A cached plan row records the round count it ran under: with the
    // cap absent from the key, raising `iterativeRecallMaxRounds` served
    // the cached plan - and its token - under the OLD budget until the
    // TTL expired. The suffix is `itv:plan:r<cap>`, so the keys must
    // partition by cap while commit keys stay token-partitioned (the cap
    // never changes what a committed payload means).
    await seed();
    const base = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const keyFor = async (maxRounds?: number, commitToken?: string): Promise<string> => {
      const config = withIterative(base, maxRounds);
      const store = await Store.open(config, { mode: "read", loadVec: false });
      try {
        const probe = probeQueryCache({
          store,
          config,
          opts: {
            query: "warehouse rotation",
            iterative: true,
            ...(commitToken !== undefined ? { iterativeToken: commitToken } : {}),
          } as Parameters<typeof probeQueryCache>[0]["opts"],
          limit: 10,
          policy: { explicit: false, wantSemantic: false },
          sessionFocus: null,
          tuned: null,
          planHash: "plan-hash-stable",
        });
        if (probe.slot === null) throw new Error("cache probe returned no slot");
        return probe.slot.key;
      } finally {
        await store.close();
      }
    };
    const planDefault = await keyFor();
    const planRaised = await keyFor(4);
    expect(planRaised).not.toBe(planDefault);
    // The cap-lowered key is distinct too, and the commit partition is
    // indifferent to the cap: one token, one commit key at every cap.
    const planLowered = await keyFor(1);
    expect(planLowered).not.toBe(planDefault);
    expect(planLowered).not.toBe(planRaised);
    const commitAtDefault = await keyFor(undefined, KNOB_OFF_TOKEN);
    const commitAtRaised = await keyFor(4, KNOB_OFF_TOKEN);
    expect(commitAtRaised).toBe(commitAtDefault);
    expect(commitAtDefault).not.toBe(planDefault);
  });
});
