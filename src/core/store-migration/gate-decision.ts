/**
 * What a session start, the automatic worker, `o2b update` and the manual
 * verb decide when they meet the migration gate (change
 * auto-store-migration): ONE pure function of an explicit state. Nothing
 * here reads a file, the clock or a process; the callers gather the state
 * (`gate-state.ts`) and act on the answer.
 *
 * The rules, as invariants the table test states them:
 *
 *  1. A holder that may still run (its identity matches, or cannot be
 *     told and its gate is younger than a day) keeps its gate: nobody
 *     opens or takes it over. A start sees only the pid, so a live pid is
 *     "unknown" to it.
 *  2. A gate that is not this vault's migration run (an interrupted
 *     rollback's or legacy tree removal's, another vault's) is never
 *     opened or taken over by the automatic path: the worker refuses and
 *     names the command that finishes it.
 *  3. A dead holder's gate of this vault's migration run is recovered by
 *     the next step allowed to write (the worker, `o2b update`, the manual
 *     verb), whatever the setting, the cooldown and the payload: resumed
 *     when the attempt may go on, otherwise opened (which leaves the
 *     machine on the legacy layout and writable, its run resumable).
 *  4. With the setting off no new migration starts: the automatic path
 *     only resumes the run its own attempt started, and only when that
 *     attempt did not report how it ended.
 *  5. A holder that cannot be told, past the age ceiling, reaches a worker
 *     that checks exactly whenever the automatic path would act on the
 *     gate were its holder gone; that worker never acts on an uncertain
 *     answer.
 *  6. A switched machine with nothing left to finish decides "nothing"
 *     from its cheap reads (its run state, the attempt record, the gate).
 *  7. A start and the worker decide the same on the same state: the start
 *     spawns exactly when the worker would act, and answers the worker's
 *     own "nothing" otherwise. The one difference is the worker's exact
 *     knowledge of a holder the start could not tell.
 *  8. A switch counts as finished only when it is proven
 *     ({@link switchProvenFinished}): a switched machine whose run state
 *     cannot be read finishes, publishes and clears nothing until it reads
 *     back (a stopped run's gate of this vault is still opened).
 *  9. A switched machine whose run state reads none or failed can never
 *     prove its switch on its own (only a run state that reads done does):
 *     the automatic path decides "nothing" for it ("switch-unproven"),
 *     never "finish", so no start spawns a worker for it at every start;
 *     a stopped run's gate of this vault is still opened, once. The
 *     operator's `o2b brain migrate-store` ends the attempt's record.
 * 10. A rollback of this vault that began and did not finish (its record
 *     is there, or cannot be read, and the run state does not read rolled
 *     back) is the operator's choice, as a finished one is: the automatic
 *     path never migrates, resumes or finishes there. Where it would act it
 *     refuses and names the command that finishes the rollback (on a
 *     switched machine also the plain migrate-store, which stays on the
 *     store and ends it); a stopped migration run's gate of this vault is
 *     opened, nothing more.
 * 11. A finished rollback whose gate stayed (its holder is gone and the
 *     run state reads rolled back: only its release failed) is opened by
 *     the next step allowed to write, whatever the setting, the cooldown
 *     and the payload. Nothing is migrated; the machine is writable again.
 */

/** Who asks. */
export type GateAsker =
  /** A session start or server start: cheap reads only, it spawns the worker. */
  | "start"
  /** The automatic worker, judging the holder exactly, under its claim. */
  | "worker"
  /** `o2b update`: the worker's logic in the foreground. */
  | "update"
  /** `o2b update --skip-store-migration`: checks and runs nothing. */
  | "update-skip"
  /** `o2b brain migrate-store`: the operator's own run. */
  | "manual";

/**
 * The gate's holder as the asker's judgement sees it: the cheap one (a
 * start) sees only whether the pid is alive (`dead`, or `unknown` for a
 * live pid); the exact one also compares the start identity.
 */
export type GateHolderSeen = "dead" | "alive" | "unknown";

