/**
 * `o2b brain foresight` (t_08a79c81): render the forward-looking
 * envelope - recurring routines coming due, open commitments, open
 * questions. `--write` additionally persists a dated markdown note
 * under `Brain/foresight/` so the projection itself becomes
 * recallable vault content.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { join, relative } from "node:path";

import {
  buildForesight,
  FORESIGHT_HORIZON_DAYS,
  type ForesightEnvelope,
} from "../../../core/brain/temporal/foresight.ts";
import { isoDate } from "../../../core/brain/time.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";
import { lanePagesInStore, writeLanePage } from "../../../core/store/lane-pages.ts";
import { toPosix } from "../../../core/path-safety.ts";

/** How a page held as a store record is named: `store:<record path>`, as `feedback` names its records. */
const STORE_RECORD_PREFIX = "store:";

const USAGE = "usage: o2b brain foresight [--horizon-days N] [--write] [--vault <path>] [--json]";

function renderBody(envelope: ForesightEnvelope): string {
  const lines = [`# Foresight\n`, `Horizon: ${envelope.horizonDays} day(s)\n`];
  for (const item of envelope.upcoming) {
    lines.push(`## ${item.title}\n`);
    lines.push(`- kind: ${item.kind}`);
    if (item.due !== null) lines.push(`- due: ${item.due}`);
    lines.push(`- why: ${item.why}`);
    lines.push(`- sources: ${item.sources.join(", ")}`);
    lines.push("");
  }
  if (envelope.upcoming.length === 0) lines.push("Nothing anticipated inside the horizon.\n");
  return lines.join("\n");
}

export async function cmdBrainForesight(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "horizon-days": { type: "string" },
    write: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = flags["json"] === true;
  const vault = brainVerbContext(flags).vault;
  const horizonRaw = flags["horizon-days"] as string | undefined;
  const horizonDays = horizonRaw !== undefined ? Number(horizonRaw) : FORESIGHT_HORIZON_DAYS;
  if (!Number.isInteger(horizonDays) || horizonDays < 1) {
    process.stderr.write(`brain foresight: --horizon-days must be a positive integer\n${USAGE}\n`);
    return 2;
  }

  try {
    const now = new Date();
    const envelope = buildForesight(vault, { now, horizonDays });

    let writtenPath: string | undefined;
    if (flags["write"] === true) {
      // A record-lane page: a store record on a store-only machine.
      const dir = join(vault, "Brain", "foresight");
      writtenPath = join(dir, `${isoDate(now)}.md`);
      writeLanePage(
        vault,
        writtenPath,
        {
          kind: "brain-foresight",
          date: isoDate(now),
          horizon_days: String(envelope.horizonDays),
          generated_at: envelope.generatedAt,
          tags: ["brain", "brain/foresight"],
        },
        renderBody(envelope),
        { overwrite: true, existsErrorKind: "foresight", vaultForRelativePath: vault },
      );
      // On a store-only machine the page is a store record and no file
      // exists at that path: it is named by its record path instead.
      if (lanePagesInStore(vault)) {
        writtenPath = `${STORE_RECORD_PREFIX}${toPosix(relative(vault, writtenPath))}`;
      }
    }

    if (asJson) {
      okJson({ ...envelope, ...(writtenPath !== undefined ? { written_path: writtenPath } : {}) });
    } else {
      ok(`foresight: ${envelope.upcoming.length} item(s) within ${envelope.horizonDays}d`);
      for (const item of envelope.upcoming) {
        ok(`  [${item.kind}]${item.due !== null ? ` due ${item.due}` : ""} ${item.title}`);
        ok(`    ${item.why}`);
      }
      if (writtenPath !== undefined) ok(`written: ${writtenPath}`);
    }
    return 0;
  } catch (exc) {
    const message = `foresight failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
