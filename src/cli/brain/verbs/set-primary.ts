import { brainSettingsFromStore } from "../../../core/brain/policy/load.ts";
import { setBrainSetting, unsetBrainSetting } from "../../../core/brain/policy/settings-write.ts";
import { setPrimaryAgent, type SetPrimaryAgentResult } from "../../../core/brain/set-primary.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

/**
 * On a store-only machine (or with no vault) `primary_agent` is a shared
 * settings record with human authority, written by the shared settings
 * writer; nothing under `Brain/` changes.
 */
function setPrimaryInStore(
  vault: string | null,
  config: string,
  agent: string,
  name: string | null,
): SetPrimaryAgentResult {
  const ctx = { vault, configPath: config, authority: "human" as const, agent };
  const result =
    name === null
      ? unsetBrainSetting(ctx, "primary_agent")
      : setBrainSetting(ctx, "primary_agent", name);
  const asName = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return { previous: asName(result.previous), next: asName(result.value), changed: result.changed };
}

export async function cmdBrainSetPrimary(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    clear: { type: "boolean" },
    json: { type: "boolean" },
    agent: { type: "string" },
  });
  const { vault, config } = brainVerbContext(flags, { vault: "optional" });

  let name: string | null;
  if (flags["clear"]) {
    if (positional.length > 0)
      return fail("brain set-primary --clear takes no positional argument");
    name = null;
  } else {
    if (positional.length < 1)
      return fail("brain set-primary requires <name> or --clear; see `o2b brain help set-primary`");
    if (positional.length > 1) return fail("brain set-primary accepts a single <name> argument");
    const supplied = positional[0]!.trim();
    if (supplied.length === 0) return fail("brain set-primary <name> must be non-empty");
    name = supplied;
  }

  let result;
  try {
    result =
      vault === null || brainSettingsFromStore(vault)
        ? setPrimaryInStore(vault, config, resolveBrainAgent(flags, config), name)
        : setPrimaryAgent(vault, name);
  } catch (exc) {
    return fail(`set-primary failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({ previous: result.previous, next: result.next, changed: result.changed });
    return 0;
  }

  const fmt = (v: string | null): string => v ?? "null";
  if (!result.changed) {
    ok(`primary_agent already set to ${fmt(result.next)}`);
  } else {
    ok(`primary_agent: ${fmt(result.previous)} → ${fmt(result.next)}`);
  }
  return 0;
}
