import { defaultConfigPath } from "../../../core/config.ts";
import { bootstrapBrain } from "../../../core/brain/init.ts";
import { computeBrainStatus } from "../../../core/brain/status.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { parse, fail, ok, info, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainInit(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    force: { type: "boolean" },
    "primary-agent": { type: "string" },
    starter: { type: "boolean" },
    "starter-path": { type: "string" },
    json: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const primaryAgentFlag = flags["primary-agent"];
  let primaryAgent: string | undefined;
  if (typeof primaryAgentFlag === "string") {
    const trimmed = primaryAgentFlag.trim();
    if (trimmed.length === 0) {
      return fail("brain init: --primary-agent must be a non-empty string when provided");
    }
    primaryAgent = trimmed;
  }

  const starterPathFlag = flags["starter-path"];
  let starterPath: string | undefined;
  if (typeof starterPathFlag === "string") {
    starterPath = starterPathFlag.trim();
    if (starterPath.length === 0) {
      return fail("brain init: --starter-path must be a non-empty path when provided");
    }
  }

  let result;
  try {
    result = bootstrapBrain(vault, {
      force: Boolean(flags["force"]),
      configPath: config,
      starter: Boolean(flags["starter"]),
      ...(primaryAgent !== undefined ? { primaryAgent } : {}),
      ...(starterPath !== undefined ? { starterPath } : {}),
    });
  } catch (exc) {
    return fail(`failed to initialize Brain: ${(exc as Error).message ?? exc}`);
  }

  const stream: AdvisoryStream = {
    command: "brain",
    argv,
    jsonRequested: Boolean(flags["json"]),
  };

  // Resolved once, ahead of both renderers: the human stream prints it
  // as a rail line and the machine stream carries it as a field, and a
  // second evaluation could disagree with the first.
  const empty = brainHasNothingRecorded(vault);

  if (flags["json"]) {
    okJson({
      vault,
      created: result.created,
      overwritten: result.overwritten,
      skipped: result.skipped,
      ...(empty ? nextCommandField("brain-empty") : {}),
    });
  } else {
    ok(`brain initialized: ${vault}`);
    for (const p of result.created) info(`  created: ${p}`);
    for (const p of result.overwritten) info(`  overwritten: ${p}`);
    for (const p of result.skipped) info(`  exists: ${p}`);
  }

  // no-dead-ends, task 5. This verb creates the tree and then says
  // nothing about what goes in it, which is the archetypal dead end:
  // the whole point of a Brain is the first recorded signal. The rail
  // keeps the line off the `--json` payload.
  //
  // phase 3: fired UNCONDITIONALLY until now, so a re-run over a Brain
  // full of preferences - every path in `result.skipped` - still
  // asserted `brain-empty`, whose registered class reads "Brain with
  // nothing recorded in it". The claim is about content, not about
  // whether this run created anything, so the condition is the content.
  if (empty) emitNextStep("brain-empty", stream);
  return 0;
}

/**
 * True when the Brain holds no signal, preference or retired record.
 *
 * Counted through the shared status snapshot rather than a private
 * walk: `computeBrainStatus` is already this codebase's answer to "what
 * is in this Brain", and a second counter here would be a second thing
 * to keep in step with the directory layout. Processed signals count as
 * recorded - a Brain whose inbox has been drained into `processed/` has
 * a history, and telling its operator it is empty would be false.
 */
function brainHasNothingRecorded(vault: string): boolean {
  const { counts } = computeBrainStatus(vault);
  return counts.inbox + counts.inbox_processed + counts.preferences + counts.retired === 0;
}
