import { defaultConfigPath } from "../../../core/config.ts";
import { setPrimaryAgent } from "../../../core/brain/set-primary.ts";
import { parse, fail, ok, okJson, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSetPrimary(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    clear: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

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
    result = setPrimaryAgent(vault, name);
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
