/**
 * Tests for the bundled opencode plugin (`plugins/opencode/open-second-brain.ts`).
 *
 * opencode is not installed on dev or CI machines: the plugin is
 * exercised directly through V1 server() and V2 setup() with a stub
 * `o2b-hook` executable (via `OSB_HOOK_BIN`) and a temp spool dir (via
 * `OSB_OPENCODE_SPOOL_DIR`). Every hook must be fail-soft: a broken
 * client, missing binary, or unwritable spool dir must never throw
 * into opencode.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenSecondBrain from "../../plugins/opencode/open-second-brain.ts";

let spoolDir: string;
let binDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  spoolDir = mkdtempSync(join(tmpdir(), "osb-oc-spool-"));
  binDir = mkdtempSync(join(tmpdir(), "osb-oc-bin-"));
  for (const k of ["OSB_HOOK_BIN", "OSB_OPENCODE_SPOOL_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  process.env["OSB_OPENCODE_SPOOL_DIR"] = spoolDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [spoolDir, binDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** Stub o2b-hook that prints an active-inject response. */
function stubHookBin(context: string | null): string {
  const path = join(binDir, "o2b-hook");
  const body =
    context === null
      ? "#!/bin/sh\nexit 0\n"
      : `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
        })}'\n`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

interface FakeMessage {
  info: { id: string; role: string; time?: { created?: number } };
  parts: Array<Record<string, unknown>>;
}

function fakeClient(messages: FakeMessage[] | (() => never)) {
  // Faithful to the real opencode SDK client: `session.messages` is a
  // method that reads instance state through `this` (the shipped client
  // dereferences `this._client`). Modeling it as a `this`-dependent
  // method shorthand - not an arrow - means a detached call
  // (`const m = session.messages; await m(...)`) throws here exactly as
  // it does against the real client, so the capture path must invoke it
  // as a method.
  return {
    session: {
      messageStore: messages,
      async messages(this: { messageStore: FakeMessage[] | (() => never) }, _opts: unknown) {
        const store = this.messageStore;
        if (typeof store === "function") store();
        return { data: store };
      },
    },
  };
}

function pluginInput(client: unknown) {
  return {
    client,
    project: { id: "proj-1" },
    directory: "/work/dir",
    worktree: "/work/dir",
    $: undefined,
    serverUrl: new URL("http://localhost:1"),
  };
}

const MESSAGES: FakeMessage[] = [
  {
    info: { id: "msg-1", role: "user", time: { created: 1765900000000 } },
    parts: [{ type: "text", text: "please fix the bug" }],
  },
  {
    info: { id: "msg-2", role: "assistant", time: { created: 1765900060000 } },
    parts: [
      { type: "text", text: "working on it" },
      { type: "tool", tool: "edit", callID: "call-7", state: { input: { filePath: "/a.ts" } } },
    ],
  },
  {
    info: { id: "msg-3", role: "ignored-kind" },
    parts: [{ type: "text", text: "dropped" }],
  },
];

async function makeHooks(client: unknown) {
  return await OpenSecondBrain.server(pluginInput(client) as never);
}

interface V2ToolEvent {
  tool: string;
  status: string;
  result?: { content: unknown[]; [key: string]: unknown };
}

async function makeV2Plugin(
  messages: unknown[] | ((call: number) => unknown[]),
  events: Array<{
    type: string;
    data?: unknown;
    properties?: unknown;
    location?: { directory: string };
  }> = [],
  sessionDirectories: Record<string, string> = {},
) {
  let contextHook: ((event: { system: Array<{ type: "text"; text: string }> }) => void) | undefined;
  let toolHook: ((event: V2ToolEvent) => void) | undefined;
  let signal: AbortSignal | undefined;
  let drained!: () => void;
  const processed = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const contextCalls: string[] = [];
  const ctx = {
    location: { directory: "/work/dir" },
    session: {
      async hook(_name: string, callback: typeof contextHook) {
        contextHook = callback;
      },
      async get({ sessionID }: { sessionID: string }) {
        return { location: { directory: sessionDirectories[sessionID] ?? "/work/dir" } };
      },
      async context({ sessionID }: { sessionID: string }) {
        contextCalls.push(sessionID);
        return typeof messages === "function" ? messages(contextCalls.length - 1) : messages;
      },
    },
    tool: {
      async hook(_name: string, callback: typeof toolHook) {
        toolHook = callback;
      },
    },
    event: {
      async *subscribe(input: { signal: AbortSignal }) {
        signal = input.signal;
        for (const event of events) yield event;
        drained();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  };
  const cleanup = await OpenSecondBrain.setup(ctx as never);
  await processed;
  return { contextHook: contextHook!, toolHook: toolHook!, contextCalls, signal: signal!, cleanup };
}

test("exports V1 server and V2 setup on one default definition", () => {
  expect(OpenSecondBrain.id).toBe("open-second-brain");
  expect(typeof OpenSecondBrain.server).toBe("function");
  expect(typeof OpenSecondBrain.setup).toBe("function");
});

describe("opencode plugin - session capture spool", () => {
  test("session.idle writes a spool snapshot with meta line and normalized turns", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "sess-abc" } },
    } as never);

    const file = join(spoolDir, "sess-abc.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const meta = JSON.parse(lines[0]!);
    expect(meta.type).toBe("session_meta");
    expect(meta.originator).toBe("open-second-brain-opencode-plugin");
    expect(meta.format).toBe(1);
    expect(meta.session_id).toBe("sess-abc");

    const turns = lines.slice(1).map((l) => JSON.parse(l));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({
      type: "turn",
      turnId: "msg-1",
      timestamp: new Date(1765900000000).toISOString(),
      role: "user",
      text: "please fix the bug",
    });
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("working on it");
    expect(turns[1].toolCalls).toEqual([
      { name: "edit", id: "call-7", input: { filePath: "/a.ts" } },
    ]);
  });

  test("snapshot rewrite is idempotent across repeated idle events", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const ev = { event: { type: "session.idle", properties: { sessionID: "sess-abc" } } };
    await hooks.event!(ev as never);
    const first = readFileSync(join(spoolDir, "sess-abc.jsonl"), "utf8");
    await hooks.event!(ev as never);
    expect(readFileSync(join(spoolDir, "sess-abc.jsonl"), "utf8")).toBe(first);
  });

  test("unrelated event types do not touch the spool", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    await hooks.event!({
      event: { type: "file.edited", properties: { sessionID: "sess-abc" } },
    } as never);
    expect(existsSync(join(spoolDir, "sess-abc.jsonl"))).toBe(false);
  });

  test("session id is sanitized for the spool filename", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "../../evil" } },
    } as never);
    expect(existsSync(join(spoolDir, ".._.._evil.jsonl"))).toBe(true);
  });

  test("a throwing client never propagates out of the event hook", async () => {
    const hooks = await makeHooks(
      fakeClient(() => {
        throw new Error("boom");
      }),
    );
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "sess-x" } },
    } as never);
    expect(existsSync(join(spoolDir, "sess-x.jsonl"))).toBe(false);
  });
});

