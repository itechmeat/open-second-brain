/**
 * The whole state space of what a start, the worker, `o2b update` and the
 * manual verb decide when they meet the migration gate (change
 * auto-store-migration), against one oracle stated as invariants.
 * `decideGate` is pure: each row hands it the state as the asker's own
 * judgement sees it, and the oracle judges by the truth.
 *
 * State:
 *  - the gate: absent; unreadable; torn; this vault's migration run; this
 *    vault's rollback (a removal takes the same path); another vault's
 *    migration;
 *  - its holder (a held gate): provably dead; alive with the recorded
 *    identity, young or past the ceiling; alive with another identity (a
 *    reused pid), young or past the ceiling; alive and unknown, young or
 *    past the ceiling;
 *  - this vault's run state: none; unreadable; in progress with the gate's
 *    run id; in progress with another id; failed; done; rolled back;
 *  - the machine: legacy with something to migrate, legacy with nothing
 *    left, switched;
 *  - the attempt record: none; an attempt; an attempt with the gate
 *    cleanup owed; a failure in its cooldown; a failure past it; a
 *    remembered wait;
 *  - this machine's rollback record (`rollback.json`, read once with the
 *    run state): none; there (a rollback began and did not finish, unless
 *    the run state reads rolled back, which settles it); unreadable;
 *  - the setting: on, off;
 *  - who asks: a start (the pid alone); the worker a start spawned (exact);
 *    `o2b update` (exact, an explicit run); `o2b update
 *    --skip-store-migration`; the manual verb.
 *
 * Impossible combinations, left out: a run in progress with the gate's
 * run id when the gate is not this vault's migration run (no such id); a
 * legacy machine whose run is done with no rollback record (a run is done
 * only after its switch, and a finished rollback records rolled-back; a
 * rollback that cleared the switch and then failed leaves exactly a done
 * run on the legacy layout, with its record); a switched machine whose
 * run is rolled back (the rollback returns it to the legacy layout).
 *
 * The holder as seen: a start sees only the pid, so every live pid is
 * `unknown` to it; the exact judgement sees a reused pid as `dead`. A gate
 * past the ceiling is `aged`.
 *
 * Invariants (the oracle):
 *  1. A holder that may still run keeps its gate: nobody opens it, takes
 *     it over or works around it (a start may only spawn the worker, and
 *     only for a gate past the ceiling).
 *  2. A gate that is not this vault's migration run is never opened or
 *     taken over by the automatic path.
 *  3. A dead holder's gate of this vault's migration run is recovered
 *     (resumed or opened; finished or opened on a switched machine) by the
 *     worker, `o2b update` and the manual verb, whatever the setting, the
 *     cooldown and the payload; a start spawns the worker for it, except
 *     for a reused pid younger than the ceiling, which only an identity
 *     query tells (the documented limit of a start).
 *  4. With the setting off no new migration starts: the automatic path
 *     resumes only the run its own unfinished attempt started, under that
 *     run's gate.
 *  5. A start never needs the exact identity: its state carries the pid
 *     alone. A holder that cannot be told, past the ceiling, on this
 *     vault's migration run, always reaches the worker; a worker that
 *     cannot tell a holder never acts on it.
 *  6. A switched and finished machine decides "nothing" from its cheap
 *     reads alone (no tree walk).
 *  7. The same state gives the same decision for a start and the worker it
 *     spawns: the start spawns exactly when the worker acts and otherwise
 *     answers the worker's own "nothing", except for a holder the start
 *     cannot tell past the ceiling, which only the worker's exact check
 *     decides.
 *  8. A start's cheap reads decide either nothing yet ("gather") or the
 *     same as all its reads.
 *  9. `--skip-store-migration` decides nothing.
 * 10. A run state that cannot be read is never migrated over by the
 *     automatic path: it could be a run the operator rolled back (its
 *     stopped gate is still opened, which leaves the run as it is).
 * 11. A switch counts as finished only when it is proven (the state reads
 *     back as done on a switched device, `switchProvenFinished`): on a
 *     switched machine whose run state cannot be read nobody finishes,
 *     publishes or clears ("finish"), and nobody answers that nothing is
 *     left (which the report shows as done). A stopped run's gate of this
 *     vault is still opened.
 * 12. A refusal because of another vault's stopped run names that vault
 *     (the holder) and what the run was (a migration, a rollback), so the
 *     command it names finishes that run there; other refusals name no
 *     other vault.
 * 13. A switched machine whose run state reads none or failed can never
 *     prove its switch finished on its own (only a run that reads done
 *     does): the automatic path never finishes it, so no start spawns a
 *     worker for it again and again. The decision is "nothing" with its
 *     own reason, the switch not proven; a stopped run's gate of this
 *     vault is still opened, once. (An unfinished rollback answers first,
 *     invariant 14.)
 * 14. An unfinished or unreadable rollback is never migrated over by the
 *     automatic path: a rollback that began and did not finish is the
 *     operator's choice, as a finished one is. The automatic path never
 *     migrates, resumes or finishes there, and never answers that nothing
 *     is left or nothing is needed; where it acts it refuses, naming the
 *     rollback, or opens a stopped migration run's gate without migrating.
 * 15. A dead rollback gate of this vault whose run state reads rolled back
 *     (the rollback finished, and only its release failed) is opened by
 *     the worker and `o2b update`, whatever the setting, the cooldown and
 *     the payload, and nothing is migrated: the machine is writable again.
 *     A start spawns the worker for it (a reused pid younger than the
 *     ceiling excepted, as in 3).
 * 16. An unfinished or unreadable rollback's refusal says which layout it
 *     met: on a switched machine (the rollback failed before it cleared
 *     the switch) the plain migrate-store stays on the store and ends it,
 *     so the refusal is marked switched and the surfaces name both
 *     commands; on the legacy layout it is never marked. The manual verb
 *     is never refused for an unfinished rollback on either layout: the
 *     operator's own migrate-store ends it.
 */
