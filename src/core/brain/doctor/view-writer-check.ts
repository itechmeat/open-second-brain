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
import { readPartition } from "../../store/state-digest.ts";
import { inspectStore } from "../../store/store-open.ts";
import { partitionDir, resolveConfiguredStoreRoot } from "../../store/store-paths.ts";
import {
  VIEW_PASS_KIND,
  VIEW_RENDER_KIND,
  VIEW_WRITER_HERE_COMMAND,
  VIEW_WRITER_SILENCE_DAYS,
  VIEW_WRITER_SILENCE_MS,
} from "../../view/constants.ts";
import { foldViewWriter } from "../../view/writer-fold.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

/** The view writer has published nothing in the view for the silence window. */
export const VIEW_WRITER_SILENT_CODE = "view-writer-silent";

function sharedRecords(ctx: StoreSideCheckContext): ReadonlyArray<StoreRecord> | null {
  const root = resolveConfiguredStoreRoot(ctx.configPath);
  if (root.origin === "default" && !isDualWriteEnabled(ctx.configPath)) return null;
  const store = inspectStore(root.root);
  if (store === null || !store.partitions.has("shared")) return null;
  let complete = true;
  const shards = readPartition(partitionDir(store.root, "shared"), {
    onUnreadable: () => {
      complete = false;
    },
  });
  return complete ? prepareRecords(shards.flatMap((s) => s.records)).records : null;
}

export const viewWriterCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    let records: ReadonlyArray<StoreRecord> | null;
    try {
      records = sharedRecords(ctx);
    } catch {
      return; // the store section reports a root or store it cannot use
    }
    if (records === null) return;
    const state = foldViewWriter(records);
    if (state.writer === null || state.since === null) return;
    const writer = state.writer;
    const since = state.since;
    const published = records.findLast(
      (r) =>
        r.device === writer &&
        (r.kind === VIEW_RENDER_KIND || r.kind === VIEW_PASS_KIND) &&
        compareRecords(r, since) > 0,
    );
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