/** The migration gate as read. */
export type GateSeen =
  | { readonly kind: "none" }
  /** The gate file exists and cannot be read now. */
  | { readonly kind: "unreadable" }
  /** The gate file holds no gate record (torn, damaged): a migration replaces it. */
  | { readonly kind: "damaged" }
  | {
      readonly kind: "held";
      /** The vault the gate names, as recorded. */
      readonly vault: string;
      /** Whether the gate names this vault. */
      readonly ours: boolean;
      /** A migration run's gate, or another command's (a rollback, a legacy tree removal). */
      readonly run: "migration" | "rollback" | "removal";
      readonly runId: string;
      readonly holder: GateHolderSeen;
      /** The gate is older than the age a holder that cannot be told is trusted for. */
      readonly aged: boolean;
    };

/** This device's migration run state as read. */
export type RunSeen =
  | { readonly phase: "none" }
  /** `state.json` is there and cannot be read or parsed. */
  | { readonly phase: "unreadable" }
  | { readonly phase: "in-progress"; readonly runId: string }
  | { readonly phase: "failed" }
  | { readonly phase: "done" }
  | { readonly phase: "rolled-back" };

/**
 * This machine's rollback record as read with the run state: none, there
 * (a rollback began; a run state that reads rolled back settles it) or
 * unreadable (it could be a rollback that began).
 */
export type RollbackSeen = "none" | "unfinished" | "unreadable";

/** The automatic migration's attempt record as read. */
export interface AttemptSeen {
  readonly kind: "none" | "attempt" | "failure" | "waiting";
  /** The record's cooldown has not run out (attempt and failure records). */
  readonly cooling: boolean;
  /** An attempt that could not open the stopped run's gate it should have opened. */
  readonly owed: boolean;
}

/** The whole state one gate decision is taken on. A null field is not read yet. */
export interface GateState {
  readonly asker: GateAsker;
  /** `auto_store_migration`: on, or off (failing closed). */
  readonly setting: boolean;
  /** This device writes to the store only (it switched). */
  readonly switched: boolean;
  readonly gate: GateSeen | null;
  readonly record: AttemptSeen | null;
  readonly run: RunSeen | null;
  /** This machine's rollback record; read with the run state, null when it is not. */
  readonly rollback: RollbackSeen | null;
  /** On the legacy layout: whether anything is left to migrate. */
  readonly payload: boolean | null;
}

/** Why nothing is done. */
export type GateNone =
  | "skipped"
  | "disabled"
  | "not-available"
  | "rolled-back"
  | "run-unreadable"
  | "switch-unproven"
  | "waiting"
  | "backoff"
  | "running"
  | "other-vault-running"
  | "nothing-left";

/** Why a gate is opened and nothing more is done. */
export type GateOpen = Exclude<GateNone, "running" | "other-vault-running" | "skipped">;

/** What a refusal names. */
export type GateRefusal =
  | "interrupted-rollback"
  | "interrupted-removal"
  | "other-vault-gate"
  /** A rollback of this vault began and did not finish (its gate is gone). */
  | "unfinished-rollback"
  /** This machine's rollback record cannot be read: a rollback may not have finished. */
  | "rollback-unreadable";