import { describe, expect, test } from "bun:test";

import {
  decideGate,
  type AttemptSeen,
  type GateAsker,
  type GateDecision,
  type GateSeen,
  type GateState,
  type RunSeen,
} from "../../../src/core/store-migration/gate-decision.ts";

const GATES = [
  "none",
  "unreadable",
  "damaged",
  "own-migration",
  "own-rollback",
  "other-vault",
  "other-vault-rollback",
];
const OTHER_VAULT = new Set(["other-vault", "other-vault-rollback"]);
const HOLDERS = [
  "dead",
  "alive-young",
  "alive-old",
  "reused-young",
  "reused-old",
  "unknown-young",
  "unknown-old",
] as const;
const RUNS = [
  "none",
  "unreadable",
  "in-progress-gate",
  "in-progress-other",
  "failed",
  "done",
  "rolled-back",
] as const;
const ROLLBACKS = ["none", "unfinished", "unreadable"] as const;
const MACHINES = ["legacy", "legacy-empty", "switched"] as const;
const RECORDS = [
  "none",
  "attempt",
  "attempt-owed",
  "failure-cooling",
  "failure-due",
  "waiting",
] as const;
const ASKERS: ReadonlyArray<GateAsker> = ["start", "worker", "update", "update-skip", "manual"];

type Holder = (typeof HOLDERS)[number];
type Run = (typeof RUNS)[number];
type Rollback = (typeof ROLLBACKS)[number];
type Machine = (typeof MACHINES)[number];
type RecordCase = (typeof RECORDS)[number];

const GATE_RUN = "migrate-20261118T100000000Z";

interface Row {
  readonly gate: string;
  readonly holder: Holder | null;
  readonly run: Run;
  readonly rollback: Rollback;
  readonly machine: Machine;
  readonly record: RecordCase;
  readonly setting: boolean;
  readonly asker: GateAsker;
}

