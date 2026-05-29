import { defaultConfigPath } from "../../../core/config.ts";
import { buildMorningBrief } from "../../../core/brain/morning-brief.ts";
import { parseOptionalNumberFlag } from "../../coerce.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain morning-brief` - render a read-only session-start summary:
 * top confirmed preferences, recent reconcile open questions, and recent
 * notes. Bounded by the shared recall char budget.
 */
export async function cmdBrainMorningBrief(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "top-k": { type: "string" },
    "lookback-days": { type: "string" },
    "max-chars-per-memory": { type: "string" },
    "max-total-chars": { type: "string" },
  });

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  // Positive-integer validation mirroring the MCP tool's
  // optionalPositiveInt, so the CLI and MCP surfaces share semantics.
  const positiveInt = (name: string): { value: number | null; error: string | null } => {
    const parsed = parseOptionalNumberFlag(flags, name);
    if (parsed.error) return parsed;
    if (parsed.value !== null && (!Number.isInteger(parsed.value) || parsed.value < 1)) {
      return { value: null, error: `--${name} must be a positive integer` };
    }
    return parsed;
  };

  const topKFlag = positiveInt("top-k");
  if (topKFlag.error) return fail(topKFlag.error);
  const lookbackFlag = positiveInt("lookback-days");
  if (lookbackFlag.error) return fail(lookbackFlag.error);
  const perMemFlag = positiveInt("max-chars-per-memory");
  if (perMemFlag.error) return fail(perMemFlag.error);
  const totalFlag = positiveInt("max-total-chars");
  if (totalFlag.error) return fail(totalFlag.error);

  let brief;
  try {
    brief = buildMorningBrief(vault, {
      now: new Date(),
      topK: topKFlag.value ?? 10,
      lookbackDays: lookbackFlag.value ?? 7,
      ...(perMemFlag.value !== null ? { maxCharsPerMemory: perMemFlag.value } : {}),
      ...(totalFlag.value !== null ? { maxTotalChars: totalFlag.value } : {}),
    });
  } catch (exc) {
    return fail(`morning-brief failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(brief, null, 2) + "\n");
  } else {
    process.stdout.write((brief.text.length > 0 ? brief.text : "(nothing to surface)") + "\n");
  }
  return 0;
}
