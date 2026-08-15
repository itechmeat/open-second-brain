import { existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportPreferencesJson, exportPreferencesLlmsTxt } from "../../../core/brain/export.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, ok, parse } from "../helpers.ts";

/**
 * `o2b brain export --format json|llms-txt [--out <file>] [--force]`.
 *
 * Preference principles are free text an agent wrote, and the llms-txt
 * form exists to be pasted into a foreign prompt - the destination least
 * likely to be read before it is shared. Both forms go through the shared
 * egress guard (registry entry `brain-preference-export`): the JSON as a
 * tree, serialised afterwards, and llms-txt as text.
 */
export async function cmdBrainExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const format = flags["format"] as string | undefined;
  if (format !== "json" && format !== "llms-txt") {
    process.stderr.write("error: --format is required and must be one of json|llms-txt\n");
    return 2;
  }

  let body: string;
  let redacted: boolean;
  try {
    if (format === "json") {
      const verdict = redactForEgress("brain-preference-export", exportPreferencesJson(vault));
      if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
      body = JSON.stringify(verdict.payload) + "\n";
      redacted = verdict.redacted;
    } else {
      const verdict = redactForEgress("brain-preference-export", exportPreferencesLlmsTxt(vault));
      if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
      body = verdict.payload;
      redacted = verdict.redacted;
    }
  } catch (exc) {
    return fail(`export failed: ${(exc as Error).message ?? exc}`);
  }

  const outPath = flags["out"] as string | undefined;
  if (outPath === undefined) {
    process.stdout.write(body);
    if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
    return 0;
  }
  if (existsSync(outPath) && !flags["force"])
    return fail(`${outPath} exists; pass --force to overwrite`);
  try {
    atomicWriteFileSync(outPath, body);
  } catch (exc) {
    return fail(`failed to write ${outPath}: ${(exc as Error).message ?? exc}`);
  }
  ok(`wrote ${outPath}`);
  if (redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}