function name(r: Row): string {
  return [
    `gate=${r.gate}${r.holder !== null ? `/${r.holder}` : ""}`,
    `run=${r.run}`,
    `rollback=${r.rollback}`,
    `machine=${r.machine}`,
    `record=${r.record}`,
    `setting=${r.setting ? "on" : "off"}`,
    `asker=${r.asker}`,
  ].join(" ");
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const gate of GATES) {
    const holders: ReadonlyArray<Holder | null> =
      gate === "none" || gate === "unreadable" || gate === "damaged" ? [null] : HOLDERS;
    for (const holder of holders) {
      for (const run of RUNS) {
        if (run === "in-progress-gate" && gate !== "own-migration") continue;
        for (const rollback of ROLLBACKS) {
          for (const machine of MACHINES) {
            if (machine !== "switched" && run === "done" && rollback === "none") continue;
            if (machine === "switched" && run === "rolled-back") continue;
            for (const record of RECORDS) {
              for (const setting of [true, false]) {
                for (const asker of ASKERS) {
                  out.push({ gate, holder, run, rollback, machine, record, setting, asker });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const cheapAsker = (asker: GateAsker): boolean => asker === "start";

function gateSeen(r: Row, cheap: boolean): GateSeen {
  if (r.gate === "none" || r.gate === "unreadable" || r.gate === "damaged") {
    return { kind: r.gate };
  }
  const h = r.holder!;
  const holder =
    h === "dead"
      ? "dead"
      : cheap
        ? "unknown"
        : h.startsWith("alive")
          ? "alive"
          : h.startsWith("reused")
            ? "dead"
            : "unknown";
  return {
    kind: "held",
    vault: OTHER_VAULT.has(r.gate) ? "/vaults/other" : "/vaults/this",
    ours: !OTHER_VAULT.has(r.gate),
    run: r.gate.endsWith("rollback") ? "rollback" : "migration",
    runId:
      r.gate === "own-rollback"
        ? `rollback-${GATE_RUN}`
        : r.gate === "other-vault-rollback"
          ? "rollback-migrate-other"
          : r.gate === "other-vault"
            ? "migrate-other"
            : GATE_RUN,
    holder,
    aged: h.endsWith("-old"),
  };
}

function runSeen(r: Row): RunSeen {
  switch (r.run) {
    case "in-progress-gate":
      return { phase: "in-progress", runId: GATE_RUN };
    case "in-progress-other":
      return { phase: "in-progress", runId: "migrate-20261117T090000000Z" };
    default:
      return { phase: r.run };
  }
}

function recordSeen(r: Row): AttemptSeen {
  switch (r.record) {
    case "none":
      return { kind: "none", cooling: false, owed: false };
    case "attempt":
      return { kind: "attempt", cooling: true, owed: false };
    case "attempt-owed":
      return { kind: "attempt", cooling: true, owed: true };
    case "failure-cooling":
      return { kind: "failure", cooling: true, owed: false };
    case "failure-due":
      return { kind: "failure", cooling: false, owed: false };
    case "waiting":
      return { kind: "waiting", cooling: false, owed: false };
  }
}

/** The state as `asker` sees it (its own judgement of the holder). */
function stateOf(r: Row, asker: GateAsker = r.asker, cheap = cheapAsker(asker)): GateState {
  return {
    asker,
    setting: r.setting,
    switched: r.machine === "switched",
    gate: gateSeen(r, cheap),
    record: recordSeen(r),
    run: runSeen(r),
    rollback: r.rollback,
    payload: r.machine === "legacy",
  };
}

const ACTS = new Set(["open", "migrate", "refuse", "finish"]);
const acts = (d: GateDecision): boolean => ACTS.has(d.act);
const automatic = (asker: GateAsker): boolean =>
  asker === "start" || asker === "worker" || asker === "update";

function violations(r: Row): string[] {
  const out: string[] = [];
  const d = decideGate(stateOf(r));
  const held = r.holder !== null;
  const h = r.holder;
  const aged = h !== null && h.endsWith("-old");
  const possiblyLive =
    r.gate === "unreadable" || (held && (h!.startsWith("alive") || h!.startsWith("unknown")));
  const deadHolder = held && (h === "dead" || h!.startsWith("reused"));
  const ownMigration = r.gate === "own-migration";
  const legacy = r.machine !== "switched";
  // A rollback that began and did not finish (a rolled-back run settles it).
  const rollbackOpen = r.rollback !== "none" && r.run !== "rolled-back";
  // A finished rollback whose gate stayed: the automatic path opens it (15).
  const finishedRollbackGate =
    r.gate === "own-rollback" && deadHolder && r.run === "rolled-back" && legacy;

  if (d.act === "gather") out.push("8: a full state asked for more");

  // 9
  if (r.asker === "update-skip") {
    if (d.act !== "none" || d.why !== "skipped") out.push("9: --skip-store-migration decided");
    return out;
  }

  // 1
  if (possiblyLive) {
    const allowed =
      d.act === "none" ||
      (d.act === "refuse" && OTHER_VAULT.has(r.gate) && r.asker === "manual") ||
      (d.act === "spawn" && r.asker === "start" && aged);
    if (!allowed) out.push(`1: a holder that may still run met ${d.act}`);
  }

  // 2
  if (automatic(r.asker) && held && !ownMigration) {
    if (d.act === "open" && !finishedRollbackGate)
      out.push("2: the automatic path opened another command's or vault's gate");
    if (d.act === "migrate") out.push("2: the automatic path migrated over a gate not its own");
    if (r.gate === "own-rollback" && d.act === "finish") {
      out.push("2: a switch finished across an interrupted rollback");
    }
  }

  // 3
  if (ownMigration && deadHolder) {
    if (r.asker === "start") {
      const startSeesIt = h === "dead" || aged;
      if (startSeesIt && d.act !== "spawn") out.push("3: a start left a dead holder's gate");
    } else {
      const recovered = legacy
        ? d.act === "migrate" || d.act === "open"
        : d.act === "finish" || d.act === "open";
      if (!recovered) out.push(`3: a dead holder's gate was not recovered (${JSON.stringify(d)})`);
    }
  }

  // 4
  if (!r.setting && legacy && (r.asker === "worker" || r.asker === "update")) {
    if (d.act === "migrate") {
      const ownRun =
        d.resume &&
        ownMigration &&
        deadHolder &&
        r.record === "attempt" &&
        r.run === "in-progress-gate";
      if (!ownRun) out.push("4: a migration started with the setting off");
    }
  }

  // 5
  if (r.asker === "worker" || r.asker === "update") {
    const seen = gateSeen(r, false);
    if (seen.kind === "held" && seen.holder === "unknown" && acts(d)) {
      out.push("5: a worker acted on a holder it cannot tell");
    }
  }
  if (r.asker === "start" && ownMigration && aged && d.act !== "spawn") {
    out.push("5: an uncertain holder past the ceiling did not reach the worker");
  }

  // 10
  if (automatic(r.asker) && r.run === "unreadable" && legacy && d.act === "migrate") {
    out.push("10: a migration over a run state that cannot be read");
  }

  // 12
  if (d.act === "refuse") {
    const expected = d.why === "other-vault-gate" ? "/vaults/other" : null;
    if (d.holder !== expected) out.push(`12: a refusal named the holder ${String(d.holder)}`);
    // The command it names finishes what holds the gate: a rollback's
    // gate is never answered with a resume, which would migrate again.
    const holderRun =
      d.why !== "other-vault-gate"
        ? null
        : r.gate === "other-vault-rollback"
          ? "rollback"
          : "migration";
    if ((d.holderRun ?? null) !== holderRun) {
      out.push(`12: a refusal named the holder's run ${String(d.holderRun)}`);
    }
  }

  // 11
  if (r.machine === "switched" && r.run === "unreadable") {
    if (d.act === "finish") out.push("11: a switch not proven finished was finished");
    if (d.act === "none" && d.why === "nothing-left") {
      out.push("11: a switch not proven finished was answered as nothing left");
    }
  }

  // 14
  if (automatic(r.asker) && rollbackOpen) {
    if (d.act === "migrate") out.push("14: a migration over an unfinished rollback");
    if (d.act === "finish") out.push("14: a switch finished across an unfinished rollback");
    if (d.act === "none" && (d.why === "nothing-left" || d.why === "not-available")) {
      out.push(`14: an unfinished rollback answered ${d.why}`);
    }
    if (d.act === "open" && !(ownMigration && deadHolder)) {
      out.push(`14: an unfinished rollback opened ${JSON.stringify(d)}`);
    }
    if (d.act === "refuse" && !d.why.includes("rollback")) {
      out.push(`14: an unfinished rollback refused for ${d.why}`);
    }
  }

  // 16
  if (d.act === "refuse" && (d.why === "unfinished-rollback" || d.why === "rollback-unreadable")) {
    if (r.asker === "manual") out.push(`16: the manual verb refused for ${d.why}`);
    if ((d.switched === true) !== !legacy) {
      out.push(`16: a ${r.machine} machine's ${d.why} marked switched=${String(d.switched)}`);
    }
  }
  if (d.act === "refuse" && d.why !== "unfinished-rollback" && d.why !== "rollback-unreadable") {
    if (d.switched !== undefined) out.push(`16: a ${d.why} refusal marked switched`);
  }

  // 15
  if (finishedRollbackGate) {
    if (r.asker === "worker" || r.asker === "update") {
      if (d.act !== "open")
        out.push(`15: a finished rollback's gate was left: ${JSON.stringify(d)}`);
    }
    if (r.asker === "start" && (h === "dead" || aged) && d.act !== "spawn") {
      out.push("15: a start left a finished rollback's gate");
    }
  }

  // 13
  if (
    r.machine === "switched" &&
    (r.run === "none" || r.run === "failed") &&
    automatic(r.asker) &&
    r.record !== "none" &&
    !rollbackOpen
  ) {
    if (d.act === "finish") out.push("13: a switch that can never be proven was finished");
    const opensOwnGate = ownMigration && deadHolder;
    // A holder the asker sees as live (a start sees a reused pid so) keeps its gate.
    const holderKept = d.act === "none" && (d.why === "running" || d.why === "other-vault-running");
    if (d.act === "none" && !holderKept && d.why !== "switch-unproven") {
      out.push(`13: an unprovable switch answered ${d.why}`);
    }
    if (d.act === "open" && (!opensOwnGate || d.why !== "switch-unproven")) {
      out.push(`13: an unprovable switch opened ${JSON.stringify(d)}`);
    }
  }

  // 6
  if (
    r.machine === "switched" &&
    r.run !== "in-progress-gate" &&
    r.run !== "in-progress-other" &&
    r.run !== "unreadable" &&
    r.record === "none" &&
    r.rollback === "none" &&
    (r.gate === "none" || r.gate === "damaged") &&
    (r.asker === "start" || r.asker === "worker")
  ) {
    const cheapOnly = { ...stateOf(r), payload: null };
    const c = decideGate(cheapOnly);
    if (c.act !== "none" || c.why !== "nothing-left") {
      out.push(`6: a finished switched machine decided ${JSON.stringify(c)}`);
    }
  }

  // 7: the start's own view, asked of the worker.
  if (r.asker === "start") {
    const worker = decideGate(stateOf(r, "worker", true));
    const seen = gateSeen(r, true);
    const undecided = seen.kind === "held" && seen.holder === "unknown" && seen.aged;
    if (!undecided) {
      if (worker.act === "none" && JSON.stringify(worker) !== JSON.stringify(d)) {
        out.push(`7: start ${JSON.stringify(d)} vs worker ${JSON.stringify(worker)}`);
      }
      if (acts(worker) && d.act !== "spawn") {
        out.push(`7: the worker acts (${worker.act}) and the start does not spawn it`);
      }
    }
  }

  // 8: the cheap reads of a start.
  if (r.asker === "start") {
    const full = stateOf(r);
    const cheap = {
      ...full,
      payload: null,
      run: legacy ? null : full.run,
      rollback: legacy ? null : full.rollback,
    };
    const c = decideGate(cheap);
    if (c.act !== "gather" && JSON.stringify(c) !== JSON.stringify(d)) {
      out.push(`8: the cheap reads decided ${JSON.stringify(c)}, all reads ${JSON.stringify(d)}`);
    }
  }
  return out;
}

/**
 * Rows per gate state: runs x rollback records x machines without the
 * impossible ones, x records, settings, askers.
 */
function perGate(withGateRun: boolean): number {
  const runs = withGateRun ? 7 : 6;
  // Legacy (2 kinds): every run but done with no rollback record, the
  // done run with one of the two others. Switched: every run but rolled back.
  const legacy = 2 * ((runs - 1) * 3 + 2);
  const switched = (runs - 1) * 3;
  return (legacy + switched) * 6 * 2 * 5;
}

describe("the migration gate decision, over its whole state space", () => {
  const all = rows();

  test("covers every row", () => {
    // Gates: 3 without a holder + 4 x 7 holders. Runs x rollback records x
    // machines without the impossible ones (see perGate), plus the run
    // with the gate's id only for this vault's migration gate. Records 6,
    // settings 2, askers 5.
    expect(all.length).toBe(3 * perGate(false) + 7 * (perGate(true) + 3 * perGate(false)));
  });

  test("keeps every invariant in every row", () => {
    const broken = all.flatMap((row) => violations(row).map((v) => `${name(row)}: ${v}`));
    expect(broken.slice(0, 40)).toEqual([]);
    expect(broken.length).toBe(0);
  });
});
