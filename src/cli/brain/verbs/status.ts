import {
  buildOperatorSnapshot,
  renderOperatorSnapshot,
} from "../../../core/brain/operator-snapshot.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain status` - unified operator status snapshot (O3). Composes
 * doctor, semantic health, hygiene, stale scan, review candidates, active
 * profile, and state-file health into one readable snapshot. Every problem
 * line carries the exact next command to run (from the diagnostics-signal
 * definition). A healthy vault prints a compact all-clear. Read-only.
 */
export async function cmdBrainStatus(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  let snapshot;
  try {
    snapshot = await buildOperatorSnapshot(vault, { configPath: config });
  } catch (exc) {
    return fail(`status failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderOperatorSnapshot(snapshot));
  return 0;
}
