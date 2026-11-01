/**
 * Open Second Brain plugin for opencode (https://opencode.ai).
 *
 * Installed by `o2b install --target opencode --apply` into
 * `~/.config/opencode/plugins/open-second-brain.ts`. The file is
 * deliberately self-contained (no imports beyond node builtins and the
 * Bun globals opencode already provides) so the copy works standalone
 * inside opencode's plugin sandbox.
 *
 * Supports OpenCode V1 (server) and V2 (setup). Five behaviors mirror
 * the Claude Code / Codex hook layer:
 *
 * 1. Active-context inject: V1 `experimental.chat.system.transform` /
 *    V2 `session.hook("context")`
 *    spawns the bundled `o2b-hook active-inject` PATH shim (override:
 *    `OSB_HOOK_BIN`) with a synthetic SessionStart payload and appends
 *    `hookSpecificOutput.additionalContext` to the system prompt.
 *    Vault resolution, budgeting, and quiet-failure semantics are
 *    inherited from the shim rather than reimplemented here.
 *
 * 2. Session capture: V1 snapshots the full message list on idle,
 *    compaction, or deletion; V2 snapshots active context on idle and
 *    before/after compaction, merging with earlier snapshots to retain
 *    history. The deterministic JSONL spool lives under
 *    `${XDG_DATA_HOME:-~/.local/share}/open-second-brain/opencode/`
 *    (`%LOCALAPPDATA%\\open-second-brain\\opencode\\` on native Windows)
 *    (override: `OSB_OPENCODE_SPOOL_DIR`). The spool format is owned
 *    by Open Second Brain (`format: 1`); `o2b brain import-session`
 *    pointed at the spool dir ingests it via the `opencode` session
 *    adapter. Snapshot-rewrite, not append: idempotent and
 *    self-healing after crashes.
 *
 * 3. Post-write reminder: V1 `tool.execute.after` /
 *    V2 `tool.hook("execute.after")` appends the standard
 *    logging nudge to the output of file-mutating tools so the model
 *    sees it, matching the Claude Code post-write-reminder contract.
 *
 * 4. Tool gating: V1 `tool.execute.before` /
 *    V2 `tool.hook("execute.before")` relays the opt-in PreToolUse
 *    shims (`pretool-orient`, `pretool-host-backup`) with synthetic
 *    PreToolUse payloads carrying the opencode session id. Only an
 *    explicit structured `permissionDecision: "deny"` throws (with the
 *    shim's `permissionDecisionReason` as the error text) - the one
 *    blocking channel opencode offers. Every other outcome (flag off,
 *    missing binary, spawn failure, timeout, malformed stdout) passes
 *    the tool call untouched, because a plugin bug must never break
 *    operator tool calls on a lane without the Claude Code wrapper's
 *    forced exit-0 safety net. The Claude Code "nudge on allow"
 *    downgrade has no channel on a tool call here and is declared as a
 *    divergence in the opencode hook parity census.
 *
 * 5. Prompt-time injection: V1 `chat.message` /
 *    V2 `session.hook("prompt")` observes the user prompt and relays
 *    the opt-in UserPromptSubmit shims (`recall-inject`, `nav-inject`,
 *    `counterparty-brief`, `reground-deliver`) with synthetic payloads
 *    carrying the opencode session id, so the vault hook-state ledger
 *    dedupes exactly as on the Claude Code lane. The shims'
 *    `hookSpecificOutput.additionalContext` enters a single-slot
 *    per-turn queue that the context delivery points drain on the first
 *    model request of the turn - the prompt hook itself runs before
 *    durable prompt admission and is not a delivery channel.
 *
 * Every hook body is fail-soft: a missing vault, missing binary, or
 * session API error must never break the operator's opencode session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SPOOL_FORMAT = 1;
const SPOOL_ORIGINATOR = "open-second-brain-opencode-plugin";
const CAPTURE_EVENTS = new Set(["session.idle", "session.compacted", "session.deleted"]);
const V2_CAPTURE_EVENTS = new Set([
  // v2 tree naming: the turn ends with an idle event.
  "session.idle",
  // v2 >= 2.0.24 naming: the turn ends with an execution event, and a
  // failed or interrupted run still leaves messages worth capturing.
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.revert.committed",
  "session.deleted",
]);
const MUTATING_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);

/**
 * The host marker the synthetic hook payloads carry, and `hooks/lib/
 * detect.ts` answers with the `opencode` runtime - the honest answer to
 * "which harness is calling", where a fabricated Claude Code
 * `tool_use_id` would mislabel every audit row this lane writes. The
 * two literals are one contract stated in both files (this file is
 * copied alone into opencode's plugin directory and cannot import it).
 */
const PAYLOAD_HOST_MARKER = "opencode";

/**
 * opencode's tool names, translated onto the Claude Code spellings the
 * shim decision cores parse. The relay's design is a synthetic
 * Claude-Code-shaped payload, so the translation lives here rather than
 * in the shims: opencode names its file tools in lowercase, and the
 * cores' tool sets are exact-match. Any name outside the table passes
 * verbatim.
 */
