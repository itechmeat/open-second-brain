/**
 * Canonical MCP server payload builder.
 *
 * Pure function: given the plugin config (vault + identity), return the
 * two `McpServerEntry` objects that every adapter writes verbatim.
 * Same input → byte-identical output; this is what lets `--apply`
 * be idempotent and `verify` detect drift via re-construction rather
 * than a stored hash.
 */

import type { McpPayload, McpServerEntry } from "./types.ts";

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export interface PayloadConfig {
  readonly vault: string;
  readonly agent_name: string | null;
  readonly timezone: string | null;
}

const COMMAND = "o2b";

/**
 * `command` + leading args that start the `o2b` launcher on `platform`.
 *
 * POSIX: `o2b` straight off PATH (the `install-cli` symlink). Native
 * Windows: `cmd /d /c o2b` - the launcher there is `o2b.cmd`, and a batch
 * file is not something every host can spawn directly (Node refuses `.cmd`
 * without a shell since the 2024 BatBadBut fix; Rust and Bun resolve only
 * `.exe` from a bare name). `cmd /c <name>` is the form several MCP hosts'
 * Windows docs give for `npx`, and it resolves `o2b.cmd` through PATH and
 * PATHEXT. `/d` skips cmd's AutoRun, whose output would corrupt the
 * JSON-RPC stream on stdout.
 *
 * cmd.exe looks for a bare name in the current directory BEFORE PATH, and
 * an MCP host starts its servers in the project it opened - so a repository
 * that ships an `o2b.cmd` would run it. The Windows payload therefore
 * carries {@link WINDOWS_LAUNCHER_ENV}, which turns that lookup off for
 * this cmd.exe and everything it starts (the launcher's own `bun` lookup
 * included). An absolute launcher path was the alternative, but cmd's
 * quote stripping (`cmd /c "<path with a space>" ... "<vault>"`) breaks it
 * for any profile or vault path with a space in it.
 */
export function launcherCommand(platform: string = process.platform): {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
} {
  if (platform === "win32") return { command: "cmd", prefix: ["/d", "/c", COMMAND] };
  return { command: COMMAND, prefix: [] };
}

/**
 * Characters `cmd.exe` interprets even inside an argument a host did not
 * quote (hosts quote only arguments with whitespace). A vault path holding
 * one would be split or executed by the `cmd /c` launcher, so the Windows
 * payload refuses it by name instead of writing a config that breaks - or
 * runs something - at spawn time.
 */
const CMD_METACHARACTERS = /[&|<>^%"!]/;

/**
 * Environment every Windows payload entry carries: cmd.exe and the Win32
 * search it drives stop looking in the current directory for a bare
 * command name (see {@link launcherCommand}).
 */
export const WINDOWS_LAUNCHER_ENV: Readonly<Record<string, string>> = Object.freeze({
  NoDefaultCurrentDirectoryInExePath: "1",
});

export function buildPayload(cfg: PayloadConfig, platform: string = process.platform): McpPayload {
  if (!cfg.vault || typeof cfg.vault !== "string") {
    throw new PayloadError("buildPayload: vault is required");
  }
  if (platform === "win32" && CMD_METACHARACTERS.test(cfg.vault)) {
    throw new PayloadError(
      `buildPayload: the vault path ${cfg.vault} contains a character cmd.exe interprets ` +
        '(& | < > ^ % " !); MCP hosts on Windows start o2b through `cmd /c`, which would split ' +
        "or execute it. Move or rename the vault so its path has none of them.",
    );
  }
  const env = buildEnv(cfg, platform);
  const { command, prefix } = launcherCommand(platform);
  const full: McpServerEntry = {
    command,
    args: [...prefix, "mcp", "--vault", cfg.vault],
    ...(env ? { env } : {}),
  };
  const writer: McpServerEntry = {
    command,
    args: [...prefix, "mcp", "--writer-only", "--vault", cfg.vault],
    ...(env ? { env } : {}),
  };
  return { full, writer };
}

/**
 * The arguments `o2b` itself receives from a payload entry, with the
 * Windows launcher words (`cmd /d /c o2b`) taken off the front.
 *
 * A host that does not start the launcher - grok runs
 * `bun run <repo>/src/cli/main.ts` directly - appends the entry's args to
 * its own command. Handing it the Windows args unchanged would make the
 * CLI see `/d /c o2b mcp …` and refuse an unknown verb. The check looks at
 * the entry's own shape rather than the current platform, so a payload
 * built for either platform strips correctly on any host.
 */
export function cliArgs(entry: McpServerEntry): ReadonlyArray<string> {
  const win = launcherCommand("win32");
  const hasPrefix =
    entry.command === win.command && win.prefix.every((word, i) => entry.args[i] === word);
  return hasPrefix ? entry.args.slice(win.prefix.length) : entry.args;
}

function buildEnv(cfg: PayloadConfig, platform: string): Record<string, string> | undefined {
  const env: Record<string, string> = platform === "win32" ? { ...WINDOWS_LAUNCHER_ENV } : {};
  if (cfg.agent_name) env["VAULT_AGENT_NAME"] = cfg.agent_name;
  if (cfg.timezone) env["VAULT_TIMEZONE"] = cfg.timezone;
  return Object.keys(env).length > 0 ? env : undefined;
}
