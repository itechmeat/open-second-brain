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
import { setTimeout as sleep } from "node:timers/promises";

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
  const payload =
    context === null
      ? null
      : JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
        });
  if (process.platform === "win32") {
    // Native Windows runs the shim as `o2b-hook.cmd` through `cmd /d /c`,
    // the way the plugin starts the installed launcher. The fixed test
    // contexts hold no cmd metacharacters, so a plain `echo` prints them.
    const path = join(binDir, "o2b-hook.cmd");
    writeFileSync(path, payload === null ? "@exit /b 0\r\n" : `@echo ${payload}\r\n`);
    return path;
  }
  const path = join(binDir, "o2b-hook");
  const body =
    payload === null
      ? "#!/bin/sh\nexit 0\n"
      : `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${payload}'\n`;
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
  disconnectedStreams: Array<"error" | "end"> = [],
) {
  let contextHook: ((event: { system: Array<{ type: "text"; text: string }> }) => void) | undefined;
  let toolHook: ((event: V2ToolEvent) => void) | undefined;
  let signal: AbortSignal | undefined;
  let drained!: () => void;
  const processed = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const contextCalls: string[] = [];
  const subscriptions: number[] = [];
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
        subscriptions.push(Date.now());
        const disconnected = disconnectedStreams.shift();
        if (disconnected === "error") throw new Error("Event stream disconnected");
        if (disconnected === "end") return;
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
  if (!cleanup) throw new Error("V2 setup did not register its event subscription");
  const timeout = new AbortController();
  try {
    await Promise.race([
      processed,
      sleep(3_500, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("V2 capture did not resume after stream disconnect");
      }),
    ]);
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    timeout.abort();
  }
  return {
    contextHook: contextHook!,
    toolHook: toolHook!,
    contextCalls,
    subscriptions,
    signal: signal!,
    cleanup,
  };
}

test("exports V1 server and V2 setup on one default definition", () => {
  expect(OpenSecondBrain.id).toBe("open-second-brain");
  expect(typeof OpenSecondBrain.server).toBe("function");
  expect(typeof OpenSecondBrain.setup).toBe("function");
});

test("V1's experimental V2 loader can omit the released V2 capabilities", async () => {
  const v1Context = {
    options: {},
    agent: {},
    aisdk: {},
    catalog: {},
    command: {},
    integration: {},
    plugin: {},
    reference: {},
    skill: {},
  };
  expect(await OpenSecondBrain.setup(v1Context as never)).toBeUndefined();
});

for (const missing of [
  "location.directory",
  "session.hook",
  "session.get",
  "session.context",
  "tool.hook",
  "event.subscribe",
]) {
  test(`V2 setup registers nothing without ${missing}`, async () => {
    const registered: string[] = [];
    const context = {
      location: { directory: "/work/dir" },
      session: {
        async hook() {
          registered.push("context");
        },
        async get() {
          return { location: { directory: "/work/dir" } };
        },
        async context() {
          return [];
        },
      },
      tool: {
        async hook() {
          registered.push("tool");
        },
      },
      event: {
        async *subscribe() {
          registered.push("event");
          yield { type: "irrelevant" };
        },
      },
    };
    const [domain, member] = missing.split(".");
    delete (context as unknown as Record<string, Record<string, unknown>>)[domain!]![member!];

    expect(await OpenSecondBrain.setup(context as never)).toBeUndefined();
    expect(registered).toEqual([]);
  });
}

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

