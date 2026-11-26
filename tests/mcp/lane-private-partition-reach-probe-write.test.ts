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
 *     refusal; no call answers an internal error.
 */

import { describe, expect, test } from "bun:test";

import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { makeLaneEnv } from "../core/lanes/fixtures/lane-env.ts";
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
  IDENTITY_TOOLS,
  PROBE_ENTITY,
  identityProblems,
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
}

const labelOf = (c: ProbeCall): string => `${c.tool} ${c.verb} ${c.names}`;

async function answer(
  s: ReturnType<typeof server>,
  tool: string,
  args: Record<string, unknown>,
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
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seed one store, call every planned call below local reach, snapshot around it. */
async function runStore(withPrivate: boolean): Promise<Run> {
  const e = makeLaneEnv("store", withPrivate ? "osb-lane-pw-priv-" : "osb-lane-pw-twin-");
  try {
    const lanes = await seedProbeStore(e, localServer(e), withPrivate);
    seedIdentityTwins(e, withPrivate);
    const before = snapshot(e);
    const remote = server(e);
    const answers = new Map<string, Answer>();
    const skipped: string[] = [];
    let calls = 0;
    for (const tool of buildToolTable()) {
      const plan = planTool(tool, lanes);
      skipped.push(...plan.skipped);
      for (const c of plan.calls) {
        const label = labelOf(c);
        if (answers.has(label)) continue;
        // oxlint-disable-next-line no-await-in-loop -- one store, its calls in order
        const a = await answer(remote, c.tool, c.args);
        answers.set(label, { ...a, passed: JSON.stringify(c.args) });
        calls++;
      }
    }
    return { lanes, before, after: snapshot(e), answers, skipped, calls };
  } finally {
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
  test("no call below local reach discloses, drops or fails on a private entry", async () => {
    const started = Date.now();
    const twin = await runStore(false);
    const seeded = await runStore(true);
    const canaries = seeded.lanes.flatMap((l) => (l.hidden?.marks ?? []).map((t) => t.mark));
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
      if (a.text.includes(LANE_ENTRY_WITHHELD_MESSAGE) && label.endsWith(":hidden")) continue;
      // A base call that meets an identity twin (it passes the twin's
      // name) gets the fixed refusal.
      if (
        a.text.includes(LANE_ENTRY_WITHHELD_MESSAGE) &&
        IDENTITY_TOOLS.has(label.split(" ")[0]!) &&
        a.passed?.includes(PROBE_ENTITY) === true
      )
        continue;
      // A verb under the coarse rule (bulk form) gets the fixed refusal.
      if (
        a.text.includes(LANE_ENTRY_WITHHELD_MESSAGE) &&
        COARSE_VERBS.has(label.split(" ").slice(0, 2).join(" "))
      )
        continue;
      // A bridge dismissal beside a dismissal list held in `private` gets
      // the fixed refusal (same answer for a dismissed and an absent pair).
      if (
        a.text.includes(LANE_ENTRY_WITHHELD_MESSAGE) &&
        label.split(" ").slice(0, 2).join(" ") === "brain_bridges dismiss"
      )
        continue;
      problems.push(`${label}: twin succeeds, here ${a.text.slice(0, 200)}`);
    }

    // 5. No lane gains a shared entry with the identity of a private one.
    const added = new Map(
      [...seeded.after.sharedFields].filter(([key]) => !seeded.before.sharedKeys.has(key)),
    );
    problems.push(...identityProblems(seeded.before.privateEntries, added));

    console.log(
      [
        `calls below local reach: twin ${twin.calls}, with private entries ${seeded.calls}; compared ${compared}`,
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
