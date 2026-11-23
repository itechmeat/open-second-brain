/**
 * The run of a dream session (change `dream-launched-agent`, design D2):
 * a device-local record the worker writes before it starts a session and
 * removes when the session ends. Its id and a random token, handed to
 * the session's server through the environment, are the credential the
 * three operations check; the record stores only that token's hash. Queue
 * lease tokens also live here until cleanup and are exposed only after
 * checking the run credential.
 *
 * `<device state>/dream/runs/<run>.json`, mode 0600, never synced. A
 * record past its expiry is refused and swept by the next run. Beside it,
 * `<run>.calls` holds one line per call of the session's server (the
 * tool and the outcome, no content): what the worker and the check read
 * to say what a session did.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "../../fs-atomic.ts";
import { withLocalLock } from "../../store/local-lock.ts";

/** Subdirectory of the device state directory holding the run records. */
export const DREAM_RUNS_DIR = join("dream", "runs");

export interface DreamRunRecord {
  readonly run: string;
  /** Hex sha256 of the token. */
  readonly token_sha256: string;
  /** The dream owner revision the run was created under. */
  readonly owner_revision: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** The operations the session may take. */
  readonly operations: ReadonlyArray<string>;
  /** Whether the session may take items of the private partition. */
  readonly private_allowed: boolean;
  /** Most items one session may take. */
  readonly item_budget: number;
  /** The name of the command the worker started: the agent its answers name. */
  readonly agent: string;
}

export interface DreamRunLease {
  readonly generation: number;
  readonly lease_token: string;
}

interface StoredDreamRun extends DreamRunRecord {
  readonly leases: Readonly<Record<string, DreamRunLease>>;
}

export type DreamRunCheck =
  | { readonly ok: true; readonly record: DreamRunRecord }
  | { readonly ok: false; readonly reason: string };

const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;

/** Whether `run` can name a run record (no path separators, bounded). */
export function isDreamRunId(run: string): boolean {
  return RUN_ID.test(run);
}

/** `<deviceStateDir>/dream/runs`. */
export function dreamRunsDir(deviceStateDir: string): string {
  return join(deviceStateDir, DREAM_RUNS_DIR);
}

function recordPath(deviceStateDir: string, run: string): string {
  return join(dreamRunsDir(deviceStateDir), `${run}.json`);
}

function callsPath(deviceStateDir: string, run: string): string {
  return join(dreamRunsDir(deviceStateDir), `${run}.calls`);
}

