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
 * Renders the active-context block by spawning the same
 * `o2b-hook active-inject` shim the Claude Code and Codex hook layers
 * use. Returns null on every failure mode (binary missing, timeout,
 * empty or malformed output) — the caller treats null as "no inject".
 */
function renderActiveContext(cwd: string): string | null {
  try {
    const bin = process.env["OSB_HOOK_BIN"] ?? "o2b-hook";
    const command = hookCommand(bin);
    if (command === null) return null;
    const proc = Bun.spawnSync(command.argv, {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd })),
      stdout: "pipe",
      stderr: "ignore",
      timeout: HOOK_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      env: command.env,
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
 * How to start the `o2b-hook` shim `bin` (a bare name or a path), or null
 * when it cannot be found.
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
function hookCommand(bin: string): {
  readonly argv: string[];
  readonly verbatim: boolean;
  readonly env: Record<string, string | undefined> | undefined;
} | null {
  if (process.platform !== "win32")
    return { argv: [bin, "active-inject"], verbatim: false, env: undefined };
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
      `""${resolved}" active-inject"`,
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
