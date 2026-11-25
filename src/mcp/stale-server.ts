/**
 * A long-lived `o2b mcp` server that outlived its install.
 *
 * An agent session keeps its MCP server for days. After an update the
 * server still runs the code it started with, and after the machine moved
 * its brain into the store the server still holds the layout it saw at
 * start: a server of an older release kept writing the legacy `Brain/log`
 * files on a switched machine and brought `Brain/` back into the vault.
 *
 * So before a write the server compares what it started with to what the
 * machine has now: the version of the code installed on disk (the
 * `package.json` beside this module) and, for a server that started on an
 * unswitched machine whose vault held a legacy tree, whether the sticky
 * switch marker names this machine's device now (`store-only.ts`). When
 * either changed, it
 * refuses the write and every later one, with a plain message to restart
 * the agent session. The look costs two small file reads and runs on a
 * write at most once a {@link STALE_SERVER_CHECK_MS}; a read looks only
 * at the day's dream check, which would start a worker that writes.
 * What cannot be read counts as unchanged: an unknown is never a refusal.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hasLegacyTree, storeOnlyAnswer } from "../core/store/store-only.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../core/version.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";

/** The refusal token, named in the message and carried in `data`. */
export const STALE_SERVER_REFUSAL = "server_outdated";

/** A write looks at the install at most this often. */
export const STALE_SERVER_CHECK_MS = 60_000;

const PACKAGE_NAME = "open-second-brain";

/** What a server compares: the installed version and the machine's layout. */
export interface ServerFingerprint {
  /** The version of the code on disk; `null` when it cannot be read. */
  readonly version: string | null;
  /** Whether this machine's device switched to the brain store (its marker or its record). */
  readonly switched: boolean;
  /** Whether the served vault holds a legacy tree (`Brain/`) an older layout writes to. */
  readonly legacy: boolean;
}

/** The version of the install on disk, or `null` when its manifest cannot be read. */
export function installedVersionOnDisk(): string | null {
  try {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === PACKAGE_NAME && typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

/** The machine as a server serving `vault` sees it now. */
export function readServerFingerprint(
  configPath: string | undefined,
  vault: string | null,
): ServerFingerprint {
  let switched = false;
  try {
    const answer = storeOnlyAnswer(
      { vault, ...(configPath !== undefined ? { configPath } : {}) },
      { persistSwitch: false },
    );
    switched = answer.reason === "device-switched";
  } catch {
    switched = false;
  }
  let legacy = false;
  try {
    legacy = hasLegacyTree(vault);
  } catch {
    legacy = false;
  }
  return { version: installedVersionOnDisk(), switched, legacy };
}

export interface StaleServerGuardOptions {
  readonly configPath?: string;
  /** The vault the server serves. */
  readonly vault?: string | null;
  /** The look at the machine (default {@link readServerFingerprint}). */
  readonly read?: () => ServerFingerprint;
  /** The version this process runs (default the one it was loaded with). */
  readonly running?: string;
  /** Wall clock (default `Date.now`). */
  readonly now?: () => number;
}

/** Decides, write by write, whether this server is older than the machine it serves. */
export class StaleServerGuard {
  readonly #read: () => ServerFingerprint;
  readonly #now: () => number;
  readonly #running: string;
  /** The server started unswitched on a vault with a legacy tree: a switch strands it. */
  readonly #legacyAtStart: boolean;
  #lastLook = Number.NEGATIVE_INFINITY;
  #reason: string | null = null;

  constructor(options: StaleServerGuardOptions = {}) {
    const configPath = options.configPath;
    const vault = options.vault ?? null;
    this.#read = options.read ?? (() => readServerFingerprint(configPath, vault));
    this.#now = options.now ?? Date.now;
    this.#running = options.running ?? OPEN_SECOND_BRAIN_VERSION;
    const start = this.#read();
    this.#legacyAtStart = !start.switched && start.legacy;
  }

  /** Why this server must not write any more, or `null` while it may. */
  reason(): string | null {
    if (this.#reason !== null) return this.#reason;
    const now = this.#now();
    if (now - this.#lastLook < STALE_SERVER_CHECK_MS) return null;
    this.#lastLook = now;
    const seen = this.#read();
    if (seen.version !== null && seen.version !== this.#running) {
      this.#reason =
        `Open Second Brain ${seen.version} is installed, but this server still runs ` +
        `${this.#running}, the version it started with`;
    } else if (this.#legacyAtStart && seen.switched) {
      this.#reason =
        "this machine's brain moved into the brain store after this server started, " +
        "and the server still holds the old layout";
    }
    return this.#reason;
  }

  /** Throw the refusal when this server must not write. */
  assertMayWrite(tool: string): void {
    const reason = this.reason();
    if (reason === null) return;
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: refused (${STALE_SERVER_REFUSAL}). ${reason}. Nothing was written: restart the ` +
        "agent session so it starts the installed Open Second Brain.",
      Object.freeze({ code: STALE_SERVER_REFUSAL, tool, running: this.#running, reason }),
    );
  }
}
