/**
 * `o2b search focus <set|status|clear>` — the session-scoped recall focus
 * that biases subsequent queries towards a query/path pair until its TTL
 * expires.
 */

import {
  clearSessionFocus,
  normalizeSessionFocus,
  readSessionFocus,
  writeSessionFocus,
} from "../../../core/search/index.ts";
import type { SearchSessionFocus } from "../../../core/search/index.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

const ACTIONS = new Set(["set", "status", "clear"]);

/** Focus lifetime when `--ttl-minutes` is omitted. */
const DEFAULT_TTL_MINUTES = "120";

export async function cmdSearchFocus(argv: ReadonlyArray<string>): Promise<number> {
  const action = argv[0];
  if (!action || !ACTIONS.has(action)) {
    throw new CliError(
      "usage: o2b search focus <set|status|clear> [--query Q] [--path P] [--session S]",
    );
  }
  const { flags } = parseFlags(argv.slice(1), {
    ...VAULT_FLAGS,
    query: { type: "string" },
    path: { type: "string" },
    session: { type: "string" },
    "ttl-minutes": { type: "string", default: DEFAULT_TTL_MINUTES },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  // Session-scoped focus (t_5b478e47): --session binds the focus to
  // one session's file under search-focus/ instead of the global file.
  const session = flagString(flags, "session");
  const json = flagBoolean(flags, "json");

  if (action === "set") {
    const ttlMinutes = Number(flags["ttl-minutes"] ?? DEFAULT_TTL_MINUTES);
    const focus = normalizeSessionFocus(
      {
        query: flagString(flags, "query") ?? null,
        pathPrefix: flagString(flags, "path") ?? null,
        ttlMinutes,
      },
      Date.now(),
    );
    writeSessionFocus(cfg, focus, session);
    writeFocusResponse(focus, json);
    return 0;
  }

  if (action === "clear") {
    clearSessionFocus(cfg, session);
    writeFocusResponse(null, json);
    return 0;
  }

  writeFocusResponse(readSessionFocus(cfg, Date.now(), session), json);
  return 0;
}

function focusJson(focus: SearchSessionFocus | null): Record<string, unknown> {
  return { active: focus !== null, focus };
}

function writeFocusResponse(focus: SearchSessionFocus | null, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(focusJson(focus)) + "\n");
    return;
  }
  if (!focus) {
    process.stdout.write("search focus: inactive\n");
    return;
  }
  const parts = [
    focus.query !== null ? `query=${JSON.stringify(focus.query)}` : null,
    focus.pathPrefix !== null ? `path=${JSON.stringify(focus.pathPrefix)}` : null,
    focus.expiresAt !== null ? `expires_at=${new Date(focus.expiresAt).toISOString()}` : null,
  ].filter((part): part is string => part !== null);
  process.stdout.write(`search focus: active ${parts.join(" ")}\n`);
}
