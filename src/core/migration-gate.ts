/**
 * The device-local migration gate (design D11 step 2). While a brain
 * store migration runs on this machine, the gate file in the device-local
 * state (`<state base>/open-second-brain/migration-gate.json`, never
 * synced) names the vault it migrates, and every writer of that vault on
 * this machine refuses with a migration-in-progress message
 * ({@link assertNoMigrationInProgress}, called from the vault-identity
 * write guard every writer passes, on both of its lanes: the audit lane a
 * freeze lets through is a write into the legacy tree like any other).
 * The rollback of a migration and the removal of the legacy tree hold the
 * same gate, so they refuse the same writers.
 *
 * The run holding the gate makes writes of its own into the tree it
 * migrates (its snapshot and the snapshot's log line); it makes them inside
 * {@link asMigrationGateHolder}, which lets through only the process that
 * holds the gate, and only for the call it wraps.
 *
 * It replaces the vault freeze marker for the migration because that
 * marker syncs: other machines keep writing during a migration here, and
 * their writes reach the store through the delta pass and the transition
 * import.
 *
 * The gate is one small JSON file, read once per content write (a missing
 * file is one failed open). Vaults are compared by their real path, case
 * folded on Windows, so a writer reaching the vault by another spelling
 * (a link, a junction, another drive-letter case) is refused too.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicWriteFileSync, sleepSync } from "./fs-atomic.ts";
import { processDirsEnv, stateRootDir, type PlatformDirsEnv } from "./platform-dirs.ts";
import { gateHolderLiveness, type HolderJudge } from "./store-migration/holder-liveness.ts";

/** What the gate file holds. */
export interface MigrationGate {
  /** Resolved path of the vault being migrated. */
  readonly vault: string;
  readonly run_id: string;
  readonly since: string;
  /** Process id of the run holding the gate. */
  readonly pid: number;
  /**
   * The start identity of that process (`store-migration/process-identity.ts`),
   * so a pid reused by an unrelated process is told apart from the holder.
   * Absent in a gate written by an older release.
   */
  readonly started?: string;
}

const GATE_FILE = "migration-gate.json";

/** The progress the run holding the gate last reported, beside the gate. */
const PROGRESS_FILE = "migration-gate-progress.json";

/** The command that continues an interrupted migration, which also lifts the gate. */
export const MIGRATION_GATE_NEXT_COMMAND = "o2b brain migrate-store --resume";

/** The command that continues an interrupted rollback of a migration. */
export const ROLLBACK_GATE_NEXT_COMMAND = "o2b brain migrate-store --rollback";

/** The command that continues an interrupted removal of the legacy tree. */
export const REMOVAL_GATE_NEXT_COMMAND = "o2b brain migrate-store --remove-legacy";

/** Which run holds the gate, read off its run id. */
export const GATE_RUN_KIND = Object.freeze({
  migration: "migration",
  rollback: "rollback",
  removal: "removal",
  unknown: "unknown",
} as const);

export type GateRunKind = (typeof GATE_RUN_KIND)[keyof typeof GATE_RUN_KIND];

/** The run kind of a gate: `migrate-`, `rollback-` or `remove-legacy-` run ids. */
export function gateRunKind(gate: MigrationGate): GateRunKind {
  if (gate.run_id.startsWith("migrate-")) return GATE_RUN_KIND.migration;
  if (gate.run_id.startsWith("rollback-")) return GATE_RUN_KIND.rollback;
  if (gate.run_id.startsWith("remove-legacy-")) return GATE_RUN_KIND.removal;
  return GATE_RUN_KIND.unknown;
}

const RUN_NAME: Readonly<Record<GateRunKind, string>> = Object.freeze({
  migration: "a brain store migration of this vault",
  rollback: "the rollback of the brain store migration of this vault",
  removal: "the removal of this vault's legacy brain tree",
  unknown: "a brain store migration of this vault",
});

