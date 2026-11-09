/**
 * Where the device-config copy of the MCP token map lives (design D14 item
 * 15): `mcp-tokens.json` beside the machine config file. A leaf, so the
 * MCP transport (`mcp/token-source.ts`, the reader) and the store
 * migration (the writer of the copy) share one path rule.
 */

import { dirname, join } from "node:path";

import { defaultConfigPath } from "../../config.ts";

/** File name of the device-config token map, beside the machine config. */
export const DEVICE_TOKEN_FILE = "mcp-tokens.json";

/** Path of the device-config token map. */
export function deviceTokenStorePath(configPath?: string | null): string {
  return join(dirname(configPath ?? defaultConfigPath()), DEVICE_TOKEN_FILE);
}