export type GateDecision =
  /** More of the state is needed (a start reads its expensive fields only then). */
  | { readonly act: "gather" }
  /** Nothing is done. */
  | { readonly act: "none"; readonly why: GateNone }
  /** A start: spawn the worker, which decides again under its claim. */
  | { readonly act: "spawn" }
  /** Open this vault's stopped migration run's gate; nothing more. */
  | { readonly act: "open"; readonly why: GateOpen }
  /**
   * Run the migration (it takes a stopped run's gate over). `resume`: the
   * setting is off and this is the attempt's own run, gone on with.
   */
  | { readonly act: "migrate"; readonly resume: boolean }
  /**
   * Refuse, naming what holds the gate (the worker records it as a
   * refusal). `holder`: the vault whose stopped run holds it, for
   * `other-vault-gate` (its recovery runs from that vault); null otherwise.
   * `holderRun`: what that run was, so the command named finishes it (a
   * rollback is never answered with a resume, which would migrate again).
   */
  | {
      readonly act: "refuse";
      readonly why: GateRefusal;
      readonly holder: string | null;
      readonly holderRun?: "migration" | "rollback" | "removal";
      /**
       * Set on an unfinished rollback's refusal on a switched machine
       * (rule 10): there `o2b brain migrate-store` stays on the store and
       * ends the rollback, so the surfaces name it beside `--rollback`.
       */
      readonly switched?: true;
    }
  /**
   * A switched machine: finish what is left (an interrupted switch, the
   * success outputs of an automatic attempt, a moot record) and open a
   * stopped migration run's gate of this vault left after it.
   */
  | { readonly act: "finish" };

/**
 * Whether this device's switch to the brain store is proven finished: the
 * device writes to the store only, and its migration run state reads back
 * as `done`. A state that cannot be read, is gone, or is still in
 * progress proves nothing. Every place that writes or reports the
 * automatic migration's success asks this one predicate: the worker
 * before it writes a success output, and the report before it says the
 * switch is done.
 */
export function switchProvenFinished(switched: boolean, run: RunSeen | null): boolean {
  return switched && run !== null && run.phase === "done";
}

const GATHER: GateDecision = Object.freeze({ act: "gather" });

function none(why: GateNone): GateDecision {
  return { act: "none", why };
}

/** How the gate bears on the decision. */
type GateClass =
  | { readonly k: "free" }
  | { readonly k: "block"; readonly why: "running" | "other-vault-running" }
  /** A holder that cannot be told, past the age ceiling: only the exact judgement decides. */
  | { readonly k: "aged" }
  | { readonly k: "dead-own-migration"; readonly runId: string }
  | { readonly k: "dead-own-command"; readonly run: "rollback" | "removal" }
  | {
      readonly k: "dead-other-vault";
      readonly vault: string;
      readonly run: "migration" | "rollback" | "removal";
    };

function classify(gate: GateSeen): GateClass {
  if (gate.kind === "none" || gate.kind === "damaged") return { k: "free" };
  if (gate.kind === "unreadable") return { k: "block", why: "running" };
  const live = gate.holder === "alive" || (gate.holder === "unknown" && !gate.aged);
  if (live) return { k: "block", why: gate.ours ? "running" : "other-vault-running" };
  if (gate.holder === "unknown") return { k: "aged" };
  if (!gate.ours) return { k: "dead-other-vault", vault: gate.vault, run: gate.run };
  return gate.run === "migration"
    ? { k: "dead-own-migration", runId: gate.runId }
    : { k: "dead-own-command", run: gate.run };
}

/**
 * The refusal an unfinished rollback of this vault gives (rule 10), or
 * null when there is none. A run state that reads rolled back settles a
 * record the rollback could not remove.
 */
function rollbackRefusal(state: GateState): Extract<GateDecision, { act: "refuse" }> | null {
  if (state.rollback === null || state.rollback === "none") return null;
  if (state.run?.phase === "rolled-back") return null;
  return {
    act: "refuse",
    why: state.rollback === "unfinished" ? "unfinished-rollback" : "rollback-unreadable",
    holder: null,
  };
}

/** An attempt or failure record still in its cooldown, for an asker that waits it out. */
function coolingDown(state: GateState): boolean {
  const record = state.record;
  return (
    honoursCooldown(state) &&
    record !== null &&
    (record.kind === "attempt" || record.kind === "failure") &&
    record.cooling
  );
}

/** The state with the gate's holder judged gone: what the worker does when its check says so. */
function holderGone(state: GateState): GateState {
  const gate = state.gate;
  if (gate === null || gate.kind !== "held") return state;
  return { ...state, gate: { ...gate, holder: "dead", aged: false } };
}

