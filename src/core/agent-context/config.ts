/**
 * Machine-config flags of the agent-context hooks that `src/core/config.ts`
 * does not carry (task 4.3): the module stays small so the 2100-line core
 * config does not grow. `neighbour_updates_enabled` is on whenever a brain
 * store is in use; `false` or `0` (config or its environment override,
 * the boolean rule every setting follows) turns it off. Resolution never
 * throws: a value that is not a boolean keeps the default.
 */

import { discoverConfig } from "../config.ts";
import { parseBool } from "../validate.ts";

function readFlag(raw: string): boolean {
  try {
    return parseBool(raw, true, NEIGHBOUR_UPDATES_ENABLED_KEY);
  } catch {
    return true;
  }
}

export const NEIGHBOUR_UPDATES_ENABLED_KEY = "neighbour_updates_enabled";
export const NEIGHBOUR_UPDATES_ENV = "OPEN_SECOND_BRAIN_NEIGHBOUR_UPDATES_ENABLED";

/** Whether the neighbour-updates lane runs on this machine. */
export function resolveNeighbourUpdatesEnabled(configPath?: string): boolean {
  try {
    const envRaw = process.env[NEIGHBOUR_UPDATES_ENV];
    if (envRaw !== undefined && envRaw !== "") return readFlag(envRaw);
    const configRaw = discoverConfig(configPath).data[NEIGHBOUR_UPDATES_ENABLED_KEY];
    if (configRaw !== undefined && String(configRaw) !== "") return readFlag(String(configRaw));
    return true;
  } catch {
    return true;
  }
}