const RUN_COMMAND: Readonly<Record<GateRunKind, string>> = Object.freeze({
  migration: MIGRATION_GATE_NEXT_COMMAND,
  rollback: ROLLBACK_GATE_NEXT_COMMAND,
  removal: REMOVAL_GATE_NEXT_COMMAND,
  unknown: MIGRATION_GATE_NEXT_COMMAND,
});

/**
 * What a caller refused by the gate can do about it: `later` while the run
 * holding it may still be running (it lifts the gate when it ends), and
 * `recover` once its holder is gone (nothing lifts it until the run is
 * continued: the next start for an automatic migration, or the command).
 */
export const GATE_RETRY = Object.freeze({
  later: "later",
  recover: "recover",
} as const);

export type GateRetry = (typeof GATE_RETRY)[keyof typeof GATE_RETRY];

/**
 * What is known of the process holding the gate, by the one judgement every
 * reader of the gate uses (`gateHolderLiveness`, exact): `running` when its
 * pid is alive and its start identity is the recorded one, `unknown` when the
 * pid is alive but no identity was recorded or none can be read now (it may
 * be the run, or a process that reused its pid), `stopped` when the pid is
 * gone or now belongs to another process.
 */
export const GATE_HOLDER = Object.freeze({
  running: "running",
  unknown: "unknown",
  stopped: "stopped",
} as const);

export type GateHolder = (typeof GATE_HOLDER)[keyof typeof GATE_HOLDER];

/** The operator's remedy for a gate no run will open. */
export const FORCE_RELEASE_GATE_COMMAND = "o2b brain migrate-store --force-release-gate";

/** A gate file that is there and is no gate: `damaged` (read, not a gate) or `unreadable`. */
export interface GateFault {
  readonly kind: "damaged" | "unreadable";
  readonly path: string;
  /** The read error's code, for an unreadable gate. */
  readonly code?: string;
}

/** A write refused because a migration of its vault holds this machine's gate. */
export class MigrationInProgressError extends Error {
  override readonly name = "MigrationInProgressError";
  /** What to run, or null when the remedy is not a command (an unreadable gate). */
  readonly next_command: string | null;
  readonly kind: GateRunKind;
  readonly holder: GateHolder;
  readonly retry: GateRetry;
  /** The progress the run last reported, or null when none can be read. */
  readonly progress: string | null;
  /** Set when the gate file is damaged or cannot be read. */
  readonly fault: GateFault | null;
  constructor(
    readonly gate: MigrationGate,
    facts: {
      readonly holder?: GateHolder;
      readonly progress?: string | null;
      readonly fault?: GateFault;
    } = {},
  ) {
    const kind = gateRunKind(gate);
    const holder = facts.holder ?? GATE_HOLDER.unknown;
    const progress = facts.progress ?? null;
    const fault = facts.fault ?? null;
    const since = gate.since === "" ? "an unknown time" : gate.since;
    const command = RUN_COMMAND[kind];
    const running =
      `${RUN_NAME[kind]} holds this machine's migration gate (run ${gate.run_id}, since ${since}` +
      `${progress === null ? "" : `, ${progress}`})`;
    let what: string;
    let remedy: string;
    let next: string | null = command;
    let retry: GateRetry = GATE_RETRY.later;
    if (fault?.kind === "unreadable") {
      what =
        `this machine's migration gate ${fault.path} cannot be read (${fault.code ?? "EIO"}), ` +
        "so a brain store migration of any vault may hold it";
      remedy =
        "Writes stay refused until it can be read: fix its permissions, or remove the file " +
        "if no migration is running";
      next = null;
      retry = GATE_RETRY.recover;
    } else if (fault?.kind === "damaged") {
      what =
        `this machine's migration gate ${fault.path} is damaged (it does not read as a gate), ` +
        "so a brain store migration of any vault may hold it";
      remedy = `Writes stay refused until it is gone: if no migration is running, run \`${FORCE_RELEASE_GATE_COMMAND}\``;
      next = FORCE_RELEASE_GATE_COMMAND;
      retry = GATE_RETRY.recover;
    } else if (holder === GATE_HOLDER.stopped) {
      what =
        `${RUN_NAME[kind]} (run ${gate.run_id}, started ${since}) stopped without ` +
        `finishing: its process ${gate.pid} is gone and the run still holds this ` +
        "machine's migration gate";
      remedy =
        "Writes stay refused until the run is continued: the next start of Open Second " +
        `Brain does that for an automatic migration, or run \`${command}\``;
      retry = GATE_RETRY.recover;
    } else if (holder === GATE_HOLDER.unknown) {
      what =
        `${running}; its process ${gate.pid} is alive, but whether it is the run's own ` +
        "process cannot be told";
      remedy =
        "Try again when it has finished; if no migration is running, " +
        `\`${FORCE_RELEASE_GATE_COMMAND}\` opens the gate`;
      // Its process is alive: continuing the run is not the remedy, and
      // forcing the gate open under a live run is not one to suggest.
      next = null;
    } else {
      what =
        `${RUN_NAME[kind]} is running on this machine (run ${gate.run_id}, since ${since}` +
        `${progress === null ? "" : `, ${progress}`})`;
      remedy = "Try again when it has finished";
      // A live run: waiting is the remedy. `--resume` is the command of a
      // stopped run only; beside a live one it is refused.
      next = null;
    }
    super(`${what}; the write was refused and nothing was written. ${remedy}`);
    this.kind = kind;
    this.holder = holder;
    this.progress = progress;
    this.fault = fault;
    this.retry = retry;
    this.next_command = next;
  }
}

