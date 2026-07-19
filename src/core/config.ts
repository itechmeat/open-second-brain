/**
 * Configuration discovery and persistence.
 *
 * Mirrors `src/open_second_brain/config.py` from the legacy Python implementation
 * — same lookup chain (env → XDG → ~/.config), same simple `key: value` YAML
 * subset, same atomic write semantics, same redaction policy. Tests pin parity
 * via parallel suites in tests/core/config.test.ts.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "./fs-atomic.ts";
import { isFile } from "./fs-utils.ts";
import { resolveActiveProfileVault } from "./brain/portability/profiles.ts";
import { resolvePointerVault } from "./brain/portability/pointer.ts";
import {
  isWikiLinkFormat,
  WIKI_LINK_FORMATS,
  type WikiLinkFormat,
} from "./brain/link-graph/format-wikilink.ts";
import type { LinkOutputFormat } from "./brain/wikilink.ts";
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
 * Order: `VAULT_DIR` env → project pointer walk-up → active profile →
 * `vault` field in plugin config → `null`. Caller decides whether to
 * error out or accept a positional path.
 */
export function resolveVault(configPath?: string, opts: { cwd?: string } = {}): string | null {
  const env = process.env["VAULT_DIR"];
  if (env) return expandTilde(env);
  // Project pointer (Workspace Insight Suite, t_1375e69f): a pointer file
  // in (or above) the working directory is the most specific durable
  // artifact, so it beats the profile pointer. Pointers only exist when
  // the operator linked the directory - without one the chain is
  // byte-identical to before. The walk stops at the filesystem root and
  // reads at most one small JSON per level; malformed pointers and
  // dangling targets fail soft to the next resolution step.
  const pointerVault = resolvePointerVault(opts.cwd ?? process.cwd());
  if (pointerVault !== null) return expandTilde(pointerVault);
  // Multi-vault profiles (v0.22.0): an active named profile overrides the
  // bare `vault` key. With no profiles registry the result is unchanged.
  const discovery = discoverConfig(configPath);
  const profileVault = resolveActiveProfileVault(discovery.path);
  if (profileVault) return expandTilde(profileVault);
  const cfg = discovery.data["vault"];
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

/**
 * Stable per-install device identity (Memory Integrity Suite). Keys the
 * per-device Brain log shards (`Brain/log/<date>.<deviceId>.jsonl`), so
 * it MUST live in the device-local config and never in the synced
 * vault - all devices sharing one id would defeat the sharding.
 *
 * Generated once (8 hex chars) on first use and persisted. An invalid
 * hand-edited value self-heals to a fresh generated id; the
 * `sync-conflict` prefix is reserved so a renamed Syncthing conflict
 * copy can never masquerade as a shard.
 */
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_RE.test(value) && !value.startsWith("sync-conflict");
}

export function resolveDeviceId(configPath?: string): string {
  // Env override: a valid id wins outright; the empty string opts out
  // of sharding (legacy single-file log pair). The test preload pins
  // this to "" so the suite stays deterministic; an invalid value
  // falls through to config resolution.
  const env = process.env["O2B_DEVICE_ID"];
  if (env !== undefined && (env === "" || isValidDeviceId(env))) return env;
  const resolved = configPath ?? defaultConfigPath();

  const read = (): string | null => {
    const value = discoverConfig(resolved).data["device_id"];
    return value && isValidDeviceId(value) ? value : null;
  };

  const existing = read();
  if (existing !== null) return existing;

  // First-use generation. Two processes racing here could each persist
  // a different id and split one device's logs across two shards, so
  // the read-generate-write sequence holds a directory lock (same
  // bounded-retry shape as the log writer's `acquireLogLock`). A
  // lock failure (read-only config home, exotic fs) falls through to
  // the unlocked path - identity resolution must never fail.
  const dir = dirname(resolved);
  mkdirSync(dir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        release = lockfile.lockSync(dir, { stale: 10_000, realpath: false });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ELOCKED") break;
        Bun.sleepSync(50);
      }
    }
    // Re-check under the lock: the racing process may have just won.
    const won = read();
    if (won !== null) return won;
    const generated = randomBytes(4).toString("hex");
    setConfigValue("device_id", generated, resolved);
    return generated;
  } finally {
    release?.();
  }
}

/**
 * Store-hardening escape hatch (D2). Default OFF: MCP responses redact
 * the absolute vault host path to an opaque store reference (see
 * {@link vaultStoreReference}) because those responses land in model
 * context - the exact leak surface this guards. Set
 * `expose_host_paths: true` (or the env twin) to restore the raw path
 * for operators whose tooling depends on it.
 */