describe("opencode plugin - spool location without the override", () => {
  // The plugin cannot import platform-dirs.ts (it is copied alone into
  // opencode's plugin directory), so it restates the data-dir order: XDG,
  // then ~/.local/share on POSIX, then %LOCALAPPDATA% on Windows. The core
  // reader looks in the same place, so the two must agree.
  //
  // Each case runs in a child process: `os.homedir()` is fixed at process
  // start, so re-pointing HOME in this process would spool into the real
  // profile instead of the temp one.
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "osb-oc-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const PLUGIN = join(import.meta.dir, "..", "..", "plugins", "opencode", "open-second-brain.ts");
  const DRIVER = `
import OpenSecondBrain from ${JSON.stringify(PLUGIN)};
const client = { session: { async messages() { return { data: [
  { info: { id: "m1", role: "user", time: { created: 1765900000000 } },
    parts: [{ type: "text", text: "hi" }] },
] }; } } };
const hooks = await OpenSecondBrain.server({ client, project: { id: "p" }, directory: "/w", worktree: "/w" });
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "sess-loc" } } });
`;

  function idle(extra: Record<string, string>): void {
    const driver = join(home, "driver.ts");
    writeFileSync(driver, DRIVER);
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      USERPROFILE: home,
      ...extra,
    };
    if (process.env["SYSTEMROOT"]) env["SYSTEMROOT"] = process.env["SYSTEMROOT"];
    const proc = Bun.spawnSync({ cmd: [process.execPath, driver], env, stderr: "pipe" });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  }

  const SPOOL_TAIL = ["open-second-brain", "opencode", "sess-loc.jsonl"] as const;

  test("XDG_DATA_HOME wins on every platform", () => {
    const xdg = join(home, "xdg-data");
    idle({ XDG_DATA_HOME: xdg, LOCALAPPDATA: join(home, "local-app-data") });
    expect(existsSync(join(xdg, ...SPOOL_TAIL))).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "POSIX: ~/.local/share without XDG_DATA_HOME, LOCALAPPDATA ignored",
    () => {
      idle({ LOCALAPPDATA: join(home, "local-app-data") });
      expect(existsSync(join(home, ".local", "share", ...SPOOL_TAIL))).toBe(true);
    },
  );

  test.skipIf(process.platform !== "win32")("Windows: %LOCALAPPDATA% without XDG_DATA_HOME", () => {
    const local = join(home, "local-app-data");
    idle({ LOCALAPPDATA: local });
    expect(existsSync(join(local, ...SPOOL_TAIL))).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "Windows: the profile's AppData/Local when LOCALAPPDATA is empty",
    () => {
      idle({ LOCALAPPDATA: "" });
      expect(existsSync(join(home, "AppData", "Local", ...SPOOL_TAIL))).toBe(true);
    },
  );
});

describe("opencode plugin - active context inject", () => {
  test("appends rendered context to the system array when o2b-hook responds", async () => {
    process.env["OSB_HOOK_BIN"] = stubHookBin("ACTIVE PREFS BLOCK");
    const hooks = await makeHooks(fakeClient(MESSAGES));
    const output = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]!({} as never, output as never);
    expect(output.system).toEqual(["base", "ACTIVE PREFS BLOCK"]);
  });

  test.skipIf(process.platform !== "win32")(
    "Windows: an o2b-hook.cmd in the current directory is never the one run",
    async () => {
      // cmd.exe looks for a bare name in the current directory before PATH,
      // and opencode runs in the project it opened. The plugin resolves the
      // shim on PATH first, so a repository's own o2b-hook.cmd stays inert.
      stubHookBin("FROM PATH");
      const project = mkdtempSync(join(tmpdir(), "osb-oc-project-"));
      writeFileSync(
        join(project, "o2b-hook.cmd"),
        '@echo {"hookSpecificOutput":{"additionalContext":"PLANTED"}}\r\n',
      );
      const savedPath = process.env["PATH"];
      const savedCwd = process.cwd();
      delete process.env["OSB_HOOK_BIN"];
      process.env["PATH"] = `${binDir};${savedPath ?? ""}`;
      process.chdir(project);
      try {
        const hooks = await makeHooks(fakeClient(MESSAGES));
        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({} as never, output as never);
        expect(output.system).toEqual(["FROM PATH"]);
      } finally {
        process.chdir(savedCwd);
        process.env["PATH"] = savedPath;
        rmSync(project, { recursive: true, force: true });
      }
    },
  );

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
  for (const executionType of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    test(`opencode 2.0.24 turn-end event ${executionType} writes a spool snapshot`, async () => {
      const plugin = await makeV2Plugin(
        [
          {
            id: "msg-exec",
            type: "user",
            time: { created: 1765900000000 },
            text: "captured on execution end",
          },
        ],
        [
          {
            type: executionType,
            data: { sessionID: "sess-execution" },
            location: { directory: "/work/dir" },
          },
        ],
      );
      try {
        const turns = readFileSync(join(spoolDir, "sess-execution.jsonl"), "utf8")
          .trim()
          .split("\n")
          .slice(1)
          .map((line) => JSON.parse(line));
        expect(turns.map((turn) => turn.turnId)).toEqual(["msg-exec"]);
      } finally {
        plugin.cleanup();
      }
    });
  }

  test("a revert with an uncaptured boundary rebuilds from current context", async () => {
    const plugin = await makeV2Plugin(
      (call) => [
        {
          id: call === 0 ? "msg-old" : "msg-current",
          type: "user",
          time: { created: 1765900000000 },
          text: call === 0 ? "old" : "current",
        },
      ],
      [
        {
          type: "session.idle",
          data: { sessionID: "sess-missed-boundary" },
          location: { directory: "/work/dir" },
        },
        {
          type: "session.revert.committed",
          data: { sessionID: "sess-missed-boundary", to: "msg-uncaptured" },
          location: { directory: "/work/dir" },
        },
      ],
    );
    try {
      const turns = readFileSync(join(spoolDir, "sess-missed-boundary.jsonl"), "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line));
      expect(turns.map((turn) => turn.turnId)).toEqual(["msg-current"]);
    } finally {
      plugin.cleanup();
    }
  });

  for (const boundaryType of ["user", "compaction"]) {
    test(`a committed revert removes the ${boundaryType} boundary and following turns`, async () => {
      const before = {
        id: "msg-retained",
        type: "user",
        time: { created: 1765900000000 },
        text: "keep",
      };
      const boundary = {
        id: "msg-boundary",
        type: boundaryType,
        time: { created: 1765900060000 },
        ...(boundaryType === "user" ? { text: "undo this" } : {}),
      };
      const removed = {
        id: "msg-removed",
        type: "user",
        time: { created: 1765900120000 },
        text: "removed suffix",
      };
      const after = {
        id: "msg-new",
        type: "user",
        time: { created: 1765900180000 },
        text: "new branch",
      };
      const plugin = await makeV2Plugin(
        (call) => (call === 0 ? [before, boundary, removed] : call === 1 ? [removed] : [after]),
        [
          {
            type: "session.compaction.started",
            data: { sessionID: "sess-revert" },
            location: { directory: "/work/dir" },
          },
          {
            type: "session.compaction.ended",
            data: { sessionID: "sess-revert" },
            location: { directory: "/work/dir" },
          },
          {
            type: "session.revert.committed",
            data: { sessionID: "sess-revert", to: "msg-boundary" },
            location: { directory: "/work/dir" },
          },
          {
            type: "session.idle",
            data: { sessionID: "sess-revert" },
            location: { directory: "/work/dir" },
          },
        ],
      );
      try {
        const turns = readFileSync(join(spoolDir, "sess-revert.jsonl"), "utf8")
          .trim()
          .split("\n")
          .slice(1)
          .map((line) => JSON.parse(line));
        expect(turns.map((turn) => turn.turnId)).toEqual(["msg-retained", "msg-new"]);
        expect(turns.map((turn) => turn.text)).toEqual(["keep", "new branch"]);
      } finally {
        plugin.cleanup();
      }
    });
  }

  for (const disconnect of ["error", "end"] as const) {
    test(`capture resumes after a stream ${disconnect}`, async () => {
      const plugin = await makeV2Plugin(
        [
          {
            id: "msg-recovered",
            type: "user",
            time: { created: 1765900000000 },
            text: "after reconnect",
          },
        ],
        [
          {
            type: "session.idle",
            data: { sessionID: "sess-recovered" },
            location: { directory: "/work/dir" },
          },
        ],
        {},
        [disconnect],
      );
      try {
        const lines = readFileSync(join(spoolDir, "sess-recovered.jsonl"), "utf8")
          .trim()
          .split("\n");
        expect(JSON.parse(lines[1]!)).toMatchObject({
          turnId: "msg-recovered",
          text: "after reconnect",
        });
        expect(plugin.subscriptions).toHaveLength(2);
        expect(plugin.subscriptions[1]! - plugin.subscriptions[0]!).toBeGreaterThanOrEqual(900);
      } finally {
        plugin.cleanup();
      }
      await sleep(1_100);
      expect(plugin.subscriptions).toHaveLength(2);
    });
  }

  test("cleanup during retry prevents another event subscription", async () => {
    let attempts = 0;
    let disconnected!: () => void;
    const ended = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const ctx = {
      location: { directory: "/work/dir" },
      session: {
        async hook() {},
        async get() {
          return {};
        },
        async context() {
          return [];
        },
      },
      tool: { async hook() {} },
      event: {
        async *subscribe() {
          attempts++;
          yield { type: "server.connected" };
          disconnected();
          throw new Error("Disconnected");
        },
      },
    };
    const cleanup = await OpenSecondBrain.setup(ctx as never);
    if (!cleanup) throw new Error("V2 capture did not start");
    try {
      await ended;
      await sleep(10);
      cleanup();
      await sleep(1_100);
      expect(attempts).toBe(1);
    } finally {
      cleanup();
    }
  });

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