/** The decision for `state` ({@link GateDecision}); see the module header. */
export function decideGate(state: GateState): GateDecision {
  if (state.asker === "update-skip") return none("skipped");
  if (state.gate === null) return GATHER;
  const cls = classify(state.gate);
  if (cls.k === "aged") {
    // Only the worker's exact check tells a hung holder from a reused pid:
    // a start hands the gate to it whenever it would act were the holder
    // gone, and the worker never acts on an answer it cannot be sure of.
    if (state.asker !== "start") return none("running");
    const gone = decideGate(holderGone(state));
    return gone.act === "none" || gone.act === "gather" ? gone : { act: "spawn" };
  }
  const decision = state.switched ? decideSwitched(state, cls) : decideLegacy(state, cls);
  if (state.asker !== "start" || decision.act === "none" || decision.act === "gather") {
    return decision;
  }
  return { act: "spawn" };
}

function decideSwitched(state: GateState, cls: GateClass): GateDecision {
  if (state.run === null || state.record === null) return GATHER;
  const interrupted = state.run.phase === "in-progress";
  const ownGate = cls.k === "dead-own-migration";
  if (state.run.phase === "unreadable") {
    // Rule 8: no proven switch, so nothing is finished, published or
    // cleared (an attempt's record stays pending); a stopped run's gate of
    // this vault is still opened, as on the legacy layout.
    if (cls.k === "block") return none(cls.why);
    return ownGate ? { act: "open", why: "run-unreadable" } : none("run-unreadable");
  }
  if (state.asker === "manual") {
    // The operator's run on a switched machine finishes an interrupted
    // switch; a live holder refuses it.
    if (cls.k === "block") return none(cls.why);
    return interrupted || ownGate ? { act: "finish" } : none("nothing-left");
  }
  // Rule 10: a rollback that began here (killed or failed before it
  // cleared the switch) is answered before anything is finished.
  const rollback = rollbackRefusal(state);
  if (rollback !== null) {
    if (cls.k === "block") return none(cls.why);
    if (ownGate) return { act: "open", why: "rolled-back" };
    if (cls.k === "dead-own-command") {
      return { act: "refuse", why: `interrupted-${cls.run}` as GateRefusal, holder: null };
    }
    return coolingDown(state) ? none("backoff") : { ...rollback, switched: true };
  }
  if (!interrupted && state.record.kind === "none" && !ownGate) return none("nothing-left");
  if (cls.k === "block") return none(cls.why);
  // Finishing the switch must not cut across an interrupted rollback or
  // removal of this vault: only its own command finishes it.
  if (cls.k === "dead-own-command") {
    return { act: "refuse", why: `interrupted-${cls.run}` as GateRefusal, holder: null };
  }
  // Rule 9: nothing will ever read back as done here, so finishing would
  // only end where it started, at every start.
  if (state.run.phase === "none" || state.run.phase === "failed") {
    return ownGate ? { act: "open", why: "switch-unproven" } : none("switch-unproven");
  }
  // Only a failure the finishing itself recorded cools down; the record of
  // the attempt that switched is finished at once.
  if (
    interrupted &&
    state.record.kind === "failure" &&
    state.record.cooling &&
    !state.record.owed &&
    !ownGate
  ) {
    return none("backoff");
  }
  if (interrupted || state.record.kind !== "none") return { act: "finish" };
  // Only a stopped run's gate is left: the switch finished and was stopped
  // before it opened its gate.
  return { act: "open", why: "nothing-left" };
}