export function resolveExposeHostPaths(configPath?: string): boolean {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS", "expose_host_paths", configPath);
}

/**
 * Device-local installation secret that keys {@link vaultStoreReference}.
 *
 * Sixteen random bytes (128-bit) rendered as 32 lowercase hex, generated
 * once and persisted beside `device_id` in the same device-local config.
 * Three properties make the store reference unguessable offline:
 *
 *   - it is NEVER synced (device-local config, like `device_id`);
 *   - it is NEVER derived from `device_id`, so the `O2B_DEVICE_ID=""`
 *     sharding opt-out (which makes the device id empty and predictable)
 *     cannot weaken it;
 *   - it has NO empty/predictable escape hatch: the only env override
 *     ({@link INSTALLATION_SECRET_ENV_KEY}, for deterministic tests) is
 *     honoured solely when it is itself a full 32-hex key.
 *
 * A missing or corrupt persisted value self-heals to a fresh key under the
 * same directory lock `resolveDeviceId` uses, so a concurrent first use
 * cannot split into two keys.
 */
export const INSTALLATION_SECRET_CONFIG_KEY = "installation_secret";
/** Test-only env override; honoured ONLY when it is a full 32-hex key. */
export const INSTALLATION_SECRET_ENV_KEY = "O2B_INSTALLATION_SECRET";
/** Strict shape: 32 lowercase hex = 16 bytes = a 128-bit key. */
export const INSTALLATION_SECRET_RE = /^[0-9a-f]{32}$/;

export function isValidInstallationSecret(value: string): boolean {
  return INSTALLATION_SECRET_RE.test(value);
}

export function resolveInstallationSecret(configPath?: string): string {
  // Env override exists for deterministic tests only, and is accepted solely
  // as a full 32-hex key so it can never make the secret empty or guessable.
  const env = process.env[INSTALLATION_SECRET_ENV_KEY];
  if (env !== undefined && isValidInstallationSecret(env)) return env;
  const resolved = configPath ?? defaultConfigPath();

  const read = (): string | null => {
    const value = discoverConfig(resolved).data[INSTALLATION_SECRET_CONFIG_KEY];
    return value && isValidInstallationSecret(value) ? value : null;
  };

  const existing = read();
  if (existing !== null) return existing;

  // First-use generation under a directory lock, mirroring resolveDeviceId:
  // a lock failure falls through to the unlocked path so secret resolution
  // never fails outright.
  const dir = dirname(resolved);
  mkdirSync(dir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        release = lockfile.lockSync(dir, { stale: 10_000, realpath: false });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ELOCKED") break;
        Bun.sleepSync(50);
      }
    }
    const won = read();
    if (won !== null) return won;
    const generated = randomBytes(16).toString("hex");
    setConfigValue(INSTALLATION_SECRET_CONFIG_KEY, generated, resolved);
    return generated;
  } finally {
    release?.();
  }
}

/** Prefix of the opaque store reference emitted in place of a host path. */
export const VAULT_STORE_REF_PREFIX = "vault://";
/** Hex length of the store-reference digest (128 bits of HMAC-SHA256). */
const VAULT_STORE_REF_HEX_LEN = 32;

/**
 * Stable opaque reference for a vault, of the form `vault://<32-hex>`.
 * Computed as HMAC-SHA256, keyed by the device-local
 * {@link resolveInstallationSecret}, over the ABSOLUTE vault path. The key
 * makes the reference unguessable offline (a plain hash of a common host
 * path is trivially reversible), and truncating to 128 bits keeps collisions
 * negligible. It is stable across calls on the same install (agents correlate
 * by it) and never leaks the raw path. Returned by MCP tools in place of the
 * absolute path unless {@link resolveExposeHostPaths} is on.
 */
export function vaultStoreReference(vaultPath: string, configPath?: string): string {
  const key = resolveInstallationSecret(configPath);
  const digest = createHmac("sha256", key)
    .update(resolve(vaultPath))
    .digest("hex")
    .slice(0, VAULT_STORE_REF_HEX_LEN);
  return `${VAULT_STORE_REF_PREFIX}${digest}`;
}

export function resolveLinkOutputFormat(configPath?: string): LinkOutputFormat {
  const env = process.env["OBSIDIAN_LINK_FORMAT"]?.trim();
  const data = env ? {} : discoverConfig(configPath).data;
  const raw = env || data["link_output_format"] || data["linkOutputFormat"];
  return raw === "markdown" ? "markdown" : "wikilink";
}

