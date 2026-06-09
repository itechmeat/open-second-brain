import { resolveAgentName } from "../../../core/config.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
} from "../../../core/brain/apply-evidence.ts";
import { brainVerbContext, fail, normalizeFlagString, ok, okJson, parse } from "../helpers.ts";

export async function cmdBrainApplyEvidence(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    pref: { type: "string" },
    artifact: { type: "string" },
    result: { type: "string" },
    outcome: { type: "string" },
    agent: { type: "string" },
    note: { type: "string" },
    json: { type: "boolean" },
  });
  for (const field of ["pref", "artifact", "result"] as const) {
    if (typeof flags[field] !== "string" || (flags[field] as string).trim() === "") {
      return fail(`brain apply-evidence missing required flag: --${field}`);
    }
  }
  const { config, vault } = brainVerbContext(flags);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  if (flags["agent"] !== undefined && explicitAgent === null) {
    return fail("--agent must be a non-empty string when provided");
  }
  const agent = explicitAgent ?? resolveAgentName(config);

  const resultStr = String(flags["result"]);
  if (resultStr !== "applied" && resultStr !== "violated" && resultStr !== "outdated") {
    return fail(`--result must be 'applied', 'violated', or 'outdated'; got ${resultStr}`);
  }
  const outcomeStr = flags["outcome"] !== undefined ? String(flags["outcome"]) : undefined;
  if (
    outcomeStr !== undefined &&
    outcomeStr !== "success" &&
    outcomeStr !== "failure" &&
    outcomeStr !== "unknown"
  ) {
    return fail(`--outcome must be 'success', 'failure', or 'unknown'; got ${outcomeStr}`);
  }

  try {
    const out = appendApplyEvidence(vault, {
      pref_id: String(flags["pref"]),
      artifact: String(flags["artifact"]),
      result: resultStr,
      agent,
      ...(outcomeStr !== undefined ? { outcome: outcomeStr } : {}),
      ...(flags["note"] ? { note: String(flags["note"]) } : {}),
    });
    if (flags["json"]) {
      okJson({ logged_at: out.logged_at, log_path: out.log_path });
    } else {
      ok(`logged: ${out.log_path}`);
      ok(`at: ${out.logged_at}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`apply-evidence failed: ${(exc as Error).message ?? exc}`);
  }
}
