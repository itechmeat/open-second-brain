/**
 * Registry-wide differential probe of the write rule
 * (`lane-private-partition-reach`): every tool and every verb, write verbs
 * included, called below local reach on a store WITH `private` entries
 * and on a twin built by the same seeding code WITHOUT any
 * (`lane-private-partition-reach-probe-write-plan.ts`). On the store with
 * private entries:
 *
 *  1. no canary of a private entry is in any answer or error;
 *  2. every private lane entry reads the same at local reach afterwards
 *     (an artifact the machine regenerates for itself stays live and
 *     private), and no lane loses or gains more shared entries than the
 *     twin's lane does with the same calls;
 *  3. every machine-state and device-state file that existed before still
 *     exists unless the twin dropped it too, and keeps every private
 *     canary it held;
 *  4. a call that succeeds on the twin succeeds too, or answers the fixed
 *     refusal; no call answers an internal error;
 *  5. no lane gains a shared entry with the identity of a private one, and
 *     every creating verb of the plan has an identity twin or the reason
 *     it has none (`lane-private-partition-reach-probe-identity.ts`);
 *  6. a call naming a private entry (`:hidden`) answers the fixed refusal
 *     or as the call naming an absent entry does;
 *  7. every call refused with the fixed answer has a successful control:
 *     the same call on the twin (for a `:hidden` call, the call naming the
 *     shared entry), so a refusal is never of a call that fails anyway;
 *  8. a refused call leaves the raw records of both partitions as they
 *     were before it;
 *  9. every list or count call answers the counts a store holding only the
 *     fixture's `shared` records answers at local reach
 *     (`lane-private-partition-reach-probe-counts.ts`).
 */

import { describe, expect, test } from "bun:test";

import { join } from "node:path";

import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { countMismatches, isListOrCountCall } from "./lane-private-partition-reach-probe-counts.ts";
import {
  planTool,
  seedProbeStore,
  snapshot,
  type ProbeCall,
  type ProbeLane,
  type StoreSnapshot,
} from "./lane-private-partition-reach-probe-write-plan.ts";
import {
  COARSE_VERBS,
  IDENTITY_TWINS,
  NO_IDENTITY_TWIN,
  identityProblems,
  meetsIdentityTwin,
  seedIdentityTwins,
} from "./lane-private-partition-reach-probe-identity.ts";
import { localServer, server } from "./lane-private-partition-reach-writes-fixture.ts";

/** One call may not hold the probe longer than this. */
const CALL_TIMEOUT_MS = 10_000;

interface Answer {
  readonly ok: boolean;
  readonly text: string;
  /** The arguments passed, serialized: a mark passed in is not disclosed by an echo. */
  readonly passed?: string;
}

interface Run {
  readonly lanes: ProbeLane[];
  readonly before: StoreSnapshot;
  readonly after: StoreSnapshot;
  readonly answers: Map<string, Answer>;
  readonly skipped: string[];
  readonly calls: number;
  /** The canary marks of the identity twins seeded. */
  readonly twinMarks: string[];
  /** Per call, the shared keys it added. */
  readonly creates: Map<string, string[]>;
  /** Refused calls after which the raw records of a partition differ. */
  readonly traces: string[];
  /** The list or count calls, by label. */
  readonly listCalls: Set<string>;
  /** Every call made, by label. */
  readonly made: Map<string, ProbeCall>;
}

/**
 * The store a run seeds and how it calls: the twin and the store with
 * private entries call everything below local reach; the shared-only twin
 * of the count comparison is the twin's store answering every list or
 * count call at local reach.
 */
type RunMode = "twin" | "private" | "shared-local";

const labelOf = (c: ProbeCall): string => `${c.tool} ${c.verb} ${c.names}`;

/** The plan's `<tool> <verb>` of a call. */
const verbOf = (c: ProbeCall): string => `${c.tool} ${c.verb}`;

/**
 * Whether an answer of `tool` is the fixed refusal: its whole message,
 * bare or after the tool's name, as the error or the error result's text.
 */