const PRETOOL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  read: "Read",
  edit: "Edit",
  write: "Write",
  multiedit: "MultiEdit",
  patch: "apply_patch",
  apply_patch: "apply_patch",
});

/**
 * opencode names MCP tools `<server>_<tool>` with a single underscore,
 * so the Brain surfaces arrive as `open-second-brain_brain_search` and
 * the decision cores' suffix matchers - built for the `mcp__` double
 * underscore spellings - never fire. The relay strips the server prefix
 * from a Brain tool name, so an orientation refresh and every
 * brain-tool branch of the cores see the bare name.
 */
function translateToolName(tool: string): string {
  const mapped = PRETOOL_TOOL_NAMES[tool.toLowerCase()] ?? tool;
  const brainIndex = mapped.toLowerCase().indexOf("_brain_");
  return brainIndex >= 0 ? mapped.slice(brainIndex + 1) : mapped;
}
const ACTIVE_CONTEXT_TTL_MS = 5 * 60 * 1000;
/** A failed render retries sooner than a successful one expires. */
const ACTIVE_CONTEXT_NEGATIVE_TTL_MS = 30 * 1000;
const HOOK_TIMEOUT_MS = 10_000;

/**
 * The PreToolUse relay: the shims the execute.before gate spawns and the
 * default-OFF flag each one answers to. The env/config key pairs restate
 * the canonical resolvers in src/core/config.ts exactly as the hook
 * wrappers' stdlib twins do, so a flag the shim would honor is one this
 * gate spawns for (and flags off mean zero spawns). `mutatingOnly`
 * mirrors the Claude Code host-backup row matcher
 * (Write|Edit|MultiEdit|apply_patch).
 */
const PRETOOL_SHIMS: ReadonlyArray<{
  readonly name: string;
  readonly envKey: string;
  readonly configKey: string;
  readonly mutatingOnly?: boolean;
}> = [
  {
    name: "pretool-orient",
    envKey: "OPEN_SECOND_BRAIN_HOOK_STRICT_ENABLED",
    configKey: "hook_strict_enabled",
  },
  {
    name: "pretool-host-backup",
    envKey: "OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP",
    configKey: "host_settings_backup",
    mutatingOnly: true,
  },
];

/**
 * The UserPromptSubmit relay: the prompt-time shims and the default-OFF
 * flag each answers to, restated from src/core/config.ts exactly as the
 * PreToolUse pairs above. The opencode prompt hook observes the prompt
 * before durable admission and is not a delivery channel, so the shims'
 * additionalContext rides the per-turn queue below instead.
 */
const PROMPT_SHIMS: ReadonlyArray<{
  readonly name: string;
  readonly envKey: string;
  readonly configKey: string;
}> = [
  {
    name: "recall-inject",
    envKey: "OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED",
    configKey: "recall_inject_enabled",
  },
  {
    name: "nav-inject",
    envKey: "OPEN_SECOND_BRAIN_NAV_TIER_ENABLED",
    configKey: "nav_tier_enabled",
  },
  {
    name: "counterparty-brief",
    envKey: "OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED",
    configKey: "counterparty_brief_enabled",
  },
  {
    name: "reground-deliver",
    envKey: "OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED",
    configKey: "reground_parts_enabled",
  },
];

/** Disambiguates concurrent spool writes within one process. */
let spoolWriteSeq = 0;

const POST_WRITE_NUDGE =
  "Open Second Brain: artifact written. If a taste signal or scoped " +
  "preference applies, call brain_feedback / brain_apply_evidence / " +
  "brain_note (full contract earlier in this session).";

interface SpoolTurn {
  readonly type: "turn";
  readonly turnId: string;
  readonly timestamp: string;
  readonly role: "user" | "assistant" | "system";
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly id?: string;
    readonly input: Record<string, unknown>;
  }>;
}

function spoolDir(): string {
  const override = process.env["OSB_OPENCODE_SPOOL_DIR"];
  if (override && override.length > 0) return override;
  const xdg = process.env["XDG_DATA_HOME"];
  // Mirrors `dataBaseDir` in src/core/platform-dirs.ts (this file is copied
  // into opencode's plugin directory and cannot import it): XDG wins, then
  // %LOCALAPPDATA% on native Windows, then ~/.local/share.
  const local = process.env["LOCALAPPDATA"];
  let base: string;
  if (xdg && xdg.length > 0) base = xdg;
  else if (process.platform !== "win32") base = join(homedir(), ".local", "share");
  else base = local && local.length > 0 ? local : join(homedir(), "AppData", "Local");
  return join(base, "open-second-brain", "opencode");
}

