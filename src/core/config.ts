/**
 * Configuration discovery and persistence.
 *
 * Mirrors `src/open_second_brain/config.py` from the legacy Python implementation
 * — same lookup chain (env → XDG → ~/.config), same simple `key: value` YAML
 * subset, same atomic write semantics, same redaction policy. Tests pin parity
 * via parallel suites in tests/core/config.test.ts.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "./fs-atomic.ts";
import { isFile } from "./fs-utils.ts";
import type { ConfigDiscovery } from "./types.ts";

const SECRET_KEY_PARTS = ["key", "token", "secret", "password", "credential"] as const;

const CONFIG_VALUE_REJECTED_CHARS = ['"', "\\", "\n", "\r"] as const;

/**
 * Resolve the location of the plugin config file.
 *
 * Order: `OPEN_SECOND_BRAIN_CONFIG` env, `XDG_CONFIG_HOME`, `~/.config/open-second-brain/config.yaml`.
 */
export function defaultConfigPath(): string {
  const override = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  if (override) return expandTilde(override);

  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(expandTilde(xdg), "open-second-brain", "config.yaml");

  return join(homedir(), ".config", "open-second-brain", "config.yaml");
}

/**
 * Parse the simple `key: value` YAML subset used for the plugin config.
 *
 * Intentionally not a real YAML parser — keeping this dependency-free and
 * matching the Python `parse_simple_yaml` exactly so round-trips are stable.
 * Lines that aren't `key: value` (comments, blanks, complex YAML) are skipped.
 */
export function parseSimpleYaml(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes (single OR double).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

/** Read and parse the config file, or report it as missing. */
export function discoverConfig(path?: string): ConfigDiscovery {
  const resolved = path ?? defaultConfigPath();
  if (!isFile(resolved)) {
    return { path: resolved, exists: false, data: {} };
  }
  try {
    const text = readFileSync(resolved, "utf8");
    return { path: resolved, exists: true, data: parseSimpleYaml(text) };
  } catch {
    return { path: resolved, exists: false, data: {} };
  }
}

/**
 * Persist a single `key: value` pair into the plugin config file.
 *
 * Atomic: writes to a temp sibling and renames, with fsync on file and parent
 * dir. Rejects values containing characters that would break the simple parser
 * on read-back rather than silently corrupting them.
 */
export function setConfigValue(key: string, value: string, path?: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`config value for ${JSON.stringify(key)} must be a string`);
  }
  for (const bad of CONFIG_VALUE_REJECTED_CHARS) {
    if (value.includes(bad)) {
      throw new Error(
        `config value for ${JSON.stringify(key)} contains a disallowed character ` +
          `(${JSON.stringify(bad)}); reject rather than silently corrupting on read-back`,
      );
    }
  }

  const resolved = path ?? defaultConfigPath();
  const discovery = discoverConfig(resolved);
  const data = { ...discovery.data, [key]: value };
  const body =
    Object.entries(data)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n";
  atomicWriteFileSync(resolved, body);
  return resolved;
}

export interface TimezoneValidationResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/** Validate an IANA timezone name without normalising or trimming it. */
export function validateTimezoneName(name: string): TimezoneValidationResult {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return { ok: true, error: null };
  } catch (exc) {
    return { ok: false, error: (exc as Error).message ?? String(exc) };
  }
}

/**
 * Resolve the IANA timezone for stamping Daily entries.
 *
 * Order: `VAULT_TIMEZONE` env → `timezone` field in plugin config → `null`
 * (caller falls back to the host's local clock). Invalid IANA names are silently
 * treated as "not configured" so a typo never breaks logging.
 */
export function resolveTimezone(configPath?: string): string | null {
  let name = process.env["VAULT_TIMEZONE"];
  if (!name) {
    name = discoverConfig(configPath).data["timezone"];
  }
  if (!name) return null;
  return validateTimezoneName(name).ok ? name : null;
}

/**
 * Resolve the vault directory.
 *
 * Order: `VAULT_DIR` env → `vault` field in plugin config → `null`. Caller
 * decides whether to error out or accept a positional path.
 */
export function resolveVault(configPath?: string): string | null {
  const env = process.env["VAULT_DIR"];
  if (env) return expandTilde(env);
  const cfg = discoverConfig(configPath).data["vault"];
  if (cfg) return expandTilde(cfg);
  return null;
}

/**
 * Resolve the agent identity used when no explicit `agent` is supplied.
 *
 * Order: `VAULT_AGENT_NAME` env → `agent_name`/`agentName` in plugin config →
 * the literal placeholder `"agent"`. Used by every Brain writer that needs
 * an `agent:` field (signals, evidence rows, log entries) and by the
 * Hermes pre_llm_call hook.
 */
export function resolveAgentName(configPath?: string): string {
  const env = process.env["VAULT_AGENT_NAME"];
  if (env) return env;
  const data = discoverConfig(configPath).data;
  const value = data["agent_name"] ?? data["agentName"];
  if (value) return value;
  return "agent";
}

/** Replace values for keys whose name suggests a secret with `[REDACTED]`. */
export function redactMapping<T extends Record<string, unknown>>(data: T): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => lowered.includes(part))) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