export function migrationGatePath(source: PlatformDirsEnv = processDirsEnv()): string {
  return join(stateRootDir(source), GATE_FILE);
}

/**
 * The form two spellings of one vault share: its real path (links and
 * junctions resolved), case folded on Windows, where `C:\Vault` and
 * `c:\vault` are one folder. A path that cannot be resolved keeps its
 * resolved spelling.
 */
export function canonicalVault(vault: string): string {
  resolveCount++;
  let path: string;
  try {
    path = realpathSync(vault);
  } catch {
    path = resolve(vault);
  }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** How many vault spellings {@link canonicalVault} resolved, process wide (for the cache test). */
let resolveCount = 0;

export function migrationGateResolveCount(): number {
  return resolveCount;
}

/** How many vault spellings were stat'ed for the cached comparison, process wide. */
let statCount = 0;

export function migrationGateStatCount(): number {
  return statCount;
}

/** Whether the gate names `vault`, however either was spelled. */
function gateNames(gate: MigrationGate, vault: string): boolean {
  return canonicalVault(gate.vault) === canonicalVault(vault);
}

/**
 * What the gate file says: no gate, a gate, a damaged gate (it was read
 * but is not a gate: the migration is its remedy), or a gate that exists
 * and could not be read even after a few short retries (a sharing
 * violation while another run rewrites it: it may be live, so it is never
 * taken over or released on that read).
 */
export type MigrationGateState =
  | { readonly kind: "none" }
  | { readonly kind: "held"; readonly gate: MigrationGate }
  | { readonly kind: "damaged" }
  | { readonly kind: "unreadable"; readonly code: string };

/** Attempts and pause of a gate read that hits an I/O failure. */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 25;

/** Read and classify the gate file (see {@link MigrationGateState}). */
export function readMigrationGateState(source?: PlatformDirsEnv): MigrationGateState {
  return readGate(source).state;
}

/** The gate file's state and, when it was read, its text. */
function readGate(source?: PlatformDirsEnv): {
  readonly state: MigrationGateState;
  readonly text: string | null;
} {
  const state = readGateState(source);
  return { state: state.state, text: state.text };
}

function readGateState(source?: PlatformDirsEnv): {
  state: MigrationGateState;
  text: string | null;
} {
  const path = migrationGatePath(source);
  let text: string | null = null;
  let code = "";
  for (let attempt = 0; attempt < READ_ATTEMPTS && text === null; attempt++) {
    if (attempt > 0) sleepSync(READ_RETRY_MS);
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      // Released between a check and the read, or never held: not held.
      code = String((err as NodeJS.ErrnoException).code ?? "EIO");
      if (code === "ENOENT") return { state: { kind: "none" }, text: null };
    }
  }
  if (text === null) return { state: { kind: "unreadable", code }, text: null };
  try {
    const parsed = JSON.parse(text) as Partial<MigrationGate>;
    // An empty vault names nothing to compare: it is damaged, and refuses
    // every vault like any other gate that does not read as one.
    if (
      typeof parsed.vault === "string" &&
      parsed.vault !== "" &&
      typeof parsed.run_id === "string"
    ) {
      const held: MigrationGateState = {
        kind: "held",
        gate: {
          vault: parsed.vault,
          run_id: parsed.run_id,
          since: typeof parsed.since === "string" ? parsed.since : "",
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          ...(typeof parsed.started === "string" ? { started: parsed.started } : {}),
        },
      };
      return { state: held, text };
    }
  } catch {
    // fall through: not a gate
  }
  return { state: { kind: "damaged" }, text };
}

