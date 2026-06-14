/**
 * `o2b brain note-history <path>` (Session Knowledge Synthesis, t_6a201155):
 * decompose a note's git history into recallable episodic phases, split
 * deterministically on a commit-time gap.
 *
 *   o2b brain note-history <path> [--gap-hours N] [--max-count N] [--json]
 */

import { decomposeNoteHistory } from "../../../core/brain/note-history.ts";
import { brainVerbContext, parse, usageError } from "../helpers.ts";

const USAGE = "usage: o2b brain note-history <path> [--gap-hours N] [--max-count N] [--json]";

export async function cmdBrainNoteHistory(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "gap-hours": { type: "string" },
    "max-count": { type: "string" },
    json: { type: "boolean" },
  });

  const path = positional[0]?.trim() ?? "";
  if (path.length === 0) return usageError(USAGE);

  const gapHours = parsePositiveInt(flags["gap-hours"]);
  if (gapHours === "invalid")
    return usageError("brain note-history: --gap-hours must be a positive integer");
  const maxCount = parsePositiveInt(flags["max-count"]);
  if (maxCount === "invalid")
    return usageError("brain note-history: --max-count must be a positive integer");

  const vault = brainVerbContext(flags).vault;
  const result = decomposeNoteHistory(vault, path, {
    ...(gapHours !== undefined ? { gapHours } : {}),
    ...(maxCount !== undefined ? { maxCount } : {}),
  });

  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (!result.available) {
    process.stdout.write(`${result.notePath}: ${result.reason ?? "no history available"}\n`);
    return 0;
  }
  if (result.phases.length === 0) {
    process.stdout.write(`${result.notePath}: ${result.reason ?? "no commits"}\n`);
    return 0;
  }
  process.stdout.write(
    `${result.notePath}: ${result.commitCount} commit(s) in ${result.phases.length} phase(s)\n`,
  );
  for (const phase of result.phases) {
    process.stdout.write(
      `  phase ${phase.index}: ${phase.firstDate} -> ${phase.lastDate}  (${phase.commitCount} commit(s), ${phase.authors.join(", ")})\n`,
    );
    for (const subject of phase.subjects) process.stdout.write(`    - ${subject}\n`);
  }
  return 0;
}

function parsePositiveInt(
  value: string | boolean | string[] | undefined,
): number | undefined | "invalid" {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return "invalid";
  return parsed;
}
