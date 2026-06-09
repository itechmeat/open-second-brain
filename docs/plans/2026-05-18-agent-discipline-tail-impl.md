# v0.10.7 Implementation Plan — Agent logging discipline tail (§B + §D + §E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No active git.** The user explicitly forbids any active git
> action (`commit`, `push`, `branch`, `tag`, `amend`, `stash`,
> `reset --hard`, `rebase`). Each "Pause for review" step means:
> stop, surface the diff with `git diff`, wait for the user to
> stage / commit themselves.

**Goal:** Close the remaining §30 work in one release — `§B`
writer-MCP split, `§D` daily discipline cron, `§E` claude-memory
bridge.

**Architecture:**
- `src/mcp/tools.ts` gains a `scope: "full" | "writer"` filter; a
  new `.mcp.json` server entry `open-second-brain-writer` runs the
  same CLI with `--scope writer` and `alwaysLoad: true`.
- `src/core/discipline/` (new module) and `bin/o2b-discipline-report`
  produce a deterministic Telegram-safe text block from `Brain/log`,
  git activity, and vault delta. Hermes cron delivers it.
- `src/core/brain/import-claude-memory.ts` and a new
  `o2b brain import-claude-memory` CLI verb copy
  `metadata.type: feedback` MEMORY entries into
  `Brain/preferences/` with a sidecar manifest for idempotency.

**Tech Stack:** Bun ≥ 1.1, TypeScript (strict), `bun test`, no new
runtime dependencies. SHA-256 via `node:crypto`, YAML via the
existing `js-yaml` already on the dep tree.

**Design source:** `docs/plans/2026-05-18-agent-discipline-tail-design.md`.

---

## Phase 0 — Baseline check

### Task 0.1: Verify clean baseline

**Steps:**

- [ ] **Step 1: Confirm tests pass.** Run `bun test` from
  `/srv/projects/open-second-brain`. Expected: all green.

- [ ] **Step 2: Confirm typecheck passes.** Run
  `bun run typecheck`. Expected: zero errors.

- [ ] **Step 3: Record current version.** Read `package.json`;
  current `"version"` should be `"0.10.6"`. Plan bumps to
  `0.10.7` in Phase 4.

**Pause for review.** Do not change anything yet.

---

## Phase 1 — §B Writer MCP split

### Task 1.1: `buildToolTable` accepts an optional `scope`