/**
 * Named MCP tool-surface profile (Agent Surface Suite). Returns the raw
 * configured name or null; validation against the known profile set
 * happens in the resolver, which fails open on unknown names.
 */
export function resolveMcpToolProfile(configPath?: string): string | null {
  const env = process.env["OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE"]?.trim();
  if (env) return env;
  const raw = discoverConfig(configPath).data["mcp_tool_profile"]?.trim();
  return raw ? raw : null;
}

/**
 * Optional skills directory override (Agent Surface Suite). When set,
 * `skills_attach` / `list_skills` / `get_skill` read from this path
 * instead of `<vault>/Brain/skills/`. Supports `~` expansion. A relative
 * value is anchored to the directory of the resolved config file so the
 * skill root is deterministic regardless of the process working
 * directory (a bare `skills_dir: nested/skills` would otherwise resolve
 * against an unpredictable CWD). Falls back to null (use the default
 * vault-local path).
 */
export function resolveSkillsDir(configPath?: string): string | null {
  const discovery = discoverConfig(configPath);
  const env = process.env["OPEN_SECOND_BRAIN_SKILLS_DIR"]?.trim();
  const raw = env || discovery.data["skills_dir"]?.trim();
  if (!raw || raw.length === 0) return null;
  const expanded = expandTilde(raw);
  return isAbsolute(expanded) ? expanded : resolve(dirname(discovery.path), expanded);
}

/**
 * Shared body for a default-OFF boolean config gate: env var (trimmed)
 * wins, falling back to the matching `_brain.yaml`/config key (trimmed);
 * only the literal strings `"true"`/`"1"` are truthy, anything else
 * (including absence) resolves to `false`. Replaces seven copy-pasted
 * resolver bodies that differed only in their env/config key names.
 */
function resolveConfigFlag(envKey: string, configKey: string, configPath?: string): boolean {
  const env = process.env[envKey]?.trim();
  const raw = env || discoverConfig(configPath).data[configKey]?.trim();
  return raw === "true" || raw === "1";
}

/**
 * Skill-attach triggers gate (Agent Surface Suite). When enabled (default
 * OFF), the `triggers` field from each skill's SKILL.md frontmatter is
 * included in the lexical scorer as a 2x-BM25 tag signal. When disabled
 * or unset, triggers are ignored and scoring is name (3x) + description
 * (1x) only.
 */
export function resolveSkillsAttachTriggers(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS",
    "skills_attach_triggers",
    configPath,
  );
}

/**
 * Skill auto-attach gate (Agent Surface Suite). Default OFF: the
 * skills_attach tool returns an empty block unless the operator sets
 * `skill_auto_attach: "true"` (or the matching env override), so the
 * default per-turn injection stays bit-identical.
 */
export function resolveSkillAutoAttach(configPath?: string): boolean {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH", "skill_auto_attach", configPath);
}

/**
 * Context-pack focus wiring gate (Agent Surface Suite, t_5b478e47).
 * Default OFF: brain_context_pack ignores the active search focus
 * unless `search_focus_context_pack: "true"`, keeping the default
 * pack byte-identical.
 */
export function resolveSearchFocusContextPack(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_SEARCH_FOCUS_CONTEXT_PACK",
    "search_focus_context_pack",
    configPath,
  );
}

/**
 * Context-pack density-ranking gate (impact-per-token allocation,
 * t_affa3bd9). Default OFF: brain_context_pack orders purely by tier →
 * recency unless `density_ranking_context_pack: "true"` (or the env
 * override), keeping the default pack byte-identical. When on, a
 * deterministic value-per-token density score breaks within-tier ties
 * (after session focus, before recency).
 */
export function resolveDensityRankingContextPack(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_DENSITY_RANKING_CONTEXT_PACK",
    "density_ranking_context_pack",
    configPath,
  );
}

/**
 * Post-compaction pinned-anchor survival audit gate
 * (session-lifecycle-capture-durability, t_12c8b256). Default OFF: the
 * `o2b brain post-compact-audit` entry is a no-op unless
 * `post_compact_survival_audit: "true"`, so unchanged installs run no
 * post-compaction re-assertion and stay byte-identical.
 */
export function resolvePostCompactSurvivalAudit(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT",
    "post_compact_survival_audit",
    configPath,
  );
}