function decideLegacy(state: GateState, cls: GateClass): GateDecision {
  if (cls.k === "block") return none(cls.why);
  if (state.asker === "manual") {
    // The operator's explicit run: it takes a gate of this vault over from
    // a holder that is gone; another vault's gate refuses it.
    return cls.k === "dead-other-vault"
      ? { act: "refuse", why: "other-vault-gate", holder: cls.vault, holderRun: cls.run }
      : { act: "migrate", resume: true };
  }
  if (state.record === null) return GATHER;
  if (cls.k === "dead-own-migration") return recoverStoppedRun(state, cls.runId);
  if (cls.k === "dead-own-command" && cls.run === "rollback") {
    // Rule 11: a rollback that finished and could not release its gate.
    if (state.run === null) return GATHER;
    if (state.run.phase === "rolled-back") return { act: "open", why: "rolled-back" };
  }
  // Nothing of this vault is owed: the opt-out and the rest apply.
  if (!state.setting) return none("disabled");
  if (state.payload === null || state.run === null) return GATHER;
  // Rule 10: a rollback that began and did not finish is the operator's
  // choice, and a record that cannot be read could be that one. Answered
  // whatever the payload, so no surface says nothing is needed while it
  // stands.
  const rollback = rollbackRefusal(state);
  if (rollback !== null) {
    if (cls.k === "dead-own-command") {
      return { act: "refuse", why: `interrupted-${cls.run}` as GateRefusal, holder: null };
    }
    return coolingDown(state) ? none("backoff") : rollback;
  }
  if (!state.payload) return none("not-available");
  // A run the operator rolled back is their decision, never redone on its
  // own; a run state that cannot be read could be that one.
  if (state.run.phase === "rolled-back") return none("rolled-back");
  if (state.run.phase === "unreadable") return none("run-unreadable");
  // `o2b update` is the operator's explicit run: like the manual verb it
  // neither waits out a cooldown nor a remembered wait.
  if (honoursCooldown(state)) {
    if (state.record.kind === "waiting") return none("waiting");
    if (
      (state.record.kind === "attempt" || state.record.kind === "failure") &&
      state.record.cooling
    ) {
      return none("backoff");
    }
  }
  if (cls.k === "dead-own-command") {
    return { act: "refuse", why: `interrupted-${cls.run}` as GateRefusal, holder: null };
  }
  if (cls.k === "dead-other-vault") {
    return { act: "refuse", why: "other-vault-gate", holder: cls.vault, holderRun: cls.run };
  }
  return { act: "migrate", resume: false };
}

/** A start and its worker wait out a cooldown and a remembered wait; `o2b update` does not. */
function honoursCooldown(state: GateState): boolean {
  return state.asker === "start" || state.asker === "worker";
}

/**
 * A stopped migration run's gate on this vault, on the legacy layout: it
 * is resumed when the attempt may go on, and opened otherwise (rule 3).
 */
function recoverStoppedRun(state: GateState, gateRunId: string): GateDecision {
  if (state.payload === null || state.run === null) return GATHER;
  const record = state.record!;
  const run = state.run;
  // What cannot be gone on with: a run state that cannot be read (it could
  // be a rollback's), a gate an attempt already owes (it ended, and could
  // not open it), a failure the attempt already recorded (its cooldown
  // stands), a rolled-back machine, nothing left to move.
  if (run.phase === "unreadable") return { act: "open", why: "run-unreadable" };
  // Rule 10: a rollback that began here is never migrated over; the gate
  // is opened and the rollback's own command finishes it.
  if (state.rollback === null) return GATHER;
  if (rollbackRefusal(state) !== null) return { act: "open", why: "rolled-back" };
  if (honoursCooldown(state)) {
    if (record.owed) return { act: "open", why: "backoff" };
    if (record.kind === "failure" && record.cooling) return { act: "open", why: "backoff" };
  }
  if (run.phase === "rolled-back") return { act: "open", why: "rolled-back" };
  if (!state.payload) return { act: "open", why: "not-available" };
  if (state.setting) return { act: "migrate", resume: false };
  // Off: only the attempt's own run, which did not report how it ended (an
  // owed gate's attempt ended: it refused or waited, and is not resumed).
  if (
    record.kind === "attempt" &&
    !record.owed &&
    run.phase === "in-progress" &&
    run.runId === gateRunId
  ) {
    return { act: "migrate", resume: true };
  }
  return { act: "open", why: "disabled" };
}
