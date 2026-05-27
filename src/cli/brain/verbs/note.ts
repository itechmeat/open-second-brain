/**
 * `o2b brain note <text> [--agent <name>]` — CLI mirror of the MCP
 * `brain_note` tool. Writes one `Brain/log/<today>.md` entry under
 * the `note` event kind plus the JSONL sidecar. Intended for cron
 * jobs and shell scripts that cannot reach the MCP surface.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { appendBrainNote } from "../../../core/brain/note.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

export async function cmdBrainNote(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });

  if (positional.length === 0) {
    return usageError('brain note requires a text argument: o2b brain note "<text>"');
  }
  if (positional.length > 1) {
    return usageError("brain note takes exactly one positional argument — quote multi-word text");
  }
  const text = positional[0]!;
  // Pre-validate empty / whitespace-only text at the CLI surface so a
  // cron caller that forgot to interpolate `$VAR` gets the same exit-2
  // shape as a missing positional. The core would otherwise throw, and
  // the catch arm below maps to exit 1 — that drift is on the spec
  // (design §7.2: "Empty / whitespace only → exit 2").
  if (text.trim().length === 0) {
    return usageError('brain note requires non-empty text: o2b brain note "<text>"');
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);

  let res;
  try {
    res = appendBrainNote({
      vault,
      text,
      ...(explicitAgent ? { agent: explicitAgent } : {}),
      configPath: config,
    });
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }

  if (flags["json"]) {
    okJson({
      logged_at: res.logged_at,
      log_path: res.log_path,
      absolute_log_path: res.absolute_log_path,
      agent: res.agent,
    });
    return 0;
  }
  ok(`logged note at ${res.log_path}`);
  return 0;
}