/**
 * Post-compaction verbatim recent-turns re-surface gate (C3 / t_92317f91).
 * Default OFF: the bounded last-N-turns buffer is captured and readable on
 * demand, but nothing is auto-surfaced into the post-compaction context
 * unless `recent_turns_resurface: "true"`, so unchanged installs stay
 * byte-identical.
 */
export function resolveRecentTurnsResurface(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_RECENT_TURNS_RESURFACE",
    "recent_turns_resurface",
    configPath,
  );
}

/**
 * SessionEnd handoff-note gate (Agent Surface Suite, t_28afa4d2).
 * Default OFF: lifecycle capture writes no handoff note unless
 * `session_handoff: "true"`.
 */
export function resolveSessionHandoff(configPath?: string): boolean {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SESSION_HANDOFF", "session_handoff", configPath);
}

/**
 * Rated-decision recall config keys (Belief lifecycle suite, B5,
 * t_5712fa39). Both are OPTIONAL and default-OFF: when neither the env
 * nor the config key is set, {@link resolveDecisionRecallMaxPerSession}
 * returns `null`, which disables rated-decision recall entirely so the
 * session-injection output is byte-identical to today.
 */
export const DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY = "decision_recall.max_per_session";
export const DECISION_RECALL_MAX_PER_SESSION_ENV_KEY =
  "OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION";
export const DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY = "decision_recall.min_spacing_turns";
export const DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY =
  "OPEN_SECOND_BRAIN_DECISION_RECALL_MIN_SPACING_TURNS";

/**
 * Shared body for a non-negative-integer config value: env var (trimmed)
 * wins, falling back to the config key (trimmed). Returns `null` when
 * unset, blank, or not a non-negative integer, so an unconfigured value
 * leaves the caller's default behaviour intact.
 */
function resolveConfigNonNegativeInt(
  envKey: string,
  configKey: string,
  configPath?: string,
): number | null {
  const env = process.env[envKey]?.trim();
  const raw = env || discoverConfig(configPath).data[configKey]?.trim();
  if (!raw || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Max rated-decision recalls per session. `null` (the default) disables
 * the feature entirely - injection stays byte-identical.
 */
export function resolveDecisionRecallMaxPerSession(configPath?: string): number | null {
  return resolveConfigNonNegativeInt(
    DECISION_RECALL_MAX_PER_SESSION_ENV_KEY,
    DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY,
    configPath,
  );
}

/**
 * Minimum turns between two rated-decision recalls. `null` (unset)
 * resolves to `0` (no spacing) at the call site.
 */
export function resolveDecisionRecallMinSpacingTurns(configPath?: string): number | null {
  return resolveConfigNonNegativeInt(
    DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY,
    DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY,
    configPath,
  );
}

/**
 * Wikilink output format (Workspace Insight Suite, t_5f31b5f1).
 * Default `preserve` keeps every generated/normalized link exactly as
 * typed - byte-identical to pre-suite behaviour. `full` and `short`
 * select the rewrite mode for `o2b brain links normalize` and for
 * generators that adopt the kernel. An unknown value fails fast: a
 * typo must never silently rewrite links in the wrong mode.
 */
export function resolveWikiLinkFormat(configPath?: string): WikiLinkFormat {
  const env = process.env["OPEN_SECOND_BRAIN_WIKI_LINK_FORMAT"]?.trim();
  const raw = env || discoverConfig(configPath).data["wiki_link_format"]?.trim();
  if (raw === undefined || raw === "") return "preserve";
  if (!isWikiLinkFormat(raw)) {
    throw new Error(
      `wiki_link_format must be one of ${WIKI_LINK_FORMATS.join(", ")}; got '${raw}'`,
    );
  }
  return raw;
}

/**
 * Trigger cooldown window in days (Workspace Insight Suite,
 * t_cd1fee79): how long a dismissed/acted trigger blocks recreation
 * and how long a delivered trigger stays out of the morning brief.
 * Default 7. An invalid value fails fast.
 */
export function resolveTriggerCooldownDays(configPath?: string): number {
  const env = process.env["OPEN_SECOND_BRAIN_TRIGGER_COOLDOWN_DAYS"]?.trim();
  const raw = env || discoverConfig(configPath).data["trigger_cooldown_days"]?.trim();
  if (raw === undefined || raw === "") return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`trigger_cooldown_days must be a non-negative integer; got '${raw}'`);
  }
  return days;
}

