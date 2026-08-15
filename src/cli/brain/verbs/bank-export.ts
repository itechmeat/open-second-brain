import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportBankBundle } from "../../../core/brain/portability/bundle.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain bank-export [--out <file>]` - serialise a whole-vault bank
 * bundle (preferences + page graph + page contracts + sources dashboard)
 * to a schema-versioned JSON. Prints to stdout, or writes to
 * `--out <file>`. Read-only on the vault.
 *
 * Every byte goes through the shared egress guard first (registry entry
 * `brain-bank-export`). The guard runs over the bundle TREE and the JSON
 * is serialised afterwards, so redaction can never disturb the
 * document's own quoting.
 */
export async function cmdBrainBankExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, { vault: { type: "string" }, out: { type: "string" } });
  const { vault } = brainVerbContext(flags);

  let json: string;
  let redacted: boolean;
  try {
    const verdict = redactForEgress("brain-bank-export", exportBankBundle(vault));
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
    json = JSON.stringify(verdict.payload, null, 2) + "\n";
    redacted = verdict.redacted;
  } catch (exc) {
    return fail(`bank-export failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    if (typeof flags["out"] === "string") {
      atomicWriteFileSync(flags["out"], json);
      process.stdout.write(`wrote ${flags["out"]}\n`);
    } else {
      process.stdout.write(json);
    }
  } catch (exc) {
    return fail(`bank-export failed to write output: ${(exc as Error).message ?? exc}`);
  }
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
