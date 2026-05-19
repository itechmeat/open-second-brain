import { defaultConfigPath } from "../../../core/config.ts";
import { bootstrapBrain } from "../../../core/brain/init.ts";
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

  if (flags["json"]) {
    okJson({ vault, created: result.created, overwritten: result.overwritten, skipped: result.skipped });
    return 0;
  }
  ok(`brain initialized: ${vault}`);
  for (const p of result.created) info(`  created: ${p}`);
  for (const p of result.overwritten) info(`  overwritten: ${p}`);
  for (const p of result.skipped) info(`  exists: ${p}`);
  return 0;
}