function sanitizeSessionId(id: string): string | null {
  const name = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (name.length === 0 || /^\.{1,2}$/.test(name)) return null;
  return name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractSessionId(properties: unknown): string | null {
  const props = asRecord(properties);
  if (!props) return null;
  if (typeof props["sessionID"] === "string") return props["sessionID"];
  const info = asRecord(props["info"]);
  if (info && typeof info["id"] === "string") return info["id"];
  const session = asRecord(props["session"]);
  if (session && typeof session["id"] === "string") return session["id"];
  return null;
}

/**
 * Normalizes a V1 SDK message (`{info, parts}`) or a V2 session message
 * (`{id, type, text|content}`) into a spool turn.
 * Unknown roles and empty messages return null and are skipped: the
 * spool only carries what the session adapter understands.
 */
function normalizeMessage(message: unknown): SpoolTurn | null {
  const m = asRecord(message);
  if (!m) return null;
  const info = asRecord(m["info"]) ?? m;
  if (!info || typeof info["id"] !== "string") return null;
  const role = info["role"] ?? info["type"];
  if (role !== "user" && role !== "assistant" && role !== "system") return null;

  const time = asRecord(info["time"]);
  const created = time && typeof time["created"] === "number" ? time["created"] : null;
  const timestamp = created !== null ? new Date(created).toISOString() : new Date(0).toISOString();

  const texts: string[] = [];
  const toolCalls: Array<{ name: string; id?: string; input: Record<string, unknown> }> = [];
  if (typeof m["text"] === "string" && m["text"].length > 0) texts.push(m["text"]);
  const parts = Array.isArray(m["parts"])
    ? m["parts"]
    : Array.isArray(m["content"])
      ? m["content"]
      : [];
  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (!part) continue;
    if (part["type"] === "text" && typeof part["text"] === "string" && part["text"].length > 0) {
      texts.push(part["text"]);
    } else if (part["type"] === "tool") {
      const tool = typeof part["tool"] === "string" ? part["tool"] : part["name"];
      if (typeof tool !== "string") continue;
      const state = asRecord(part["state"]);
      const input = state ? (asRecord(state["input"]) ?? {}) : {};
      toolCalls.push({
        name: tool,
        ...(typeof part["callID"] === "string"
          ? { id: part["callID"] }
          : typeof part["id"] === "string"
            ? { id: part["id"] }
            : {}),
        input,
      });
    }
  }
  if (texts.length === 0 && toolCalls.length === 0) return null;
  return {
    type: "turn",
    turnId: info["id"],
    timestamp,
    role,
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/**
 * Deterministic snapshot write: same messages produce a byte-identical
 * file (no wall-clock fields), so repeated `session.idle` events are
 * no-ops for downstream content-hash dedup. Atomic via tmp + rename.
 */
function writeSpool(
  sessionId: string,
  directory: string,
  messages: unknown[],
  preserveExisting = false,
  revertTo?: string,
): void {
  const name = sanitizeSessionId(sessionId);
  if (name === null) return;
  const meta = {
    type: "session_meta",
    originator: SPOOL_ORIGINATOR,
    format: SPOOL_FORMAT,
    session_id: sessionId,
    directory,
  };
  const dir = spoolDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${name}.jsonl`);
  const turns = new Map<string, SpoolTurn | null>();
  if (preserveExisting) {
    try {
      const lines = readFileSync(target, "utf8").trimEnd().split("\n");
      const previous = asRecord(JSON.parse(lines[0]!));
      if (previous?.["session_id"] === sessionId && previous["format"] === SPOOL_FORMAT) {
        // Include control-message IDs so a revert can target a non-transcript boundary.
        if (Array.isArray(previous["message_ids"])) {
          for (const id of previous["message_ids"]) {
            if (typeof id === "string") turns.set(id, null);
          }
        }
        for (const line of lines.slice(1)) {
          const turn = asRecord(JSON.parse(line));
          if (turn?.["type"] === "turn" && typeof turn["turnId"] === "string") {
            turns.set(turn["turnId"], turn as unknown as SpoolTurn);
          }
        }
      }
    } catch {
      // A missing or incomplete previous snapshot must not block a fresh one.
    }
  }
  if (revertTo !== undefined) {
    const ids = Array.from(turns.keys());
    const boundary = ids.indexOf(revertTo);
    if (boundary === -1) {
      // An older or missed snapshot cannot locate the boundary safely.
      // Rebuild from authoritative context rather than reintroducing removed turns.
      console.warn(
        "Open Second Brain: revert boundary was not captured; rebuilding from active context",
      );
      turns.clear();
    } else {
      for (const id of ids.slice(boundary)) turns.delete(id);
    }
  }
  for (const message of messages) {
    const record = asRecord(message);
    const info = asRecord(record?.["info"]) ?? record;
    if (typeof info?.["id"] === "string") turns.set(info["id"], normalizeMessage(message));
  }
  const lines = [
    JSON.stringify({
      ...meta,
      ...(preserveExisting ? { message_ids: Array.from(turns.keys()) } : {}),
    }),
    ...Array.from(turns.values())
      .filter((turn) => turn !== null)
      .map((turn) => JSON.stringify(turn)),
  ];
  spoolWriteSeq += 1;
  const tmp = join(dir, `.${name}.jsonl.tmp-${process.pid}-${spoolWriteSeq}`);
  writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
  renameSync(tmp, target);
}

/** Pulls the message list out of the SDK response defensively. */
function messageList(response: unknown): unknown[] | null {
  if (Array.isArray(response)) return response;
  const r = asRecord(response);
  if (r && Array.isArray(r["data"])) return r["data"];
  return null;
}

/**
 * The machine config path, matching the core default: the XDG layout on
 * POSIX, `%LOCALAPPDATA%\open-second-brain\config.yaml` on native
 * Windows (the same resolution `src/core/platform-dirs.ts` and the
 * spool-dir resolver below make, so a flag the shims honor is one this
 * relay reads); the env override wins. A missing file means every flag
 * is off.
 */
function osbConfigPath(): string {
  const override = process.env["OPEN_SECOND_BRAIN_CONFIG"]?.trim();
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  let base: string;
  if (xdg && xdg.length > 0) {
    base = xdg;
  } else if (process.platform === "win32") {
    base = process.env["LOCALAPPDATA"]?.trim() || join(homedir(), "AppData", "Local");
  } else {
    base = join(homedir(), ".config");
  }
  return join(base, "open-second-brain", "config.yaml");
}

/**
 * Cut an unquoted trailing `#...` comment: one scan tracking quote
 * state, so a `#` INSIDE a quoted value (a vault path like
 * `/data/brain#main`) stays whole. The stdlib twin of the canonical
 * resolver's quote-aware YAML parsing, as shipped in the hook wrappers.
 */
function stripUnquotedComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return value.slice(0, i);
    }
  }
  return value;
}

