/**
 * Every surface that says what the automatic migration will do restates
 * the gate decision (`gate-decision.ts`): the report state (the status
 * block, `o2b brain upgrade --dry-run`), the doctor's finding, the
 * session notice line, the `o2b update --dry-run` outcome and the start's
 * own answer. Each is derived from the decision's answer and its reason,
 * never from its own reading of the state, so none can disagree with
 * what the next step does. This table walks every answer the decision
 * can give and checks each surface for it.
 *
 * A switched machine reports its switch done only when it is proven
 * finished (`switchProvenFinished`: the run state reads back as done):
 * the rows with a run state that cannot be read, and with a finish that
 * reads back as anything else, check that no surface says done.
 *
 * A rollback that began and did not finish (or whose record cannot be
 * read) is answered with the command that finishes it, never with a
 * migration; a finished rollback whose gate stayed is opened by the next
 * start, and no surface offers a migration for it.
 */
import { describe, expect, test } from "bun:test";

import { migrationFindingKind } from "../../../src/core/brain/doctor/migration-check.ts";
import { failureNoticeTail } from "../../../src/core/brain/runtime-notices.ts";
import {
  AUTO_MIGRATION_SPAWN,
  migrationOwnsUpgrade,
  startDecisionOf,
} from "../../../src/core/maintenance/ensure-current.ts";
import {
  AUTO_MIGRATION_STATE,
  reportOf,
  type ReportFacts,
} from "../../../src/core/store-migration/auto-report.ts";
import {
  AUTO_MIGRATION_ROLLBACK_COMMAND,
  type AutoMigrationFailure,
} from "../../../src/core/store-migration/auto-state.ts";
import { AUTO_MIGRATION_OUTCOME } from "../../../src/core/store-migration/auto-worker.ts";
import type {
  GateDecision,
  GateNone,
  GateOpen,
  GateRefusal,
} from "../../../src/core/store-migration/gate-decision.ts";
import {
  describeUpdateStoreMigration,
  dryRunOf,
  UPDATE_STORE_MIGRATION,
} from "../../../src/core/store-migration/update-step.ts";
import { MIGRATE_STORE_COMMAND } from "../../../src/core/store/migration-availability.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");

/** The vault whose stopped migration holds the gate in an other-vault refusal. */
const HOLDER_VAULT = "/srv/vaults/holder";

const FAILURE: AutoMigrationFailure = {
  state: "failed",
  failedAt: "2026-11-19T11:00:00.000Z",
  error: "the disk is full",
  consecutiveFailures: 1,
  retryAfter: "2026-11-19T13:00:00.000Z",
  manualCommand: MIGRATE_STORE_COMMAND,
  attempt: false,
  written: { row: false, log: false, notice: false },
  gateOwed: null,
};

/** A legacy machine with something to migrate, a failure recorded. */
function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    now: NOW,
    switched: false,
    interrupted: false,
    runRolledBack: false,
    legacyDataPresent: true,
    available: true,
    nextCommands: ["o2b brain migrate-store --dry-run"],
    error: null,
    storeAbsent: false,
    running: null,
    failure: FAILURE,
    waiting: null,
    settingProblem: null,
    stoppedGate: null,
    switchFinished: false,
    rollbackPending: null,
    ...over,
  };
}

/** The attempt record an automatic attempt that switched this machine leaves until its outputs are written. */
const ATTEMPT: AutoMigrationFailure = { ...FAILURE, attempt: true };

/** Whether `d` makes a start spawn the worker (the start's own answer). */
function acts(d: GateDecision): boolean {
  return d.act !== "none" && d.act !== "gather" && d.act !== "spawn";
}

const NONES: ReadonlyArray<GateNone> = [
  "disabled",
  "not-available",
  "rolled-back",
  "run-unreadable",
  "switch-unproven",
  "waiting",
  "backoff",
  "running",
  "other-vault-running",
  "nothing-left",
];
const OPENS: ReadonlyArray<GateOpen> = [
  "disabled",
  "not-available",
  "rolled-back",
  "run-unreadable",
  "switch-unproven",
  "waiting",
  "backoff",
  "nothing-left",
];
const REFUSALS: ReadonlyArray<GateRefusal> = [
  "interrupted-rollback",
  "interrupted-removal",
  "other-vault-gate",
  "unfinished-rollback",
  "rollback-unreadable",
];
/** The refusals whose command finishes this vault's rollback. */
const ROLLBACK_REFUSALS = new Set<GateRefusal>([
  "interrupted-rollback",
  "unfinished-rollback",
  "rollback-unreadable",
]);
/** How a switched machine names the plain command that stays on the store and ends a rollback. */
const STAY_ON_STORE = `\`${MIGRATE_STORE_COMMAND}\` to end it and stay on the brain store`;
/** What a gate left by a finished rollback is released with by hand. */
const FORCE_RELEASE = `${MIGRATE_STORE_COMMAND} --force-release-gate`;

