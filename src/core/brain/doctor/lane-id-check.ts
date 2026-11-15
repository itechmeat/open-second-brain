/**
 * The doctor finding for lane entry ids an earlier release filed under
 * another path's id (task 3.9, design D15 item 1): a migrated page
 * `x.json.md` whose record sits under `x.json`. A store-only dream pass on
 * a machine that holds `private` repairs them
 * (`store-migration/lane-id-repair.ts`); a machine without `private` never
 * runs the repair, since a file's own record there may be invisible to it,
 * so on a store where no machine holds `private` the ids stay mis-filed
 * until one does. The finding names them on every machine, with what to
 * run. Read-only.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_ROOT_REL } from "../path-constants.ts";
import {
  brainRelOfEntry,
  laneFolderRivals,
  lanePlaceOf,
  normalizedFolderPlace,
} from "../../store/lane-paths.ts";
import { configuredStore } from "../../store/read/store-entities.ts";
import { misfiledLaneIds } from "../../store-migration/lane-id-repair.ts";
import { TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import { withholdsPrivate } from "./store-check.ts";
import { pushUncertain } from "./uncertain-stream.ts";
import type {
  DoctorCheck,
  DoctorCheckContext,
  DoctorFindings,
  StoreSideCheckContext,
  StoreSideDoctorCheck,
} from "./check.ts";

/** Lane entries filed under the id of another path. */
export const LANE_ID_MISFILED_CODE = "lane-id-misfiled";

/** How many mis-filed entries the message names. */
const NAMED = 5;

export const laneIdMisfiledCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    // Below local reach only the repairs no record of the `private`
    // partition takes part in are named and counted.
    // And only the pages the caller may read, by both paths they answer to.
    const readable = ctx.readable;
    const pathOf = (key: string): string => {
      const [lane, ...rest] = key.split("/");
      return `${BRAIN_ROOT_REL}/${brainRelOfEntry(lane!, rest.join("/"))}`;
    };
    const misfiled = misfiledLaneIds(ctx.configPath, {
      sharedOnly: withholdsPrivate(ctx),
    }).filter(
      (r) => readable === undefined || (readable(pathOf(r.from)) && readable(pathOf(r.to))),
    );
    if (misfiled.length === 0) return;
    const store = configuredStore(ctx.configPath);
    const named = misfiled
      .slice(0, NAMED)
      .map((r) => `${r.from} (its own id is ${r.to})`)
      .join(", ");
    const more = misfiled.length > NAMED ? `, and ${misfiled.length - NAMED} more` : "";
    // Below local reach one remedy for every machine: which partitions this
    // machine holds is not the caller's to learn.
    const remedy = withholdsPrivate(ctx)
      ? "run `o2b brain dream` on a machine that holds every partition, or run `brain_doctor` " +
        "locally for the exact remedy"
      : store?.partitions.has("private") === true
        ? "the next `o2b brain dream` on this machine repairs them"
        : "this machine does not hold the private partition, so it does not repair them: run " +
          "`o2b brain dream` on a machine that holds it, or, when no machine does, add it on one " +
          "with `o2b store init --partitions shared,private` and run `o2b brain dream` there";
    out.issues.push({
      severity: "warning",
      code: LANE_ID_MISFILED_CODE,
      path: store?.root ?? "",
      message:
        `${misfiled.length} lane page(s) an earlier release imported are filed under the id of ` +
        `another path, so no path reads them: ${named}${more}. ${remedy}`,
    });
  },
};

/** Top folders of the legacy tree whose pages the migration cannot import. */
export const LANE_FOLDER_UNIMPORTABLE_CODE = "lane-folder-unimportable";

/**
 * The top folders of a vault's legacy `Brain/` tree whose pages no lane
 * takes (task 3.9): a folder whose name maps to no lane of its own (the
 * root lane, another folder's lane, no lane name at all), or one whose
 * lane another folder of the tree takes too (`My Notes/` beside
 * `my-notes/`). The migration lists their pages as items it could not
 * convert and archives them; renaming the folder before migrating keeps
 * them. A folder spelled otherwise than its lane with no rival is
 * imported under its lane, so it is not named. Read-only.
 */
export const laneFolderCollisionCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const brain = join(ctx.vault, BRAIN_ROOT_REL);
    let folders: string[];
    try {
      folders = readdirSync(brain, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
    } catch {
      return;
    }
    const named: string[] = [];
    for (const folder of folders) {
      // A probe page: only the folder's name decides.
      if (lanePlaceOf(`${folder}/probe.md`) !== null) continue;
      const place = normalizedFolderPlace(`${folder}/probe.md`);
      if (place === null) {
        named.push(`${folder} (its name is no lane of its own)`);
        continue;
      }
      const rivals = laneFolderRivals(folders, folder, place.lane);
      if (rivals.length > 0)
        named.push(`${folder} (lane ${place.lane}, also ${rivals.join(", ")})`);
    }
    if (named.length === 0) return;
    // Folder names of the vault, and how many: a local-reach fact. Below
    // local reach the finding is stated by name only, with no names or
    // figures.
    if (ctx.reach !== undefined && ctx.reach !== TRANSPORT_REACH.local) {
      pushUncertain(out.uncertain, {
        code: LANE_FOLDER_UNIMPORTABLE_CODE,
        path: brain,
        message:
          "some folders of the legacy tree would not import; run brain_doctor locally to see " +
          "which",
      });
      return;
    }
    out.issues.push({
      severity: "warning",
      code: LANE_FOLDER_UNIMPORTABLE_CODE,
      path: brain,
      message:
        `the migration cannot import the pages of ${named.length} folder(s) of the legacy ` +
        `${BRAIN_ROOT_REL} tree and would archive them: ${named.join("; ")}. Rename each to a ` +
        "lane name of its own (lowercase letters, digits and hyphens) before migrating",
    });
  },
};
