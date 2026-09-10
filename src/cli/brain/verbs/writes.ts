import {
  NOTE_REVERT_ACTION,
  NoteRevertError,
  applyNoteRevert,
  planNoteRevert,
  type NoteRevertEntry,
  type NoteRevertSelector,
} from "../../../core/brain/notes/revert.ts";
import { listNoteWrites, type NoteWriteRecord } from "../../../core/brain/notes/write-log.ts";
import {
  NOTE_WRITE_OP,
  WRITE_IMAGE_RETENTION_DAYS,
  isNoteWriteOp,
  pruneWriteImages,
  type NoteWriteOp,
} from "../../../core/brain/notes/write-record.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
} from "../helpers.ts";

/**
 * `o2b brain writes` - the operator's view of who wrote what
 * (who-wrote-what, Task A / t_662f4e82).
 *
 * Subcommands:
 *   list          (default)  recorded note writes, newest first
 *   revert                   plan, and with --apply run, a per-agent undo
 *   prune-images             bound the before-image store by age
 *
 * `list` is the default because the question that brings an operator
 * here is "what has been written to my vault", and making them type the
 * subcommand to ask it would be a road sign pointing at itself.
 */
export async function cmdBrainWrites(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = sub === undefined || sub.startsWith("--") ? argv : argv.slice(1);
  const { flags } = parse(rest, {
    vault: { type: "string" },
    agent: { type: "string" },
    device: { type: "string" },
    path: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    op: { type: "string" },
    "older-than-days": { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "string" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  if (sub === undefined || sub.startsWith("--") || sub === "list") {
    return listWrites(flags, json);
  }
  if (sub === "revert") {
    return revert(flags, json);
  }
  if (sub === "prune-images") {
    return pruneImages(flags, json);
  }
  return usageError(
    `unknown brain writes subcommand '${sub}' - expected list, revert or prune-images`,
  );
}

/** Hex characters of each digest shown in the plain table. */
const DIGEST_PREVIEW_LENGTH = 8;

/** What the table prints where a fact is absent rather than empty. */
const ABSENT_COLUMN = "-";

function listWrites(
  flags: Record<string, string | boolean | string[] | undefined>,
  json: boolean,
): number {
  const rawOp = normalizeFlagString(flags["op"]);
  if (rawOp !== null && !isNoteWriteOp(rawOp)) {
    return usageError(
      `--op must be one of ${Object.values(NOTE_WRITE_OP).join("|")}, got '${rawOp}'`,
    );
  }
  const op: NoteWriteOp | null = rawOp;
  const { vault } = brainVerbContext(flags);
  const agent = normalizeFlagString(flags["agent"]);
  const device = normalizeFlagString(flags["device"]);
  const path = normalizeFlagString(flags["path"]);
  const since = normalizeFlagString(flags["since"]);
  const until = normalizeFlagString(flags["until"]);

  const result = listNoteWrites(vault, {
    ...(agent !== null ? { agent } : {}),
    ...(device !== null ? { device } : {}),
    ...(path !== null ? { path } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(op !== null ? { op } : {}),
  });

  if (json) {
    okJson({
      writes: result.writes.map((w) => ({ ...w })),
      count: result.writes.length,
      warnings: result.warnings.map((w) => ({
        path: w.path,
        line: w.lineNumber,
        message: w.message,
      })),
    });
    return 0;
  }

  if (result.writes.length === 0) {
    ok("no recorded note writes");
  } else {
    for (const write of result.writes) ok(renderRow(write));
  }
  // Warnings after the rows and never instead of them: a day whose log
  // lost a line still has the writes it kept, and hiding them would make
  // an incomplete list read as a complete one.
  for (const warning of result.warnings) {
    ok(`warning: ${warning.path}:${warning.lineNumber}: ${warning.message}`);
  }
  return 0;
}

/** One row: when, what, who, where, and the two ends of the content. */
function renderRow(write: NoteWriteRecord): string {
  const device = write.device === "" ? ABSENT_COLUMN : write.device;
  const before = write.hash_before.slice(0, DIGEST_PREVIEW_LENGTH);
  const after = write.hash_after.slice(0, DIGEST_PREVIEW_LENGTH);
  return [
    write.timestamp,
    write.op,
    write.agent === "" ? ABSENT_COLUMN : write.agent,
    device,
    write.target,
    `${before} -> ${after}`,
  ].join("  ");
}

function pruneImages(
  flags: Record<string, string | boolean | string[] | undefined>,
  json: boolean,
): number {
  const raw = normalizeFlagString(flags["older-than-days"]);
  let olderThanDays = WRITE_IMAGE_RETENTION_DAYS;
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 0) {
      return usageError(`--older-than-days must be a non-negative integer, got '${raw}'`);
    }
    olderThanDays = parsed;
  }
  const dryRun = flags["dry-run"] === true;
  const { vault } = brainVerbContext(flags);
  const result = pruneWriteImages(vault, { olderThanDays, dryRun });

  if (json) {
    okJson({
      removed: [...result.removed],
      removed_count: result.removed.length,
      kept: result.kept,
      skipped: [...result.skipped],
      skipped_count: result.skipped.length,
      dry_run: result.dry_run,
      older_than_days: olderThanDays,
    });
    return 0;
  }
  // The verb says what it DID, not what it was asked to do: a dry run
  // that printed "removed 3" would be the one sentence an operator would
  // act on and the one that was not true.
  const verb = result.dry_run ? "would remove" : "removed";
  ok(`${verb} ${result.removed.length} before-image(s) older than ${olderThanDays} day(s)`);
  ok(`kept ${result.kept}`);
  for (const sha of result.removed) ok(`- ${sha}`);
  // A name this store did not write is left where it is, and the only
  // pass anybody makes over the store is the one that has to say so -
  // otherwise a conflict copy sits there unbounded and unmentioned.
  if (result.skipped.length > 0) {
    ok(`skipped ${result.skipped.length} name(s) that are not before-images`);
    for (const name of result.skipped) ok(`? ${name}`);
  }
  return 0;
}

/**
 * `revert` - plan what undoing a selection of writes would do, and with
 * `--apply <digest>` do it.
 *
 * Two invocations rather than a confirmation prompt, because the digest
 * is what makes the second one refer to the first: an operator applies
 * the plan they read, and a vault that moved in between is refused
 * rather than re-planned silently. The plan itself is a REPORT and exits
 * 0 even when every target is refused - a revert that finds nothing safe
 * to undo answered the question it was asked. Only a selector this verb
 * will not accept, and an apply that cannot run, exit non-zero.
 */
function revert(
  flags: Record<string, string | boolean | string[] | undefined>,
  json: boolean,
): number {
  const selector: NoteRevertSelector = {
    ...selectorField(flags, "agent"),
    ...selectorField(flags, "device"),
    ...selectorField(flags, "path"),
    ...selectorField(flags, "since"),
    ...selectorField(flags, "until"),
  };
  const digest = normalizeFlagString(flags["apply"]);
  const { vault } = brainVerbContext(flags);

  try {
    return digest === null
      ? printPlan(vault, selector, json)
      : printApply(vault, selector, digest, json);
  } catch (err) {
    // The code first, then the sentence: an operator scripting around
    // this reads one token, and the rest of the line is for the human.
    if (err instanceof NoteRevertError) return fail(`${err.code}: ${err.message}`);
    throw err;
  }
}

/** One selector field, present only when the flag carried a value. */
function selectorField(
  flags: Record<string, string | boolean | string[] | undefined>,
  key: "agent" | "device" | "path" | "since" | "until",
): Partial<Record<typeof key, string>> {
  const value = normalizeFlagString(flags[key]);
  return value === null ? {} : { [key]: value };
}

/** The plan's own `--apply` line, so the digest never has to be retyped. */
function applyInvocation(selector: NoteRevertSelector, digest: string): string {
  const parts = ["o2b", "brain", "writes", "revert"];
  for (const [key, value] of Object.entries(selector)) parts.push(`--${key}`, String(value));
  parts.push("--apply", digest);
  return parts.join(" ");
}

/** One planned target: what, where, why not, how many writes, both digests. */
function renderEntry(entry: NoteRevertEntry): string {
  const now = entry.hash_now.slice(0, DIGEST_PREVIEW_LENGTH);
  const to = entry.hash_to.slice(0, DIGEST_PREVIEW_LENGTH);
  return [
    entry.action,
    entry.target,
    entry.reason ?? ABSENT_COLUMN,
    String(entry.writes.length),
    `${now} -> ${to}`,
  ].join("  ");
}

function printPlan(vault: string, selector: NoteRevertSelector, json: boolean): number {
  const plan = planNoteRevert(vault, selector);
  if (json) {
    okJson({
      selector: { ...plan.selector },
      entries: plan.entries.map((e) => ({ ...e })),
      digest: plan.digest,
      planned_at: plan.planned_at,
      warnings: plan.warnings.map((w) => ({
        path: w.path,
        line: w.lineNumber,
        message: w.message,
      })),
    });
    return 0;
  }

  if (plan.entries.length === 0) ok("no recorded note writes match this selector");
  for (const entry of plan.entries) ok(renderEntry(entry));
  // Warnings before the digest, because a day whose log lost a line is a
  // day whose write history is incomplete, and the digest below seals
  // exactly the plan that incomplete history produced.
  for (const warning of plan.warnings) {
    ok(`warning: ${warning.path}:${warning.lineNumber}: ${warning.message}`);
  }
  ok(`digest: ${plan.digest}`);
  ok(applyInvocation(plan.selector, plan.digest));
  return 0;
}

function printApply(
  vault: string,
  selector: NoteRevertSelector,
  digest: string,
  json: boolean,
): number {
  const result = applyNoteRevert(vault, selector, digest);
  if (json) {
    okJson({
      snapshot: { ...result.snapshot },
      applied: result.applied.map((e) => ({ ...e })),
      refused: result.refused.map((e) => ({ ...e })),
      failed: result.failed.map((f) => ({ ...f })),
      recorded: result.recorded.map((r) => ({ ...r })),
      recoverability: {
        state: result.recoverability.state,
        coverage: [...result.recoverability.coverage],
        blockers: [...result.recoverability.blockers],
      },
    });
    return 0;
  }

  ok(`snapshot: ${result.snapshot.run_id}`);
  for (const entry of result.applied) ok(`${entry.action}  ${entry.target}`);
  for (const entry of result.refused) {
    ok(`${NOTE_REVERT_ACTION.refuse}  ${entry.target}  ${entry.reason ?? ABSENT_COLUMN}`);
  }
  // A target the apply could not carry out is neither applied nor
  // refused, and a plan whose entry appears nowhere reads as a plan that
  // never contained it.
  for (const failure of result.failed) {
    ok(`failed  ${failure.target}  ${failure.reason}`);
  }
  // An unrecorded revert is a fact the operator is told, not one they
  // have to infer from a missing line in a later listing.
  for (const row of result.recorded) {
    if (row.write_id === null) ok(`warning: ${row.target}: ${row.audit_reason}`);
  }
  ok(`recoverability: ${result.recoverability.state}`);
  return 0;
}