/**
 * Default-OFF flag read: env (trimmed) wins, then a top-level `key:` in
 * the machine config; only literal `true`/`1` is truthy. The stdlib twin
 * of `resolveConfigFlag` in src/core/config.ts (this file is copied
 * alone into opencode's plugin directory and cannot import it), agreeing
 * with the hook wrappers so a flag the shims honor is one the relay
 * spawns for; anything else reads off, which keeps the default path at
 * zero spawns.
 */
function configFlagOn(envKey: string, configKey: string): boolean {
  const env = process.env[envKey]?.trim();
  if (env) return env === "true" || env === "1";
  let text: string;
  try {
    text = readFileSync(osbConfigPath(), "utf8");
  } catch {
    return false;
  }
  // Anchored at column 0: a top-level YAML key has no indentation, and
  // an indented match would arm the gate off a key nested under some
  // other mapping - the canonical resolver reads top-level keys only.
  const match = new RegExp(`^${configKey}\\s*:\\s*(.+?)\\s*$`, "m").exec(text);
  if (match === null) return false;
  const value = stripUnquotedComment(match[1]!)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value === "true" || value === "1";
}

/**
 * One shim spawn, through `hookCommand` - the only `Bun.spawnSync` site
 * in this file, so every relay ride keeps the Windows current-directory
 * planting guard. Never throws and never decides: every failure mode
 * (binary missing, spawn error, timeout, non-zero exit) collapses to
 * `ok: false` so callers fail soft.
 */
