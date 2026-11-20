/**
 * The view writer section of the doctor (design D7, spec `human-view`
 * "Silent view writer"; task 2.7).
 *
 * Doctor on every machine reports a view writer that has published
 * nothing in the view for {@link VIEW_WRITER_SILENCE_DAYS} days: no render
 * record and no idle heartbeat (`view-pass`) since the later of its last
 * publication and the record that gave it the role. The view's pages then
 * go stale, though no data is lost, and the finding names the command that
 * moves the role to the machine it runs on.
 *
 * Silent like the store section when the store is not in use on this
 * machine (no store root configured and dual writes off), when no store
 * exists yet, when this machine does not hold the `shared` partition the
 * view writer records live in, when a shard of it cannot be read (a read
 * missing the writer's records would raise a false alarm), and when no
 * machine holds the role. Read-only.
 */

import { isDualWriteEnabled } from "../../store/dual-write.ts";
import { compareRecords, type StoreRecord } from "../../store/envelope.ts";
import { parseHlc } from "../../store/hlc.ts";
import { prepareRecords } from "../../store/fold.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { inspectStore } from "../../store/store-open.ts";
import { resolveConfiguredStoreRoot, shardMonth } from "../../store/store-paths.ts";
import {
  VIEW_PASS_KIND,
  VIEW_RENDER_KIND,
  VIEW_WRITER_HERE_COMMAND,
  VIEW_WRITER_SILENCE_DAYS,
  VIEW_WRITER_SILENCE_MS,
} from "../../view/constants.ts";
import { foldViewWriter, VIEW_WRITER_KINDS } from "../../view/writer-fold.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

/** The view writer has published nothing in the view for the silence window. */
export const VIEW_WRITER_SILENT_CODE = "view-writer-silent";

/**
 * What the check folds, read as the view reads it: the writer records of
 * the `settings` stream of `shared` (`catchUpSettings`), then only the
 * writer's own `log` shards from the month of its claim on, for its
 * renders and passes. A migrated store's `log` holds its whole history;
 * none of it but the writer's view records is kept, and no other device's
 * shard is read. `null` when there is no store to read or a shard the
 * answer depends on could not be read in full.
 */
function writerActivity(
  ctx: StoreSideCheckContext,
): { writer: string; since: StoreRecord; published: StoreRecord | undefined } | "none" | null {
  const root = resolveConfiguredStoreRoot(ctx.configPath);
  if (root.origin === "default" && !isDualWriteEnabled(ctx.configPath)) return null;
  const store = inspectStore(root.root);
  if (store === null || !store.partitions.has("shared")) return null;
  const settings = readStreamRecords(store.root, "shared", SETTINGS, {
    keep: (record) => VIEW_WRITER_KINDS.has(record.kind),
  });
  if (settings.unreadable.length > 0) return null;
  const state = foldViewWriter(prepareRecords(settings.records).records);
  if (state.writer === null || state.since === null) return "none";
  const writer = state.writer;
  const since = state.since;
  const fromMonth = shardMonth(parseHlc(since.hlc)!.physical);
  const log = readStreamRecords(store.root, "shared", LOG, {
    device: writer,
    month: (month) => month >= fromMonth,
    keep: (record) => record.kind === VIEW_RENDER_KIND || record.kind === VIEW_PASS_KIND,
  });
  if (log.unreadable.length > 0) return null;
  const published = prepareRecords(log.records).records.findLast(
    (r) => r.device === writer && compareRecords(r, since) > 0,
  );
  return { writer, since, published };
}

const SETTINGS = { stream: "settings" } as const;
const LOG = { stream: "log" } as const;

export const viewWriterCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    let activity: ReturnType<typeof writerActivity>;
    try {
      activity = writerActivity(ctx);
    } catch {
      return; // the store section reports a root or store it cannot use
    }
    if (activity === null || activity === "none") return;
    const { writer, since, published } = activity;
    const lastMs = parseHlc((published ?? since).hlc)!.physical;
    if (ctx.now.getTime() - lastMs <= VIEW_WRITER_SILENCE_MS) return;
    out.issues.push({
      severity: "warning",
      code: VIEW_WRITER_SILENT_CODE,
      message:
        `the view writer ${writer} has published nothing in the human view since ` +
        `${new Date(lastMs).toISOString()} (more than ${VIEW_WRITER_SILENCE_DAYS} days), so the ` +
        "view pages are going stale; no data is lost. If that machine should no longer render " +
        `the view, run \`${VIEW_WRITER_HERE_COMMAND}\` on the one that should (add --force when ` +
        `${writer} is unreachable)`,
    } satisfies DoctorIssue);
  },
};
