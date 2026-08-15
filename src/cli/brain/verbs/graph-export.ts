import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportVaultGraph } from "../../../core/brain/portability/graph.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain graph-export [--out <file>]` - serialise the user's vault
 * pages (links + typed relations) to a stable graph.json. Prints to
 * stdout, or writes to `--out <file>`. Read-only on the vault.
 *
 * The graph carries no page body, but it does carry every title, path
 * and relation target, so it goes through the shared egress guard
 * (registry entry `brain-graph-export`) like every other export.
 */
export async function cmdBrainGraphExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, { vault: { type: "string" }, out: { type: "string" } });
  const { vault } = brainVerbContext(flags);

  let json: string;
  let redacted: boolean;
  try {
    const verdict = redactForEgress("brain-graph-export", exportVaultGraph(vault));
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
    json = JSON.stringify(verdict.payload, null, 2) + "\n";
    redacted = verdict.redacted;
  } catch (exc) {
    return fail(`graph-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`graph-export failed to write output: ${(exc as Error).message ?? exc}`);
  }
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