function spawnHookShim(
  shim: string,
  payload: Record<string, unknown>,
): { ok: boolean; stdout: string } {
  try {
    const bin = process.env["OSB_HOOK_BIN"] ?? "o2b-hook";
    const command = hookCommand(bin, shim);
    if (command === null) return { ok: false, stdout: "" };
    const proc = Bun.spawnSync(command.argv, {
      stdin: Buffer.from(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "ignore",
      timeout: HOOK_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      env: command.env,
    });
    if (!proc.success) return { ok: false, stdout: "" };
    return { ok: true, stdout: proc.stdout.toString("utf8").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * The relay's verdict: exactly the three fields it reads from shim
 * stdout. Malformed or empty output parses as a pass with no context,
 * so a shim that answers garbage can never block a tool call and never
 * injects.
 */
function readHookVerdict(stdout: string): {
  deny: boolean;
  reason: string | null;
  context: string | null;
} {
  const pass = { deny: false, reason: null, context: null };
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(stdout));
  } catch {
    return pass;
  }
  const hookOutput = parsed !== null ? asRecord(parsed["hookSpecificOutput"]) : null;
  if (hookOutput === null) return pass;
  const reason = hookOutput["permissionDecisionReason"];
  const context = hookOutput["additionalContext"];
  return {
    deny: hookOutput["permissionDecision"] === "deny",
    reason: typeof reason === "string" && reason.length > 0 ? reason : null,
    context: typeof context === "string" && context.length > 0 ? context : null,
  };
}

/** Spawn one shim and read its verdict; a failed spawn passes. */
function spawnHookVerdict(
  shim: string,
  payload: Record<string, unknown>,
): { deny: boolean; reason: string | null; context: string | null } {
  const spawned = spawnHookShim(shim, payload);
  if (!spawned.ok) return { deny: false, reason: null, context: null };
  return readHookVerdict(spawned.stdout);
}

/**
 * Renders the active-context block by spawning the same
 * `o2b-hook active-inject` shim the Claude Code and Codex hook layers
 * use. Returns null on every failure mode (binary missing, timeout,
 * empty or malformed output) — the caller treats null as "no inject".
 */
function renderActiveContext(cwd: string): string | null {
  const spawned = spawnHookShim("active-inject", { hook_event_name: "SessionStart", cwd });
  if (!spawned.ok) return null;
  return readHookVerdict(spawned.stdout).context;
}

/**
 * opencode's tool input onto the snake_case keys the shim decision
 * cores read: the camelCase `filePath` the host passes is copied to
 * `file_path`, everything else rides verbatim. A non-object input
 * becomes the empty payload the shims answer allow to.
 */
function translateToolInput(toolInput: unknown): Record<string, unknown> {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) return {};
  const source = toolInput as Record<string, unknown>;
  const translated: Record<string, unknown> = { ...source };
  if (typeof source["filePath"] === "string" && translated["file_path"] === undefined) {
    translated["file_path"] = source["filePath"];
  }
  // opencode's patch tool carries the diff body under its own key; the
  // Codex apply_patch shape the backup shim parses reads `input`.
  if (typeof source["patchText"] === "string" && translated["input"] === undefined) {
    translated["input"] = source["patchText"];
  }
  return translated;
}

/**
 * The execute.before gate: relay each opt-in PreToolUse shim with a
 * synthetic Claude-Code-shaped payload - the host's tool name and
 * argument keys translated onto the spellings the shim decision cores
 * parse (`pretool-orient` reads `Read` and `file_path`; the backup shim
 * reads the Write/Edit family), and an explicit `hook_host` marker so
 * runtime detection answers `opencode` instead of guessing. The pure
 * decision cores and the vault hook-state ledger see the same view the
 * Claude Code lane sees, and the audit trail records the translated
 * spellings - the census declares that divergence.
 *
 * Fail-soft by construction: only an explicit structured
 * `permissionDecision: "deny"` throws, carrying the shim's
 * `permissionDecisionReason` - the one blocking channel opencode
 * offers. A flag that is off (which also means zero spawns), a missing
 * binary, a spawn failure, a timeout, malformed stdout, and an
 * untranslatable payload all pass the tool call untouched.
 */
function runPretoolGate(call: {
  tool: string;
  sessionId: string | null;
  toolInput: unknown;
  cwd: string;
}): void {
  let payload: Record<string, unknown>;
  try {
    payload = {
      hook_event_name: "PreToolUse",
      ...(call.sessionId !== null ? { session_id: call.sessionId } : {}),
      hook_host: PAYLOAD_HOST_MARKER,
      tool_name: translateToolName(call.tool),
      tool_input: translateToolInput(call.toolInput),
      cwd: call.cwd,
    };
  } catch {
    return; // a payload this host shape breaks is not a deny: pass
  }
  const mutating = MUTATING_TOOLS.has(call.tool.toLowerCase());
  for (const shim of PRETOOL_SHIMS) {
    if (!configFlagOn(shim.envKey, shim.configKey)) continue;
    if (shim.mutatingOnly === true && !mutating) continue;
    const verdict = spawnHookVerdict(shim.name, payload);
    if (verdict.deny) {
      throw new Error(
        verdict.reason ?? `Open Second Brain: the ${shim.name} gate denied this tool call.`,
      );
    }
  }
}

/**
 * The per-turn queue for prompt-time context, keyed by SESSION. The
 * plugin instance is server-wide: every session on the opencode host
 * shares one queue object, so a single slot would deliver one session's
 * recalled vault context into another session's model request and let
 * any background request consume the turn's injection. Each session
 * owns a single slot: its prompt starts a new turn (replacing any
 * payload a previous prompt left undelivered), every answering shim
 * appends into that session's slot, and the first model request
 * belonging to the session drains it exactly once - the context hooks
 * fire per model request, so a turn with several requests would
 * otherwise inject the shim payload repeatedly. Events that name no
 * session share one session-less bucket, which is the pre-keying
 * behavior for hosts that never identify the session. The take-once
 * cursor of the reground carrier is the pattern; the active inject's
 * TTL cache is deliberately untouched.
 */
function promptContextQueue(): {
  beginTurn(sessionId: string | null): void;
  offer(sessionId: string | null, text: string): void;
  take(sessionId: string | null): string | null;
} {
  const slots = new Map<string, string | null>();
  const slotKey = (sessionId: string | null): string => sessionId ?? "";
  return {
    beginTurn(sessionId) {
      slots.set(slotKey(sessionId), null);
    },
    offer(sessionId, text) {
      const key = slotKey(sessionId);
      const current = slots.get(key);
      slots.set(key, current === null || current === undefined ? text : `${current}\n\n${text}`);
    },
    take(sessionId) {
      if (sessionId !== null) {
        const value = slots.get(sessionId) ?? null;
        // Deleted, not nulled: the plugin instance is server-wide and
        // the map would otherwise grow one entry per session forever.
        slots.delete(sessionId);
        return value;
      }
      // A delivery input that names no session (older hosts) may drain
      // THE one pending slot - unambiguous while exactly one session has
      // context queued, and silence otherwise, which keeps the
      // cross-session guarantee intact.
      const pending = [...slots.entries()].filter(([, value]) => value !== null);
      if (pending.length !== 1) return null;
      const [key] = pending[0]!;
      const value = slots.get(key) ?? null;
      slots.delete(key);
      return value;
    },
  };
}

/** The session id a context-delivery input names, when it names one. */
function contextSessionId(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;
  const direct = record["sessionID"] ?? record["sessionId"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const message = asRecord(record["message"]);
  const nested = message?.["sessionID"] ?? message?.["sessionId"];
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

/**
 * The user text of one prompt event, across the shapes upstream releases
 * have shipped: the text rides the event record, its `message`, or the
 * output's `message`/text `parts` (the documented V1 `chat.message`
 * shape, whose input carries only session/agent/model ids).
 */
function observePromptText(record: Record<string, unknown>, output: unknown): string | null {
  for (const candidate of [record, asRecord(record["message"])]) {
    if (candidate === null) continue;
    const value = candidate["prompt"] ?? candidate["text"];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const outRecord = asRecord(output);
  if (outRecord !== null) {
    const message = asRecord(outRecord["message"]);
    const messageText = message?.["text"] ?? message?.["content"];
    if (typeof messageText === "string" && messageText.length > 0) return messageText;
    // Text parts ride the output directly on one shape and inside its
    // message on the other; both spellings are joined in part order.
    for (const parts of [outRecord["parts"], message?.["parts"]]) {
      if (!Array.isArray(parts)) continue;
      const text = parts
        .map((part) => (asRecord(part)?.["type"] === "text" ? asRecord(part)?.["text"] : null))
        .filter((value): value is string => typeof value === "string")
        .join("");
      if (text.length > 0) return text;
    }
  }
  return null;
}

/**
 * Best-effort read of a V1 `chat.message` / V2 `prompt` event: the
 * prompt text plus the opencode session id (the ledger inside the vault
 * hook-state dedupes on it). The id is taken only where a SESSION id can
 * appear - the record or its message's `sessionID`, or the `session`
 * record's own id - never a top-level or message `id`, which on the
 * documented V1 shape is a MESSAGE id and would key the per-session
 * ledger per message.
 */
function observePrompt(
  event: unknown,
  output?: unknown,
): { prompt: string | null; sessionId: string | null } {
  const record = asRecord(event);
  if (record === null) return { prompt: null, sessionId: null };
  const prompt = observePromptText(record, output);
  let sessionId: string | null = null;
  for (const candidate of [record, asRecord(record["message"]), asRecord(record["session"])]) {
    if (candidate === null) continue;
    const value =
      candidate === record || candidate === asRecord(record["message"])
        ? candidate["sessionID"]
        : (candidate["id"] ?? candidate["sessionID"]);
    if (typeof value === "string" && value.length > 0) {
      sessionId = value;
      break;
    }
  }
  return { prompt, sessionId };
}

/**
 * The prompt lane: relay each opt-in UserPromptSubmit shim with a
 * synthetic Claude-Code-shaped payload carrying the opencode session id,
 * so the vault hook-state ledger (recall once per session, brief on the
 * first qualifying turn, reground's take-once cursor) dedupes exactly as
 * on the Claude Code lane. Returned additionalContext enters the
 * per-turn queue; nothing here throws - a broken shim or a flag that is
 * off (zero spawns) just means no context this turn.
 */
function runPromptShims(call: {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  queue: ReturnType<typeof promptContextQueue>;
}): void {
  call.queue.beginTurn(call.sessionId);
  const payload: Record<string, unknown> = {
    hook_event_name: "UserPromptSubmit",
    ...(call.sessionId !== null ? { session_id: call.sessionId } : {}),
    prompt: call.prompt,
    cwd: call.cwd,
  };
  for (const shim of PROMPT_SHIMS) {
    if (!configFlagOn(shim.envKey, shim.configKey)) continue;
    const verdict = spawnHookVerdict(shim.name, payload);
    if (verdict.context !== null) call.queue.offer(call.sessionId, verdict.context);
  }
}

/** Each loaded plugin instance has its own short-lived active-context cache. */
function activeContextFor(cwd: string): () => string | null {
  let cache: { value: string | null; at: number } | null = null;
  return () => {
    const now = Date.now();
    const ttl = cache?.value === null ? ACTIVE_CONTEXT_NEGATIVE_TTL_MS : ACTIVE_CONTEXT_TTL_MS;
    if (cache === null || now - cache.at > ttl) {
      cache = { value: renderActiveContext(cwd), at: now };
    }
    return cache.value;
  };
}

/**
 * How to start the `o2b-hook` shim `bin` (a bare name or a path) with the
 * subcommand `shim` (the hook entry point, e.g. `active-inject`), or null
 * when it cannot be found. The single argv builder for every spawn in
 * this file - no second builder may appear, or the Windows guard below
 * stops covering the new site.
 *
 * POSIX: `bin` itself - `execvp` searches PATH only.
 *
 * Native Windows: the shim is `o2b-hook.cmd`, which Bun.spawn cannot start
 * from a bare name (it resolves `.exe` only), so it runs through cmd.exe.
 * But cmd.exe looks for a bare name in the current directory before PATH,
 * and opencode runs in the project it opened: `cmd /c o2b-hook` would run
 * an `o2b-hook.cmd` that repository ships. So the name is resolved to an
 * absolute path here first, with `Bun.which` (PATH only, never the
 * current directory), and cmd gets that path - quoted as a whole with
 * `/s`, the form Node uses for `shell: true`, so spaces and parentheses in
 * it survive. `NoDefaultCurrentDirectoryInExePath` covers the launcher's
 * own `bun` lookup as well. `OSB_HOOK_BIN` is operator-controlled; the
 * resolved path is the only non-literal in the command line.
 */
function hookCommand(
  bin: string,
  shim: string,
): {
  readonly argv: string[];
  readonly verbatim: boolean;
  readonly env: Record<string, string | undefined> | undefined;
} | null {
  if (process.platform !== "win32") return { argv: [bin, shim], verbatim: false, env: undefined };
  const resolved = Bun.which(bin, { PATH: process.env["PATH"] ?? "" });
  if (resolved === null) return null;
  const comspec = process.env["ComSpec"];
  const systemRoot = process.env["SystemRoot"] || "C:\\Windows";
  return {
    argv: [
      comspec && comspec.length > 0 ? comspec : join(systemRoot, "System32", "cmd.exe"),
      "/d",
      "/s",
      "/c",
      `""${resolved}" ${shim}"`,
    ],
    verbatim: true,
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
  };
}

/**
 * V1 entry point, called through the default export's server() method.
 */
const openSecondBrainV1 = async (pluginInput: {
  client: unknown;
  project?: unknown;
  directory?: string;
  worktree?: string;
}) => {
  const directory = typeof pluginInput.directory === "string" ? pluginInput.directory : "";
  const worktree = typeof pluginInput.worktree === "string" ? pluginInput.worktree : "";
  // Anchor active-inject to the real project scope, not an arbitrary dir.
  const injectCwd = worktree || directory || process.cwd();
  const client = asRecord(pluginInput.client);
  const getActiveContext = activeContextFor(injectCwd);
  const promptQueue = promptContextQueue();

  async function captureSession(sessionId: string): Promise<void> {
    const session = client ? asRecord(client["session"]) : null;
    const messages = session ? session["messages"] : null;
    if (typeof messages !== "function") return;
    // Invoke as a method bound to `session`: the opencode SDK client
    // dereferences `this._client` internally, so a detached call
    // (`messages(...)`) throws "undefined is not an object". Reflect.apply
    // carries the receiver without re-narrowing the SDK's untyped shape.
    const response: unknown = await Reflect.apply(messages, session, [{ path: { id: sessionId } }]);
    const list = messageList(response);
    if (list === null) return;
    writeSpool(sessionId, directory, list);
  }

  return {
    event: async ({ event }: { event: { type?: string; properties?: unknown } }) => {
      try {
        if (typeof event?.type !== "string" || !CAPTURE_EVENTS.has(event.type)) return;
        const sessionId = extractSessionId(event.properties);
        if (sessionId === null) return;
        await captureSession(sessionId);
      } catch {
        // Capture is best-effort; never break the operator's session.
      }
    },

    "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
      try {
        if (!Array.isArray(output?.system)) return;
        const context = getActiveContext();
        if (context !== null) {
          output.system.push(context);
        }
        // Drain the prompt lane's per-turn queue beside the cached active
        // inject: the first model request BELONGING TO THE PROMPTING
        // SESSION delivers it, the take() clearing makes later requests in
        // the turn no-ops, and another session's request drains nothing.
        const queued = promptQueue.take(contextSessionId(input));
        if (queued !== null) {
          output.system.push(queued);
        }
      } catch {
        // Inject is a nicety; the session works without it.
      }
    },

    "chat.message": async (input: unknown, output: unknown) => {
      try {
        const observed = observePrompt(input, output);
        if (observed.prompt === null) return;
        runPromptShims({
          prompt: observed.prompt,
          sessionId: observed.sessionId,
          cwd: injectCwd,
          queue: promptQueue,
        });
      } catch {
        // Prompt-time injection is best-effort; the turn proceeds without it.
      }
    },

    "tool.execute.after": async (input: { tool?: string }, output: { output?: unknown }) => {
      try {
        const tool = typeof input?.tool === "string" ? input.tool.toLowerCase() : "";
        if (!MUTATING_TOOLS.has(tool)) return;
        if (output && typeof output.output === "string") {
          output.output = `${output.output}\n\n${POST_WRITE_NUDGE}`;
        }
      } catch {
        // Reminder is a nicety; tool output stays untouched on failure.
      }
    },

    "tool.execute.before": (
      input: { tool?: string; sessionID?: string },
      output: { args?: unknown },
    ) => {
      runPretoolGate({
        tool: typeof input?.tool === "string" ? input.tool : "",
        sessionId: typeof input?.sessionID === "string" ? input.sessionID : null,
        toolInput: output?.args,
        cwd: injectCwd,
      });
    },
  };
};

interface V2Context {
  location: { directory: string };
  session: {
    hook(
      name: "context",
      callback: (event: {
        system: Array<{ type: "text"; text: string }>;
        /** The session the model request belongs to, when the host names it. */
        sessionID?: string;
      }) => void,
    ): Promise<unknown>;
    hook(name: "prompt", callback: (event: unknown) => void): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
  };
  tool: {
    hook(
      name: "execute.after",
      callback: (event: {
        tool: string;
        status: string;
        result?: { content: unknown[]; [key: string]: unknown };
      }) => void,
    ): Promise<unknown>;
    hook(
      name: "execute.before",
      callback: (input: { tool?: string; sessionID?: string }, output: { args?: unknown }) => void,
    ): Promise<unknown>;
  };
  event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<{
      type?: string;
      data?: unknown;
      properties?: unknown;
      location?: { directory?: string };
    }>;
  };
}

/**
 * One best-effort registration: a V2 host that rejects a hook name
 * (the newer names are feature-detected upstream, so an older build
 * may refuse them) must degrade that one hook to a no-op instead of
 * killing setup - capture and every later hook would otherwise never
 * start.
 */
async function registerV2Hook(register: () => Promise<unknown>): Promise<void> {
  try {
    await register();
  } catch {
    // The hook stays unregistered; everything else keeps working.
  }
}

/** V2 reads this default definition; V1 calls server() on the same object. */
export default {
  id: "open-second-brain",
  server: openSecondBrainV1,
  async setup(ctx: V2Context) {
    // V1's experimental V2 loader also calls setup(), but without these
    // capabilities; its separate V1 loader still runs server().
    if (
      typeof ctx?.location?.directory !== "string" ||
      typeof ctx.session?.hook !== "function" ||
      typeof ctx.session?.get !== "function" ||
      typeof ctx.session?.context !== "function" ||
      typeof ctx.tool?.hook !== "function" ||
      typeof ctx.event?.subscribe !== "function"
    )
      return;

    const directory = ctx.location.directory;
    const getActiveContext = activeContextFor(directory);
    const promptQueue = promptContextQueue();

    await registerV2Hook(() =>
      ctx.session.hook("context", (event) => {
        try {
          const context = getActiveContext();
          if (context !== null) event.system.push({ type: "text", text: context });
          // Drain the prompt lane's per-turn queue beside the cached
          // active inject; the take() clearing delivers the queued
          // context exactly once per turn even when this hook fires for
          // several model requests, and only for the session the prompt
          // came from.
          const queued = promptQueue.take(contextSessionId(event));
          if (queued !== null) event.system.push({ type: "text", text: queued });
        } catch {
          // Context injection is best-effort.
        }
      }),
    );

    await registerV2Hook(() =>
      ctx.session.hook("prompt", (event: unknown) => {
        try {
          const observed = observePrompt(event);
          if (observed.prompt === null) return;
          runPromptShims({
            prompt: observed.prompt,
            sessionId: observed.sessionId,
            cwd: directory,
            queue: promptQueue,
          });
        } catch {
          // Prompt-time injection is best-effort; the turn proceeds without it.
        }
      }),
    );

    await registerV2Hook(() =>
      ctx.tool.hook("execute.after", (event) => {
        try {
          if (event.status !== "completed" || !MUTATING_TOOLS.has(event.tool.toLowerCase())) return;
          if (!event.result || !Array.isArray(event.result.content)) return;
          event.result = {
            ...event.result,
            content: [...event.result.content, { type: "text", text: POST_WRITE_NUDGE }],
          };
        } catch {
          // Reminder is best-effort; tool results remain untouched on failure.
        }
      }),
    );

    await registerV2Hook(() =>
      ctx.tool.hook("execute.before", (input, output) => {
        runPretoolGate({
          tool: typeof input?.tool === "string" ? input.tool : "",
          sessionId: typeof input?.sessionID === "string" ? input.sessionID : null,
          toolInput: output?.args,
          cwd: directory,
        });
      }),
    );

    const controller = new AbortController();
    void (async () => {
      let retryDelay = 1_000;
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            retryDelay = 1_000;
            try {
              if (!event || !V2_CAPTURE_EVENTS.has(event.type ?? "")) continue;
              const sessionID = extractSessionId(event.data ?? event.properties);
              if (sessionID === null) continue;
              // The event stream is server-wide, not scoped to this plugin's location.
              const eventDirectory = event.location?.directory;
              if (eventDirectory && eventDirectory !== directory) continue;
              if (!eventDirectory) {
                const session = asRecord(await ctx.session.get({ sessionID }));
                const location = asRecord(session?.["location"]);
                if (location?.["directory"] !== directory) continue;
              }
              const revertTo =
                event.type === "session.revert.committed"
                  ? asRecord(event.data ?? event.properties)?.["to"]
                  : undefined;
              if (event.type === "session.revert.committed" && typeof revertTo !== "string")
                continue;
              const messages = messageList(await ctx.session.context({ sessionID }));
              if (messages !== null)
                writeSpool(sessionID, directory, messages, true, revertTo as string | undefined);
            } catch {
              // A failed snapshot must not stop later session captures.
            }
          }
        } catch {
          // Subscriptions are live-only and do not reconnect automatically.
        }
        if (controller.signal.aborted) break;
        console.warn(`Open Second Brain: capture stream ended; retrying in ${retryDelay}ms`);
        try {
          await sleep(retryDelay, undefined, { signal: controller.signal, ref: false });
        } catch {
          break; // Cleanup aborts a pending retry immediately.
        }
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    })();

    return () => controller.abort();
  },
};