/** The gate, or null when no migration holds it (an unreadable gate counts as held). */
export function readMigrationGate(source?: PlatformDirsEnv): MigrationGate | null {
  const state = readMigrationGateState(source);
  if (state.kind === "none") return null;
  return state.kind === "held" ? state.gate : UNREADABLE_GATE;
}

const UNREADABLE_GATE: MigrationGate = Object.freeze({
  vault: "",
  run_id: "unknown",
  since: "",
  pid: 0,
});

/** A migration asked for the gate while a migration of another vault holds it. */
export class MigrationGateHeldError extends Error {
  override readonly name = "MigrationGateHeldError";
  /** With `readError`, the gate file exists and could not be read (that code). */
  constructor(
    readonly gate: MigrationGate,
    readError?: string,
  ) {
    super(
      readError === undefined
        ? `another brain store migration holds this machine's migration gate (run ${gate.run_id}, ` +
            `since ${gate.since}); let it finish, or resume it with \`${MIGRATION_GATE_NEXT_COMMAND}\``
        : `this machine's migration gate ${migrationGatePath()} cannot be read (${readError}); ` +
            "nothing was changed. Try again in a moment",
    );
  }
}

/**
 * Hold the gate for `vault` and run `runId`, recording `started`, the start
 * identity of this process, when it is known. A gate already held for the
 * same vault is taken over (a resumed run, or the rollback of an
 * interrupted one, re-holds what the last run left); a gate held for
 * another vault is refused with a {@link MigrationGateHeldError}, so one
 * run never lifts another's protection. A damaged gate is replaced: the
 * migration is its remedy. A gate that cannot be read at all is refused
 * too: it may be another run's live gate.
 */
export function holdMigrationGate(
  vault: string,
  runId: string,
  started: string | null = null,
): void {
  const state = readMigrationGateState();
  if (state.kind === "unreadable") throw new MigrationGateHeldError(UNREADABLE_GATE, state.code);
  if (state.kind === "held" && !gateNames(state.gate, vault)) {
    throw new MigrationGateHeldError(state.gate);
  }
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  const gate: MigrationGate = {
    vault: resolve(vault),
    run_id: runId,
    since: new Date().toISOString(),
    pid: process.pid,
    ...(started === null ? {} : { started }),
  };
  atomicWriteFileSync(path, `${JSON.stringify(gate, null, 2)}\n`);
}

/**
 * Release the gate when it is held for `vault` by the run `runId`: a run
 * removes only its own gate, never one a later run took over. A damaged
 * gate is released by any run on any vault; a gate that cannot be read is
 * left in place (it may be another run's live gate).
 */