/**
 * A stopped gate is worded as its own sentence, apart from the failure:
 * the run that left it may be a later manual run, not the automatic
 * attempt whose failure the line names.
 */
const STOPPED_GATE =
  "A migration run of this vault, automatic or manual, stopped with its gate closed";
/** What attributed the gate to the failed automatic attempt. */
const GATE_OF_THE_FAILURE = "it stopped";

interface Row {
  readonly d: GateDecision;
  readonly f: ReportFacts;
  readonly report: string;
  readonly finding: "warning" | "advice" | null;
  /** What the notice line must say, and must never say (null: no failure line). */
  readonly notice: { readonly says: readonly string[]; readonly never?: readonly string[] } | null;
  readonly dryRun: string;
  /** What the report's message must say, when the row pins it. */
  readonly reportSays?: string;
  /** The command the report names, when the row pins it. */
  readonly manualCommand?: string;
}

function noneRow(why: GateNone): Row {
  switch (why) {
    case "not-available":
      return {
        d: { act: "none", why },
        f: facts({ legacyDataPresent: false, available: false }),
        report: AUTO_MIGRATION_STATE.notNeeded,
        finding: null,
        notice: null,
        dryRun: UPDATE_STORE_MIGRATION.notNeeded,
      };
    case "nothing-left":
      return {
        d: { act: "none", why },
        f: facts({ switched: true, available: false, failure: null }),
        report: AUTO_MIGRATION_STATE.done,
        finding: null,
        notice: null,
        dryRun: UPDATE_STORE_MIGRATION.notNeeded,
      };
    case "disabled":
      return {
        d: { act: "none", why },
        f: facts(),
        report: AUTO_MIGRATION_STATE.failed,
        finding: "warning",
        notice: { says: ["off on this machine"] },
        dryRun: UPDATE_STORE_MIGRATION.disabled,
      };
    case "rolled-back":
      return {
        d: { act: "none", why },
        f: facts(),
        report: AUTO_MIGRATION_STATE.rolledBack,
        finding: "advice",
        notice: { says: ["rolled back"] },
        dryRun: UPDATE_STORE_MIGRATION.rolledBack,
      };
    case "run-unreadable":
      return {
        d: { act: "none", why },
        f: facts(),
        report: AUTO_MIGRATION_STATE.waiting,
        finding: "advice",
        notice: { says: ["cannot be read"] },
        dryRun: UPDATE_STORE_MIGRATION.waiting,
      };
    case "switch-unproven":
      // Switched, the run state reads absent or failed with an attempt's
      // record: never reported done, nothing retried, the manual command.
      return {
        d: { act: "none", why },
        f: facts({ switched: true, available: false, failure: ATTEMPT }),
        report: AUTO_MIGRATION_STATE.pending,
        finding: "advice",
        notice: null,
        dryRun: UPDATE_STORE_MIGRATION.refused,
        reportSays: "does not record that the switch finished",
      };
    case "waiting":
      return {
        d: { act: "none", why },
        f: facts({
          failure: null,
          storeAbsent: true,
          waiting: {
            state: "waiting",
            since: "2026-11-19T11:00:00.000Z",
            missing: [],
            firstMachines: ["dev-b"],
            reason: null,
            awaitsStore: true,
          },
        }),
        report: AUTO_MIGRATION_STATE.waiting,
        finding: "advice",
        notice: { says: ["waits"] },
        dryRun: UPDATE_STORE_MIGRATION.waiting,
      };
    case "backoff":
      return {
        d: { act: "none", why },
        f: facts(),
        report: AUTO_MIGRATION_STATE.failed,
        finding: "warning",
        notice: { says: [`tries again after ${FAILURE.retryAfter}`] },
        dryRun: UPDATE_STORE_MIGRATION.refused,
      };
    case "running":
    case "other-vault-running":
      return {
        d: { act: "none", why },
        f: facts({ failure: null }),
        report: AUTO_MIGRATION_STATE.running,
        finding: "advice",
        notice: { says: ["runs now"] },
        dryRun: UPDATE_STORE_MIGRATION.running,
      };
    case "skipped":
      throw new Error("not an answer of the worker");
  }
}