/**
 * Recall-gate telemetry gate (Workspace Insight Suite, t_65036e02).
 * Default OFF: brain_recall_gate stays a pure diagnostic unless
 * `recall_gate_telemetry: "true"`, when every decision lands as a
 * gate_telemetry continuity record (prompt hash only, never the
 * prompt).
 */
export function resolveRecallGateTelemetry(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_RECALL_GATE_TELEMETRY",
    "recall_gate_telemetry",
    configPath,
  );
}

/**
 * Recall adequacy thresholds (retrieval-precision-quality-loop,
 * t_b8f66fec). Configurable floors that drive the sufficient / weak /
 * insufficient verdict over existing recall relevance scores. Defaults
 * mirror DEFAULT_RECALL_ADEQUACY_THRESHOLDS (0.6 / 0.3 / 1). Invalid
 * values fail fast rather than silently reverting to a default.
 */
export function resolveRecallAdequacyThresholds(configPath?: string): {
  sufficient: number;
  weak: number;
  minResults: number;
} {
  const data = discoverConfig(configPath).data;
  const sufficient = resolveAdequacyFloor(
    "recall_adequacy_sufficient",
    process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_SUFFICIENT"],
    data["recall_adequacy_sufficient"],
    0.6,
  );
  const weak = resolveAdequacyFloor(
    "recall_adequacy_weak",
    process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_WEAK"],
    data["recall_adequacy_weak"],
    0.3,
  );
  if (weak > sufficient) {
    throw new Error(
      `recall_adequacy_weak (${weak}) must not exceed recall_adequacy_sufficient (${sufficient})`,
    );
  }
  const minResults = resolveAdequacyMinResults(
    process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_MIN_RESULTS"],
    data["recall_adequacy_min_results"],
  );
  return { sufficient, weak, minResults };
}