function lockPath(deviceStateDir: string, run: string): string {
  return recordPath(deviceStateDir, run);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Write a run record and return it with the token (shown once, never stored). */
export function createDreamRun(
  deviceStateDir: string,
  input: {
    readonly ownerRevision: string;
    readonly budgetMs: number;
    readonly operations: ReadonlyArray<string>;
    readonly privateAllowed: boolean;
    readonly itemBudget: number;
    readonly agent: string;
    readonly now?: number;
  },
): { readonly record: DreamRunRecord; readonly token: string } {
  const now = input.now ?? Date.now();
  sweepStaleDreamRuns(deviceStateDir, now);
  const run = randomUUID();
  const token = randomBytes(32).toString("hex");
  const record: DreamRunRecord = {
    run,
    token_sha256: sha256(token),
    owner_revision: input.ownerRevision,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + input.budgetMs).toISOString(),
    operations: [...input.operations],
    private_allowed: input.privateAllowed,
    item_budget: input.itemBudget,
    agent: input.agent,
  };
  const stored: StoredDreamRun = { ...record, leases: {} };
  const dir = dreamRunsDir(deviceStateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = recordPath(deviceStateDir, run);
  writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { record, token };
}

/** The run record of `run`, or `null` when there is none or it cannot be read. */
export function readDreamRun(deviceStateDir: string, run: string): DreamRunRecord | null {
  if (!isDreamRunId(run)) return null;
  try {
    return publicRecord(readStoredDreamRun(deviceStateDir, run));
  } catch {
    return null;
  }
}

function readStoredDreamRun(deviceStateDir: string, run: string): StoredDreamRun {
  const parsed = JSON.parse(readFileSync(recordPath(deviceStateDir, run), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid run record");
  const r = parsed as Record<string, unknown>;
  if (r["run"] !== run || typeof r["token_sha256"] !== "string") {
    throw new Error("invalid run record");
  }
  if (typeof r["owner_revision"] !== "string" || typeof r["expires_at"] !== "string") {
    throw new Error("invalid run record");
  }
  if (
    typeof r["created_at"] !== "string" ||
    !Array.isArray(r["operations"]) ||
    typeof r["private_allowed"] !== "boolean" ||
    typeof r["item_budget"] !== "number" ||
    typeof r["agent"] !== "string"
  ) {
    throw new Error("invalid run record");
  }
  const leases = r["leases"];
  if (typeof leases !== "object" || leases === null || Array.isArray(leases)) {
    throw new Error("invalid run record");
  }
  for (const lease of Object.values(leases)) {
    if (
      typeof lease !== "object" ||
      lease === null ||
      typeof lease["generation"] !== "number" ||
      !Number.isInteger(lease["generation"]) ||
      typeof lease["lease_token"] !== "string"
    ) {
      throw new Error("invalid run record");
    }
  }
  return parsed as StoredDreamRun;
}

function publicRecord(record: StoredDreamRun): DreamRunRecord {
  return {
    run: record.run,
    token_sha256: record.token_sha256,
    owner_revision: record.owner_revision,
    created_at: record.created_at,
    expires_at: record.expires_at,
    operations: [...record.operations],
    private_allowed: record.private_allowed,
    item_budget: record.item_budget,
    agent: record.agent,
  };
}

/** Serialize all changes made by processes serving one run. */
export function withDreamRunLock<T>(deviceStateDir: string, run: string, fn: () => T): T {
  if (!isDreamRunId(run)) throw new Error("invalid dream run id");
  return withLocalLock(lockPath(deviceStateDir, run), fn);
}

/** Run one operation with the run credential validated and private leases available. */
export function withAuthorizedDreamRun<T>(
  deviceStateDir: string,
  input: {
    readonly run: string;
    readonly token: string;
    readonly ownerRevision: string | null;
    readonly now?: number;
  },
  fn: (record: DreamRunRecord, leases: Map<string, DreamRunLease>) => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string } {
  if (!isDreamRunId(input.run)) return { ok: false, reason: "no such dream run on this device" };
  return withDreamRunLock(deviceStateDir, input.run, () => {
    const checked = checkDreamRun(deviceStateDir, input);
    if (!checked.ok) return checked;
    const stored = readStoredDreamRun(deviceStateDir, input.run);
    const leases = new Map(Object.entries(stored.leases));
    const before = new Map(leases);
    const value = fn(checked.record, leases);
    const changed =
      before.size !== leases.size ||
      [...before].some(([id, lease]) => {
        const next = leases.get(id);
        return next?.generation !== lease.generation || next?.lease_token !== lease.lease_token;
      });
    if (changed) {
      const updated: StoredDreamRun = { ...stored, leases: Object.fromEntries(leases) };
      atomicWriteText(
        recordPath(deviceStateDir, input.run),
        `${JSON.stringify(updated, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    return { ok: true, value };
  });
}

/**
 * Whether `run` and `token` name a live run of this device, created
 * under `ownerRevision`. Every refusal names why, never the token.
 */
export function checkDreamRun(
  deviceStateDir: string,
  input: {
    readonly run: string | undefined;
    readonly token: string | undefined;
    readonly ownerRevision: string | null;
    readonly now?: number;
  },
): DreamRunCheck {
  const now = input.now ?? Date.now();
  if (input.run === undefined || input.run === "" || input.token === undefined) {
    return { ok: false, reason: "no dream run: this server works only for a run the worker made" };
  }
  const record = readDreamRun(deviceStateDir, input.run);
  if (record === null) return { ok: false, reason: "no such dream run on this device" };
  const want = Buffer.from(record.token_sha256, "hex");
  const got = Buffer.from(sha256(input.token), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return { ok: false, reason: "the dream run's token does not match" };
  }
  if (Date.parse(record.expires_at) <= now) return { ok: false, reason: "the dream run expired" };
  if (input.ownerRevision === null || record.owner_revision !== input.ownerRevision) {
    return { ok: false, reason: "the dream owner changed since the run was made" };
  }
  return { ok: true, record };
}

/** Remove the run record of `run` and its call log. */
export function removeDreamRun(deviceStateDir: string, run: string): void {
  if (!isDreamRunId(run)) return;
  withDreamRunLock(deviceStateDir, run, () => removeDreamRunUnderLock(deviceStateDir, run));
}

/** Remove a run while its lock is already held. */
export function removeDreamRunUnderLock(deviceStateDir: string, run: string): void {
  if (!isDreamRunId(run)) return;
  rmSync(recordPath(deviceStateDir, run), { force: true });
  rmSync(callsPath(deviceStateDir, run), { force: true });
}

/** Remove every run record past its expiry (and one that cannot be read). Returns the ids. */
export function sweepStaleDreamRuns(deviceStateDir: string, now: number = Date.now()): string[] {
  const dir = dreamRunsDir(deviceStateDir);
  if (!existsSync(dir)) return [];
  const swept: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const run = name.slice(0, -".json".length);
    const record = readDreamRun(deviceStateDir, run);
    if (record !== null && Date.parse(record.expires_at) > now) continue;
    removeDreamRun(deviceStateDir, run);
    swept.push(run);
  }
  return swept;
}

/** One call of the session's server, as the call log keeps it. */
export interface DreamRunCall {
  readonly at: string;
  readonly tool: string;
  readonly outcome: string;
  /** The model an answer named (an answer's call only). */
  readonly model?: string;
}

/** Append one call to the run's call log (the tool and the outcome, no content). */
export function appendDreamRunCall(
  deviceStateDir: string,
  run: string,
  call: {
    readonly tool: string;
    readonly outcome: string;
    readonly model?: string;
    readonly now?: number;
  },
): void {
  if (!isDreamRunId(run)) return;
  withDreamRunLock(deviceStateDir, run, () =>
    appendDreamRunCallUnderLock(deviceStateDir, run, call),
  );
}

/** Append a call while the run lock is already held. */
export function appendDreamRunCallUnderLock(
  deviceStateDir: string,
  run: string,
  call: {
    readonly tool: string;
    readonly outcome: string;
    readonly model?: string;
    readonly now?: number;
  },
): void {
  if (!isDreamRunId(run) || !existsSync(recordPath(deviceStateDir, run))) return;
  const line: DreamRunCall = {
    at: new Date(call.now ?? Date.now()).toISOString(),
    tool: call.tool,
    outcome: call.outcome,
    ...(call.model !== undefined ? { model: call.model } : {}),
  };
  appendFileSync(callsPath(deviceStateDir, run), JSON.stringify(line) + "\n", { mode: 0o600 });
}

/** The calls the run's server logged, oldest first. */
export function readDreamRunCalls(deviceStateDir: string, run: string): DreamRunCall[] {
  if (!isDreamRunId(run)) return [];
  let text: string;
  try {
    text = readFileSync(callsPath(deviceStateDir, run), "utf8");
  } catch {
    return [];
  }
  const out: DreamRunCall[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as DreamRunCall);
    } catch {
      // A torn last line is skipped.
    }
  }
  return out;
}
