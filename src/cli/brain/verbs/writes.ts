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
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  if (sub === undefined || sub.startsWith("--") || sub === "list") {
    return listWrites(flags, json);
  }
  if (sub === "prune-images") {
    return pruneImages(flags, json);
  }
  return usageError(`unknown brain writes subcommand '${sub}' - expected list or prune-images`);
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
  return 0;
}
