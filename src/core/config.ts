/**
 * Configuration discovery and persistence.
 *
 * Mirrors `src/open_second_brain/config.py` from the legacy Python implementation
 * — same lookup chain (env → XDG → ~/.config), same simple `key: value` YAML
 * subset, same atomic write semantics, same redaction policy. Tests pin parity
 * via parallel suites in tests/core/config.test.ts.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
import type { ConfigDiscovery } from "./types.ts";

const SECRET_KEY_PARTS = ["key", "token", "secret", "password", "credential"] as const;

const CONFIG_VALUE_REJECTED_CHARS = ['"', "\\", "\n", "\r"] as const;

export type LinkOutputFormat = "wikilink" | "markdown";

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
 * instead of `<vault>/Brain/skills/`. Supports `~` expansion.
 * Falls back to null (use the default vault-local path).
 */
export function resolveSkillsDir(configPath?: string): string | null {
  const env = process.env["OPEN_SECOND_BRAIN_SKILLS_DIR"]?.trim();
  const raw = env || discoverConfig(configPath).data["skills_dir"]?.trim();
  return raw && raw.length > 0 ? expandTilde(raw) : null;
}

/**
 * Skill-attach triggers gate (Agent Surface Suite). When enabled (default
 * OFF), the `triggers` field from each skill's SKILL.md frontmatter is
 * included in the lexical scorer as a 2x-BM25 tag signal. When disabled
 * or unset, triggers are ignored and scoring is name (3x) + description
 * (1x) only.
 */
export function resolveSkillsAttachTriggers(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS"]?.trim();
  const raw = env || discoverConfig(configPath).data["skills_attach_triggers"]?.trim();
  return raw === "true" || raw === "1";
}

/**
 * Skill auto-attach gate (Agent Surface Suite). Default OFF: the
 * skills_attach tool returns an empty block unless the operator sets
 * `skill_auto_attach: "true"` (or the matching env override), so the
 * default per-turn injection stays bit-identical.
 */
export function resolveSkillAutoAttach(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH"]?.trim();
  const raw = env || discoverConfig(configPath).data["skill_auto_attach"]?.trim();
  return raw === "true" || raw === "1";
}

/**
 * Context-pack focus wiring gate (Agent Surface Suite, t_5b478e47).
 * Default OFF: brain_context_pack ignores the active search focus
 * unless `search_focus_context_pack: "true"`, keeping the default
 * pack byte-identical.
 */
export function resolveSearchFocusContextPack(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_SEARCH_FOCUS_CONTEXT_PACK"]?.trim();
  const raw = env || discoverConfig(configPath).data["search_focus_context_pack"]?.trim();
  return raw === "true" || raw === "1";
}

/**
 * Post-compaction pinned-anchor survival audit gate
 * (session-lifecycle-capture-durability, t_12c8b256). Default OFF: the
 * `o2b brain post-compact-audit` entry is a no-op unless
 * `post_compact_survival_audit: "true"`, so unchanged installs run no
 * post-compaction re-assertion and stay byte-identical.
 */
export function resolvePostCompactSurvivalAudit(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT"]?.trim();
  const raw = env || discoverConfig(configPath).data["post_compact_survival_audit"]?.trim();
  return raw === "true" || raw === "1";
}

/**
 * SessionEnd handoff-note gate (Agent Surface Suite, t_28afa4d2).
 * Default OFF: lifecycle capture writes no handoff note unless
 * `session_handoff: "true"`.
 */
export function resolveSessionHandoff(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_SESSION_HANDOFF"]?.trim();
  const raw = env || discoverConfig(configPath).data["session_handoff"]?.trim();
  return raw === "true" || raw === "1";
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
  const env = process.env["OPEN_SECOND_BRAIN_RECALL_GATE_TELEMETRY"]?.trim();
  const raw = env || discoverConfig(configPath).data["recall_gate_telemetry"]?.trim();
  return raw === "true" || raw === "1";
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
  const env = process.env["OPEN_SECOND_BRAIN_GENERATION_TRACE_ENABLED"]?.trim();
  const raw = env || discoverConfig(configPath).data["generation_trace_enabled"]?.trim();
  return raw === "true" || raw === "1";
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