const ROWS: ReadonlyArray<Row> = [
  ...NONES.map(noneRow),
  ...OPENS.filter((why) => why !== "rolled-back").map((why): Row => ({
    d: { act: "open", why },
    f: facts({ stoppedGate: "other" }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: [STOPPED_GATE, "the next start opens the gate"],
      never: ["before it changed anything", GATE_OF_THE_FAILURE],
    },
    // The update would open the gate: work, never "not needed".
    dryRun: UPDATE_STORE_MIGRATION.pending,
  })),
  {
    // A finished rollback whose gate stayed (its release met a busy lock):
    // the next start opens it; nothing offers a migration.
    d: { act: "open", why: "rolled-back" },
    f: facts({ runRolledBack: true }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: ["the next start opens the gate", "no start migrates it again"],
      never: [GATE_OF_THE_FAILURE, STOPPED_GATE],
    },
    dryRun: UPDATE_STORE_MIGRATION.pending,
    reportSays: "rolled back to the legacy layout",
    manualCommand: FORCE_RELEASE,
  },
  {
    // A stopped migration run's gate over a rollback that began and did
    // not finish: the gate is opened, the rollback's command finishes it.
    d: { act: "open", why: "rolled-back" },
    f: facts({ stoppedGate: "other", rollbackPending: "unfinished" }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: ["the next start opens the gate", "no start migrates it again"],
      never: [GATE_OF_THE_FAILURE],
    },
    dryRun: UPDATE_STORE_MIGRATION.pending,
    reportSays: "began and did not finish",
    manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND,
  },
  {
    d: { act: "migrate", resume: true },
    f: facts({ stoppedGate: "own-run" }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: [STOPPED_GATE, "the next start finishes that run"],
      never: [GATE_OF_THE_FAILURE],
    },
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  {
    d: { act: "migrate", resume: false },
    f: facts({ stoppedGate: "other" }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: [STOPPED_GATE, "the next start goes on with the migration"],
      never: [GATE_OF_THE_FAILURE],
    },
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  {
    d: { act: "migrate", resume: false },
    f: facts({ failure: null }),
    report: AUTO_MIGRATION_STATE.pending,
    finding: "advice",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  {
    d: { act: "migrate", resume: false },
    f: facts(),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: { says: ["the next start tries again"], never: [STOPPED_GATE, "gate closed"] },
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  ...REFUSALS.map((why): Row => ({
    d: { act: "refuse", why, holder: why === "other-vault-gate" ? HOLDER_VAULT : null },
    f: facts({ failure: null }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: {
      says: [ROLLBACK_REFUSALS.has(why) ? AUTO_MIGRATION_ROLLBACK_COMMAND : "refuses"],
    },
    dryRun: UPDATE_STORE_MIGRATION.refused,
    ...(ROLLBACK_REFUSALS.has(why) ? { manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND } : {}),
    ...(why === "unfinished-rollback" ? { reportSays: "began and did not finish" } : {}),
    ...(why === "rollback-unreadable" ? { reportSays: "rollback record cannot be read" } : {}),
  })),
  ...(["unfinished-rollback", "rollback-unreadable"] as const).map((why): Row => ({
    // A rollback that failed before it cleared the switch: the machine
    // still writes to the store, so the operator may finish the rollback
    // or stay on the store, which ends it. Every surface names both.
    d: { act: "refuse", why, holder: null, switched: true },
    f: facts({ switched: true, available: false, failure: null }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: { says: [AUTO_MIGRATION_ROLLBACK_COMMAND, STAY_ON_STORE] },
    dryRun: UPDATE_STORE_MIGRATION.refused,
    manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND,
    reportSays: STAY_ON_STORE,
  })),
  ...(["unfinished", "unreadable"] as const).map((pending): Row => ({
    // Opted out over a rollback that began and did not finish: the report
    // names the rollback's command, never a migration.
    d: { act: "none", why: "disabled" },
    f: facts({ failure: null, rollbackPending: pending }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.disabled,
    reportSays: "rollback",
    manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND,
  })),
  // Another vault's stopped rollback or removal: the command finishes it
  // there, never a resume, which would migrate that vault again.
  ...(["rollback", "removal"] as const).map((holderRun): Row => ({
    d: { act: "refuse", why: "other-vault-gate", holder: HOLDER_VAULT, holderRun },
    f: facts({ failure: null }),
    report: AUTO_MIGRATION_STATE.failed,
    finding: "warning",
    notice: { says: ["refuses"] },
    dryRun: UPDATE_STORE_MIGRATION.refused,
  })),
  {
    // Opted out, and rolled back: reported as rolled back, never as off.
    d: { act: "none", why: "disabled" },
    f: facts({ runRolledBack: true, failure: null }),
    report: AUTO_MIGRATION_STATE.rolledBack,
    finding: "advice",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.disabled,
  },
  {
    // Switched, its run state cannot be read: the attempt that switched it
    // stays pending, and nothing says the switch is done.
    d: { act: "none", why: "run-unreadable" },
    f: facts({ switched: true, available: false, failure: ATTEMPT }),
    report: AUTO_MIGRATION_STATE.waiting,
    finding: "advice",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.waiting,
    reportSays: "whether its switch finished",
  },
  {
    // Switched, the attempt's outputs left, the run state proven done.
    d: { act: "finish" },
    f: facts({ switched: true, available: false, failure: ATTEMPT, switchFinished: true }),
    report: AUTO_MIGRATION_STATE.done,
    finding: null,
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  {
    // Switched, the attempt's outputs left, the run state reads back as
    // anything but done: pending, never done.
    d: { act: "finish" },
    f: facts({ switched: true, available: false, failure: ATTEMPT }),
    report: AUTO_MIGRATION_STATE.pending,
    finding: "advice",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.pending,
    reportSays: "does not read back as done",
  },
  {
    // A switched machine with a record left from before the switch: done,
    // the next start clears it.
    d: { act: "finish" },
    f: facts({ switched: true, available: false, switchFinished: true }),
    report: AUTO_MIGRATION_STATE.done,
    finding: null,
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
  {
    d: { act: "finish" },
    f: facts({ switched: true, interrupted: true, failure: null }),
    report: AUTO_MIGRATION_STATE.pending,
    finding: "advice",
    notice: null,
    dryRun: UPDATE_STORE_MIGRATION.pending,
  },
];

describe("answer x surface", () => {
  test("every answer of the worker's decision has a row", () => {
    const seen = new Set(ROWS.map((r) => `${r.d.act}:${"why" in r.d ? r.d.why : ""}`));
    for (const why of NONES) expect(seen.has(`none:${why}`)).toBe(true);
    for (const why of OPENS) expect(seen.has(`open:${why}`)).toBe(true);
    for (const why of REFUSALS) expect(seen.has(`refuse:${why}`)).toBe(true);
    for (const act of ["migrate", "finish"]) expect(seen.has(`${act}:`)).toBe(true);
  });

  for (const row of ROWS) {
    const label = `${row.d.act}${"why" in row.d ? ` ${row.d.why}` : ""}${
      row.d.act === "migrate" ? ` resume=${row.d.resume}` : ""
    } (${row.f.stoppedGate ?? "no gate"}, ${row.f.failure !== null ? "failure" : "no record"}${
      row.f.switched ? ", switched" : ""
    })`;

    test(`${label}: report, doctor, notice, update dry run, start`, () => {
      const report = reportOf(row.d, row.f);
      expect([label, "report", report.state]).toEqual([label, "report", row.report]);
      expect([label, "doctor", migrationFindingKind(report)]).toEqual([
        label,
        "doctor",
        row.finding,
      ]);

      // The message and what the next start does agree: a report whose
      // next start retries nothing announces no automatic attempt.
      if (report.nextStart.startsWith("nothing") && !report.nextStart.includes("tries again")) {
        expect([label, report.message.includes("next automatic attempt")]).toEqual([label, false]);
      }
      if (row.reportSays !== undefined) {
        expect([label, report.message]).toEqual([label, expect.stringContaining(row.reportSays)]);
      }
      if (row.manualCommand !== undefined) {
        expect([label, report.manualCommand]).toEqual([label, row.manualCommand]);
        // Nothing offers a migration where the operator rolled back.
        const said = `${report.message} ${report.nextStart}`;
        expect([label, said.includes("go on with the migration")]).toEqual([label, false]);
      }
      // A switch reported done is a switch proven finished.
      if (
        row.f.switched &&
        report.state === AUTO_MIGRATION_STATE.done &&
        (row.d.act === "finish" || (row.d.act === "none" && row.d.why === "run-unreadable"))
      ) {
        expect([label, "proven", row.f.switchFinished]).toEqual([label, "proven", true]);
      }

      // The report names the run that left a stopped gate as a migration
      // run, never as the automatic attempt: a manual run may own it.
      if (row.f.stoppedGate !== null && row.d.act !== "refuse") {
        const said = `${report.message} ${report.nextStart}`;
        expect([label, said.includes("attempt stopped")]).toEqual([label, false]);
        expect([label, said.includes("stopped attempt")]).toEqual([label, false]);
      }

      const tail = failureNoticeTail(row.d, {
        setting: !(row.d.act === "none" && row.d.why === "disabled"),
        failure: row.f.failure ?? FAILURE,
        stoppedGate: row.f.stoppedGate,
      });
      if (row.notice === null) {
        // A switched machine shows no failure line at all (store-only).
        if (row.f.failure !== null && !row.f.switched) {
          expect([label, tail]).toEqual([label, null]);
        }
      } else {
        for (const says of row.notice.says) {
          expect([label, tail]).toEqual([label, expect.stringContaining(says)]);
        }
        for (const never of row.notice.never ?? []) {
          expect([label, never, tail?.includes(never)]).toEqual([label, never, false]);
        }
        // The failure is one sentence and the stopped gate another.
        if (row.notice.says.includes(STOPPED_GATE)) {
          expect([label, tail?.includes(`). ${STOPPED_GATE}`)]).toEqual([label, true]);
        }
      }

      const dry = dryRunOf(row.d, row.f.nextCommands);
      expect([label, "dry run", dry.outcome]).toEqual([label, "dry run", row.dryRun]);
      if (row.d.act === "refuse") {
        expect([label, dry.manual_command]).toEqual([label, expect.any(String)]);
        expect(report.manualCommand).toBe(dry.manual_command);
        // The plain command that stays on the store is named exactly where
        // it ends the refusal: a switched machine's unfinished rollback.
        const stays = row.d.switched === true;
        for (const [surface, said] of [
          ["report", `${report.message} ${report.nextStart}`],
          ["notice", tail ?? ""],
          ["dry run", describeUpdateStoreMigration(dry)],
        ] as const) {
          expect([label, surface, said.includes(STAY_ON_STORE)]).toEqual([label, surface, stays]);
        }
        // Another vault's stopped run is recovered from that vault: the
        // command names it, and resumes that run.
        if (row.d.why === "other-vault-gate") {
          for (const said of [report.manualCommand, report.message, tail]) {
            expect([label, said]).toEqual([label, expect.stringContaining(HOLDER_VAULT)]);
          }
          const finish =
            row.d.holderRun === "rollback"
              ? "--rollback"
              : row.d.holderRun === "removal"
                ? "--remove-legacy"
                : "--resume";
          expect([label, report.manualCommand]).toEqual([
            label,
            `${MIGRATE_STORE_COMMAND} --vault ${HOLDER_VAULT} ${finish}`,
          ]);
          if (row.d.holderRun === "rollback") {
            expect([label, report.message]).toEqual([
              label,
              expect.stringContaining("stopped rollback"),
            ]);
          }
        }
      }

      // The start: it spawns exactly when the worker acts, and says why otherwise.
      if (acts(row.d)) return;
      if (row.d.act !== "none") return;
      const start = startDecisionOf(row.d.why);
      if (row.d.why === "run-unreadable") {
        expect(start).toBe(AUTO_MIGRATION_SPAWN.runUnreadable);
        expect(migrationOwnsUpgrade(start)).toBe(false);
      }
      if (row.d.why === "running") expect(migrationOwnsUpgrade(start)).toBe(true);
      if (row.d.why === "nothing-left") expect(start).toBeNull();
      if (row.d.why === "switch-unproven") {
        expect(start).toBe(AUTO_MIGRATION_SPAWN.switchUnproven);
      }
    });
  }

  test("the dry run never says not needed while the update would act", () => {
    for (const row of ROWS) {
      if (!acts(row.d)) continue;
      expect(dryRunOf(row.d, []).outcome).not.toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    }
  });
});