export function releaseMigrationGate(vault: string, runId: string): void {
  const state = readMigrationGateState();
  if (state.kind === "none" || state.kind === "unreadable") return;
  if (state.kind === "held" && (!gateNames(state.gate, vault) || state.gate.run_id !== runId)) {
    return;
  }
  try {
    unlinkSync(migrationGatePath());
  } catch {
    // already gone
  }
  try {
    unlinkSync(progressPath());
  } catch {
    // never reported, or already gone
  }
}

function progressPath(source: PlatformDirsEnv = processDirsEnv()): string {
  return join(stateRootDir(source), PROGRESS_FILE);
}

/** How far the run holding the gate is: its step, and its import's counts once known. */
export interface MigrationGateProgress {
  readonly run_id: string;
  /** A few words ("backed up, importing the legacy tree"). */
  readonly progress: string;
  /** Items in the run's journal, once its import began. */
  readonly journaled?: number;
  /** Record items its dry run planned, once its import began. */
  readonly planned?: number;
}

/**
 * Record how far the run `runId` holding the gate is: its step in a few
 * words, and, once its import began, how many items it journaled of how
 * many it planned. The one progress file of a run, read by the writers
 * the gate refuses, the status block and the doctor
 * ({@link readMigrationGateProgress}). Best effort: a progress that cannot
 * be written only leaves them without it.
 */
export function recordMigrationGateProgress(
  runId: string,
  progress: string,
  counts?: { readonly journaled: number; readonly planned: number },
): void {
  try {
    const path = progressPath();
    mkdirSync(dirname(path), { recursive: true });
    const body: MigrationGateProgress = { run_id: runId, progress, ...counts };
    atomicWriteFileSync(path, `${JSON.stringify(body)}\n`);
  } catch {
    // the refusal is still made, only without the progress
  }
}

/**
 * The progress the run `runId` last recorded, or null (none, another
 * run's, unreadable). The one reader of the progress file.
 */
export function readMigrationGateProgress(runId: string): MigrationGateProgress | null {
  try {
    const parsed = JSON.parse(readFileSync(progressPath(), "utf8")) as Record<string, unknown>;
    if (parsed["run_id"] !== runId || typeof parsed["progress"] !== "string") return null;
    const journaled = parsed["journaled"];
    const planned = parsed["planned"];
    const counted = Number.isInteger(journaled) && Number.isInteger(planned);
    return {
      run_id: runId,
      progress: parsed["progress"],
      ...(counted ? { journaled: journaled as number, planned: planned as number } : {}),
    };
  } catch {
    return null;
  }
}

/** "N of about M legacy items imported so far", for a report sentence. */
export function describeImportCounts(p: {
  readonly journaled: number;
  readonly planned: number;
}): string {
  return `${p.journaled} of about ${Math.max(p.planned, p.journaled)} legacy items imported so far`;
}

/** A run's progress as a refusal or a report says it: the step, then the counts when known. */
export function describeMigrationGateProgress(p: MigrationGateProgress): string {
  return p.journaled !== undefined && p.planned !== undefined
    ? `${p.progress}, ${describeImportCounts({ journaled: p.journaled, planned: p.planned })}`
    : p.progress;
}

/** The progress the gate's run last recorded, as the refusal says it, or null. */
function readGateProgress(gate: MigrationGate): string | null {
  const p = readMigrationGateProgress(gate.run_id);
  return p === null ? null : describeMigrationGateProgress(p);
}

/**
 * The vault whose gate the current call is the holder of
 * ({@link asMigrationGateHolder}), canonical, or null outside such a call.
 */
let holderScope: string | null = null;

/**
 * Run `fn` as the run holding the gate on `vault`: the writes it makes into
 * `vault` pass the gate, when this process is the one the gate names. The
 * run's own writes into the tree it migrates (its snapshot and the
 * snapshot's log line) are made this way; nothing else is, so a writer this
 * process calls outside `fn` is refused like any other.
 */