describe("opencode plugin - active context inject", () => {
  test("appends rendered context to the system array when o2b-hook responds", async () => {
    process.env["OSB_HOOK_BIN"] = stubHookBin("ACTIVE PREFS BLOCK");
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]!({} as never, output as never);
    expect(output.system).toEqual(["base", "ACTIVE PREFS BLOCK"]);
  });

  test("caches the rendered context between calls", async () => {
    process.env["OSB_HOOK_BIN"] = stubHookBin("CACHED BLOCK");
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const out1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as never, out1 as never);
    // Re-point the stub at different content: a cached plugin must not pick it up.
    stubHookBin("CHANGED BLOCK");
    const out2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as never, out2 as never);
    expect(out2.system).toEqual(["CACHED BLOCK"]);
  });

  test("missing o2b-hook binary degrades to no-op", async () => {
    process.env["OSB_HOOK_BIN"] = join(binDir, "does-not-exist");
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]!({} as never, output as never);
    expect(output.system).toEqual(["base"]);
  });

  test("silent o2b-hook (no stdout) degrades to no-op", async () => {
    process.env["OSB_HOOK_BIN"] = stubHookBin(null);
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as never, output as never);
    expect(output.system).toEqual([]);
  });
});

describe("opencode plugin - post-write reminder", () => {
  test("appends the nudge to file-mutating tool output", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { title: "t", output: "wrote /a.ts", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "s", callID: "c" } as never,
      output as never,
    );
    expect(output.output).toContain("wrote /a.ts");
    expect(output.output).toContain("Open Second Brain: artifact written.");
  });

  test("leaves non-mutating tool output untouched", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { title: "t", output: "file contents", metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s", callID: "c" } as never,
      output as never,
    );
    expect(output.output).toBe("file contents");
  });

  test("non-string output is left alone", async () => {
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { title: "t", output: { structured: true }, metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "write", sessionID: "s", callID: "c" } as never,
      output as never,
    );
    expect(output.output).toEqual({ structured: true });
  });
});

