/**
 * Open Second Brain plugin for opencode (https://opencode.ai).
 *
 * Installed by `o2b install --target opencode --apply` into
 * `~/.config/opencode/plugins/open-second-brain.ts`. The file is
 * deliberately self-contained (no imports beyond node builtins and the
 * Bun globals opencode already provides) so the copy works standalone
 * inside opencode's plugin sandbox.
 *
 * Supports OpenCode V1 (server) and V2 (setup). Three behaviors mirror
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
 * Every hook body is fail-soft: a missing vault, missing binary, or
 * session API error must never break the operator's opencode session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SPOOL_FORMAT = 1;
const SPOOL_ORIGINATOR = "open-second-brain-opencode-plugin";
const CAPTURE_EVENTS = new Set(["session.idle", "session.compacted", "session.deleted"]);
const V2_CAPTURE_EVENTS = new Set([
  "session.idle",
  "session.compaction.started",
  "session.compaction.ended",
  "session.deleted",
]);
const MUTATING_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);
const ACTIVE_CONTEXT_TTL_MS = 5 * 60 * 1000;
/** A failed render retries sooner than a successful one expires. */
const ACTIVE_CONTEXT_NEGATIVE_TTL_MS = 30 * 1000;
const HOOK_TIMEOUT_MS = 10_000;

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
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
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
  const turns = new Map<string, SpoolTurn>();
  if (preserveExisting) {
    try {
      const lines = readFileSync(target, "utf8").trimEnd().split("\n");
      const previous = asRecord(JSON.parse(lines[0]!));
      if (previous?.["session_id"] === sessionId && previous["format"] === SPOOL_FORMAT) {
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
  for (const message of messages) {
    const turn = normalizeMessage(message);
    if (turn) turns.set(turn.turnId, turn);
  }
  const lines = [
    JSON.stringify(meta),
    ...Array.from(turns.values(), (turn) => JSON.stringify(turn)),
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
 * Renders the active-context block by spawning the same
 * `o2b-hook active-inject` shim the Claude Code and Codex hook layers
 * use. Returns null on every failure mode (binary missing, timeout,
 * empty or malformed output) — the caller treats null as "no inject".
 */
function renderActiveContext(cwd: string): string | null {
  try {
    const bin = process.env["OSB_HOOK_BIN"] ?? "o2b-hook";
    const proc = Bun.spawnSync([bin, "active-inject"], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd })),
      stdout: "pipe",
      stderr: "ignore",
      timeout: HOOK_TIMEOUT_MS,
    });
    if (!proc.success) return null;
    const raw = proc.stdout.toString("utf8").trim();
    if (raw.length === 0) return null;
    const parsed = asRecord(JSON.parse(raw));
    const hookOutput = parsed ? asRecord(parsed["hookSpecificOutput"]) : null;
    const context = hookOutput ? hookOutput["additionalContext"] : null;
    return typeof context === "string" && context.length > 0 ? context : null;
  } catch {
    return null;
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

    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      try {
        const context = getActiveContext();
        if (context !== null && Array.isArray(output?.system)) {
          output.system.push(context);
        }
      } catch {
        // Inject is a nicety; the session works without it.
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
  };
};

interface V2Context {
  location: { directory: string };
  session: {
    hook(
      name: "context",
      callback: (event: { system: Array<{ type: "text"; text: string }> }) => void,
    ): Promise<unknown>;
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

/** V2 reads this default definition; V1 calls server() on the same object. */
export default {
  id: "open-second-brain",
  server: openSecondBrainV1,
  async setup(ctx: V2Context) {
    const directory = ctx.location.directory;
    const getActiveContext = activeContextFor(directory);

    await ctx.session.hook("context", (event) => {
      try {
        const context = getActiveContext();
        if (context !== null) event.system.push({ type: "text", text: context });
      } catch {
        // Context injection is best-effort.
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
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
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
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
            const messages = messageList(await ctx.session.context({ sessionID }));
            if (messages !== null) writeSpool(sessionID, directory, messages, true);
          } catch {
            // A failed snapshot must not stop later session captures.
          }
        }
      } catch {
        // A disconnected event stream must not break the session.
      }
    })();

    return () => controller.abort();
  },
};