export function asMigrationGateHolder<T>(vault: string, fn: () => T): T {
  const previous = holderScope;
  holderScope = canonicalVault(vault);
  try {
    return fn();
  } finally {
    holderScope = previous;
  }
}

/**
 * Refuse a write to a destination the caller named (an export's `--out`, a
 * config export's `--output`) when it lies inside the vault a held gate
 * names, compared the way the gate compares vaults (real paths, case folded
 * on Windows; a destination that does not exist yet is judged by its
 * nearest existing ancestor). A destination anywhere else is left alone, as
 * before; so is any destination under a gate that names no vault (damaged
 * or unreadable): which vault it would be inside cannot be told.
 */
export function assertDestinationOutsideGatedVault(destination: string): void {
  const { state } = readGate();
  if (state.kind !== "held") return;
  const vault = canonicalVault(state.gate.vault);
  const rel = relative(vault, canonicalDestination(destination));
  // Whole components: "..notes" is a folder inside, ".." and "../x" are not.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  assertNoMigrationInProgress(state.gate.vault);
}

/** `destination` resolved through its nearest existing ancestor, case folded on Windows. */
function canonicalDestination(destination: string): string {
  let head = resolve(destination);
  const tail: string[] = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync(head);
      const joined = tail.length === 0 ? real : join(real, ...tail.toReversed());
      return process.platform === "win32" ? joined.toLowerCase() : joined;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      tail.push(basename(head));
      head = parent;
    }
  }
  const fallback = resolve(destination);
  return process.platform === "win32" ? fallback.toLowerCase() : fallback;
}

/**
 * Whether a write to `vault` would be refused by the gate right now
 * ({@link assertNoMigrationInProgress} without the throw): for a reader
 * that would otherwise create or refresh a file it does not need, so it
 * can leave the tree alone instead.
 */
export function migrationGateRefuses(vault: string): boolean {
  // A yes or no only: no message is built, so no holder is judged (a start
  // that asks this never queries a process identity).
  return gatedFor(vault) !== null;
}

/**
 * Refuse a write to `vault` while a migration of it, its rollback or the
 * removal of its legacy tree holds this machine's gate, whether that run is
 * still running or stopped with the gate closed. An unreadable gate refuses
 * every vault (fails closed). Only the holder's own writes, inside
 * {@link asMigrationGateHolder}, pass.
 */
export function assertNoMigrationInProgress(vault: string): void {
  const refusal = migrationGateRefusal(vault);
  if (refusal === null) return;
  const recorder = REFUSALS.getStore();
  if (recorder !== undefined && recorder.refused === null) recorder.refused = refusal;
  throw refusal;
}

/**
 * The refusal a write to `vault` would meet right now, or null when the gate
 * lets it through ({@link assertNoMigrationInProgress} without the throw),
 * for a writer that degrades instead of failing and says why.
 */
export function migrationGateRefusal(vault: string): MigrationInProgressError | null {
  const gated = gatedFor(vault);
  if (gated === null) return null;
  if ("fault" in gated) return new MigrationInProgressError(UNREADABLE_GATE, gated);
  // The refusal path only: what the run's holder and progress are.
  return new MigrationInProgressError(gated.gate, {
    holder: refusalHolder(gated.gate),
    progress: readGateProgress(gated.gate),
  });
}

/** Why a write to `vault` is refused (the gate, or a gate file fault), or null. */
function gatedFor(
  vault: string,
): { readonly gate: MigrationGate } | { readonly fault: GateFault } | null {
  const { state, text } = readGate();
  if (state.kind === "none") return null;
  if (state.kind !== "held") {
    return {
      fault: {
        kind: state.kind,
        path: migrationGatePath(),
        ...(state.kind === "unreadable" ? { code: state.code } : {}),
      },
    };
  }
  const gate = state.gate;
  if (!gateNamesCached(text ?? "", gate, vault)) return null;
  if (holderScope !== null && holderScope === canonicalVault(gate.vault)) {
    if (gate.pid === process.pid) return null;
  }
  return { gate };
}