**Files:**
- Modify: `src/mcp/tools.ts:608` (the `buildToolTable` function).
- Create: `tests/mcp/scope-filter.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/mcp/scope-filter.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { buildToolTable } from "../../src/mcp/tools.ts";

  describe("buildToolTable scope filter", () => {
    test("default scope returns the full surface", () => {
      const full = buildToolTable();
      const names = full.map((t) => t.name);
      expect(names).toContain("brain_feedback");
      expect(names).toContain("brain_apply_evidence");
      expect(names).toContain("brain_dream");
      expect(names).toContain("payment_memory_init");
      expect(names).toContain("vault_health");
      expect(full.length).toBeGreaterThanOrEqual(15);
    });

    test("writer scope returns exactly the two writer tools", () => {
      const writer = buildToolTable("writer");
      const names = writer.map((t) => t.name).sort();
      expect(names).toEqual(["brain_apply_evidence", "brain_feedback"]);
    });

    test("writer-scope schemas are the same instances as full scope", () => {
      const full = buildToolTable("full");
      const writer = buildToolTable("writer");
      for (const w of writer) {
        const matched = full.find((t) => t.name === w.name);
        expect(matched).toBeDefined();
        expect(w.inputSchema).toEqual(matched!.inputSchema);
        expect(w.description).toEqual(matched!.description);
      }
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL** — `bun test tests/mcp/scope-filter.test.ts`.
  TypeScript fails compile on `buildToolTable("writer")` (argument count).

- [ ] **Step 3: Minimal implementation** — edit
  `src/mcp/tools.ts` near the existing `buildToolTable` declaration:

  ```ts
  export type ToolScope = "full" | "writer";

  const WRITER_TOOL_NAMES: ReadonlySet<string> = new Set([
    "brain_feedback",
    "brain_apply_evidence",
  ]);

  export function buildToolTable(scope: ToolScope = "full"): ToolDefinition[] {
    const all: ToolDefinition[] = [
      // ... (the existing big array, unchanged)
    ];
    if (scope === "full") return all;
    return all.filter((t) => WRITER_TOOL_NAMES.has(t.name));
  }
  ```

  Keep the existing array contents byte-identical — just wrap them
  with the new signature and append the filter clause.

- [ ] **Step 4: Run test, expect PASS** —
  `bun test tests/mcp/scope-filter.test.ts`. Three test cases pass.

- [ ] **Step 5: Verify nothing else broke.** Run `bun test`. All
  green.

**Pause for review.**

### Task 1.2: `MCPServer` accepts an optional `serverName`

**Files:**
- Modify: `src/mcp/server.ts`.
- Modify: `src/mcp/protocol.ts` only if `SERVER_NAME` needs to be
  exposed via parameter (it likely already is).

- [ ] **Step 1: Read current ctor.** Run
  `grep -n "constructor\|SERVER_NAME\|name:" src/mcp/server.ts` to
  identify how the server announces its name during `initialize`.

- [ ] **Step 2: Write failing test** — append to
  `tests/mcp/mcp.test.ts` (existing file, add a new describe block):

  ```ts
  import { MCPServer } from "../../src/mcp/server.ts";

  describe("MCPServer serverName override", () => {
    test("default ctor uses SERVER_NAME constant", () => {
      const srv = new MCPServer({ vault: "/tmp/x", configPath: null, repoRoot: null });
      // Simulate initialize and read announced name.
      const init = srv.handleInitialize();
      expect(init.serverInfo.name).toBe("open-second-brain");
    });

    test("explicit serverName flows into initialize response", () => {
      const srv = new MCPServer(
        { vault: "/tmp/x", configPath: null, repoRoot: null },
        { serverName: "open-second-brain-writer" },
      );
      const init = srv.handleInitialize();
      expect(init.serverInfo.name).toBe("open-second-brain-writer");
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL** — `bun test tests/mcp/mcp.test.ts`.
  Fails on `MCPServer` second-arg signature.

- [ ] **Step 4: Minimal implementation** — in `src/mcp/server.ts`:

  ```ts
  export interface MCPServerOptions {
    readonly serverName?: string;
    readonly scope?: ToolScope;
  }

  export class MCPServer {
    private readonly serverName: string;
    private readonly scope: ToolScope;

    constructor(ctx: ServerContext, opts: MCPServerOptions = {}) {
      // ... existing ctx assignment ...
      this.serverName = opts.serverName ?? SERVER_NAME;
      this.scope = opts.scope ?? "full";
      this.tools = buildToolTable(this.scope);
    }

    handleInitialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { /* existing */ },
        serverInfo: { name: this.serverName, version: SERVER_VERSION },
      };
    }
    // ...
  }
  ```

  If the existing class already has a separate `name`-emitting
  code path, route it through `this.serverName` instead of
  `SERVER_NAME` directly. Do NOT remove `SERVER_NAME` from
  `protocol.ts` — it stays as the default.

- [ ] **Step 5: Run test, expect PASS** — `bun test tests/mcp/`.
  Both new cases pass.

- [ ] **Step 6: Run full test suite, expect PASS** — `bun test`.

**Pause for review.**

### Task 1.3: `serveStdio` accepts `{ scope, serverName }`

**Files:**
- Modify: `src/mcp/stdio.ts`.

- [ ] **Step 1: Locate `serveStdio` signature** — `grep -n "serveStdio" src/mcp/stdio.ts`.

- [ ] **Step 2: Write failing test** — append to `tests/mcp/mcp.test.ts`:

  ```ts
  import { serveStdioFromString } from "../../src/mcp/stdio.ts";

  describe("serveStdioFromString respects scope+name", () => {
    test("writer scope filters tools/list response", async () => {
      const ctx = { vault: "/tmp/x", configPath: null, repoRoot: null };
      const initReq = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const listReq = JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      });
      const out = await serveStdioFromString(
        ctx,
        `${initReq}\n${listReq}\n`,
        { scope: "writer", serverName: "open-second-brain-writer" },
      );
      const lines = out.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[0].result.serverInfo.name).toBe("open-second-brain-writer");
      const toolNames = (lines[1].result.tools as Array<{ name: string }>)
        .map((t) => t.name).sort();
      expect(toolNames).toEqual(["brain_apply_evidence", "brain_feedback"]);
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL** — argument count error.

- [ ] **Step 4: Minimal implementation** — extend
  `serveStdioFromString` and `serveStdio` to accept an `opts:
  { scope?: ToolScope; serverName?: string }` second argument
  and forward it to the `new MCPServer(ctx, opts)` call.

  ```ts
  export async function serveStdioFromString(
    ctx: ServerContext,
    input: string,
    opts: MCPServerOptions = {},
  ): Promise<string> {
    const server = new MCPServer(ctx, opts);
    // ... existing line-by-line handling ...
  }
  ```

  `serveStdio` (the stdin-driven version) mirrors the change.

- [ ] **Step 5: Run test, expect PASS**.

- [ ] **Step 6: Full test sweep** — `bun test`.

**Pause for review.**

### Task 1.4: `o2b mcp --scope writer|full` CLI flag

**Files:**
- Modify: `src/cli/main.ts` (the `mcp` subcommand).
- Create: `tests/cli/mcp-scope-arg.test.ts`.

- [ ] **Step 1: Locate the mcp subcommand handler** —
  `grep -n '"mcp"\|case "mcp"' src/cli/main.ts`.

- [ ] **Step 2: Write failing tests** —
  `tests/cli/mcp-scope-arg.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { runCli } from "../helpers/run-cli.ts";

  describe("o2b mcp --scope arg validation", () => {
    test("invalid scope value exits 2 with a clear error", async () => {
      const res = await runCli(["mcp", "--scope", "nope"], { stdin: "" });
      expect(res.returncode).toBe(2);
      expect(res.stderr).toContain("--scope");
      expect(res.stderr).toMatch(/full.*writer|writer.*full/);
    });

    test("missing --scope value exits 2", async () => {
      const res = await runCli(["mcp", "--scope"], { stdin: "" });
      expect(res.returncode).toBe(2);
    });

    test("--scope writer starts the server and answers tools/list", async () => {
      const init = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const list = JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      });
      const res = await runCli(
        ["mcp", "--scope", "writer"],
        { stdin: `${init}\n${list}\n` },
      );
      expect(res.returncode).toBe(0);
      const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const names = (lines[1].result.tools as Array<{ name: string }>)
        .map((t) => t.name).sort();
      expect(names).toEqual(["brain_apply_evidence", "brain_feedback"]);
    });
  });
  ```

- [ ] **Step 3: Run tests, expect FAIL.**

- [ ] **Step 4: Parse and forward the flag.** In `src/cli/main.ts`,
  inside the `mcp` subcommand branch:

  ```ts
  // existing: collects positional args, vault override, etc.
  let scope: "full" | "writer" = "full";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope") {
      const v = args[i + 1];
      if (v !== "full" && v !== "writer") {
        process.stderr.write(
          `o2b mcp: invalid --scope value: ${v ?? "<missing>"}; expected one of: full, writer\n`,
        );
        process.exit(2);
      }
      scope = v;
      args.splice(i, 2);
      i--;
    }
  }
  const serverName = scope === "writer"
    ? "open-second-brain-writer"
    : "open-second-brain";
  await serveStdio(ctx, { scope, serverName });
  ```

  The exact positional-parsing context depends on the current
  CLI structure (it might already have a `parseFlags` helper). If
  a helper exists, add `--scope` to it; do not duplicate parsing.

- [ ] **Step 5: Run tests, expect PASS.**

- [ ] **Step 6: Run full test sweep.**

**Pause for review.**

### Task 1.5: Writer-server instructions text

**Files:**
- Modify: `src/mcp/instructions.ts`.

- [ ] **Step 1: Read current `buildInstructions`** — `cat src/mcp/instructions.ts`.

- [ ] **Step 2: Write failing test** — append to
  `tests/mcp/mcp.test.ts`:

  ```ts
  import { buildInstructions } from "../../src/mcp/instructions.ts";

  describe("buildInstructions writer mode", () => {
    test("writer instructions name both tools and point at the full server", () => {
      const text = buildInstructions({
        vault: "/tmp/x",
        agent: "@agent",
        scope: "writer",
      });
      expect(text).toContain("brain_feedback");
      expect(text).toContain("brain_apply_evidence");
      expect(text).toContain("open-second-brain"); // points at sibling server
      expect(text).not.toMatch(/payment_/i);
      expect(text).not.toMatch(/brain_dream/);
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL**.

- [ ] **Step 4: Implement the writer branch** — in
  `src/mcp/instructions.ts`:

  ```ts
  export interface BuildInstructionsOpts {
    readonly vault: string;
    readonly agent: string;
    readonly scope?: ToolScope;
  }

  const WRITER_INSTRUCTIONS = `Open Second Brain — writer surface (always-loaded).

  Two tools live here:
    - brain_feedback        — record one new taste signal the user just expressed.
    - brain_apply_evidence  — record applied | violated | outdated against an
                              active preference for an artifact this turn produced.

  The full Brain surface (brain_dream, brain_digest, brain_query, brain_doctor,
  brain_backlinks, brain_search, Pay Memory tools, vault_health,
  second_brain_status, second_brain_query) lives on the sibling
  "open-second-brain" MCP server (deferred). Use ToolSearch to reach it.

  Prefer the writer-server copy of brain_feedback / brain_apply_evidence over
  any duplicate exposed by the full server — both call the same handler, but the
  writer copy is always available without ToolSearch.`;

  export function buildInstructions(opts: BuildInstructionsOpts): string {
    if (opts.scope === "writer") return WRITER_INSTRUCTIONS;
    // existing full-surface text branch ...
  }
  ```

  Wire `serveStdio` / `MCPServer.handleInitialize` to call
  `buildInstructions({ vault, agent, scope })` instead of the
  current arg-less / scope-blind call.

- [ ] **Step 5: Run test, expect PASS**.

- [ ] **Step 6: Full sweep.**

**Pause for review.**

### Task 1.6: `.mcp.json` second-server entry

**Files:**
- Modify: `/srv/projects/open-second-brain/.mcp.json`.
- Create: `tests/mcp/mcp-json.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/mcp/mcp-json.test.ts`:

  ```ts
  import { readFileSync } from "node:fs";
  import { describe, expect, test } from "bun:test";

  describe(".mcp.json shipped with the plugin", () => {
    const file = JSON.parse(
      readFileSync("/srv/projects/open-second-brain/.mcp.json", "utf8"),
    );
    test("declares both open-second-brain and -writer entries", () => {
      expect(Object.keys(file.mcpServers).sort()).toEqual([
        "open-second-brain",
        "open-second-brain-writer",
      ]);
    });
    test("writer entry passes --scope writer and alwaysLoad: true", () => {
      const w = file.mcpServers["open-second-brain-writer"];
      expect(w.command).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/o2b");
      expect(w.args).toEqual(["mcp", "--scope", "writer"]);
      expect(w.alwaysLoad).toBe(true);
    });
    test("full server has no alwaysLoad flag", () => {
      const f = file.mcpServers["open-second-brain"];
      expect(f.alwaysLoad).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Update `.mcp.json`:**

  ```json
  {
    "mcpServers": {
      "open-second-brain": {
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
        "args": ["mcp"]
      },
      "open-second-brain-writer": {
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
        "args": ["mcp", "--scope", "writer"],
        "alwaysLoad": true
      }
    }
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review. End of §B track.**

---

## Phase 2 — §D Discipline report

### Task 2.1: Config schema for `discipline_report`

**Files:**
- Modify: `src/core/brain/policy.ts` (extend `BrainConfig`).
- Create: `tests/core/brain/policy-discipline.test.ts`.

- [ ] **Step 1: Inspect the current `BrainConfig` shape** —
  `grep -n "BrainConfig\b\|discipline" src/core/brain/policy.ts`.

- [ ] **Step 2: Write failing test** —
  `tests/core/brain/policy-discipline.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { loadBrainConfig } from "../../../src/core/brain/policy.ts";

  function vaultWith(yaml: string): string {
    const v = mkdtempSync(join(tmpdir(), "o2b-policy-"));
    mkdirSync(join(v, "Brain"), { recursive: true });
    writeFileSync(join(v, "Brain", "_brain.yaml"), yaml, "utf8");
    return v;
  }

  describe("discipline_report config", () => {
    test("missing section → discipline_report undefined", () => {
      const v = vaultWith("schema_version: 1\n");
      const cfg = loadBrainConfig(v);
      expect(cfg.discipline_report).toBeUndefined();
      rmSync(v, { recursive: true });
    });

    test("populated section is parsed verbatim", () => {
      const v = vaultWith(
        "schema_version: 1\n" +
        "discipline_report:\n" +
        "  enabled: true\n" +
        "  timezone: Europe/Belgrade\n" +
        "  watched_paths:\n" +
        "    - /srv/projects/foo\n" +
        "  known_agents:\n" +
        "    - '@claude-vps-agent'\n",
      );
      const cfg = loadBrainConfig(v);
      expect(cfg.discipline_report).toEqual({
        enabled: true,
        timezone: "Europe/Belgrade",
        watched_paths: ["/srv/projects/foo"],
        known_agents: ["@claude-vps-agent"],
      });
      rmSync(v, { recursive: true });
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL.**

- [ ] **Step 4: Extend `BrainConfig`** in `src/core/brain/policy.ts`:

  ```ts
  export interface DisciplineReportConfig {
    readonly enabled: boolean;
    readonly timezone: string;
    readonly watched_paths: ReadonlyArray<string>;
    readonly known_agents: ReadonlyArray<string>;
  }

  export interface BrainConfig {
    // ... existing fields ...
    readonly discipline_report?: DisciplineReportConfig;
  }
  ```

  In `loadBrainConfig` (or its detailed sibling), read the
  `discipline_report` mapping from the parsed YAML, validate types
  (enabled: boolean, timezone: string, watched_paths/known_agents:
  string array). On type mismatch, append a `BrainConfigLoadWarning`
  and drop the section (return `undefined`) — do not throw, so an
  invalid config doesn't break unrelated CLI verbs.

- [ ] **Step 5: Run test, expect PASS.**

- [ ] **Step 6: Full sweep.**

**Pause for review.**

### Task 2.2: Brain-log counter per agent

**Files:**
- Create: `src/core/discipline/log-counts.ts`.
- Create: `tests/discipline/log-counts.test.ts`.
- (`tests/discipline/` is new; bun-test discovers it via the
  same root config.)

- [ ] **Step 1: Inspect existing `parseLogDay`** —
  `cat src/core/brain/log.ts | head -120`. Confirm
  `parseLogDay(vault, date)` returns `{ entries, warnings }` where
  each entry has `eventType` and `body`.

- [ ] **Step 2: Write failing test** —
  `tests/discipline/log-counts.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { countBrainEvents } from "../../src/core/discipline/log-counts.ts";

  function vaultWithLog(dayBody: string): string {
    const v = mkdtempSync(join(tmpdir(), "o2b-disc-log-"));
    const dir = join(v, "Brain", "log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-05-17.md"),
      "---\nkind: brain-log\ndate: 2026-05-17\ntags: [brain]\n---\n\n" + dayBody,
      "utf8",
    );
    return v;
  }

  describe("countBrainEvents", () => {
    test("buckets by kind per agent and ignores no-agent blocks", () => {
      const body =
        "## 08:00:00Z — feedback\n- agent: @claude-vps-agent\n- topic: foo\n\n" +
        "## 09:00:00Z — apply-evidence\n- agent: @claude-vps-agent\n- pref_id: pref-x\n\n" +
        "## 10:00:00Z — feedback\n- agent: @codex-vps-agent\n- topic: bar\n\n" +
        "## 11:00:00Z — dream-pass\n- agent: @claude-vps-agent\n- promoted: 0\n\n" +
        "## 12:00:00Z — snapshot\n- run_id: x\n";
      const v = vaultWithLog(body);
      const out = countBrainEvents(v, "2026-05-17", [
        "@claude-vps-agent",
        "@codex-vps-agent",
      ]);
      expect(out.byAgent["@claude-vps-agent"]).toEqual({
        feedback: 1,
        apply_evidence: 1,
        other: 1,
        total: 3,
      });
      expect(out.byAgent["@codex-vps-agent"]).toEqual({
        feedback: 1,
        apply_evidence: 0,
        other: 0,
        total: 1,
      });
      expect(out.total).toBe(4);
      expect(out.unknownAgents).toEqual([]);
      rmSync(v, { recursive: true });
    });

    test("agent missing from known_agents shows under unknownAgents", () => {
      const body =
        "## 08:00:00Z — feedback\n- agent: @stranger\n- topic: foo\n\n";
      const v = vaultWithLog(body);
      const out = countBrainEvents(v, "2026-05-17", ["@claude-vps-agent"]);
      expect(out.byAgent["@claude-vps-agent"]).toEqual({
        feedback: 0,
        apply_evidence: 0,
        other: 0,
        total: 0,
      });
      expect(out.unknownAgents).toEqual([
        { agent: "@stranger", counts: { feedback: 1, apply_evidence: 0, other: 0, total: 1 } },
      ]);
      rmSync(v, { recursive: true });
    });

    test("missing log file → all zeros, no error", () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-disc-log-empty-"));
      const out = countBrainEvents(v, "2026-05-17", ["@claude-vps-agent"]);
      expect(out.total).toBe(0);
      expect(out.byAgent["@claude-vps-agent"].total).toBe(0);
      rmSync(v, { recursive: true });
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL.**

- [ ] **Step 4: Implement** — `src/core/discipline/log-counts.ts`:

  ```ts
  import { parseLogDay } from "../brain/log.ts";

  export interface AgentCounts {
    readonly feedback: number;
    readonly apply_evidence: number;
    readonly other: number;
    readonly total: number;
  }

  export interface BrainEventCounts {
    readonly byAgent: Readonly<Record<string, AgentCounts>>;
    readonly unknownAgents: ReadonlyArray<{ agent: string; counts: AgentCounts }>;
    readonly total: number;
  }

  function zero(): AgentCounts {
    return { feedback: 0, apply_evidence: 0, other: 0, total: 0 };
  }

  function bump(c: AgentCounts, kind: string): AgentCounts {
    if (kind === "feedback") return { ...c, feedback: c.feedback + 1, total: c.total + 1 };
    if (kind === "apply-evidence") return { ...c, apply_evidence: c.apply_evidence + 1, total: c.total + 1 };
    return { ...c, other: c.other + 1, total: c.total + 1 };
  }

  export function countBrainEvents(
    vault: string,
    date: string,
    knownAgents: ReadonlyArray<string>,
  ): BrainEventCounts {
    const byAgent: Record<string, AgentCounts> = {};
    for (const a of knownAgents) byAgent[a] = zero();

    const unknown: Record<string, AgentCounts> = {};
    const { entries } = parseLogDay(vault, date);
    let total = 0;
    for (const e of entries) {
      const agentField = e.body["agent"];
      if (!agentField || Array.isArray(agentField)) continue;
      const target = knownAgents.includes(agentField)
        ? byAgent
        : unknown;
      target[agentField] = bump(target[agentField] ?? zero(), e.eventType);
      total += 1;
    }

    return {
      byAgent,
      unknownAgents: Object.entries(unknown).map(([agent, counts]) => ({ agent, counts })),
      total,
    };
  }
  ```

- [ ] **Step 5: Run test, expect PASS.**

- [ ] **Step 6: Full sweep.**

**Pause for review.**

### Task 2.3: Date-window helper (vault tz → UTC bounds)

**Files:**
- Create: `src/core/discipline/window.ts`.
- Create: `tests/discipline/window.test.ts`.

- [ ] **Step 1: Write failing test** — `tests/discipline/window.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { yesterdayWindow } from "../../src/core/discipline/window.ts";

  describe("yesterdayWindow", () => {
    test("Europe/Belgrade at 06:00 local → window covers prior local day", () => {
      // 2026-05-18T06:00:00 in Belgrade = 2026-05-18T04:00:00Z (CEST UTC+2).
      const now = new Date("2026-05-18T04:00:00Z");
      const w = yesterdayWindow(now, "Europe/Belgrade");
      expect(w.localDate).toBe("2026-05-17");
      // Window starts at 2026-05-17T00:00:00 local = 2026-05-16T22:00:00Z.
      expect(w.startUtc.toISOString()).toBe("2026-05-16T22:00:00.000Z");
      expect(w.endUtc.toISOString()).toBe("2026-05-17T22:00:00.000Z");
    });

    test("UTC timezone → naive 24h window", () => {
      const now = new Date("2026-05-18T03:00:00Z");
      const w = yesterdayWindow(now, "UTC");
      expect(w.localDate).toBe("2026-05-17");
      expect(w.startUtc.toISOString()).toBe("2026-05-17T00:00:00.000Z");
      expect(w.endUtc.toISOString()).toBe("2026-05-18T00:00:00.000Z");
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/window.ts`:

  ```ts
  export interface YesterdayWindow {
    readonly localDate: string;  // YYYY-MM-DD in tz
    readonly startUtc: Date;
    readonly endUtc: Date;
  }

  /**
   * Compute the [start, end) UTC interval that covers "yesterday" in the
   * given IANA timezone, relative to `now`. The Intl API is used to
   * project `now` to the local civil date and the day boundaries back
   * to UTC — JS has no built-in tz-aware Date arithmetic, but Intl
   * formatting is enough for our purposes (granularity: 1 second).
   */
  export function yesterdayWindow(now: Date, tz: string): YesterdayWindow {
    // Project now → local civil date.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const todayLocal = fmt.format(now); // e.g. "2026-05-18"
    const [y, m, d] = todayLocal.split("-").map(Number);
    const todayLocalMidnightUtc = localMidnightUtc(y, m, d, tz);
    const yesterdayLocalMidnightUtc = new Date(
      todayLocalMidnightUtc.getTime() - 24 * 60 * 60 * 1000,
    );
    // localDate = yesterday in tz
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(yesterdayLocalMidnightUtc);
    return {
      localDate,
      startUtc: yesterdayLocalMidnightUtc,
      endUtc: todayLocalMidnightUtc,
    };
  }

  /**
   * Find the UTC instant that corresponds to local midnight on the given
   * civil date in tz. Binary-search-free: try the naive UTC midnight,
   * then iteratively correct using Intl's offset for that instant. Two
   * iterations is enough for any IANA timezone (verified against tzdata
   * 2024a — no DST transition shifts by more than 1 hour from a
   * 24-hour-aligned UTC instant).
   */
  function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
    let guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    for (let i = 0; i < 4; i++) {
      const local = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
      }).format(guess);
      // Parse "YYYY-MM-DD, HH:MM:SS"
      const [date, time] = local.split(", ");
      const [hh, mm, ss] = time.split(":").map(Number);
      const drift = hh * 3600 + mm * 60 + ss;
      if (date === `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}` && drift === 0) return guess;
      guess = new Date(guess.getTime() - drift * 1000);
    }
    return guess;
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.4: Git-activity proxy

**Files:**
- Create: `src/core/discipline/activity-git.ts`.
- Create: `tests/discipline/activity-git.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/activity-git.test.ts`:

  ```ts
  import { describe, expect, test, beforeAll, afterAll } from "bun:test";
  import { execSync } from "node:child_process";
  import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { gitActivity } from "../../src/core/discipline/activity-git.ts";

  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "o2b-disc-git-"));
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email t@t && git config user.name t", { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hello\n");
    execSync("git add a.txt && git commit -q -m c1 --date=2026-05-17T10:00:00Z",
      { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T10:00:00Z" } });
    writeFileSync(join(repo, "a.txt"), "hello\nworld\n");
    execSync("git add a.txt && git commit -q -m c2 --date=2026-05-17T20:00:00Z",
      { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T20:00:00Z" } });
    writeFileSync(join(repo, "b.txt"), "x\n");
    execSync("git add b.txt && git commit -q -m c3 --date=2026-05-18T10:00:00Z",
      { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-18T10:00:00Z" } });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  describe("gitActivity", () => {
    test("counts only commits inside the [start, end) UTC window", () => {
      const out = gitActivity(repo, {
        startUtc: new Date("2026-05-17T00:00:00Z"),
        endUtc: new Date("2026-05-18T00:00:00Z"),
      });
      expect(out.commits).toBe(2);
      expect(out.filesChanged).toBe(1);
      expect(out.insertions).toBe(2); // 1 + 1
      expect(out.deletions).toBe(0);
    });

    test("non-git path → null sentinel, no throw", () => {
      const empty = mkdtempSync(join(tmpdir(), "o2b-disc-nogit-"));
      const out = gitActivity(empty, {
        startUtc: new Date("2026-05-17T00:00:00Z"),
        endUtc: new Date("2026-05-18T00:00:00Z"),
      });
      expect(out).toBeNull();
      rmSync(empty, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/activity-git.ts`:

  ```ts
  import { existsSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  import { join } from "node:path";

  export interface ActivityWindow {
    readonly startUtc: Date;
    readonly endUtc: Date;
  }

  export interface GitActivity {
    readonly commits: number;
    readonly filesChanged: number;
    readonly insertions: number;
    readonly deletions: number;
  }

  export function gitActivity(
    path: string,
    win: ActivityWindow,
  ): GitActivity | null {
    if (!existsSync(join(path, ".git"))) return null;
    const since = win.startUtc.toISOString();
    const until = win.endUtc.toISOString();
    let raw: string;
    try {
      raw = execFileSync(
        "git",
        [
          "-C", path, "log",
          `--since=${since}`, `--until=${until}`,
          "--no-merges", "--shortstat",
          "--pretty=tformat:__COMMIT__",
        ],
        { encoding: "utf8" },
      );
    } catch {
      return { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 };
    }

    const out = { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 };
    for (const line of raw.split("\n")) {
      if (line === "__COMMIT__") {
        out.commits += 1;
        continue;
      }
      // " 1 file changed, 2 insertions(+), 1 deletion(-)"
      const m = line.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
      if (!m) continue;
      out.filesChanged += Number(m[1]);
      out.insertions += Number(m[2] ?? 0);
      out.deletions += Number(m[3] ?? 0);
    }
    return out;
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.5: Non-git mtime walk

**Files:**
- Create: `src/core/discipline/activity-mtime.ts`.
- Create: `tests/discipline/activity-mtime.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/activity-mtime.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import {
    mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync,
  } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { mtimeActivity } from "../../src/core/discipline/activity-mtime.ts";

  function touch(path: string, isoUtc: string): void {
    const ts = new Date(isoUtc).getTime() / 1000;
    utimesSync(path, ts, ts);
  }

  describe("mtimeActivity", () => {
    test("counts files mtime'd inside the window; excludes noise dirs", () => {
      const root = mkdtempSync(join(tmpdir(), "o2b-disc-mtime-"));
      writeFileSync(join(root, "in1.txt"), "x");
      touch(join(root, "in1.txt"), "2026-05-17T10:00:00Z");
      writeFileSync(join(root, "in2.md"), "x");
      touch(join(root, "in2.md"), "2026-05-17T20:00:00Z");
      writeFileSync(join(root, "out.txt"), "x");
      touch(join(root, "out.txt"), "2026-05-18T10:00:00Z");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "node_modules", "noise.js"), "x");
      touch(join(root, "node_modules", "noise.js"), "2026-05-17T15:00:00Z");
      mkdirSync(join(root, "subdir"));
      writeFileSync(join(root, "subdir", "in3.md"), "x");
      touch(join(root, "subdir", "in3.md"), "2026-05-17T15:00:00Z");

      const out = mtimeActivity(root, {
        startUtc: new Date("2026-05-17T00:00:00Z"),
        endUtc: new Date("2026-05-18T00:00:00Z"),
      });
      expect(out.modifiedFiles).toBe(3);
      rmSync(root, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/activity-mtime.ts`:

  ```ts
  import { readdirSync, statSync } from "node:fs";
  import { join } from "node:path";
  import type { ActivityWindow } from "./activity-git.ts";

  const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
    ".git", ".hg", ".svn",
    "node_modules", ".cache",
    "__pycache__", ".venv", "venv",
    ".snapshots",
    "dist", "build", "out",
  ]);

  export interface MtimeActivity {
    readonly modifiedFiles: number;
  }

  export function mtimeActivity(root: string, win: ActivityWindow): MtimeActivity {
    const startMs = win.startUtc.getTime();
    const endMs = win.endUtc.getTime();
    let count = 0;

    function walk(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (EXCLUDE_DIRS.has(name)) continue;
        const p = join(dir, name);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(p);
          continue;
        }
        if (!st.isFile()) continue;
        const m = st.mtimeMs;
        if (m >= startMs && m < endMs) count += 1;
      }
    }

    walk(root);
    return { modifiedFiles: count };
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.6: Vault delta source

**Files:**
- Create: `src/core/discipline/vault-delta.ts`.
- Create: `tests/discipline/vault-delta.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/vault-delta.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { vaultDelta } from "../../src/core/discipline/vault-delta.ts";

  function touch(path: string, iso: string): void {
    const t = new Date(iso).getTime() / 1000;
    utimesSync(path, t, t);
  }

  describe("vaultDelta", () => {
    test("counts signal / preference / retired files inside window", () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-disc-delta-"));
      mkdirSync(join(v, "Brain", "inbox"), { recursive: true });
      mkdirSync(join(v, "Brain", "preferences"), { recursive: true });
      mkdirSync(join(v, "Brain", "retired"), { recursive: true });
      writeFileSync(join(v, "Brain", "inbox", "sig-1.md"), "x");
      touch(join(v, "Brain", "inbox", "sig-1.md"), "2026-05-17T12:00:00Z");
      writeFileSync(join(v, "Brain", "inbox", "sig-2.md"), "x");
      touch(join(v, "Brain", "inbox", "sig-2.md"), "2026-05-17T13:00:00Z");
      writeFileSync(join(v, "Brain", "preferences", "pref-x.md"), "x");
      touch(join(v, "Brain", "preferences", "pref-x.md"), "2026-05-17T18:00:00Z");
      writeFileSync(join(v, "Brain", "retired", "pref-y.md"), "x");
      touch(join(v, "Brain", "retired", "pref-y.md"), "2026-05-16T10:00:00Z");

      const out = vaultDelta(v, {
        startUtc: new Date("2026-05-17T00:00:00Z"),
        endUtc: new Date("2026-05-18T00:00:00Z"),
      });
      expect(out.newSignals).toBe(2);
      expect(out.newPreferences).toBe(1);
      expect(out.newRetired).toBe(0);
      expect(out.total).toBe(3);
      rmSync(v, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/vault-delta.ts`:

  ```ts
  import { existsSync, readdirSync, statSync } from "node:fs";
  import { join } from "node:path";
  import type { ActivityWindow } from "./activity-git.ts";

  export interface VaultDelta {
    readonly newSignals: number;
    readonly newPreferences: number;
    readonly newRetired: number;
    readonly total: number;
  }

  function countInWindow(dir: string, win: ActivityWindow): number {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= win.startUtc.getTime() && st.mtimeMs < win.endUtc.getTime()) n += 1;
    }
    return n;
  }

  export function vaultDelta(vault: string, win: ActivityWindow): VaultDelta {
    const newSignals = countInWindow(join(vault, "Brain", "inbox"), win);
    const newPreferences = countInWindow(join(vault, "Brain", "preferences"), win);
    const newRetired = countInWindow(join(vault, "Brain", "retired"), win);
    return {
      newSignals, newPreferences, newRetired,
      total: newSignals + newPreferences + newRetired,
    };
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.7: Status decision

**Files:**
- Create: `src/core/discipline/decision.ts`.
- Create: `tests/discipline/decision.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/decision.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { decideStatus } from "../../src/core/discipline/decision.ts";

  describe("decideStatus", () => {
    const noEvents = { byAgent: {}, unknownAgents: [], total: 0 } as any;
    const someEvents = { ...noEvents, total: 5 };
    const noActivity = {
      repo: [], nonRepo: [], vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
    } as any;
    const someRepoActivity = {
      ...noActivity, repo: [{ path: "/a", git: { commits: 2, filesChanged: 1, insertions: 1, deletions: 0 } }],
    };
    const someMtimeActivity = {
      ...noActivity, nonRepo: [{ path: "/b", modifiedFiles: 5 }],
    };
    const someVaultDelta = {
      ...noActivity, vaultDelta: { newSignals: 0, newPreferences: 1, newRetired: 0, total: 1 },
    };

    test("0 events + 0 activity → info", () => {
      expect(decideStatus(noEvents, noActivity)).toBe("info");
    });
    test("0 events + repo activity → alert", () => {
      expect(decideStatus(noEvents, someRepoActivity)).toBe("alert");
    });
    test("0 events + mtime activity (>=3) → alert", () => {
      expect(decideStatus(noEvents, someMtimeActivity)).toBe("alert");
    });
    test("0 events + mtime activity (<3) → info", () => {
      const low = { ...noActivity, nonRepo: [{ path: "/b", modifiedFiles: 2 }] };
      expect(decideStatus(noEvents, low)).toBe("info");
    });
    test("0 events + vault delta → alert", () => {
      expect(decideStatus(noEvents, someVaultDelta)).toBe("alert");
    });
    test("any events present → ok regardless of activity", () => {
      expect(decideStatus(someEvents, noActivity)).toBe("ok");
      expect(decideStatus(someEvents, someRepoActivity)).toBe("ok");
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/decision.ts`:

  ```ts
  import type { BrainEventCounts } from "./log-counts.ts";
  import type { GitActivity } from "./activity-git.ts";
  import type { MtimeActivity } from "./activity-mtime.ts";
  import type { VaultDelta } from "./vault-delta.ts";

  export interface RepoActivityRow {
    readonly path: string;
    readonly git: GitActivity;
  }
  export interface NonRepoActivityRow {
    readonly path: string;
    readonly modifiedFiles: number;
  }

  export interface ActivitySummary {
    readonly repo: ReadonlyArray<RepoActivityRow>;
    readonly nonRepo: ReadonlyArray<NonRepoActivityRow>;
    readonly vaultDelta: VaultDelta;
  }

  export type DisciplineStatus = "ok" | "info" | "alert";

  export function decideStatus(
    events: BrainEventCounts,
    activity: ActivitySummary,
  ): DisciplineStatus {
    if (events.total > 0) return "ok";
    const repoCommits = activity.repo.reduce((a, r) => a + r.git.commits, 0);
    const mtimeFiles = activity.nonRepo.reduce((a, r) => a + r.modifiedFiles, 0);
    const vaultActive = activity.vaultDelta.total > 0;
    const activitySignal = repoCommits > 0 || mtimeFiles >= 3 || vaultActive;
    return activitySignal ? "alert" : "info";
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.8: Telegram MarkdownV2 escape

**Files:**
- Create: `src/core/discipline/telegram.ts`.
- Create: `tests/discipline/telegram.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/telegram.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { escapeMarkdownV2 } from "../../src/core/discipline/telegram.ts";

  describe("escapeMarkdownV2", () => {
    test("escapes the 16 reserved characters", () => {
      const input = "_*[]()~`>#+-=|{}.!\\";
      const out = escapeMarkdownV2(input);
      // Each reserved char becomes \X.
      expect(out).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
    });
    test("leaves regular text untouched", () => {
      expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
    });
    test("escapes a realistic agent identifier", () => {
      expect(escapeMarkdownV2("@claude-vps-agent")).toBe("@claude\\-vps\\-agent");
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/telegram.ts`:

  ```ts
  // Telegram MarkdownV2 reserves these — backslash-escape them.
  const RESERVED = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

  export function escapeMarkdownV2(s: string): string {
    return s.replace(RESERVED, "\\$1");
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.9: Render the Telegram block

**Files:**
- Create: `src/core/discipline/render.ts`.
- Create: `tests/discipline/render.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/render.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { renderReport } from "../../src/core/discipline/render.ts";

  describe("renderReport", () => {
    test("status: ok with two agents, one repo, vault delta", () => {
      const text = renderReport({
        localDate: "2026-05-17",
        timezone: "Europe/Belgrade",
        status: "ok",
        events: {
          byAgent: {
            "@claude-vps-agent": { feedback: 2, apply_evidence: 3, other: 0, total: 5 },
            "@codex-vps-agent": { feedback: 0, apply_evidence: 0, other: 0, total: 0 },
          },
          unknownAgents: [],
          total: 5,
        },
        activity: {
          repo: [{ path: "/srv/projects/foo", git: { commits: 4, filesChanged: 27, insertions: 312, deletions: 148 } }],
          nonRepo: [],
          vaultDelta: { newSignals: 1, newPreferences: 0, newRetired: 0, total: 1 },
        },
      });
      expect(text).toContain("OSB discipline");
      expect(text).toContain("2026\\-05\\-17");
      expect(text).toContain("Europe/Belgrade");
      expect(text).toContain("Status: ok");
      expect(text).toContain("@claude\\-vps\\-agent");
      expect(text).toContain("2 feedback, 3 apply\\-evidence, 0 other \\(total 5\\)");
      expect(text).toContain("/srv/projects/foo");
      expect(text).toContain("4 commits");
      expect(text).toContain("vault");
      expect(text).not.toContain("Activity ratio");
    });

    test("status: alert appends the explanatory line", () => {
      const text = renderReport({
        localDate: "2026-05-17",
        timezone: "UTC",
        status: "alert",
        events: { byAgent: { "@a": { feedback: 0, apply_evidence: 0, other: 0, total: 0 } }, unknownAgents: [], total: 0 },
        activity: {
          repo: [{ path: "/x", git: { commits: 3, filesChanged: 5, insertions: 10, deletions: 2 } }],
          nonRepo: [],
          vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
        },
      });
      expect(text).toContain("Status: alert");
      expect(text).toContain("zero brain events");
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/render.ts`:

  ```ts
  import { escapeMarkdownV2 as e } from "./telegram.ts";
  import type { BrainEventCounts } from "./log-counts.ts";
  import type { ActivitySummary, DisciplineStatus } from "./decision.ts";

  export interface RenderInput {
    readonly localDate: string;
    readonly timezone: string;
    readonly status: DisciplineStatus;
    readonly events: BrainEventCounts;
    readonly activity: ActivitySummary;
  }

  export function renderReport(r: RenderInput): string {
    const lines: string[] = [];
    lines.push(`🧠 OSB discipline — ${e(r.localDate)} \\(${e(r.timezone)}\\)`);
    lines.push("");
    lines.push(`Status: ${e(r.status)}`);
    lines.push("");

    lines.push("Brain events:");
    const knownEntries = Object.entries(r.events.byAgent);
    if (knownEntries.length === 0) {
      lines.push("\\- \\(no known agents configured\\)");
    } else {
      for (const [agent, c] of knownEntries) {
        lines.push(
          `\\- ${e(agent)}: ${c.feedback} feedback, ${c.apply_evidence} apply\\-evidence, ${c.other} other \\(total ${c.total}\\)`,
        );
      }
    }
    for (const u of r.events.unknownAgents) {
      lines.push(
        `\\- ${e(u.agent)} \\(unknown\\): ${u.counts.feedback} feedback, ${u.counts.apply_evidence} apply\\-evidence, ${u.counts.other} other \\(total ${u.counts.total}\\)`,
      );
    }
    lines.push("");

    lines.push("Activity:");
    for (const row of r.activity.repo) {
      lines.push(
        `\\- ${e(row.path)} — ${row.git.commits} commits, ${row.git.filesChanged} files, \\+${row.git.insertions}/\\-${row.git.deletions}`,
      );
    }
    for (const row of r.activity.nonRepo) {
      lines.push(`\\- ${e(row.path)} — ${row.modifiedFiles} modified files`);
    }
    const vd = r.activity.vaultDelta;
    lines.push(
      `\\- vault — ${vd.newSignals} new signals, ${vd.newPreferences} new preferences, ${vd.newRetired} new retired`,
    );

    if (r.status === "alert") {
      lines.push("");
      lines.push(
        "\\_Activity present; zero brain events recorded\\. Stop guardrail likely bypassed or hook regressed\\.\\_",
      );
    }
    return lines.join("\n");
  }
  ```

  Note the em-dash `—` in "Activity:" / "vault —" lines is the
  literal Unicode character (U+2014). Telegram MarkdownV2 does not
  treat it as reserved, so no escape needed; the escape helper
  leaves it alone.

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.10: Orchestrator `runDisciplineReport`

**Files:**
- Create: `src/core/discipline/report.ts`.
- Create: `tests/discipline/report.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/discipline/report.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { execSync } from "node:child_process";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { runDisciplineReport } from "../../src/core/discipline/report.ts";

  describe("runDisciplineReport", () => {
    test("end-to-end: empty log + active repo → alert text emitted", () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-disc-e2e-vault-"));
      mkdirSync(join(vault, "Brain", "log"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "_brain.yaml"),
        "schema_version: 1\ndiscipline_report:\n" +
        "  enabled: true\n  timezone: UTC\n" +
        "  watched_paths:\n    - " + vault + "/repo\n" +
        "  known_agents:\n    - '@claude-vps-agent'\n",
        "utf8",
      );

      const repo = join(vault, "repo");
      mkdirSync(repo);
      execSync("git init -q -b main", { cwd: repo });
      execSync("git config user.email t@t && git config user.name t", { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "hi\n");
      execSync("git add . && git commit -q -m c1", {
        cwd: repo,
        env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T10:00:00Z", GIT_AUTHOR_DATE: "2026-05-17T10:00:00Z" },
      });

      const res = runDisciplineReport({
        vault,
        now: new Date("2026-05-18T01:00:00Z"),
      });
      expect(res.status).toBe("alert");
      expect(res.text).toContain("Status: alert");
      expect(res.text).toContain("1 commits");
      rmSync(vault, { recursive: true });
    });

    test("disabled config → result.status='disabled', empty text", () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-disc-dis-"));
      mkdirSync(join(vault, "Brain"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "_brain.yaml"),
        "schema_version: 1\ndiscipline_report:\n  enabled: false\n  timezone: UTC\n  watched_paths: []\n  known_agents: []\n",
        "utf8",
      );
      const res = runDisciplineReport({ vault, now: new Date() });
      expect(res.status).toBe("disabled");
      expect(res.text).toBe("");
      rmSync(vault, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/core/discipline/report.ts`:

  ```ts
  import { loadBrainConfig } from "../brain/policy.ts";
  import { existsSync } from "node:fs";
  import { join } from "node:path";

  import { countBrainEvents, type BrainEventCounts } from "./log-counts.ts";
  import { gitActivity } from "./activity-git.ts";
  import { mtimeActivity } from "./activity-mtime.ts";
  import { vaultDelta } from "./vault-delta.ts";
  import { decideStatus, type ActivitySummary, type DisciplineStatus } from "./decision.ts";
  import { renderReport } from "./render.ts";
  import { yesterdayWindow } from "./window.ts";

  export interface RunDisciplineReportOpts {
    readonly vault: string;
    readonly now?: Date;
  }

  export interface DisciplineReportResult {
    readonly status: DisciplineStatus | "disabled";
    readonly text: string;
    readonly localDate: string | null;
    readonly events: BrainEventCounts | null;
    readonly activity: ActivitySummary | null;
  }

  export function runDisciplineReport(opts: RunDisciplineReportOpts): DisciplineReportResult {
    const cfg = loadBrainConfig(opts.vault);
    const d = cfg.discipline_report;
    if (!d || !d.enabled) {
      return { status: "disabled", text: "", localDate: null, events: null, activity: null };
    }
    const now = opts.now ?? new Date();
    const win = yesterdayWindow(now, d.timezone);
    const events = countBrainEvents(opts.vault, win.localDate, d.known_agents);

    const repo: ActivitySummary["repo"] = [];
    const nonRepo: ActivitySummary["nonRepo"] = [];
    for (const p of d.watched_paths) {
      const g = gitActivity(p, win);
      if (g !== null) {
        repo.push({ path: p, git: g });
      } else if (existsSync(p)) {
        const m = mtimeActivity(p, win);
        nonRepo.push({ path: p, modifiedFiles: m.modifiedFiles });
      }
    }
    const vd = vaultDelta(opts.vault, win);

    const activity: ActivitySummary = { repo, nonRepo, vaultDelta: vd };
    const status = decideStatus(events, activity);
    const text = renderReport({
      localDate: win.localDate,
      timezone: d.timezone,
      status,
      events,
      activity,
    });
    return { status, text, localDate: win.localDate, events, activity };
  }
  ```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review.**

### Task 2.11: `bin/o2b-discipline-report` script

**Files:**
- Create: `bin/o2b-discipline-report` (executable).
- (Tested via the CLI verb in Task 2.12; this is a thin shim.)

- [ ] **Step 1: Create file** —
  `bin/o2b-discipline-report` with content:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exec bun run "$HERE/../scripts/discipline-report.ts" "$@"
  ```

- [ ] **Step 2: Create the actual TS entry** —
  `scripts/discipline-report.ts`:

  ```ts
  #!/usr/bin/env -S bun
  import { discoverConfig } from "../src/core/config.ts";
  import { runDisciplineReport } from "../src/core/discipline/report.ts";

  function readVaultArg(): string {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--vault" && argv[i + 1]) return argv[i + 1]!;
    }
    const cfg = discoverConfig();
    const v = cfg.data["vault"];
    if (typeof v !== "string" || !v) {
      process.stderr.write("o2b-discipline-report: no vault configured; pass --vault <path>\n");
      process.exit(2);
    }
    return v;
  }

  const vault = readVaultArg();
  const res = runDisciplineReport({ vault });
  if (res.status === "disabled") {
    process.stderr.write("o2b-discipline-report: discipline_report disabled in Brain/_brain.yaml\n");
    process.exit(0);
  }
  process.stdout.write(res.text + "\n");
  ```

- [ ] **Step 3: `chmod +x bin/o2b-discipline-report`.**

- [ ] **Step 4: Smoke-test from shell**:

  ```bash
  cd /srv/projects/open-second-brain
  ./bin/o2b-discipline-report --vault /tmp/nonexistent || true
  ```

  Expected: prints a clear error to stderr (vault directory missing
  or no Brain config), exits non-zero. Does not crash.

- [ ] **Step 5: Add `bin/o2b-discipline-report` to `package.json`
  `files` field** so it ships in npm publish.

**Pause for review.**

### Task 2.12: `o2b discipline report` CLI verb

**Files:**
- Modify: `src/cli/main.ts`.
- Create: `src/cli/discipline.ts`.
- Create: `tests/cli/discipline-report.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/cli/discipline-report.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runCli } from "../helpers/run-cli.ts";

  describe("o2b discipline report", () => {
    test("happy path prints the rendered block", async () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-disc-cli-"));
      mkdirSync(join(v, "Brain"), { recursive: true });
      writeFileSync(
        join(v, "Brain", "_brain.yaml"),
        "schema_version: 1\ndiscipline_report:\n  enabled: true\n  timezone: UTC\n  watched_paths: []\n  known_agents:\n    - '@a'\n",
        "utf8",
      );
      const res = await runCli(["discipline", "report", "--vault", v]);
      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain("OSB discipline");
      rmSync(v, { recursive: true });
    });

    test("disabled config exits 0 with stderr note", async () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-disc-cli2-"));
      mkdirSync(join(v, "Brain"), { recursive: true });
      writeFileSync(
        join(v, "Brain", "_brain.yaml"),
        "schema_version: 1\ndiscipline_report:\n  enabled: false\n  timezone: UTC\n  watched_paths: []\n  known_agents: []\n",
        "utf8",
      );
      const res = await runCli(["discipline", "report", "--vault", v]);
      expect(res.returncode).toBe(0);
      expect(res.stderr).toContain("disabled");
      rmSync(v, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run tests, expect FAIL.**

- [ ] **Step 3: Implement `src/cli/discipline.ts`**:

  ```ts
  import { runDisciplineReport } from "../core/discipline/report.ts";

  export async function disciplineReportVerb(
    args: string[],
    defaultVault: string,
  ): Promise<number> {
    let vault = defaultVault;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--vault" && args[i + 1]) {
        vault = args[i + 1]!;
        i++;
      }
    }
    const res = runDisciplineReport({ vault });
    if (res.status === "disabled") {
      process.stderr.write(
        "o2b discipline report: discipline_report disabled in Brain/_brain.yaml\n",
      );
      return 0;
    }
    process.stdout.write(res.text + "\n");
    return 0;
  }
  ```

- [ ] **Step 4: Wire into `src/cli/main.ts`** — add a new top-level
  branch:

  ```ts
  if (verb === "discipline") {
    const sub = args.shift();
    if (sub === "report") return disciplineReportVerb(args, defaultVault);
    if (sub === "install") return disciplineInstallVerb(args, defaultVault);
    if (sub === "uninstall") return disciplineUninstallVerb(args, defaultVault);
    process.stderr.write(`o2b discipline: unknown subcommand '${sub}'\n`);
    return 2;
  }
  ```

  (Install/uninstall land in Task 2.13.)

- [ ] **Step 5: Run tests, expect PASS.**

- [ ] **Step 6: Full sweep.**

**Pause for review.**

### Task 2.13: `o2b discipline install / uninstall` (Hermes cron CRUD)

**Files:**
- Create: `src/cli/discipline-install.ts`.
- Create: `tests/cli/discipline-install.test.ts`.

- [ ] **Step 1: Write failing test** —
  `tests/cli/discipline-install.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runCli } from "../helpers/run-cli.ts";

  function emptyJobsFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "o2b-disc-cron-"));
    const file = join(dir, "jobs.json");
    writeFileSync(file, JSON.stringify({ jobs: [] }), "utf8");
    return file;
  }

  describe("o2b discipline install / uninstall", () => {
    test("install creates exactly one job; reinstall is no-op; uninstall removes", async () => {
      const jobsFile = emptyJobsFile();
      const env = { OSB_HERMES_JOBS: jobsFile };

      const r1 = await runCli(
        ["discipline", "install", "--vault", "/tmp/v",
         "--telegram-target", "telegram:-100:42", "--at", "59 4 * * *"],
        { env },
      );
      expect(r1.returncode).toBe(0);
      let after = JSON.parse(readFileSync(jobsFile, "utf8"));
      expect(after.jobs.length).toBe(1);
      expect(after.jobs[0].name).toBe("osb-discipline-report");
      expect(after.jobs[0].deliver).toBe("telegram:-100:42");
      expect(after.jobs[0].schedule.expr).toBe("59 4 * * *");

      const r2 = await runCli(
        ["discipline", "install", "--vault", "/tmp/v",
         "--telegram-target", "telegram:-100:42", "--at", "59 4 * * *"],
        { env },
      );
      expect(r2.returncode).toBe(0);
      after = JSON.parse(readFileSync(jobsFile, "utf8"));
      expect(after.jobs.length).toBe(1);

      const r3 = await runCli(["discipline", "uninstall", "--vault", "/tmp/v"], { env });
      expect(r3.returncode).toBe(0);
      after = JSON.parse(readFileSync(jobsFile, "utf8"));
      expect(after.jobs.length).toBe(0);

      rmSync(jobsFile, { force: true });
    });
  });
  ```

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement** — `src/cli/discipline-install.ts`:

  ```ts
  import { createHash } from "node:crypto";
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  import { resolve } from "node:path";

  const DEFAULT_JOBS_FILE = "/root/.hermes/cron/jobs.json";

  function jobsFilePath(): string {
    return process.env.OSB_HERMES_JOBS ?? DEFAULT_JOBS_FILE;
  }

  function jobId(vault: string): string {
    const slug = createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 12);
    return `osb-discipline-report-${slug}`;
  }

  interface HermesJob { id: string; name: string; [k: string]: unknown; }
  interface JobsFile { jobs: HermesJob[]; }

  function loadJobs(file: string): JobsFile {
    if (!existsSync(file)) return { jobs: [] };
    return JSON.parse(readFileSync(file, "utf8"));
  }

  function saveJobs(file: string, data: JobsFile): void {
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }

  export async function disciplineInstallVerb(
    args: string[],
    _defaultVault: string,
  ): Promise<number> {
    let vault = "";
    let telegramTarget = "telegram:-1003895040510:216";
    let at = "59 4 * * *";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--vault") { vault = args[++i] ?? ""; continue; }
      if (args[i] === "--telegram-target") { telegramTarget = args[++i] ?? telegramTarget; continue; }
      if (args[i] === "--at") { at = args[++i] ?? at; continue; }
    }
    if (!vault) {
      process.stderr.write("o2b discipline install: --vault is required\n");
      return 2;
    }
    const file = jobsFilePath();
    const data = loadJobs(file);
    const id = jobId(vault);
    const existing = data.jobs.find((j) => j.id === id);
    const next: HermesJob = {
      id,
      name: "osb-discipline-report",
      script: "/srv/projects/open-second-brain/bin/o2b-discipline-report",
      no_agent: true,
      schedule: { kind: "cron", expr: at, display: at },
      deliver: telegramTarget,
      enabled: true,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      data.jobs.push(next);
    }
    saveJobs(file, data);
    process.stdout.write(`o2b discipline: job '${id}' ${existing ? "updated" : "created"} (schedule: ${at}, deliver: ${telegramTarget})\n`);
    return 0;
  }

  export async function disciplineUninstallVerb(
    args: string[],
    _defaultVault: string,
  ): Promise<number> {
    let vault = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--vault") { vault = args[++i] ?? ""; }
    }
    if (!vault) {
      process.stderr.write("o2b discipline uninstall: --vault is required\n");
      return 2;
    }
    const file = jobsFilePath();
    const data = loadJobs(file);
    const id = jobId(vault);
    const before = data.jobs.length;
    data.jobs = data.jobs.filter((j) => j.id !== id);
    saveJobs(file, data);
    const removed = before - data.jobs.length;
    process.stdout.write(`o2b discipline: ${removed > 0 ? "removed" : "no-op"} (job '${id}')\n`);
    return 0;
  }
  ```

  Wire both into `src/cli/main.ts`'s `discipline` branch.

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Full sweep.**

**Pause for review. End of §D track.**

---

## Phase 3 — §E `o2b brain import-claude-memory`

### Task 3.1: `BRAIN_LOG_EVENT_KIND.importClaudeMemory`

**Files:**
- Modify: `src/core/brain/types.ts`.

- [ ] **Step 1: Locate the existing kind enum** —
  `grep -n "BRAIN_LOG_EVENT_KIND" src/core/brain/types.ts`.

- [ ] **Step 2: Write failing test** —
  `tests/core/brain/types-import-claude-memory.test.ts`:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";

  describe("import-claude-memory log kind", () => {
    test("kind is registered as 'import-claude-memory'", () => {
      expect(BRAIN_LOG_EVENT_KIND.importClaudeMemory).toBe("import-claude-memory");
    });
  });
  ```

- [ ] **Step 3: Run test, expect FAIL.**

- [ ] **Step 4: Add the enum value** in `src/core/brain/types.ts`:

  ```ts
  export const BRAIN_LOG_EVENT_KIND = {
    // ... existing ...
    importClaudeMemory: "import-claude-memory",
  } as const;
  ```

  Add a discriminated-union member for it under
  `BrainLogEvent` (mirrors the `importSession` entry).

- [ ] **Step 5: Run test, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.2: Parse a single MEMORY file

**Files:**
- Create: `src/core/brain/claude-memory-parser.ts`.
- Create: `tests/core/brain/claude-memory-parser.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { parseClaudeMemoryFile } from "../../../src/core/brain/claude-memory-parser.ts";

  const FEEDBACK_FIXTURE = `---
  name: no-em-dashes
  description: Forbidden to use em-dashes in Russian writing for this user; use regular hyphens.
  metadata:
    node_type: memory
    type: feedback
    originSessionId: abc
  ---

  Body text here.

  **Why:** because the user said so.
  **How to apply:** apply everywhere.
  `;

  const USER_FIXTURE = `---
  name: who-am-i
  description: User is a senior developer.
  metadata:
    type: user
  ---

  Body.
  `;

  describe("parseClaudeMemoryFile", () => {
    test("feedback entry → MemoryRecord", () => {
      const r = parseClaudeMemoryFile(FEEDBACK_FIXTURE);
      expect(r.kind).toBe("feedback");
      expect(r.name).toBe("no-em-dashes");
      expect(r.description).toContain("Forbidden to use em-dashes");
      expect(r.body).toContain("**Why:**");
      expect(r.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test("non-feedback entry → kind='skip', reason recorded", () => {
      const r = parseClaudeMemoryFile(USER_FIXTURE);
      expect(r.kind).toBe("skip");
      expect(r.skipReason).toContain("type=user");
    });

    test("missing frontmatter → kind='skip'", () => {
      const r = parseClaudeMemoryFile("no frontmatter here");
      expect(r.kind).toBe("skip");
      expect(r.skipReason).toContain("frontmatter");
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/claude-memory-parser.ts`:

  ```ts
  import { createHash } from "node:crypto";
  import { load as yamlLoad } from "js-yaml";

  export type ClaudeMemoryParseResult =
    | {
        readonly kind: "feedback";
        readonly name: string;
        readonly description: string;
        readonly body: string;
        readonly bodySha256: string;
      }
    | {
        readonly kind: "skip";
        readonly skipReason: string;
      };

  const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

  export function parseClaudeMemoryFile(text: string): ClaudeMemoryParseResult {
    const m = text.match(FM_RE);
    if (!m) {
      return { kind: "skip", skipReason: "missing or malformed frontmatter" };
    }
    let fm: Record<string, unknown>;
    try {
      fm = (yamlLoad(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
      return { kind: "skip", skipReason: "frontmatter is not valid YAML" };
    }
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    const description = typeof fm.description === "string" ? fm.description.trim() : "";
    const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
    const type = typeof meta.type === "string" ? meta.type : "";
    if (type !== "feedback") {
      return { kind: "skip", skipReason: `type=${type || "<missing>"}; only feedback maps to Brain` };
    }
    if (!name || !description) {
      return { kind: "skip", skipReason: "feedback entry missing required name/description" };
    }
    const body = m[2].trim();
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    return { kind: "feedback", name, description, body, bodySha256 };
  }
  ```

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.3: Manifest sidecar I/O

**Files:**
- Create: `src/core/brain/claude-memory-manifest.ts`.
- Create: `tests/core/brain/claude-memory-manifest.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdtempSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import {
    loadManifest, saveManifest, type ClaudeMemoryManifest,
  } from "../../../src/core/brain/claude-memory-manifest.ts";

  describe("claude-memory manifest", () => {
    test("missing file → empty manifest", () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-cm-m1-"));
      expect(loadManifest(v)).toEqual({ version: 1, imports: {} });
      rmSync(v, { recursive: true });
    });

    test("round-trip", () => {
      const v = mkdtempSync(join(tmpdir(), "o2b-cm-m2-"));
      const m: ClaudeMemoryManifest = {
        version: 1,
        imports: {
          "no-em-dashes.md": {
            pref_id: "pref-no-em-dashes",
            sha256: "a".repeat(64),
            imported_at: "2026-05-18T10:00:00Z",
          },
        },
      };
      saveManifest(v, m);
      expect(loadManifest(v)).toEqual(m);
      rmSync(v, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/claude-memory-manifest.ts`:

  ```ts
  import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
  import { dirname, join } from "node:path";

  export interface ClaudeMemoryManifestEntry {
    readonly pref_id: string;
    readonly sha256: string;
    readonly imported_at: string;
  }

  export interface ClaudeMemoryManifest {
    readonly version: 1;
    readonly imports: Readonly<Record<string, ClaudeMemoryManifestEntry>>;
  }

  function manifestPath(vault: string): string {
    return join(vault, "Brain", ".imports", "claude-memory.json");
  }

  export function loadManifest(vault: string): ClaudeMemoryManifest {
    const p = manifestPath(vault);
    if (!existsSync(p)) return { version: 1, imports: {} };
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return { version: 1, imports: raw.imports ?? {} };
  }

  export function saveManifest(vault: string, m: ClaudeMemoryManifest): void {
    const p = manifestPath(vault);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n", "utf8");
  }
  ```

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.4: Decision table per memory file

**Files:**
- Create: `src/core/brain/claude-memory-plan.ts`.
- Create: `tests/core/brain/claude-memory-plan.test.ts`.

- [ ] **Step 1: Write failing test** covering all 6 rows of the
  design-doc decision table:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { planAction } from "../../../src/core/brain/claude-memory-plan.ts";

  describe("planAction", () => {
    const make = (overrides: Partial<Parameters<typeof planAction>[0]>) =>
      planAction({
        basename: "x.md", prefId: "pref-x", sha256: "h",
        inManifest: null, prefExists: false, ...overrides,
      });

    test("no manifest + no pref → CREATE", () => {
      expect(make({}).action).toBe("CREATE");
    });
    test("no manifest + pref exists → CONFLICT", () => {
      expect(make({ prefExists: true }).action).toBe("CONFLICT");
    });
    test("manifest matches + pref exists → SKIP_UNCHANGED", () => {
      expect(make({ inManifest: { sha256: "h" }, prefExists: true }).action).toBe("SKIP_UNCHANGED");
    });
    test("manifest matches + pref missing → RECREATE", () => {
      expect(make({ inManifest: { sha256: "h" }, prefExists: false }).action).toBe("RECREATE");
    });
    test("manifest differs + pref exists → UPDATE", () => {
      expect(make({ inManifest: { sha256: "old" }, prefExists: true }).action).toBe("UPDATE");
    });
    test("manifest differs + pref missing → CREATE (manifest stale)", () => {
      expect(make({ inManifest: { sha256: "old" }, prefExists: false }).action).toBe("CREATE");
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/claude-memory-plan.ts`:

  ```ts
  export type PlanAction =
    | "CREATE"
    | "UPDATE"
    | "RECREATE"
    | "SKIP_UNCHANGED"
    | "CONFLICT";

  export interface PlanActionInput {
    readonly basename: string;
    readonly prefId: string;
    readonly sha256: string;
    readonly inManifest: { sha256: string } | null;
    readonly prefExists: boolean;
  }

  export interface PlannedFile {
    readonly basename: string;
    readonly prefId: string;
    readonly action: PlanAction;
  }

  export function planAction(input: PlanActionInput): PlannedFile {
    const { basename, prefId, sha256, inManifest, prefExists } = input;
    if (inManifest === null) {
      return { basename, prefId, action: prefExists ? "CONFLICT" : "CREATE" };
    }
    if (inManifest.sha256 === sha256) {
      return { basename, prefId, action: prefExists ? "SKIP_UNCHANGED" : "RECREATE" };
    }
    return { basename, prefId, action: prefExists ? "UPDATE" : "CREATE" };
  }
  ```

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.5: Render the Brain preference for a feedback memory

**Files:**
- Create: `src/core/brain/claude-memory-render.ts`.
- Create: `tests/core/brain/claude-memory-render.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { renderPreferenceFromMemory } from "../../../src/core/brain/claude-memory-render.ts";

  describe("renderPreferenceFromMemory", () => {
    test("emits frontmatter + body + Origin block", () => {
      const out = renderPreferenceFromMemory({
        name: "no-em-dashes",
        description: "No em-dashes in Russian writing for this user.",
        body: "Body text.\n\n**Why:** said so.\n**How to apply:** apply everywhere.",
        memoryPath: "/root/.claude/projects/-root/memory/feedback_no_em_dashes.md",
        importedAt: "2026-05-18T10:00:00Z",
        bodySha256: "a".repeat(64),
      });
      expect(out).toMatch(/^---\n/);
      expect(out).toContain("id: pref-no-em-dashes");
      expect(out).toContain("status: confirmed");
      expect(out).toContain("scope: writing");
      expect(out).toContain("confidence: high");
      expect(out).toContain("_force_confirmed_via: claude-memory");
      expect(out).toContain("_imported_from: \"/root/.claude/projects/-root/memory/feedback_no_em_dashes.md\"");
      expect(out).toContain("Body text.");
      expect(out).toContain("**Why:**");
      expect(out).toContain("## Origin");
      expect(out).toContain("on 2026-05-18.");
    });

    test("body scope marker overrides default writing scope", () => {
      const out = renderPreferenceFromMemory({
        name: "x", description: "x",
        body: "First line.\nscope: testing\nrest.",
        memoryPath: "/m.md", importedAt: "2026-05-18T10:00:00Z",
        bodySha256: "a".repeat(64),
      });
      expect(out).toContain("scope: testing");
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/claude-memory-render.ts`:

  ```ts
  export interface RenderMemoryInput {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly memoryPath: string;
    readonly importedAt: string;   // ISO Z
    readonly bodySha256: string;
  }

  const SCOPE_RE = /^scope:\s*([a-z][a-z0-9-]*)\s*$/m;

  function extractScope(body: string): string {
    const m = body.match(SCOPE_RE);
    return m ? m[1] : "writing";
  }

  function isoDay(iso: string): string {
    return iso.slice(0, 10);
  }

  export function renderPreferenceFromMemory(input: RenderMemoryInput): string {
    const slug = input.name.replace(/_/g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const prefId = `pref-${slug}`;
    const topic = slug;
    const scope = extractScope(input.body);
    const fm = [
      "---",
      "kind: brain-preference",
      `id: ${prefId}`,
      `created_at: "${input.importedAt}"`,
      `_confirmed_at: "${input.importedAt}"`,
      `unconfirmed_until: "${input.importedAt}"`,
      `tags: [brain, brain/preference, brain/topic/${topic}, brain/scope/${scope}]`,
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${JSON.stringify(input.description)}`,
      "_evidenced_by: []",
      "_applied_count: 0",
      "_violated_count: 0",
      "_last_evidence_at: null",
      "_confidence: high",
      "pinned: false",
      `scope: ${scope}`,
      "_force_confirmed_via: claude-memory",
      `_imported_from: ${JSON.stringify(input.memoryPath)}`,
      `_imported_sha256: ${input.bodySha256}`,
      `_imported_at: "${input.importedAt}"`,
      "---",
      "",
      input.body.trim(),
      "",
      "## Origin",
      "",
      "Imported from Claude Code MEMORY:",
      `\`${input.memoryPath}\``,
      `on ${isoDay(input.importedAt)}.`,
      "",
    ].join("\n");
    return fm;
  }
  ```

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.6: Path-safety check

**Files:**
- Create: `src/core/brain/claude-memory-paths.ts`.
- Create: `tests/core/brain/claude-memory-paths.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { homedir } from "node:os";
  import { join } from "node:path";
  import { assertSafeMemoryPath } from "../../../src/core/brain/claude-memory-paths.ts";

  describe("assertSafeMemoryPath", () => {
    test("default home → no throw", () => {
      assertSafeMemoryPath(join(homedir(), ".claude", "projects", "-x", "memory"), false);
    });
    test("system path without override → throws", () => {
      expect(() => assertSafeMemoryPath("/etc", false)).toThrow(/not under/);
    });
    test("system path with override → no throw", () => {
      assertSafeMemoryPath("/etc", true);
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/claude-memory-paths.ts`:

  ```ts
  import { homedir } from "node:os";
  import { resolve, sep } from "node:path";

  export function defaultMemoryDir(vault: string): string {
    const slug = "-" + vault.replace(/\//g, "-");
    return resolve(homedir(), ".claude", "projects", slug, "memory");
  }

  export function assertSafeMemoryPath(path: string, override: boolean): void {
    if (override) return;
    const root = resolve(homedir(), ".claude", "projects") + sep;
    const norm = resolve(path);
    if (!norm.startsWith(root)) {
      throw new Error(
        `refusing to import from ${path}: it is not under ~/.claude/projects/.\n` +
        `Pass --allow-arbitrary-memory-path to override.`,
      );
    }
  }
  ```

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.7: Orchestrator `importClaudeMemory`

**Files:**
- Create: `src/core/brain/import-claude-memory.ts`.
- Create: `tests/core/brain/import-claude-memory-orchestrator.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
  import { bootstrapBrain } from "../../../src/core/brain/init.ts";

  function setupVault(): string {
    const v = mkdtempSync(join(tmpdir(), "o2b-cm-orch-"));
    bootstrapBrain(v, { primary_agent: "@test", agent_identity: "@test" });
    return v;
  }

  function setupMemory(): string {
    const dir = mkdtempSync(join(tmpdir(), "o2b-cm-mem-"));
    writeFileSync(
      join(dir, "feedback_a.md"),
      "---\nname: rule-a\ndescription: Rule A.\nmetadata:\n  type: feedback\n---\n\nBody A.\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "feedback_b.md"),
      "---\nname: rule-b\ndescription: Rule B.\nmetadata:\n  type: feedback\n---\n\nBody B.\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "user_who.md"),
      "---\nname: who\ndescription: User.\nmetadata:\n  type: user\n---\n\nBody.\n",
      "utf8",
    );
    writeFileSync(join(dir, "MEMORY.md"), "# index\n- a\n", "utf8");
    return dir;
  }

  describe("importClaudeMemory", () => {
    test("dry-run reports plan, performs no writes", () => {
      const vault = setupVault();
      const mem = setupMemory();
      const res = importClaudeMemory({
        vault, memoryDir: mem, mode: "dry-run", allowArbitraryMemoryPath: true,
      });
      expect(res.plans.map((p) => p.action).sort()).toEqual(["CREATE", "CREATE"]);
      expect(res.skipped.length).toBe(1);  // user_who.md; MEMORY.md is filtered earlier
      expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-a.md"))).toBe(false);
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });

    test("apply writes preferences, manifest, and log event", () => {
      const vault = setupVault();
      const mem = setupMemory();
      const res = importClaudeMemory({
        vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true,
        now: new Date("2026-05-18T10:00:00Z"),
      });
      expect(res.applied.length).toBe(2);
      expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-a.md"))).toBe(true);
      expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-b.md"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(vault, "Brain", ".imports", "claude-memory.json"), "utf8"));
      expect(Object.keys(manifest.imports).sort()).toEqual(["feedback_a.md", "feedback_b.md"]);
      const log = readFileSync(join(vault, "Brain", "log", res.localDate + ".md"), "utf8");
      expect(log).toContain("import-claude-memory");
      expect(log).toContain("created: 2");
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });

    test("second apply with no change → SKIP_UNCHANGED, zero writes", () => {
      const vault = setupVault();
      const mem = setupMemory();
      importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true });
      const before = readFileSync(join(vault, "Brain", "preferences", "pref-rule-a.md"), "utf8");
      const res2 = importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true });
      expect(res2.applied.length).toBe(0);
      expect(res2.skippedUnchanged.length).toBe(2);
      const after = readFileSync(join(vault, "Brain", "preferences", "pref-rule-a.md"), "utf8");
      expect(after).toBe(before);
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** —
  `src/core/brain/import-claude-memory.ts`:

  ```ts
  import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
  import { join } from "node:path";

  import { appendLogEvent } from "./log.ts";
  import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
  import { createSnapshot } from "./snapshot.ts";
  import { resolveAgentName } from "../config.ts";
  import { parseClaudeMemoryFile } from "./claude-memory-parser.ts";
  import {
    loadManifest, saveManifest, type ClaudeMemoryManifest,
  } from "./claude-memory-manifest.ts";
  import { planAction, type PlannedFile } from "./claude-memory-plan.ts";
  import { renderPreferenceFromMemory } from "./claude-memory-render.ts";
  import { assertSafeMemoryPath } from "./claude-memory-paths.ts";
  import { preferencePath } from "./paths.ts";

  export interface ImportClaudeMemoryOpts {
    readonly vault: string;
    readonly memoryDir: string;
    readonly mode: "dry-run" | "apply";
    readonly allowArbitraryMemoryPath?: boolean;
    readonly now?: Date;
  }

  export interface ImportClaudeMemoryResult {
    readonly mode: "dry-run" | "apply";
    readonly plans: ReadonlyArray<PlannedFile>;
    readonly skipped: ReadonlyArray<{ basename: string; reason: string }>;
    readonly conflicts: ReadonlyArray<PlannedFile>;
    readonly applied: ReadonlyArray<PlannedFile>;
    readonly skippedUnchanged: ReadonlyArray<PlannedFile>;
    readonly snapshotRunId: string | null;
    readonly localDate: string;
  }

  export function importClaudeMemory(opts: ImportClaudeMemoryOpts): ImportClaudeMemoryResult {
    assertSafeMemoryPath(opts.memoryDir, opts.allowArbitraryMemoryPath ?? false);
    if (!existsSync(opts.memoryDir)) {
      throw new Error(`memory directory not found: ${opts.memoryDir}`);
    }
    const now = opts.now ?? new Date();
    const importedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const localDate = importedAt.slice(0, 10);

    const manifest = loadManifest(opts.vault);
    const newImports: Record<string, { pref_id: string; sha256: string; imported_at: string }> = { ...manifest.imports };

    const plans: PlannedFile[] = [];
    const skipped: Array<{ basename: string; reason: string }> = [];
    const filesToWrite: Array<{ plan: PlannedFile; body: string; sha256: string }> = [];

    for (const name of readdirSync(opts.memoryDir).sort()) {
      if (name === "MEMORY.md") continue;
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(join(opts.memoryDir, name), "utf8");
      const parsed = parseClaudeMemoryFile(text);
      if (parsed.kind === "skip") {
        skipped.push({ basename: name, reason: parsed.skipReason });
        continue;
      }
      const slug = parsed.name.replace(/_/g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const prefId = `pref-${slug}`;
      const prefFile = preferencePath(opts.vault, prefId);
      const plan = planAction({
        basename: name,
        prefId,
        sha256: parsed.bodySha256,
        inManifest: manifest.imports[name] ? { sha256: manifest.imports[name]!.sha256 } : null,
        prefExists: existsSync(prefFile),
      });
      plans.push(plan);
      if (plan.action === "CREATE" || plan.action === "RECREATE" || plan.action === "UPDATE") {
        const body = renderPreferenceFromMemory({
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          memoryPath: join(opts.memoryDir, name),
          importedAt,
          bodySha256: parsed.bodySha256,
        });
        filesToWrite.push({ plan, body, sha256: parsed.bodySha256 });
      }
    }

    const conflicts = plans.filter((p) => p.action === "CONFLICT");
    const skippedUnchanged = plans.filter((p) => p.action === "SKIP_UNCHANGED");
    if (opts.mode === "dry-run") {
      return {
        mode: "dry-run",
        plans, skipped, conflicts,
        applied: [], skippedUnchanged,
        snapshotRunId: null,
        localDate,
      };
    }

    if (conflicts.length > 0) {
      throw new ConflictsError(conflicts);
    }

    let snapshotRunId: string | null = null;
    if (filesToWrite.length > 0) {
      const snap = createSnapshot(opts.vault, { runId: `import-claude-memory-${importedAt.replace(/[:.]/g, "-")}` });
      snapshotRunId = snap.runId;
    }

    const applied: PlannedFile[] = [];
    for (const { plan, body, sha256 } of filesToWrite) {
      const prefFile = preferencePath(opts.vault, plan.prefId);
      mkdirSync(join(opts.vault, "Brain", "preferences"), { recursive: true });
      if (plan.action === "UPDATE") {
        // Preserve evidence fields by merging frontmatter.
        body = mergePreservingEvidence(readFileSync(prefFile, "utf8"), body);
      }
      writeFileSync(prefFile, body, "utf8");
      newImports[plan.basename] = { pref_id: plan.prefId, sha256, imported_at: importedAt };
      applied.push(plan);
    }

    saveManifest(opts.vault, { version: 1, imports: newImports });

    const counts = {
      created: plans.filter((p) => p.action === "CREATE").length,
      updated: plans.filter((p) => p.action === "UPDATE").length,
      recreated: plans.filter((p) => p.action === "RECREATE").length,
      skipped_unchanged: skippedUnchanged.length,
      skipped_non_feedback: skipped.length,
      conflicts: conflicts.length,
    };
    appendLogEvent(opts.vault, resolveAgentName(), {
      eventType: BRAIN_LOG_EVENT_KIND.importClaudeMemory,
      body: {
        created: String(counts.created),
        updated: String(counts.updated),
        recreated: String(counts.recreated),
        skipped_unchanged: String(counts.skipped_unchanged),
        skipped_non_feedback: String(counts.skipped_non_feedback),
        conflicts: String(counts.conflicts),
        snapshot: snapshotRunId ?? "none",
      },
    });

    return {
      mode: "apply",
      plans, skipped, conflicts,
      applied, skippedUnchanged,
      snapshotRunId,
      localDate,
    };
  }

  export class ConflictsError extends Error {
    readonly conflicts: ReadonlyArray<PlannedFile>;
    constructor(conflicts: ReadonlyArray<PlannedFile>) {
      super(`import-claude-memory: ${conflicts.length} conflict(s)`);
      this.conflicts = conflicts;
    }
  }
  ```

  Note: `mergePreservingEvidence` is a small helper that walks the
  existing preference's frontmatter, picks out
  `_applied_count` / `_violated_count` / `_evidenced_by` /
  `_last_evidence_at` / `_confirmed_at` / `unconfirmed_until` /
  `pinned` / `scope`, and replaces the same keys in the freshly
  rendered preference with those preserved values. Implement
  inline (≤30 lines) — no separate file, follows the v0.10.6
  `mergeBrainYaml` pattern.

- [ ] **Step 4: Run, expect PASS. Full sweep.**

**Pause for review.**

### Task 3.8: Preserve-evidence merge — dedicated test

**Files:**
- Create: `tests/core/brain/import-claude-memory-preserve-evidence.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
  import { bootstrapBrain } from "../../../src/core/brain/init.ts";

  describe("UPDATE preserves accumulated evidence", () => {
    test("preserves _applied_count and _evidenced_by across re-import", () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-cm-pres-"));
      bootstrapBrain(vault, { primary_agent: "@test", agent_identity: "@test" });
      const mem = mkdtempSync(join(tmpdir(), "o2b-cm-pres-mem-"));
      writeFileSync(
        join(mem, "feedback_x.md"),
        "---\nname: rule-x\ndescription: V1.\nmetadata:\n  type: feedback\n---\n\nBody v1.\n",
        "utf8",
      );
      importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true });

      // Simulate accumulated evidence.
      const prefPath = join(vault, "Brain", "preferences", "pref-rule-x.md");
      let pref = readFileSync(prefPath, "utf8");
      pref = pref
        .replace("_applied_count: 0", "_applied_count: 7")
        .replace("_violated_count: 0", "_violated_count: 2")
        .replace("_evidenced_by: []", "_evidenced_by: ['[[a.md]]', '[[b.md]]']")
        .replace("pinned: false", "pinned: true");
      writeFileSync(prefPath, pref, "utf8");

      // Update memory body so sha256 changes → UPDATE branch.
      writeFileSync(
        join(mem, "feedback_x.md"),
        "---\nname: rule-x\ndescription: V2.\nmetadata:\n  type: feedback\n---\n\nBody v2.\n",
        "utf8",
      );
      importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true });

      const after = readFileSync(prefPath, "utf8");
      expect(after).toContain("_applied_count: 7");
      expect(after).toContain("_violated_count: 2");
      expect(after).toContain("_evidenced_by: ['[[a.md]]', '[[b.md]]']");
      expect(after).toContain("pinned: true");
      expect(after).toContain("principle: \"V2.\"");
      expect(after).toContain("Body v2.");

      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run, expect FAIL.** (Likely passes once Task 3.7
  is done correctly; this test is the regression net.)

- [ ] **Step 3: Refine `mergePreservingEvidence` if needed** to
  cover the listed keys. If the test passes on first run, no
  implementation change needed — just keep this as the safety net.

- [ ] **Step 4: Full sweep.**

**Pause for review.**

### Task 3.9: Conflict handling — dedicated test

**Files:**
- Create: `tests/core/brain/import-claude-memory-conflict.test.ts`.

- [ ] **Step 1: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import {
    ConflictsError,
    importClaudeMemory,
  } from "../../../src/core/brain/import-claude-memory.ts";
  import { bootstrapBrain } from "../../../src/core/brain/init.ts";

  describe("CONFLICT path", () => {
    test("apply throws ConflictsError when pref exists with no manifest entry", () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-cm-conf-"));
      bootstrapBrain(vault, { primary_agent: "@t", agent_identity: "@t" });
      // Pre-create the preference by hand.
      mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "preferences", "pref-rule-c.md"),
        "---\nid: pref-rule-c\nkind: brain-preference\n---\n\nManual.\n",
        "utf8",
      );

      const mem = mkdtempSync(join(tmpdir(), "o2b-cm-conf-mem-"));
      writeFileSync(
        join(mem, "feedback_rule_c.md"),
        "---\nname: rule-c\ndescription: From memory.\nmetadata:\n  type: feedback\n---\n\nBody.\n",
        "utf8",
      );

      expect(() =>
        importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true }),
      ).toThrow(ConflictsError);

      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });

    test("dry-run reports the conflict but does not throw", () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-cm-conf2-"));
      bootstrapBrain(vault, { primary_agent: "@t", agent_identity: "@t" });
      mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "preferences", "pref-rule-c.md"),
        "---\nid: pref-rule-c\n---\n\n",
        "utf8",
      );
      const mem = mkdtempSync(join(tmpdir(), "o2b-cm-conf2-mem-"));
      writeFileSync(
        join(mem, "feedback_rule_c.md"),
        "---\nname: rule-c\ndescription: x.\nmetadata:\n  type: feedback\n---\n\nb.\n",
        "utf8",
      );
      const res = importClaudeMemory({ vault, memoryDir: mem, mode: "dry-run", allowArbitraryMemoryPath: true });
      expect(res.conflicts.length).toBe(1);
      expect(res.conflicts[0].prefId).toBe("pref-rule-c");

      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });
  });
  ```

- [ ] **Step 2: Run, expect PASS** (orchestrator already handles
  CONFLICT). If failing, fix in `import-claude-memory.ts`.

- [ ] **Step 3: Full sweep.**

**Pause for review.**

### Task 3.10: `o2b brain import-claude-memory` CLI verb

**Files:**
- Modify: `src/cli/brain.ts` (add the verb to the dispatcher).
- Create: `tests/cli/brain-import-claude-memory.test.ts`.

- [ ] **Step 1: Locate the dispatcher** —
  `grep -n 'case "import-session"' src/cli/brain.ts`.

- [ ] **Step 2: Write failing test**:

  ```ts
  import { describe, expect, test } from "bun:test";
  import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runCli } from "../helpers/run-cli.ts";

  describe("o2b brain import-claude-memory CLI", () => {
    test("dry-run prints plan summary, exit 0, no writes", async () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-cm-cli-"));
      // bootstrap brain via CLI for realism
      await runCli(["brain", "init", "--vault", vault, "--yes"]);
      const mem = mkdtempSync(join(tmpdir(), "o2b-cm-cli-mem-"));
      writeFileSync(
        join(mem, "feedback_a.md"),
        "---\nname: a\ndescription: A.\nmetadata:\n  type: feedback\n---\n\nb.\n",
        "utf8",
      );
      const res = await runCli([
        "brain", "import-claude-memory", "--vault", vault,
        "--memory", mem, "--dry-run", "--allow-arbitrary-memory-path",
      ]);
      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain("plan:");
      expect(res.stdout).toContain("CREATE pref-a");
      expect(existsSync(join(vault, "Brain", "preferences", "pref-a.md"))).toBe(false);
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });

    test("--apply writes files and exits 0", async () => {
      const vault = mkdtempSync(join(tmpdir(), "o2b-cm-cli2-"));
      await runCli(["brain", "init", "--vault", vault, "--yes"]);
      const mem = mkdtempSync(join(tmpdir(), "o2b-cm-cli2-mem-"));
      writeFileSync(
        join(mem, "feedback_a.md"),
        "---\nname: a\ndescription: A.\nmetadata:\n  type: feedback\n---\n\nb.\n",
        "utf8",
      );
      const res = await runCli([
        "brain", "import-claude-memory", "--vault", vault,
        "--memory", mem, "--apply", "--yes", "--allow-arbitrary-memory-path",
      ]);
      expect(res.returncode).toBe(0);
      expect(existsSync(join(vault, "Brain", "preferences", "pref-a.md"))).toBe(true);
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    });

    test("--apply + --dry-run is rejected", async () => {
      const res = await runCli([
        "brain", "import-claude-memory", "--vault", "/tmp", "--apply", "--dry-run",
      ]);
      expect(res.returncode).toBe(2);
      expect(res.stderr).toMatch(/--apply.*--dry-run|--dry-run.*--apply/);
    });
  });
  ```

- [ ] **Step 3: Run tests, expect FAIL.**

- [ ] **Step 4: Implement the verb** — append to
  `src/cli/brain.ts`:

  ```ts
  // (in the verb dispatcher switch)
  case "import-claude-memory":
    return brainImportClaudeMemory(args, vault);
  ```

  and a new function near the existing `import-session` handler:

  ```ts
  import {
    importClaudeMemory, ConflictsError,
  } from "../core/brain/import-claude-memory.ts";
  import { defaultMemoryDir } from "../core/brain/claude-memory-paths.ts";

  async function brainImportClaudeMemory(args: string[], vault: string): Promise<number> {
    let memory: string | null = null;
    let mode: "dry-run" | "apply" = "dry-run";
    let modeSet = false;
    let allowArbitrary = false;
    let yes = false;
    let asJson = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--memory") { memory = args[++i] ?? null; continue; }
      if (a === "--dry-run") {
        if (modeSet && mode !== "dry-run") {
          process.stderr.write("o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n");
          return 2;
        }
        mode = "dry-run"; modeSet = true; continue;
      }
      if (a === "--apply") {
        if (modeSet && mode !== "apply") {
          process.stderr.write("o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n");
          return 2;
        }
        mode = "apply"; modeSet = true; continue;
      }
      if (a === "--yes") { yes = true; continue; }
      if (a === "--json") { asJson = true; continue; }
      if (a === "--allow-arbitrary-memory-path") { allowArbitrary = true; continue; }
    }
    if (mode === "apply" && !yes && process.stdin.isTTY === false) {
      process.stderr.write("o2b brain import-claude-memory: --apply requires --yes in non-interactive mode\n");
      return 2;
    }
    const memDir = memory ?? defaultMemoryDir(vault);
    try {
      const res = importClaudeMemory({ vault, memoryDir: memDir, mode, allowArbitraryMemoryPath: allowArbitrary });
      if (asJson) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        return 0;
      }
      if (mode === "dry-run") {
        process.stdout.write(`plan: ${res.plans.length} actionable, ${res.skipped.length} skipped\n`);
        for (const p of res.plans) process.stdout.write(`  ${p.action} ${p.prefId} (${p.basename})\n`);
        for (const s of res.skipped) process.stdout.write(`  SKIP  ${s.basename}: ${s.reason}\n`);
        if (res.conflicts.length > 0) process.stdout.write(`conflicts: ${res.conflicts.length}\n`);
      } else {
        process.stdout.write(`applied: ${res.applied.length}; unchanged: ${res.skippedUnchanged.length}; skipped: ${res.skipped.length}\n`);
        if (res.snapshotRunId) process.stdout.write(`snapshot: ${res.snapshotRunId}\n`);
      }
      return 0;
    } catch (err) {
      if (err instanceof ConflictsError) {
        process.stderr.write(`conflicts:\n`);
        for (const c of err.conflicts) {
          process.stderr.write(`  ${c.prefId} already exists in Brain but is not in Brain/.imports/claude-memory.json\n`);
        }
        return 2;
      }
      process.stderr.write(`o2b brain import-claude-memory: ${(err as Error).message}\n`);
      return 1;
    }
  }
  ```

  Add `import-claude-memory` to the help text near `import-session`.

- [ ] **Step 5: Run tests, expect PASS.**

- [ ] **Step 6: Full sweep.**

**Pause for review. End of §E track.**

---

## Phase 4 — Release wrap-up

### Task 4.1: Bump version everywhere

**Files:**
- Modify: `package.json`, `openclaw.plugin.json`, `plugin.yaml`.

- [ ] **Step 1: Edit `package.json`** — `"version": "0.10.7"`.
- [ ] **Step 2: Edit `openclaw.plugin.json`** — `"version": "0.10.7"`.
- [ ] **Step 3: Edit `plugin.yaml`** — `version: "0.10.7"`.
- [ ] **Step 4: Run `bun run sync-version:check`.** Expected: PASS
  (the existing sync-version script verifies the three files
  agree).

**Pause for review.**

### Task 4.2: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`.

- [ ] **Step 1: Add a new section at the top** under the existing
  `# Changelog` heading:

  ```markdown
  ## [0.10.7] - 2026-05-18

  Closes the remaining §30 (Agent logging discipline) work from
  `Projects/OpenSecondBrain/Features/_summary.md`. Three independent
  tracks ship together:

  ### Added

  - §30 §B — Writer MCP server split. A second `.mcp.json` entry
    (`open-second-brain-writer`) exposes `brain_feedback` and
    `brain_apply_evidence` with Claude Code's `alwaysLoad: true`
    flag so the agent never pays the ToolSearch round-trip before
    recording a taste signal or evidence event. The full MCP
    surface stays deferred under the existing `open-second-brain`
    entry. `o2b mcp` gains `--scope writer|full` (default `full`).
  - §30 §D — Daily discipline cron. New `bin/o2b-discipline-report`
    + `o2b discipline {report|install|uninstall}` build a
    deterministic Telegram MarkdownV2 block comparing
    brain-event counts per agent (parsed from `Brain/log/<date>.md`)
    against runtime-agnostic activity proxies (git activity on
    watched repos, mtime walk on watched non-repo paths, vault
    delta). Status `ok | info | alert` is binary; numeric ratios
    were rejected in design as noise-prone. Hermes cron job
    installable with `o2b discipline install [--telegram-target]
    [--at]`. No LLM in the report path.
  - §30 §E — Claude Code MEMORY → Brain bridge. New verb
    `o2b brain import-claude-memory [--memory <path>]
    [--dry-run | --apply] [--yes] [--json]
    [--allow-arbitrary-memory-path]` reads `metadata.type:
    feedback` entries from a Claude Code memory directory and
    writes them as confirmed Brain preferences with a sidecar
    manifest `Brain/.imports/claude-memory.json` for idempotency.
    UPDATE preserves accumulated evidence
    (`_applied_count`/`_violated_count`/`_evidenced_by`/...). CONFLICT
    surfaces (preference exists without a manifest entry) require
    manual resolution — never silent overwrites.
  - New module `src/core/discipline/` (report orchestrator, log
    counts, window helper, git/mtime activity, vault delta,
    decision, render, telegram-escape, install).
  - New module split for §E: `claude-memory-parser.ts`,
    `claude-memory-manifest.ts`, `claude-memory-plan.ts`,
    `claude-memory-render.ts`, `claude-memory-paths.ts`,
    `import-claude-memory.ts`.
  - `BRAIN_LOG_EVENT_KIND.importClaudeMemory = "import-claude-memory"`.

  ### Changed

  - `src/mcp/tools.ts:buildToolTable` accepts an optional
    `scope: "full" | "writer"` parameter; default unchanged.
  - `MCPServer` ctor accepts an optional `{ serverName, scope }`
    options object; defaults reproduce the v0.10.6 behavior.
  - `BrainConfig` gains an optional `discipline_report` section
    (`enabled`, `timezone`, `watched_paths`, `known_agents`).
    Missing section → §D feature disabled.

  ### Migration

  No vault data migration is required. Existing vaults run §D
  with `enabled: false` (default) until the operator adds the
  config section and runs `o2b discipline install`. §E is
  opt-in (operator runs the verb); the sidecar manifest is
  created on first `--apply`.
  ```

- [ ] **Step 2: No `[Unreleased]` section.** Per user preference,
  release notes go directly under concrete version headers.

- [ ] **Step 3: Diff the file** — `git diff CHANGELOG.md`. Confirm
  the new section is added, no other line is touched.

**Pause for review.**

### Task 4.3: Update vault `_summary.md`

**Files:**
- Modify: `/root/vault/Projects/OpenSecondBrain/Features/_summary.md`.

- [ ] **Step 1: Update §30 entry** — set to `✅ shipped fully in
  v0.10.7`. The current entry says `partially implemented in
  v0.10.6 (§A+§C)`. Replace the closing parenthetical with
  shipped-in-full and link to `[[Plan/3. Agent logging discipline]]`.

- [ ] **Step 2: Update the `Deferred work` section** — add four
  new entries (per design doc):
  - Per-tool always-load in Claude Code — trigger: appears in
    Claude Code changelog.
  - Bidirectional MEMORY ↔ Brain sync — trigger: explicit user
    request, or a second example.
  - §D non-bash-runtime activity sources — trigger: §4 second half
    ships.
  - §D non-binary thresholds — trigger: real
    false-positive/false-negative pairs.

- [ ] **Step 3: Update the Agent-logging-discipline marker** —
  the line that previously said `partially implemented in v0.10.6`
  becomes `shipped fully in v0.10.7 — §B (writer MCP split), §D
  (daily discipline cron), §E (claude-memory bridge)`.

**Pause for review.**

### Task 4.4: Update vault `Plan/3. Agent logging discipline.md`

**Files:**
- Modify: `/root/vault/Projects/OpenSecondBrain/Plan/3. Agent logging discipline.md`.

- [ ] **Step 1: Change frontmatter** — `status: shipped`, all
  three open items move into `shipped:` (or rewrite the front-matter
  to remove the `open:` field entirely).

- [ ] **Step 2: Drop the "return trigger" section** — §30 is
  closed; the trigger is no longer relevant.

- [ ] **Step 3: Add a tail note** — "v0.10.7 closed §B / §D / §E.
  Future related work would open a new feature, not reopen §30."

**Pause for review.**

### Task 4.5: Full test + typecheck pass

- [ ] **Step 1: `bun test`.** Expected: every test in the repo
  passes. If anything regresses, fix before continuing.

- [ ] **Step 2: `bun run typecheck`.** Expected: zero errors.

- [ ] **Step 3: Smoke-test the writer MCP server**:

  ```bash
  cd /srv/projects/open-second-brain
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' | \
    ./scripts/o2b mcp --scope writer | jq .
  ```

  Expected: handshake response with `serverInfo.name ==
  "open-second-brain-writer"`.

- [ ] **Step 4: Smoke-test the discipline report against the
  real vault** (read-only):

  ```bash
  ./bin/o2b-discipline-report --vault /root/vault
  ```

  Expected: either the rendered MarkdownV2 block, or `disabled`
  on stderr (if user has not yet enabled the feature in
  `Brain/_brain.yaml`).

- [ ] **Step 5: Smoke-test `import-claude-memory --dry-run`** against
  the real `~/.claude/projects/-root/memory/`:

  ```bash
  ./scripts/o2b brain import-claude-memory --vault /root/vault --dry-run
  ```

  Expected: a list of CREATE / SKIP_UNCHANGED / CONFLICT rows;
  no file writes; exit 0 unless conflicts exist (then exit 2).

**Pause for review. Surface the `git diff` for staging by the user
themselves — no `git add` or `git commit` from this plan.**

---

## Self-review (run BEFORE handoff)

- [ ] **Spec coverage.** Every section in
  `2026-05-18-agent-discipline-tail-design.md` maps to a Task above.
  G1 → Phase 1. G2 → Phase 2. G3 → Phase 3. Non-goals are
  represented by their absence — design doc lists them, plan does
  not implement them.
- [ ] **Placeholder scan.** No "TBD", "TODO", "fill in later", or
  "similar to Task N (no code)". Every code step shows actual code.
- [ ] **Type consistency.** `BrainEventCounts`, `ActivitySummary`,
  `DisciplineStatus`, `ClaudeMemoryManifest`, `PlannedFile`,
  `PlanAction` are defined once and referenced consistently.
  `buildToolTable` signature stays
  `(scope: ToolScope = "full") => ToolDefinition[]` across Tasks 1.1
  → 1.5.
- [ ] **No active git.** Every "Commit" step is replaced by "Pause
  for review" so the user stages diffs themselves. No `git add` or
  `git commit` invocation appears in any step.
- [ ] **Test path coverage.** Each new module ships with a focused
  unit test plus at least one integration / end-to-end test
  (`runDisciplineReport`, `importClaudeMemory`).