function resolveAdequacyFloor(
  key: string,
  env: string | undefined,
  fileValue: string | undefined,
  fallback: number,
): number {
  const raw = (env?.trim() || fileValue?.trim()) ?? "";
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number in [0,1]; got '${raw}'`);
  }
  return value;
}

function resolveAdequacyMinResults(env: string | undefined, fileValue: string | undefined): number {
  const raw = (env?.trim() || fileValue?.trim()) ?? "";
  if (raw === "") return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`recall_adequacy_min_results must be a positive integer; got '${raw}'`);
  }
  return value;
}

/**
 * Generation-report tracing gate (Hindsight brain-loop ops, t_281c3edc).
 * Default OFF: the inbound `generation_report` continuity path stays
 * dormant unless `generation_trace_enabled: "true"`, when an agent's
 * post-handoff usage report lands as a continuity record (prompt hash
 * and counts only, never the prompt). A per-call option can still enable
 * a single report when the config gate is off.
 */
export function resolveGenerationTraceEnabled(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_GENERATION_TRACE_ENABLED",
    "generation_trace_enabled",
    configPath,
  );
}

/**
 * Route-level MCP latency metrics gate (context-pack-economics-
 * observability suite). Default OFF: the `mcp_route_latency` continuity
 * path stays dormant unless `mcp_route_metrics_enabled: "true"`, when the
 * MCP server records one payload-safe latency record per tool call (tool
 * name, scope, status, duration, and argument key names only - never
 * argument values). Fail-open: a failed record never fails the call.
 */
export function resolveMcpRouteMetricsEnabled(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED",
    "mcp_route_metrics_enabled",
    configPath,
  );
}

/**
 * Token-impact + context-pack-quality ledger gate (context-pack-economics-
 * observability suite). Default OFF: the `token_impact` / `token_impact_outcome`
 * continuity paths stay dormant unless `token_impact_ledger_enabled: "true"`,
 * when opt-in `record`/`outcome` posts to `brain_token_impact` persist the
 * tokenizer-exact prompt-token delta (baseline vs packed, method-labelled)
 * and modeled inference-avoidance calibration. Payload-safe: counts and an
 * opaque pack id only, never raw prompts or recalled text. Fail-open: a
 * failed write never fails the caller. Read paths (list/summary) ignore the
 * gate so historical aggregates stay inspectable after it is turned off.
 */
export function resolveTokenImpactLedgerEnabled(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_TOKEN_IMPACT_LEDGER_ENABLED",
    "token_impact_ledger_enabled",
    configPath,
  );
}

/**
 * Agent-operable context-pack outcome-loop gate (context-pack-economics-
 * observability suite, C5). Default OFF: the `context_pack_outcome`
 * continuity path (and its composed `token_impact_outcome` calibration
 * write) stays dormant unless `context_pack_outcome_enabled: "true"`, when
 * an opt-in `post` to `brain_context_pack_outcome` records one compact
 * outcome row - first-pass/repair/retry counters plus the three strictly
 * separate token signals (exact / modeled / observed) - correlated to a
 * carried context-pack quality-sample id. Payload-safe: counts and an
 * opaque sample id only, never raw prompts, completions, or recalled text.
 * Fail-open: a failed write never fails the caller. Read paths (list/
 * summary) ignore the gate so historical aggregates stay inspectable.
 */
export function resolveContextPackOutcomeEnabled(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED",
    "context_pack_outcome_enabled",
    configPath,
  );
}

/**
 * Prompt-time bounded recall-inject gate (recall-trust-and-write-surface,
 * A2 / t_2ce46130). Default OFF: the opt-in UserPromptSubmit recall-inject
 * hook stays a no-op unless `recall_inject_enabled: "true"` (or the matching
 * env override), when each user prompt relevance-recalls a small bounded,
 * clip-safe brief of vault notes and injects it as additionalContext. The
 * hook is fail-closed (any error or timeout injects nothing) and audited
 * (every inject/abstain/error decision writes one line). Flag off keeps the
 * prompt preamble byte-identical.
 */
export function resolveRecallInjectEnabled(configPath?: string): boolean {
  return resolveConfigFlag(
    "OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED",
    "recall_inject_enabled",
    configPath,
  );
}

/**
 * Knowledge-gap loop gate (recall-trust-and-write-surface, A3 /
 * t_67d38036). Default OFF: the opt-in session-start gap agenda and
 * session-end gap promotion/auto-close stay dormant unless
 * `gap_loop_enabled: "true"` (or the matching env override). Flag off keeps
 * the session preamble byte-identical and writes no gap-task notes.
 */
export function resolveGapLoopEnabled(configPath?: string): boolean {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED", "gap_loop_enabled", configPath);
}

/**
 * Optional gap-loop recurrence threshold override (A3). A valid positive
 * integer (env first, then config) wins; anything else returns undefined so
 * the caller falls back to the named-constant default. Env-overridable so an
 * operator can tune how often a gap must recur before it promotes to a task.
 */
export function resolveGapLoopThreshold(configPath?: string): number | undefined {
  const env = process.env["OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD"]?.trim();
  const raw = env || discoverConfig(configPath).data["gap_loop_threshold"]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/**
 * Optional external judge command for the memory benchmark (Memory
 * Observability Suite, t_882c396a). Unset (the default) means the
 * judge phase is skipped - the harness itself never calls an LLM.
 */
export function resolveBenchJudgeCmd(configPath?: string): string | undefined {
  const env = process.env["OPEN_SECOND_BRAIN_BENCH_JUDGE_CMD"]?.trim();
  const raw = env || discoverConfig(configPath).data["bench_judge_cmd"]?.trim();
  return raw !== undefined && raw !== "" ? raw : undefined;
}

export const SESSION_CAPTURE_ROLES = ["user", "assistant", "system", "tool", "meta"] as const;

export type SessionCaptureRole = (typeof SESSION_CAPTURE_ROLES)[number];

function isSessionCaptureRole(value: string): value is SessionCaptureRole {
  return (SESSION_CAPTURE_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * Config-level default for session-capture role filtering (Agent
 * Surface Suite, t_e2346fe9). `session_capture_roles` is a
 * comma-separated subset of user/assistant/system/tool/meta; absent or
 * empty means "capture every role" (null = no filter, bit-identical to
 * the pre-key behaviour). An unknown role name fails fast - a silent
 * typo here would silently drop memory.
 */
export function resolveSessionCaptureRoles(configPath?: string): SessionCaptureRole[] | null {
  const env = process.env["OPEN_SECOND_BRAIN_SESSION_CAPTURE_ROLES"]?.trim();
  const raw = env || discoverConfig(configPath).data["session_capture_roles"]?.trim();
  if (!raw) return null;
  const roles: SessionCaptureRole[] = [];
  for (const part of raw.split(",")) {
    const role = part.trim().toLowerCase();
    if (role.length === 0) continue;
    if (!isSessionCaptureRole(role)) {
      throw new Error(
        `session_capture_roles: unknown role "${role}" (expected a subset of ${SESSION_CAPTURE_ROLES.join(", ")})`,
      );
    }
    if (!roles.includes(role)) roles.push(role);
  }
  return roles.length > 0 ? roles : null;
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