/**
 * Whether the gate names `vault`, cached per gate text and vault spelling: a
 * pass of thousands of writes beside another vault's gate resolves the two
 * spellings once. The gate's bytes are the key, so a gate that changes (held
 * for another vault, taken over, released and held again) is a new key and
 * never answers from an older one.
 */
const NAMES = new Map<string, boolean>();
const NAMES_LIMIT = 64;

function gateNamesCached(text: string, gate: MigrationGate, vault: string): boolean {
  // What each spelling points at now (device and inode, one stat each): a
  // link retargeted between two writes is a new key, never the old answer.
  const key = `${text}\u0000${vault}\u0000${fsIdentity(gate.vault)}\u0000${fsIdentity(vault)}`;
  const known = NAMES.get(key);
  if (known !== undefined) return known;
  const answer = gateNames(gate, vault);
  if (NAMES.size >= NAMES_LIMIT) NAMES.clear();
  NAMES.set(key, answer);
  return answer;
}

/** The file system identity a path resolves to, or "missing". */
function fsIdentity(path: string): string {
  statCount++;
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? "missing" : `${stat.dev}:${stat.ino}`;
  } catch {
    return "unreadable";
  }
}

/**
 * The holder as the refusal reports it: the exact judgement (start identity
 * included) every reader of the gate uses, kept for a few seconds per pid
 * and identity, so a hook or a pass refused many times queries the identity
 * once.
 */
const HOLDER_TTL_MS = 5000;
const HOLDERS = new Map<string, { readonly at: number; readonly holder: GateHolder }>();

/**
 * How the refusals inside a call judge the holder: `exact` by default; a
 * path that must never run a process-identity query (a session or server
 * start, the runtime notices) runs inside {@link withGateJudge}("cheap"),
 * where a live pid reads as `unknown` - the same judgement those paths
 * already make of the gate themselves.
 */
const JUDGE = new AsyncLocalStorage<HolderJudge>();

export function withGateJudge<T>(judge: HolderJudge, fn: () => T): T {
  return JUDGE.run(judge, fn);
}

function refusalHolder(gate: MigrationGate): GateHolder {
  const judge = JUDGE.getStore() ?? "exact";
  const key = `${judge}:${gate.pid}:${gate.started ?? ""}`;
  const now = Date.now();
  const known = HOLDERS.get(key);
  if (known !== undefined && now - known.at >= 0 && now - known.at < HOLDER_TTL_MS) {
    return known.holder;
  }
  const liveness = gateHolderLiveness(gate, judge);
  const holder =
    liveness === "alive"
      ? GATE_HOLDER.running
      : liveness === "dead"
        ? GATE_HOLDER.stopped
        : GATE_HOLDER.unknown;
  if (HOLDERS.size >= NAMES_LIMIT) HOLDERS.clear();
  HOLDERS.set(key, { at: now, holder });
  return holder;
}

/**
 * The first refusal of the gate met inside {@link recordMigrationRefusals},
 * however the code between the refusal and the caller reported it.
 */
export interface MigrationRefusalRecorder {
  refused: MigrationInProgressError | null;
}

const REFUSALS = new AsyncLocalStorage<MigrationRefusalRecorder>();

/**
 * Run `fn` recording the first refusal of the gate it meets, for a caller
 * that answers with a structured refusal (the MCP dispatch): a handler that
 * catches the error and throws its own (an internal error carrying the
 * message) still failed because of the gate, and the recorder says so.
 */
export function recordMigrationRefusals<T>(recorder: MigrationRefusalRecorder, fn: () => T): T {
  return REFUSALS.run(recorder, fn);
}