function isWithheld(tool: string, a: Answer): boolean {
  const whole = new Set([LANE_ENTRY_WITHHELD_MESSAGE, `${tool}: ${LANE_ENTRY_WITHHELD_MESSAGE}`]);
  try {
    const parsed = JSON.parse(a.text) as Record<string, unknown>;
    if (whole.has(String(parsed["error"]))) return true;
    const content = parsed["content"] as Array<{ text?: unknown }> | undefined;
    return parsed["isError"] === true && whole.has(String(content?.[0]?.text));
  } catch {
    return false;
  }
}

/** Every record id of both partitions of the store, as it holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** The live shared keys of the store. */
function sharedKeys(): Set<string> {
  const fold = wholeLaneStoreFold();
  return new Set([...fold.entries.keys()].filter((key) => !fold.privateKeys.has(key)));
}

/**
 * The answer of one call, or `probe_timeout` past {@link CALL_TIMEOUT_MS}.
 * The call itself is added to `pending`, so a call that timed out is
 * waited for before its store is cleaned up.
 */
async function answer(
  s: ReturnType<typeof server>,
  tool: string,
  args: Record<string, unknown>,
  pending: Array<Promise<unknown>>,
): Promise<Answer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Answer>((done) => {
    timer = setTimeout(() => done({ ok: false, text: "probe_timeout" }), CALL_TIMEOUT_MS);
  });
  try {
    const run = s
      .callTool(tool, args)
      .then((r) => {
        const text = JSON.stringify(r);
        return { ok: (r as { isError?: boolean })?.isError !== true, text };
      })
      .catch((err: unknown) => ({
        ok: false,
        text: JSON.stringify({ error: (err as Error)?.message ?? String(err) }),
      }));
    pending.push(run);
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seed one store, call every planned call, snapshot around it. */
async function runStore(mode: RunMode): Promise<Run> {
  const withPrivate = mode === "private";
  const e = makeLaneEnv("store", `osb-lane-pw-${mode}-`);
  const pending: Array<Promise<unknown>> = [];
  try {
    const local = localServer(e);
    const lanes = await seedProbeStore(e, local, withPrivate, mode === "shared-local");
    const twinMarks = await seedIdentityTwins(e, local, withPrivate);
    const before = snapshot(e);
    const remote = server(e);
    const answers = new Map<string, Answer>();
    const creates = new Map<string, string[]>();
    const traces: string[] = [];
    const listCalls = new Set<string>();
    const made = new Map<string, ProbeCall>();
    const skipped: string[] = [];
    let calls = 0;
    for (const tool of buildToolTable()) {
      const plan = planTool(tool, lanes);
      skipped.push(...plan.skipped);
      for (const c of plan.calls) {
        const label = labelOf(c);
        if (answers.has(label)) continue;
        const listing = c.names === "base" && isListOrCountCall(tool.kind, c.verb);
        if (listing) listCalls.add(label);
        const records = rawRecords(e);
        const keys = mode === "twin" ? sharedKeys() : null;
        const s = mode === "shared-local" && listing ? local : remote;
        // oxlint-disable-next-line no-await-in-loop -- one store, its calls in order
        const a = await answer(s, c.tool, c.args, pending);
        answers.set(label, { ...a, passed: JSON.stringify(c.args) });
        made.set(label, c);
        if (isWithheld(c.tool, a) && rawRecords(e) !== records) {
          traces.push(`${label}: refused, and the raw records changed`);
        }
        if (keys !== null) {
          const added = [...sharedKeys()].filter((key) => !keys.has(key));
          if (added.length > 0) creates.set(label, added);
        }
        calls++;
      }
    }
    // A call that timed out still runs: wait for it before the snapshot
    // and the cleanup.
    await Promise.allSettled(pending);
    return {
      lanes,
      before,
      after: snapshot(e),
      answers,
      skipped,
      calls,
      twinMarks,
      creates,
      traces,
      listCalls,
      made,
    };
  } finally {
    // Nothing of the store's calls may still run when it is removed.
    await Promise.allSettled(pending);
    e.cleanup();
  }
}

const laneOf = (key: string): string => key.split("/")[0]!;

/** Per lane, the shared keys a run removed (`from` before, not `to` after) or added. */
function changedPerLane(from: ReadonlySet<string>, to: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of from) {
    if (!to.has(key)) out.set(laneOf(key), (out.get(laneOf(key)) ?? 0) + 1);
  }
  return out;
}