describe("opencode plugin - V2", () => {
  test("captures V2 session messages with text and tool calls, then stops on cleanup", async () => {
    const messages = [
      { id: "msg-user", type: "user", time: { created: 1765900000000 }, text: "fix this" },
      {
        id: "msg-assistant",
        type: "assistant",
        time: { created: 1765900060000 },
        content: [
          { type: "text", text: "done" },
          {
            type: "tool",
            id: "call-8",
            name: "patch",
            state: { status: "completed", input: { path: "/a.ts" } },
          },
        ],
      },
      { id: "msg-idle", type: "idle", time: { created: 1765900080000 } },
    ];
    const plugin = await makeV2Plugin(
      messages,
      [
        { type: "file.edited", data: { sessionID: "sess-v2" } },
        { type: "session.idle", data: { sessionID: "sess-other" } },
        {
          type: "session.idle",
          data: { sessionID: "sess-v2" },
          location: { directory: "/work/dir" },
        },
      ],
      { "sess-other": "/other/project" },
    );
    expect(plugin.contextCalls).toEqual(["sess-v2"]);
    expect(existsSync(join(spoolDir, "sess-other.jsonl"))).toBe(false);
    const lines = readFileSync(join(spoolDir, "sess-v2.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session_meta", directory: "/work/dir" });
    expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual([
      {
        type: "turn",
        turnId: "msg-user",
        timestamp: new Date(1765900000000).toISOString(),
        role: "user",
        text: "fix this",
      },
      {
        type: "turn",
        turnId: "msg-assistant",
        timestamp: new Date(1765900060000).toISOString(),
        role: "assistant",
        text: "done",
        toolCalls: [{ name: "patch", id: "call-8", input: { path: "/a.ts" } }],
      },
    ]);
    plugin.cleanup();
    expect(plugin.signal.aborted).toBe(true);
  });

  test("keeps pre-compaction turns when V2 context only returns recent messages", async () => {
    const before = [
      { id: "msg_before", type: "user", time: { created: 1765900000000 }, text: "before" },
    ];
    const after = [
      {
        id: "msg_after",
        type: "assistant",
        time: { created: 1765900060000 },
        content: [{ type: "text", text: "after" }],
      },
    ];
    const plugin = await makeV2Plugin(
      (call) => (call === 0 ? before : after),
      [
        {
          type: "session.compaction.started",
          data: { sessionID: "sess-compact" },
          location: { directory: "/work/dir" },
        },
        {
          type: "session.compaction.ended",
          data: { sessionID: "sess-compact" },
          location: { directory: "/work/dir" },
        },
        {
          type: "session.idle",
          data: { sessionID: "sess-compact" },
          location: { directory: "/work/dir" },
        },
      ],
    );
    const lines = readFileSync(join(spoolDir, "sess-compact.jsonl"), "utf8").trim().split("\n");
    expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual([
      {
        type: "turn",
        turnId: "msg_before",
        timestamp: new Date(1765900000000).toISOString(),
        role: "user",
        text: "before",
      },
      {
        type: "turn",
        turnId: "msg_after",
        timestamp: new Date(1765900060000).toISOString(),
        role: "assistant",
        text: "after",
      },
    ]);
    plugin.cleanup();
  });

  test("injects context and appends a text part after successful write tools", async () => {
    process.env["OSB_HOOK_BIN"] = stubHookBin("ACTIVE PREFS BLOCK");
    const plugin = await makeV2Plugin([]);
    const request = { system: [{ type: "text" as const, text: "base" }] };
    plugin.contextHook(request);
    expect(request.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "ACTIVE PREFS BLOCK" },
    ]);
    const result: V2ToolEvent = {
      tool: "patch",
      status: "completed",
      result: { content: [{ type: "text", text: "wrote /a.ts" }] },
    };
    plugin.toolHook(result);
    expect(result.result?.content).toEqual([
      { type: "text", text: "wrote /a.ts" },
      { type: "text", text: expect.stringContaining("Open Second Brain: artifact written.") },
    ]);
    const unchanged: V2ToolEvent = {
      tool: "read",
      status: "completed",
      result: { content: [{ type: "text", text: "file contents" }] },
    };
    plugin.toolHook(unchanged);
    expect(unchanged.result?.content).toEqual([{ type: "text", text: "file contents" }]);
    plugin.cleanup();
  });
});
