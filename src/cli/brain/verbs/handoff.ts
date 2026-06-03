/**
 * `o2b brain handoff <session-file>` (Agent Surface Suite, t_28afa4d2):
 * render an operator-readable handoff note from a recorded session.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { writeHandoffNote } from "../../../core/brain/handoff.ts";
import {
  detectAdapter,
  getAdapter,
  isSessionAdapterId,
} from "../../../core/brain/sessions/registry.ts";
import type { SessionTurn } from "../../../core/brain/sessions/types.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainHandoff(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    "session-id": { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain handoff requires a <session-file> argument");
  const sessionPath = positional[0]!;
  if (!existsSync(sessionPath)) return fail(`session file does not exist: ${sessionPath}`);

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = normalizeFlagString(flags["agent"]) ?? resolveAgentName(config);
  const sessionId = normalizeFlagString(flags["session-id"]) ?? basename(sessionPath);

  // CLI error boundary: read/parse/write failures land as fail(...)
  // (controlled exit), never an uncaught exception.
  try {
    const formatRaw = flags["format"] as string | undefined;
    let adapter;
    if (formatRaw !== undefined && formatRaw !== "auto") {
      if (!isSessionAdapterId(formatRaw)) return fail(`unknown --format: ${formatRaw}`);
      adapter = getAdapter(formatRaw);
    } else {
      const text = readFileSync(sessionPath, "utf8");
      const nl = text.indexOf("\n");
      adapter = detectAdapter(nl < 0 ? text : text.slice(0, nl));
      if (adapter === null) {
        return fail(`could not autodetect session format for ${sessionPath}; pass --format`);
      }
    }

    const turns: SessionTurn[] = [];
    for await (const turn of adapter.iterate(sessionPath)) turns.push(turn);

    const result = writeHandoffNote(vault, { turns, sessionId, agent });
    if (flags["json"]) {
      okJson({ ok: true, path: result.path, scope: result.scope, turns: turns.length });
      return 0;
    }
    ok(`handoff note written: ${result.path} (${turns.length} turns)`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