/**
 * Private artifacts the machine regenerates for itself (rule (a)): the
 * procedural index, the bridge artifact and its dismissal list stay live
 * and private, their content may move.
 */
const REGENERATED = ["procedural-memory/", "proposals/bridges"];

describe("differential write probe of private-partition lane entries", () => {
  // The calls are what the probe proves: every verb of every tool, write
  // verbs included, is called in order on this store and on its twin, so
  // the run takes seconds to tens of seconds and the test passes its own
  // limit as the last argument instead of the default 5 s.
  test("no call below local reach discloses, drops or fails on a private entry", async () => {
    const started = Date.now();
    const twin = await runStore("twin");
    const seeded = await runStore("private");
    const sharedOnly = await runStore("shared-local");
    const canaries = [
      ...seeded.lanes.flatMap((l) => (l.hidden?.marks ?? []).map((t) => t.mark)),
      ...seeded.lanes.flatMap((l) =>
        (l.extraHidden ?? []).flatMap((x) => x.entry.marks.map((t) => t.mark)),
      ),
      ...seeded.twinMarks,
    ];
    const problems: string[] = [];

    // 1. No canary in any answer or error.
    for (const [label, a] of seeded.answers) {
      for (const mark of canaries) {
        if (a.passed?.includes(mark) === true) continue;
        if (a.text.includes(mark)) problems.push(`canary ${mark} in ${label}`);
      }
    }
    // 2. Every private entry reads the same; no lane loses more than the twin's.
    for (const [key, value] of seeded.before.privateEntries) {
      const after = seeded.after.privateEntries.get(key);
      const regenerated = REGENERATED.some((prefix) => key.startsWith(prefix));
      if (after === undefined) problems.push(`private entry ${key} no longer live in private`);
      else if (after !== value && !regenerated) problems.push(`private entry ${key} changed`);
    }
    // Shared entries removed or added beyond what the twin's same calls did
    // (a removal or a recreation decided from a narrowed read).
    for (const [what, pick] of [
      ["lost", (r: Run) => changedPerLane(r.before.sharedKeys, r.after.sharedKeys)],
      ["gained", (r: Run) => changedPerLane(r.after.sharedKeys, r.before.sharedKeys)],
    ] as const) {
      const twinChanged = pick(twin);
      for (const [lane, n] of pick(seeded)) {
        const t = twinChanged.get(lane) ?? 0;
        if (n > t) problems.push(`lane ${lane} ${what} ${n} shared entries (twin ${t})`);
      }
    }
    // 3. State files kept, with their private canaries.
    for (const [path, text] of seeded.before.stateFiles) {
      const after = seeded.after.stateFiles.get(path);
      if (after === undefined) {
        const twinKept = twin.after.stateFiles.has(path) || !twin.before.stateFiles.has(path);
        if (twinKept) problems.push(`state file dropped: ${path}`);
        continue;
      }
      for (const mark of canaries) {
        if (text.includes(mark) && !after.includes(mark)) {
          problems.push(`state file ${path} lost canary ${mark}`);
        }
      }
    }
    // 4. Each call: as the twin, or the fixed refusal; never an internal error.
    let compared = 0;
    for (const [label, a] of seeded.answers) {
      if (/internal[ _]error|probe_timeout/.test(a.text))
        problems.push(`${label}: ${a.text.slice(0, 160)}`);
      const t = twin.answers.get(label);
      if (t === undefined) continue;
      compared++;
      if (!t.ok || a.ok) continue;
      const withheld = isWithheld(seeded.made.get(label)!.tool, a);
      if (withheld && seeded.made.get(label)!.hidden === true) continue;
      // A base call that meets an identity twin (it passes the twin's
      // name) gets the fixed refusal.
      if (withheld && meetsIdentityTwin(label, a.passed)) continue;
      // A verb under the coarse rule (bulk form) gets the fixed refusal.
      if (withheld && COARSE_VERBS.has(label.split(" ").slice(0, 2).join(" "))) continue;
      // A bridge dismissal beside a dismissal list held in `private` gets
      // the fixed refusal (same answer for a dismissed and an absent pair).
      if (withheld && label.split(" ").slice(0, 2).join(" ") === "brain_bridges dismiss") continue;
      problems.push(`${label}: twin succeeds, here ${a.text.slice(0, 200)}`);
    }

    // 5. No lane gains a shared entry with the identity of a private one.
    const added = new Map(
      [...seeded.after.sharedFields].filter(([key]) => !seeded.before.sharedKeys.has(key)),
    );
    problems.push(...identityProblems(seeded.before.privateEntries, added));
    // Every creating verb of the plan (a call that adds a shared entry on
    // the twin) has an identity twin or the reason it has none.
    const twinned = new Set(IDENTITY_TWINS.map((twinRow) => twinRow.verb));
    for (const label of twin.creates.keys()) {
      const verb = verbOf(twin.made.get(label)!);
      if (!twinned.has(verb) && !(verb in NO_IDENTITY_TWIN)) {
        problems.push(`${label}: a creating verb with no identity twin and no reason`);
      }
    }

    // 6. A call naming a private entry answers as for an absent entry.
    let hiddenCalls = 0;
    for (const [label, a] of seeded.answers) {
      const c = seeded.made.get(label)!;
      if (c.hidden !== true) continue;
      hiddenCalls++;
      const base = seeded.answers.get(labelOf({ ...c, names: "base" }));
      if (isWithheld(c.tool, a) || (base !== undefined && base.ok === a.ok)) continue;
      problems.push(
        `${label}: answers unlike an absent entry (absent ok ${base?.ok ?? "unknown"}, here ok ${a.ok}): ${a.text.slice(0, 160)}`,
      );
    }

    // 7. Every refused call has a successful control on the twin.
    const refusedLabels: string[] = [];
    let bothFail = 0;
    for (const [label, a] of seeded.answers) {
      const c = seeded.made.get(label)!;
      const control = twin.answers.get(
        c.hidden === true ? labelOf({ ...c, names: `${c.lane}:shared` }) : label,
      );
      const withheld = isWithheld(c.tool, a);
      if (!a.ok && control !== undefined && !control.ok && !withheld) bothFail++;
      if (!withheld) continue;
      refusedLabels.push(label);
      if (control?.ok !== true) {
        problems.push(
          `${label}: refused without a successful control (${control === undefined ? "no control call" : control.text.slice(0, 120)})`,
        );
      }
    }

    // 8. A refused call leaves the raw records as they were.
    problems.push(...seeded.traces);

    // 9. List and count calls answer the shared-only twin's counts.
    let counted = 0;
    for (const label of seeded.listCalls) {
      const a = seeded.answers.get(label);
      const t = sharedOnly.answers.get(label);
      if (a === undefined || t === undefined) continue;
      counted++;
      const call = verbOf(seeded.made.get(label)!);
      problems.push(...countMismatches(call, a.text, t.text, twin.answers.get(label)?.text));
    }

    console.log(
      [
        `calls below local reach: twin ${twin.calls}, with private entries ${seeded.calls}; compared ${compared}`,
        `calls naming a private entry: ${hiddenCalls}; refused with the fixed answer: ${refusedLabels.length}; failing on both stores (not exercised): ${bothFail}`,
        `creating calls on the twin: ${[...twin.creates.keys()].join(" | ") || "none"}`,
        `list or count calls compared with the shared-only twin: ${counted}`,
        `refused with the fixed answer: ${refusedLabels.join(" | ") || "none"}`,
        `skipped (${seeded.skipped.length}):`,
        ...seeded.skipped.map((s) => `  ${s}`),
        `problems (${problems.length}):`,
        ...problems.map((p) => `  ${p}`),
        `probe time: ${Date.now() - started} ms`,
      ].join("\n"),
    );
    expect(problems).toEqual([]);
  }, 1_800_000);
});
