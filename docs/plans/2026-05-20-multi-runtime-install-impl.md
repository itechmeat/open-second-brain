# v0.10.11 — multi-runtime install + Most-applied in digest: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git policy for this project (operator-imposed):** the executing
> agent MUST NOT run `git commit`, `git push`, branch creation, or any
> other state-changing git command without an explicit per-action
> confirmation from the operator. Every "Commit" step below ends with
> `Pause: ask operator for permission to run the git command, paste
> the exact command, wait for an explicit yes`. Do not auto-stage and
> do not piggyback unrelated changes.

**Goal:** Ship `o2b install --target X [--apply|--check]` for seven
new runtimes (Cursor, Aider, opencode, kiro, Copilot CLI, Gemini CLI,
Pi) plus a `generic` printout fallback; ship `o2b init --interactive`
wizard on top of that; surface `Most-applied (Nd)` in `brain_digest`
with `_brain.yaml`-driven window and limit; add per-runtime session-
transcript awareness to `o2b discipline report` for Claude Code,
Codex, and Cursor; restructure `docs/install.md` into a router plus
per-runtime files.

**Architecture:** One `InstallAdapter` interface lives at
`src/core/install/types.ts`. Each runtime is a single file under
`src/core/install/adapters/`. Shared helpers (`json-merge.ts`,
`managed-block.ts`, `manifest.ts`, `payload.ts`) live next to the
registry. The CLI layer (`src/cli/install/*`) is thin and composes
adapters. Theme 2 reuses the existing `computeMostApplied` —
signature gains optional `windowDays` and `limit`, and both
consumers (`active.md` and `digest.ts`) read the new
`active.most_applied` block from `Brain/_brain.yaml`.

**Tech Stack:** TypeScript (Bun-native), `bun test`, `bun:sqlite`
(only for Cursor session-transcript reader; already in the stack),
no new runtime dependencies. Tests live under `tests/` mirroring
`src/`. Full suite: `bun test`. Typecheck: `bun run typecheck`.

**Spec:** `docs/plans/2026-05-20-multi-runtime-install-design.md`.
Read it before starting — every section number below (`§3.1`,
`§7.2`, ...) refers to that document.

---

## Pre-flight

These run once before Task 1.

- [ ] **Verify the working tree is clean.**

```bash
cd /srv/projects/open-second-brain
git status
```

Expected: branch is `master` or a feature branch, no unstaged
changes, no untracked files in `src/` or `tests/`. If dirty: stop
and ask the operator how to proceed.

- [ ] **Verify baseline tests pass.**

```bash
cd /srv/projects/open-second-brain
bun test
```

Expected: full suite green.

- [ ] **Verify typecheck passes.**

```bash
cd /srv/projects/open-second-brain
bun run typecheck
```

Expected: zero errors.

- [ ] **Read the spec.**

Read `docs/plans/2026-05-20-multi-runtime-install-design.md` end-to-end.

- [ ] **Resolve open questions from §13 of the spec via WebFetch.**

The spec leaves four questions to verify at impl time. Resolve before
Task 7 (Cursor) and before Task 12 (Aider). For each, record findings
in a scratch file under `/tmp/install-impl-notes.md` (gitignored) so
later tasks reference the same evidence.

```
1. Aider — does upstream support a native MCP client at impl time?
   WebFetch: https://github.com/Aider-AI/aider/blob/main/CHANGELOG.md
   WebFetch: https://aider.chat/docs/config/dotenv.html
2. opencode — exact MCP config file path.
   WebFetch: https://github.com/sst/opencode#mcp
3. kiro — exact MCP config file path.
   WebFetch: https://kiro.dev/docs/mcp (or the project's README)
4. Copilot CLI — exact `copilot mcp add` syntax + fallback file path.
   WebFetch: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
5. Gemini CLI — settings.json layout.
   WebFetch: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
6. Pi — skills directory convention.
   WebFetch: https://pi.dev/docs (if available) or
             https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
```

If any WebFetch returns conflicting or stale information, stop and
ask the operator. Do not guess.

---

## Task 1: Shared install types

**Objective:** Land the `InstallAdapter` interface and supporting
types so subsequent tasks have a stable seam.

**Files:**

- Create: `src/core/install/types.ts`
- Create: `tests/core/install/types.test.ts`

**Step 1: Write failing test.**

```typescript
// tests/core/install/types.test.ts
import { describe, expect, test } from "bun:test";
import {
  ADAPTER_STATUSES,
  INSTALL_STEP_KINDS,
  VERIFY_STATUSES,
} from "../../../src/core/install/types.ts";

describe("install types", () => {
  test("ADAPTER_STATUSES covers the four documented states", () => {
    expect(ADAPTER_STATUSES).toEqual(
      new Set([
        "not-installed",
        "installed",
        "drift",
        "unsupported-on-this-platform",
      ]),
    );
  });

  test("INSTALL_STEP_KINDS covers the five operation kinds", () => {
    expect(INSTALL_STEP_KINDS).toEqual(
      new Set([
        "json-merge",
        "managed-block",
        "subprocess",
        "file-copy",
        "symlink",
        "print",
      ]),
    );
  });

  test("VERIFY_STATUSES covers the four documented states", () => {
    expect(VERIFY_STATUSES).toEqual(
      new Set(["ok", "drift", "not-installed", "mcp-unreachable"]),
    );
  });
});
```

**Step 2: Run test to verify failure.**

```bash
bun test tests/core/install/types.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation.**

Create `src/core/install/types.ts` with the interfaces listed in
§2.2 of the spec, plus the runtime-checkable sets above. Pure
type-only file (no I/O, no side effects, no runtime deps).

Key exports:

```typescript
export const ADAPTER_STATUSES = new Set([
  "not-installed", "installed", "drift", "unsupported-on-this-platform",
] as const);
export const INSTALL_STEP_KINDS = new Set([
  "json-merge", "managed-block", "subprocess", "file-copy", "symlink", "print",
] as const);
export const VERIFY_STATUSES = new Set([
  "ok", "drift", "not-installed", "mcp-unreachable",
] as const);

export type AdapterStatus = ...;  // union over ADAPTER_STATUSES
export type InstallStepKind = ...;
export type VerifyStatus = ...;

export interface InstallEnv { ... }
export interface DetectResult { ... }
export interface InstallStep { ... }
export interface InstallPlan { ... }
export interface ApplyOpts { ... }
export interface ManifestEntry { ... }
export interface ApplyResult { ... }
export interface UninstallResult { ... }
export interface VerifyResult { ... }
export interface SessionPathsResult { ... }
export interface InstallAdapter { ... }
export interface McpPayload { ... }   // shape of the canonical MCP server entry
```

Full field list per the spec §2.2.

**Step 4: Run test to verify pass.**

```bash
bun test tests/core/install/types.test.ts
bun run typecheck
```

Expected: PASS, zero typecheck errors.

**Step 5: Commit.**

Stage and prepare:

```bash
git status
git diff --stat src/core/install/types.ts tests/core/install/types.test.ts
git add src/core/install/types.ts tests/core/install/types.test.ts
```

Pause: ask operator for permission to run the git command, paste
the exact command, wait for an explicit yes:

```bash
git commit -m "feat(install): InstallAdapter interface and supporting types"
```

---

## Task 2: `manifest.ts` sidecar I/O helper

**Objective:** Land the read/write helper for
`<vault>/.open-second-brain/install.lock.json` per §2.4 of the spec.

**Files:**

- Create: `src/core/install/manifest.ts`
- Create: `tests/core/install/manifest.test.ts`

**Step 1: Write failing tests.**

```typescript
// tests/core/install/manifest.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readManifest,
  recordEntry,
  removeEntry,
  manifestPath,
  type ManifestEntry,
} from "../../../src/core/install/manifest.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-manifest-"));
});

describe("install manifest", () => {
  test("readManifest returns empty shell when file is missing", () => {
    const m = readManifest(vault);
    expect(m.schema_version).toBe(1);
    expect(m.installs).toEqual({});
  });

  test("recordEntry creates sidecar dir + file atomically", () => {
    const entry: ManifestEntry = {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/home/u/.cursor/mcp.json",
      owned_keys: ["mcpServers.open-second-brain"],
    };
    recordEntry(vault, entry);
    const m = readManifest(vault);
    expect(m.installs.cursor).toEqual(entry);
    const raw = readFileSync(manifestPath(vault), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("recordEntry overwrites existing entry for the same target", () => {
    recordEntry(vault, {
      target: "cursor", applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge", config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(vault, {
      target: "cursor", applied_at: "2026-05-20T12:05:00.000Z",
      operation: "json-merge", config_path: "/b",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    const m = readManifest(vault);
    expect(m.installs.cursor!.applied_at).toBe("2026-05-20T12:05:00.000Z");
    expect(m.installs.cursor!.config_path).toBe("/b");
  });

  test("removeEntry deletes the named target only", () => {
    recordEntry(vault, {
      target: "cursor", applied_at: "...Z",
      operation: "json-merge", config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(vault, {
      target: "pi", applied_at: "...Z",
      operation: "symlink", config_path: null,
      owned_paths: ["/p"],
    });
    removeEntry(vault, "cursor");
    const m = readManifest(vault);
    expect(m.installs.cursor).toBeUndefined();
    expect(m.installs.pi).toBeDefined();
  });

  test("removeEntry on missing target is a no-op", () => {
    removeEntry(vault, "cursor");
    expect(readManifest(vault).installs).toEqual({});
  });

  test("readManifest tolerates forward-compat unknown top-level keys", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(
      manifestPath(vault),
      JSON.stringify({ schema_version: 1, installs: {}, future_thing: 42 }),
    );
    const m = readManifest(vault);
    expect(m.schema_version).toBe(1);
  });

  test("readManifest rejects unknown schema_version", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(
      manifestPath(vault),
      JSON.stringify({ schema_version: 999, installs: {} }),
    );
    expect(() => readManifest(vault)).toThrow(/schema_version/);
  });

  afterEach(() => {
    try { rmSync(vault, { recursive: true, force: true }); } catch {}
  });
});
```

**Step 2: Run test to verify failure.**

```bash
bun test tests/core/install/manifest.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation.**

`src/core/install/manifest.ts` exports `manifestPath(vault)`,
`readManifest(vault)`, `recordEntry(vault, entry)`,
`removeEntry(vault, target)`. Use the existing
`atomicWriteFileSync` from `src/core/fs-atomic.ts` for writes.
JSON output: 2-space indent, trailing newline.

Reject unknown `schema_version`. Tolerate unknown top-level keys
(forward-compat per spec §2.4). Missing file = empty shell.

**Step 4: Run test to verify pass.**

```bash
bun test tests/core/install/manifest.test.ts
bun run typecheck
```

Expected: all 7 tests PASS, zero typecheck errors.

**Step 5: Commit.**

```bash
git add src/core/install/manifest.ts tests/core/install/manifest.test.ts
```

Pause for operator yes, then:

```bash
git commit -m "feat(install): sidecar manifest read/write"
```

---

## Task 3: `json-merge.ts` helper

**Objective:** Safe merge of OSB's two `mcpServers` keys into an
existing JSON file, preserving user-authored content and
indentation.

**Files:**

- Create: `src/core/install/json-merge.ts`
- Create: `tests/core/install/json-merge.test.ts`
- Create fixtures: `tests/fixtures/install/json-merge/{empty,user-keys-present,osb-already,bom}.{before,after}.json`

**Step 1: Write failing tests.**

Cover six cases:

1. Empty file (or missing) — write a new file with both OSB keys
   under `mcpServers`, 2-space indent, trailing newline.
2. User has unrelated `mcpServers` keys (e.g. `mcpServers.other`)
   — keep them, add two OSB keys, preserve key order
   (user keys before OSB keys, OSB keys in insertion order).
3. User has older OSB keys with different command/args
   — overwrite both with canonical payload, byte-equal to expected
   output.
4. File has 4-space indent — preserve 4-space indent on write.
5. File has BOM at start — preserve BOM.
6. File is invalid JSON — throw `JsonMergeError` with file path
   and parse error.

```typescript
// tests/core/install/json-merge.test.ts
// see full code under tests/ folder; here is the test of case 2:
test("preserves unrelated mcpServers keys", () => {
  const before = `{
  "mcpServers": {
    "other": { "command": "x", "args": [] }
  }
}\n`;
  const after = mergeMcpServers(before, OSB_PAYLOAD);
  const parsed = JSON.parse(after);
  expect(Object.keys(parsed.mcpServers)).toEqual([
    "other",
    "open-second-brain",
    "open-second-brain-writer",
  ]);
  expect(parsed.mcpServers.other).toEqual({ command: "x", args: [] });
});
```

(Detail similar for the other 5 cases; refer to fixtures.)

**Step 2: Run test to verify failure.**

```bash
bun test tests/core/install/json-merge.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation.**

`src/core/install/json-merge.ts` exports:

- `mergeMcpServers(currentJson: string, payload: { full: McpServerEntry; writer: McpServerEntry }): string`
- `removeMcpServers(currentJson: string): string` — removes both OSB keys; empty `mcpServers` object kept (we don't dictate user's parent shape).
- `JsonMergeError extends Error` — carries path.

Implementation hints:

- Detect indentation by scanning the first indented line; default to 2 spaces if file has no nesting.
- Detect BOM by inspecting first three bytes (`﻿`); preserve verbatim.
- Use `JSON.parse` for read; manual stringify with `JSON.stringify(..., null, indent)` for write.
- Don't sort keys; preserve insertion order. JS objects retain insertion order for non-integer keys, so build the merged `mcpServers` by iterating original keys (skipping OSB names if present) then appending OSB names.

**Step 4: Run test to verify pass.**

```bash
bun test tests/core/install/json-merge.test.ts
bun run typecheck
```

Expected: all 6 tests PASS.

**Step 5: Commit.**

```bash
git add src/core/install/json-merge.ts tests/core/install/json-merge.test.ts tests/fixtures/install/json-merge/
```

Pause for operator, then:

```bash
git commit -m "feat(install): JSON-merge helper for mcpServers"
```

---

## Task 4: `managed-block.ts` helper

**Objective:** Insert / replace / remove a marker-fenced block in a
text file (used by Aider adapter and the future text-fallback
adapter).

**Files:**

- Create: `src/core/install/managed-block.ts`
- Create: `tests/core/install/managed-block.test.ts`
- Create fixtures: `tests/fixtures/install/managed-block/{insert,replace,remove}.{before,after}.txt`

**Step 1: Write failing tests.**

Cover:

1. Insert into file that has no marker block — append at end with a
   leading blank line; preserve all preceding content byte-for-byte.
2. Replace existing block — content between markers fully replaced;
   surrounding lines unchanged.
3. Remove block — both markers and everything between them removed;
   preceding and trailing blank lines normalised to one.
4. Nested markers — reject with `ManagedBlockError`.
5. Single marker without closing — reject with `ManagedBlockError`.
6. CRLF input — preserve CRLF on write (don't normalise to LF).
7. Custom marker text — markers are parametrised; default uses the
   `# >>> open-second-brain managed >>>` / `<<<` pair from
   `protect.ts`.

**Step 2-4: Standard TDD cycle.**

Implementation hints:

- Markers are parametrised so the adapter chooses (Aider uses YAML
  comment markers; generic-text-fallback uses the same).
- Use a precompiled RegExp with `^...$` and `m` flag to find the
  pair; reject if more than one of either marker appears.
- Detect line ending (CRLF vs LF) by scanning first 1KB; preserve.

**Step 5: Commit.**

```bash
git add src/core/install/managed-block.ts tests/core/install/managed-block.test.ts tests/fixtures/install/managed-block/
```

Pause, then:

```bash
git commit -m "feat(install): managed-block editor for text/YAML configs"
```

---

## Task 5: `payload.ts` builder

**Objective:** Build the canonical MCP server entries from the
plugin config — same input, deterministic output, used by every
adapter that emits MCP config.

**Files:**

- Create: `src/core/install/payload.ts`
- Create: `tests/core/install/payload.test.ts`

**Step 1: Write failing tests.**

```typescript
test("buildPayload returns full + writer entries with vault + env vars", () => {
  const cfg = {
    vault: "/home/u/vault",
    agent_name: "claude-vps-agent",
    timezone: "Europe/Belgrade",
  };
  const { full, writer } = buildPayload(cfg);
  expect(full.command).toBe("o2b");
  expect(full.args).toEqual(["mcp", "--vault", "/home/u/vault"]);
  expect(full.env).toEqual({
    VAULT_AGENT_NAME: "claude-vps-agent",
    VAULT_TIMEZONE: "Europe/Belgrade",
  });
  expect(writer.args).toEqual(["mcp", "--writer-only", "--vault", "/home/u/vault"]);
});

test("buildPayload omits env when agent_name / timezone missing", () => {
  const cfg = { vault: "/v", agent_name: null, timezone: null };
  const { full } = buildPayload(cfg);
  expect(full.env).toBeUndefined();
});

test("buildPayload throws on missing vault", () => {
  expect(() => buildPayload({ vault: null } as any)).toThrow(/vault/);
});
```

**Step 2-4: TDD cycle.**

Pure function; reads no I/O; takes the loaded plugin config as
argument. Adapters that need it call `discoverConfig` themselves
upstream.

**Step 5: Commit.**

```bash
git add src/core/install/payload.ts tests/core/install/payload.test.ts
```

Pause:

```bash
git commit -m "feat(install): canonical MCP payload builder"
```

---

## Task 6: Adapter registry

**Objective:** A `Map<target, InstallAdapter>` + `detectAll(env)`
helper. Empty in this commit (adapters land in later tasks).

**Files:**

- Create: `src/core/install/registry.ts`
- Create: `tests/core/install/registry.test.ts`

**Step 1: Write failing tests.**

```typescript
test("registry is empty initially", () => {
  const reg = createRegistry();
  expect(reg.list()).toEqual([]);
  expect(reg.get("cursor")).toBeUndefined();
});

test("register + get round-trip", () => {
  const reg = createRegistry();
  const fake: InstallAdapter = makeFakeAdapter("test");
  reg.register(fake);
  expect(reg.get("test")).toBe(fake);
  expect(reg.list().map((a) => a.target)).toEqual(["test"]);
});

test("register rejects duplicate target", () => {
  const reg = createRegistry();
  reg.register(makeFakeAdapter("cursor"));
  expect(() => reg.register(makeFakeAdapter("cursor"))).toThrow(/duplicate/);
});

test("detectAll returns one entry per registered adapter", () => {
  const reg = createRegistry();
  reg.register(makeFakeAdapter("a"));
  reg.register(makeFakeAdapter("b"));
  const env = makeEnv({});
  expect(reg.detectAll(env).map((d) => d.target)).toEqual(["a", "b"]);
});
```

**Step 2-4: TDD cycle.**

Provide a `createRegistry()` factory plus a module-level default
registry (`defaultRegistry`) that adapter files mutate via
`defaultRegistry.register(...)` at import time. Test-friendly:
`createRegistry()` returns a fresh isolated instance.

**Step 5: Commit.**

```bash
git add src/core/install/registry.ts tests/core/install/registry.test.ts
```

Pause:

```bash
git commit -m "feat(install): adapter registry"
```

---

## Task 7: `cursor` adapter

**Objective:** First real adapter — canonical JSON-merge case.

**Files:**

- Create: `src/core/install/adapters/cursor.ts`
- Create: `tests/core/install/adapters/cursor.test.ts`
- Create fixtures: `tests/fixtures/install/cursor/{clean,user-keys,osb-old,drift}.before.json` and matching `.after.json`

**Step 1: Write failing tests.**

Cover the six scenarios listed in spec §10.2:

1. Clean install on empty config — `apply` writes file; `verify` returns `ok`.
2. Re-apply — second `apply` is a byte-no-op; manifest `applied_at` is updated only if content changed.
3. Drift detection — manually mutate the file post-install; `verify` returns `drift` with the missing/extra keys.
4. Uninstall — `uninstall` removes both keys; manifest entry gone; surrounding keys preserved.
5. Uninstall without manifest entry — fails with code path message; `--force-from-snippet` succeeds when payload matches.
6. User-modified block — file mtime newer than `applied_at`, content differs from canonical; `apply` without `--force` throws exit-4 (the adapter signals via thrown error; the CLI layer converts).

```typescript
test("apply on empty config installs both keys", () => {
  const env = makeEnv({ home: TMP_HOME, configPath: join(TMP_HOME, ".cursor/mcp.json") });
  const adapter = cursorAdapter;
  const payload = buildPayload(loadFakeConfig());
  const plan = adapter.plan(payload, env);
  const result = adapter.apply(plan, env, { dryRun: false, stdout: ..., stderr: ... });
  const raw = JSON.parse(readFileSync(env.configPath, "utf8"));
  expect(Object.keys(raw.mcpServers)).toEqual([
    "open-second-brain",
    "open-second-brain-writer",
  ]);
  expect(result.manifest.owned_keys).toEqual([
    "mcpServers.open-second-brain",
    "mcpServers.open-second-brain-writer",
  ]);
});
```

**Step 2: Run test to verify failure.**

```bash
bun test tests/core/install/adapters/cursor.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation.**

`src/core/install/adapters/cursor.ts`:

- `detect(env)`: check `${XDG_CONFIG_HOME:-$HOME}/.cursor/mcp.json`;
  report `installed` if both OSB keys present and match, `drift`
  if file exists with partial or mismatched OSB keys,
  `not-installed` otherwise.
- `plan(payload, env)`: emit one `json-merge` step with preview
  (deterministic diff text).
- `apply(plan, env, opts)`: build current canonical payload from
  `payload.ts`, call `mergeMcpServers` from `json-merge.ts`, write
  atomically. Record manifest. Honor `dryRun`.
- `uninstall(env, opts)`: read manifest, call `removeMcpServers`,
  remove manifest entry. If manifest absent and not `--force-from-snippet`,
  throw `ManifestMissingError`.
- `verify(env)`: parse file, compare current key values to canonical
  payload. If file mtime is newer than `applied_at` and content
  differs from canonical → `drift`.

Auto-register: `defaultRegistry.register(cursorAdapter)` at the
bottom of the file. The default registry is imported by every CLI
verb.

**Step 4: Run test to verify pass.**

```bash
bun test tests/core/install/adapters/cursor.test.ts
bun run typecheck
```

Expected: all six scenarios PASS.

**Step 5: Commit.**

```bash
git add src/core/install/adapters/cursor.ts tests/core/install/adapters/cursor.test.ts tests/fixtures/install/cursor/
```

Pause:

```bash
git commit -m "feat(install): cursor adapter"
```

---

## Task 8: `opencode` adapter

**Objective:** Same JSON-merge pattern as Cursor; different config
path.

**Files:**

- Create: `src/core/install/adapters/opencode.ts`
- Create: `tests/core/install/adapters/opencode.test.ts`
- Fixtures: `tests/fixtures/install/opencode/`

**Pattern:** Replicate Task 7 structure. The body of the adapter
shares 90% of the code with Cursor — extract the common JSON-merge
adapter body to `adapters/_json-mcp.ts` if and only if the third
JSON-merge adapter (Task 9 or Task 10) doesn't introduce a third
shape difference. Otherwise keep them as three independent files
to avoid premature abstraction.

**Detect path:** `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/mcp.json`
(confirm via WebFetch resolved in Pre-flight).

**TDD cycle + fixtures + commit.** Brief commit message:
`feat(install): opencode adapter`.

---

## Task 9: `kiro` adapter

Same shape as Cursor / opencode. Config path `~/.kiro/settings.json`
(confirm via WebFetch). If kiro stores MCP entries under a
different top-level key than `mcpServers`, override the key in
`json-merge` call.

After this task, decide whether to extract the shared JSON-merge
adapter body into `adapters/_json-mcp.ts`. If yes, do it as a
no-op refactor (existing tests must still pass) and commit
separately:

```
git commit -m "refactor(install): extract shared JSON-merge adapter body"
```

---

## Task 10: `gemini-cli` adapter

Same shape as Cursor. Config path `~/.gemini/settings.json` under
key `mcpServers` (per
`github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md`).

**Verify hint:** `gemini --version` exit 0 is the cheap liveness
check; `o2b mcp --probe` is the MCP-side check.

TDD cycle + fixtures + commit. Message:
`feat(install): gemini-cli adapter`.

---

## Task 11: `copilot-cli` adapter (subprocess + fallback)

**Objective:** First adapter that calls a subprocess. Adds the
`subprocess` operation kind in practice.

**Files:**

- Create: `src/core/install/adapters/copilot-cli.ts`
- Create: `tests/core/install/adapters/copilot-cli.test.ts`
- Mocked subprocess fixtures.

**Step 1: Write failing tests.**

Test cases:

1. Happy path — `copilot` CLI on PATH; `apply` calls `copilot mcp
   remove open-second-brain` then `copilot mcp add ...` (twice, once per name).
2. CLI missing — `apply` falls back to JSON-merge at the documented
   fallback file path; stderr emits "copilot CLI not found; using
   file fallback".
3. CLI returns non-zero on `add` — `apply` falls back to file mode,
   stderr describes the CLI error.
4. Uninstall via subprocess — calls `copilot mcp remove` once per
   name.
5. Uninstall via file fallback — same path as Cursor uninstall.
6. Verify via `copilot mcp list` parsing — both names present →
   `ok`.

Subprocess mocking: use `Bun.spawn` injection point. The adapter
takes an injectable `spawn` function in its options (defaults to
`Bun.spawn`); tests pass a fake.

**Step 2-4: TDD cycle.**

Adapter records `operation: "subprocess"` plus optional
`fallback_file` field in manifest when fallback path was used.

**Step 5: Commit.**

```
git commit -m "feat(install): copilot-cli adapter with subprocess + file fallback"
```

---

## Task 12: `aider` adapter

**Objective:** Managed-block in `~/.aider.conf.yml` + sidecar
context file.

**Files:**

- Create: `src/core/install/adapters/aider.ts`
- Create: `templates/install/aider-context.md.tmpl`
- Create: `tests/core/install/adapters/aider.test.ts`
- Fixtures.

**Pre-task check.** Re-read Pre-flight finding #1. If upstream Aider
shipped native MCP at impl time, switch to JSON-merge against
Aider's MCP config and document the change in a one-line comment
at top of `aider.ts`. The rest of this task assumes no native MCP.

**Step 1: Write failing tests.**

Cases:

1. Clean install — creates `~/.aider.conf.yml` if missing; adds
   managed block under `read:`; generates
   `<vault>/.open-second-brain/aider-context.md` from template.
2. Pre-existing `~/.aider.conf.yml` with user's own `read:` list —
   preserves user's list; appends managed block as additional list
   entries between markers.
3. Re-apply — byte no-op when canonical payload hasn't changed.
4. Uninstall — removes managed block AND sidecar context file
   (path from manifest).
5. Template render — the sidecar context file contains a brief
   summary of `skills/brain-memory/SKILL.md` plus the current
   `Brain/active.md` body. Regeneration on each apply.
6. Verify — managed block present + sidecar file exists + non-empty.

**Step 2-4: TDD cycle.**

Template uses simple `{{var}}` substitution (no jinja). Template
content drafted as part of this task.

**Step 5: Commit.**

```
git commit -m "feat(install): aider adapter (managed-block + sidecar context)"
```

---

## Task 13: `pi` adapter

**Objective:** Symlink-only adapter; no JSON, no managed block.

**Files:**

- Create: `src/core/install/adapters/pi.ts`
- Create: `tests/core/install/adapters/pi.test.ts`

**Cases:**

1. Clean install — creates `~/.pi/skills/brain-memory` symlink
   pointing at `<repo>/skills/brain-memory`.
2. `--pi-skill-dir <path>` override — symlink at custom location.
3. Re-apply on existing valid symlink — no-op.
4. Re-apply on existing broken symlink (target gone) — replaces.
5. Re-apply on existing non-symlink at target path — refuses
   without `--force` (don't clobber a user-authored directory).
6. Uninstall — removes symlink only, never the source.
7. Verify — symlink valid + target readable.

**Step 5: Commit.**

```
git commit -m "feat(install): pi adapter (symlink-based)"
```

---

## Task 14: `generic` adapter

**Objective:** Print-only fallback; never edits any runtime config.

**Files:**

- Create: `src/core/install/adapters/generic.ts`
- Create: `tests/core/install/adapters/generic.test.ts`

**Cases:**

1. Default — prints canonical JSON payload to stdout.
2. `--format yaml` — YAML rendering.
3. `--out <path>` — writes to file; manifest records path.
4. `--out -` — explicit stdout.
5. `detect` — always returns `not-installed`.
6. `uninstall` — prints the path that the operator must remove
   manually; no file deletion.

**Step 5: Commit.**

```
git commit -m "feat(install): generic adapter (print-only fallback)"
```

---

## Task 15: `o2b mcp --writer-only` flag

**Objective:** The Payload builder emits args
`["mcp", "--writer-only", ...]`. Land the matching flag in
`o2b mcp`.

**Files:**

- Modify: `src/mcp/main.ts` (or wherever `o2b mcp` argv parsing
  lives — search for `mcpMain` or `cmdMcp`).
- Modify: `src/mcp/tools.ts:buildToolTable` to accept a
  `writerOnly: boolean` option.
- Test: `tests/mcp/writer-only.test.ts`.

**Step 1: Test.**

```typescript
test("writer-only tool table contains only the three writer tools + brain_context", () => {
  const table = buildToolTable({ writerOnly: true, ... });
  const names = table.tools.map((t) => t.name);
  expect(names.sort()).toEqual([
    "brain_apply_evidence",
    "brain_context",
    "brain_feedback",
    "brain_note",
  ]);
});

test("full tool table contains everything", () => {
  const table = buildToolTable({ writerOnly: false, ... });
  expect(table.tools.length).toBeGreaterThan(15);
});
```

**Step 2-4: TDD cycle.**

Add `--writer-only` to argv parsing. When set, pass to
`buildToolTable`. The writer-server in `.mcp.json` already
filters this way via a different mechanism (per v0.10.7); reuse
the filter logic if it lives in a helper, else extract.

**Step 5: Commit.**

```
git commit -m "feat(mcp): --writer-only flag for o2b mcp"
```

---

## Task 16: `o2b mcp --probe` flag

**Objective:** Used by `o2b install --check` to validate that the
MCP server starts and responds to `initialize`.

**Files:**

- Modify: `src/mcp/main.ts`
- Create: `src/mcp/probe.ts`
- Test: `tests/mcp/probe.test.ts`

**Behavior:** `o2b mcp --probe`:

1. Sets up an in-process pipe instead of stdio.
2. Sends an MCP `initialize` request.
3. Reads the response; checks `tools` array is non-empty.
4. Writes one line to stdout: `mcp probe ok (N tools)` or
   `mcp probe FAIL: <reason>`.
5. Exits 0 on success, non-zero on failure.

**Cases:**

1. Happy path — returns 0, prints tool count.
2. Probe with vault flag missing in plugin config — exits non-zero
   with "vault not configured".
3. Probe with vault path invalid (does not exist) — exits non-zero
   with reason.

**Step 5: Commit.**

```
git commit -m "feat(mcp): --probe flag for in-process MCP handshake"
```

---

## Task 17: `o2b install` CLI verb

**Objective:** Main entry-point. Glues registry + adapters.

**Files:**

- Create: `src/cli/install/install.ts`
- Create: `src/cli/install/render.ts`
- Modify: `src/cli/main.ts` to route `o2b install`.
- Test: `tests/cli/install/install.test.ts`.

**Step 1: Tests (organised by subcommand path).**

```typescript
describe("o2b install", () => {
  test("no args → detect-only table (text)", async () => {
    const out = await runCli(["install"], env);
    expect(out.stdout).toContain("detected runtimes");
    expect(out.exitCode).toBe(0);
    // No file writes
    expect(existsSync(env.cursorConfig)).toBe(false);
  });

  test("--json → machine output", async () => {
    const out = await runCli(["install", "--json"], env);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.targets).toBeInstanceOf(Array);
  });

  test("--target cursor (no --apply) → plan-only", async () => {
    const out = await runCli(["install", "--target", "cursor"], env);
    expect(out.stdout).toContain("json-merge");
    expect(existsSync(env.cursorConfig)).toBe(false);
  });

  test("--target cursor --apply → writes file", async () => {
    const out = await runCli(["install", "--target", "cursor", "--apply"], env);
    expect(out.exitCode).toBe(0);
    expect(existsSync(env.cursorConfig)).toBe(true);
  });

  test("--target unknown → exit 2", async () => {
    const out = await runCli(["install", "--target", "nope"], env);
    expect(out.exitCode).toBe(2);
  });

  test("--target generic --out - → stdout", async () => {
    const out = await runCli(
      ["install", "--target", "generic", "--out", "-"], env,
    );
    expect(JSON.parse(out.stdout).command).toBe("o2b");
  });

  test("apply on user-modified block exits 4", async () => {
    // setup: install once, then hand-edit, advance mtime
    await runCli(["install", "--target", "cursor", "--apply"], env);
    writeFileSync(env.cursorConfig, '{ "mcpServers": { "open-second-brain": { "command": "TAMPERED" } } }');
    advanceFileMtime(env.cursorConfig, 60);  // make mtime newer than manifest applied_at
    const out = await runCli(["install", "--target", "cursor", "--apply"], env);
    expect(out.exitCode).toBe(4);
    expect(out.stderr).toContain("hand-edited");
  });
});
```

**Step 2-4: TDD cycle.**

The verb resolves `defaultRegistry`, parses argv, dispatches:

- no `--target` → `registry.detectAll(env)` → `renderDetectTable(...)` or JSON.
- `--target X` without `--apply` → `adapter.plan(...)` → `renderPlan(...)`.
- `--target X --apply` → `adapter.detect(...)` + `adapter.plan(...)` + `adapter.apply(...)`.
- `--target generic` with `--out` / `--format` — passthrough.

Use existing `parseArgs` helper from `src/cli/argparse.ts`.

**Step 5: Commit.**

```
git commit -m "feat(cli): o2b install verb (detect + plan + apply)"
```

---

## Task 18: `o2b uninstall --target X` CLI verb

**Objective:** Sibling of `install` — reads manifest, calls
`adapter.uninstall`.

**Files:**

- Modify: `src/cli/uninstall.ts` (existing — extend with
  `--target` mode; current `--apply-local` mode stays).
- Test: `tests/cli/uninstall-target.test.ts`.

**Cases:**

1. Dry-run (`--target X`, no `--apply`) — prints what would be
   removed; no file changes.
2. `--apply` — removes per manifest; manifest entry deleted.
3. Manifest missing — exits non-zero with hint; `--force-from-snippet`
   path documented in the error message.
4. `--target X` with no manifest entry → exit 0 with "nothing
   recorded".

**Step 5: Commit.**

```
git commit -m "feat(cli): o2b uninstall --target X"
```

---

## Task 19: `o2b install --check` CLI verb

**Objective:** Runtime install health check.

**Files:**

- Modify: `src/cli/install/install.ts`
- Test: `tests/cli/install/check.test.ts`.

**Cases:**

1. All-ok — exit 0; table shows each target with status.
2. One drift — exit 3; drift row carries `fix` hint pointing at
   the exact apply command.
3. Not-installed everywhere → exit 0 (`not-installed` is not an
   error).
4. MCP probe failure on Cursor (probe spawn returns non-zero) →
   row status `mcp-unreachable` with restart hint.
5. `--json` — mirror of text output, exit code identical.

**Step 5: Commit.**

```
git commit -m "feat(cli): o2b install --check"
```

---

## Task 20: `o2b init --interactive` wizard

**Objective:** First-time setup wizard that composes
`o2b init` + optional `o2b brain init` + per-target install.

**Files:**

- Create: `src/cli/install/init-interactive.ts`
- Modify: `src/cli/main.ts` to route `o2b init --interactive`.
- Test: `tests/cli/init-interactive.test.ts`.

**Step 1: Test.**

The wizard takes an injectable `prompt(question, options)`
function. Tests pass a fake that returns scripted answers; the
wizard's output is asserted exactly.

```typescript
test("wizard happy path: clean vault, two targets selected", async () => {
  const answers = [
    "1",            // vault: first candidate
    "claude-vps",   // agent name
    "Europe/Belgrade",
    "ru",
    "1,3",          // pick targets 1 and 3 from list
    "y",            // brain init?
    "n",            // starter?
    "yes",          // confirm summary
  ];
  const result = await runWizard(makeFakePrompt(answers), env);
  expect(result.exitCode).toBe(0);
  expect(result.actions).toContain("o2b init --vault ...");
  expect(result.actions).toContain("o2b install --target cursor --apply");
});

test("wizard aborts at summary on 'no'", async () => {
  const answers = [..., "no"];
  const result = await runWizard(makeFakePrompt(answers), env);
  expect(result.exitCode).toBe(0);
  expect(result.actions).toEqual([]);   // nothing executed
});
```

**Step 2-4: TDD cycle.**

Implement nine steps per spec §5. Each step is a small private
function; the top-level wizard glues them together with the
injected prompt.

**Step 5: Commit.**

```
git commit -m "feat(cli): o2b init --interactive wizard"
```

---

## Task 21: Theme 2 — `active.most_applied` config block

**Objective:** Land the new block in `_brain.yaml` schema + loader
+ validator.

**Files:**

- Modify: `src/core/brain/types.ts` (add `BrainActiveConfig`,
  `BrainMostAppliedConfig` interfaces; add `active?:` field to
  `BrainConfig`).
- Modify: `src/core/brain/policy.ts` (loader pulls the block;
  validator rejects out-of-range values).
- Test: `tests/core/brain/policy-active.test.ts`.

**Cases:**

1. `_brain.yaml` without `active` block → loader returns
   `cfg.active === undefined`; consumers use defaults.
2. `_brain.yaml` with `active.most_applied: { window_days: 7, limit: 3 }` → loaded values.
3. `window_days: 0` → `BrainConfigError("active.most_applied.window_days must be between 1 and 365, got 0")`.
4. `window_days: "thirty"` → `BrainConfigError`.
5. `limit: -1` → `BrainConfigError`.
6. `limit: 100` → `BrainConfigError("between 1 and 50")`.

**Step 5: Commit.**

```
git commit -m "feat(brain): _brain.yaml active.most_applied config block"
```

---

## Task 22: Theme 2 — extend `computeMostApplied`

**Objective:** Make `windowDays` and `limit` parameters; keep
defaults for back-compat.

**Files:**

- Modify: `src/core/brain/most-applied.ts`
- Modify: `tests/core/brain/most-applied.test.ts` (add cases for
  custom values; existing cases must still pass).

**Cases (new ones to add to the existing test file):**

1. `windowDays: 7` — events older than 7 days excluded.
2. `windowDays: 7, limit: 2` — top 2 within 7-day window.
3. `windowDays: 365` — events from up to one year ago count.
4. Day-level fence preserved regardless of `windowDays`.

**Step 5: Commit.**

```
git commit -m "feat(brain): computeMostApplied windowDays + limit params"
```

---

## Task 23: Theme 2 — `active.md` uses configured window

**Objective:** `regenerateActive` reads
`cfg.active?.most_applied?.{window_days, limit}` and passes them
through.

**Files:**

- Modify: `src/core/brain/active.ts`
- Modify: `tests/core/brain/active.test.ts` (one new case).

**Case:**

`_brain.yaml` has `active.most_applied.window_days: 7` →
`active.md` header reads `## Most-applied (7d)` and only counts
events within the last 7 days.

**Golden test note:** existing golden fixtures used default 30/10;
verify they still pass byte-for-byte.

**Step 5: Commit.**

```
git commit -m "feat(brain): active.md honours active.most_applied config"
```

---

## Task 24: Theme 2 — digest most_applied JSON field

**Objective:** Add `most_applied` to `DigestJson` and the data
collector.

**Files:**

- Modify: `src/core/brain/digest.ts`
- Modify: `tests/core/brain/digest.test.ts`.

**Cases:**

1. Default config — `digest.most_applied.window_days === 30`,
   `limit === 10`, `entries: [...]`.
2. Custom config — values reflected in JSON.
3. Empty window — `entries: []`, block present.

**Step 5: Commit.**

```
git commit -m "feat(brain): digest JSON most_applied block"
```

---

## Task 25: Theme 2 — digest most_applied Markdown section

**Objective:** Render `## Most-applied (Nd)` between existing
sections.

**Files:**

- Modify: `src/core/brain/digest.ts:renderMarkdown`
- Modify golden Markdown fixtures: add new section for windows
  with entries; absent for empty-window cases.

**Cases:**

1. Default config + non-empty window — section rendered.
2. Empty window — section omitted entirely.
3. Custom window (`14d`) — header text reflects it.

**Step 5: Commit.**

```
git commit -m "feat(brain): digest Markdown Most-applied section"
```

---

## Task 26: Companion 2 — `sessionPaths` for claudecode/codex/cursor

**Objective:** Land the three transcript-path resolvers.

**Files:**

- Modify: existing claudecode adapter (created in earlier task or
  located via `find src/core/install/adapters/ -name '*claude*'`)
  — add `sessionPaths`. If no Claude Code adapter exists yet, the
  resolver lives standalone at
  `src/core/install/session-paths-claudecode.ts`.
- Create: `src/core/install/session-paths-codex.ts`
- Create: `src/core/install/session-paths-cursor.ts`
- Tests: `tests/core/install/session-paths-{claudecode,codex,cursor}.test.ts`

**Cases per resolver:**

1. Standard path resolves on Linux fixtures.
2. macOS layout resolves (Cursor).
3. Missing files → returns `{ paths: [] }`, not an error.

**Step 5: Commit.**

```
git commit -m "feat(install): sessionPaths for claudecode/codex/cursor"
```

---

## Task 27: Companion 2 — `o2b discipline report` transcript adapter

**Objective:** Plug session-path resolvers into the report; surface
`transcript-confirmed` sub-reason in alert rows.

**Files:**

- Modify: `scripts/discipline-report.ts` (the actual implementation
  behind `bin/o2b-discipline-report`).
- Test: `tests/scripts/discipline-report-transcripts.test.ts`.

**Cases:**

1. Claude Code transcript shows activity + zero brain events for
   the same agent that day → alert with `transcript-confirmed`.
2. Transcript empty + git/mtime activity → existing proxy result
   (no `transcript-confirmed` flag).
3. Multiple runtimes simultaneously — each evaluated independently.

**Step 5: Commit.**

```
git commit -m "feat(discipline): per-runtime transcript-confirmed signal"
```

---

## Task 28: Docs — `install/` folder restructure

**Objective:** Split `install.md` into router + per-runtime files.

**Files:**

- Modify: `install.md` (root) — reduce to router; preserve a
  pointer at the top to the per-runtime files.
- Create: `install/prerequisites.md`
- Create: `install/cursor.md`, `install/aider.md`, `install/opencode.md`,
  `install/kiro.md`, `install/copilot-cli.md`,
  `install/gemini-cli.md`, `install/pi.md`, `install/generic.md`
- Create (migrate content from existing branches): `install/claudecode.md`,
  `install/codex.md`, `install/hermes.md`, `install/openclaw.md`.

**Pattern per file:**

1. One-paragraph intro.
2. Command block: `o2b install --target X --apply` (or other
   per-runtime command).
3. Verify section: `o2b install --check --target X`.
4. Caveats (one or two paragraphs at most).
5. Uninstall command.

**Step 5: Commit.**

```
git commit -m "docs(install): split install.md into router + per-runtime files"
```

---

## Task 29: Docs — README quick install

**Objective:** Surface the one-liner up front.

**Files:**

- Modify: `README.md` — add a "Quick install" section above
  existing content.

**Step 5: Commit.**

```
git commit -m "docs: README quick-install section"
```

---

## Task 30: CHANGELOG + version bump

**Objective:** Land the v0.10.11 entry and bump
`package.json` / `pyproject.toml`.

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `package.json` (`version` field)
- Modify: `pyproject.toml` (if it carries a version field)
- Modify: any other version-bearing file (search:
  `grep -rn "0\\.10\\.10" --include='*.{json,toml,md,ts}' .`)

**Per project convention:** one PR → one CHANGELOG version. No
`[Unreleased]` placeholder.

Sample entry (operator confirms the date on ship day):

```markdown
## [0.10.11] - <YYYY-MM-DD set on the day the release ships>

### Added
- `o2b install --target X [--apply|--check]` for Cursor, Aider,
  opencode, kiro, GitHub Copilot CLI, Google Gemini CLI, Pi, and
  generic printout.
- `o2b uninstall --target X` driven by the new sidecar manifest at
  `<vault>/.open-second-brain/install.lock.json`.
- `o2b init --interactive` first-time-setup wizard.
- `o2b mcp --writer-only` and `o2b mcp --probe` subflags.
- `Brain/_brain.yaml` `active.most_applied.{window_days, limit}`
  block. `brain_digest` and `Brain/active.md` honour the values;
  default 30/10 unchanged.
- `Most-applied (Nd)` section in `brain_digest` Markdown and a
  mirrored `most_applied` field in the JSON form.
- Per-runtime session-transcript awareness in `o2b discipline
  report` for Claude Code, Codex, and Cursor.
- Documentation restructured into `install.md` router plus
  `install/<target>.md` per-runtime files.
```

**Step 5: Commit.**

```
git commit -m "chore: release v0.10.11"
```

---

## Task 31: Vault summary update (operator-coordinated)

**Objective:** Keep `Projects/OpenSecondBrain/Features/_summary.md`
in sync with what shipped.

**This task does not run autonomously.** The vault lives outside the
repo and the operator decides what to write there. The executing
agent prepares a draft snippet and presents it to the operator for
manual application.

**Draft to present:**

- §4 — strike "second half deferred" and mark the line that closes
  it. Note PR + release tag.
- §15 — same for the wizard half.
- Deferred section §D non-bash-runtime activity sources — replace
  with "partial uptake shipped in v0.10.11; remaining runtimes
  (opencode / kiro / Copilot CLI / Gemini CLI / Aider / Pi) stay
  deferred. Trigger: stable upstream transcript paths and operator
  use."
- Add new deferred items per spec §12 (project-scope, Pi path
  auto-detect, interactive apply, restart hooks).

Pause: print the snippet to the operator, ask them to drop it into
the vault file. The executing agent does not edit
`/root/vault/Projects/...` directly.

---

## Final pass

- [ ] **Full test suite green.**

```bash
bun test
```

- [ ] **Typecheck clean.**

```bash
bun run typecheck
```

- [ ] **Lint clean** (if the repo wires one — verify
  `package.json scripts`).

```bash
bun run lint
```

- [ ] **Spec compliance walk-through.** Re-read
  `docs/plans/2026-05-20-multi-runtime-install-design.md` and tick
  each §1.1 deliverable against shipped code. If any deliverable
  is missing, list it in the operator handoff message.

- [ ] **CHANGELOG matches reality.** Run `git log
  v0.10.10..HEAD --oneline` and verify every commit subject maps
  to a CHANGELOG bullet.

- [ ] **Hermes preview restart (operator-coordinated, if Hermes
  is the active runtime on this server).** After the operator
  confirms the work is shippable:

  ```bash
  hermes gateway restart
  ```

  Wait for the new `Plugin discovery complete` line in
  `~/.hermes/logs/agent.log` before testing live.

- [ ] **Operator handoff.** Summary message to operator:

  > v0.10.11 ready. Seven new install targets land; Most-applied
  > now configurable. Reviewed against design doc, all tasks
  > checked off. Suggest reviewing the seven new adapter files
  > and the new CLI verbs before tag and release. The vault
  > summary draft is in Task 31 — apply when ready.

---

## Implementation order recap

| # | Task | Depends on |
|---|---|---|
| 1 | `types.ts` interfaces | — |
| 2 | `manifest.ts` | 1 |
| 3 | `json-merge.ts` | — (independent helper) |
| 4 | `managed-block.ts` | — |
| 5 | `payload.ts` | — |
| 6 | Registry | 1 |
| 7 | `cursor` adapter | 2, 3, 5, 6 |
| 8 | `opencode` adapter | 7 |
| 9 | `kiro` adapter | 7 |
| 10 | `gemini-cli` adapter | 7 |
| 11 | `copilot-cli` adapter | 6, 3 |
| 12 | `aider` adapter | 4, 6 |
| 13 | `pi` adapter | 6 |
| 14 | `generic` adapter | 6 |
| 15 | `o2b mcp --writer-only` | — |
| 16 | `o2b mcp --probe` | — |
| 17 | `o2b install` CLI | 7-14, 15 |
| 18 | `o2b uninstall --target X` | 17 |
| 19 | `o2b install --check` | 16, 17 |
| 20 | `o2b init --interactive` | 17 |
| 21 | `active.most_applied` config | — |
| 22 | `computeMostApplied` params | 21 |
| 23 | `active.md` honours config | 22 |
| 24 | digest JSON most_applied | 22 |
| 25 | digest Markdown section | 24 |
| 26 | sessionPaths resolvers | — |
| 27 | discipline-report transcripts | 26 |
| 28 | docs restructure | 17-20 |
| 29 | README quick install | 28 |
| 30 | CHANGELOG + version | every preceding task |
| 31 | vault summary | 30 |

Tasks 1-6 are setup; they can land as one feature branch. Tasks
7-14 (adapters) are independent of each other once 1-6 are done
— they can land in any order. Tasks 15-16 land in parallel with
adapters. Tasks 17-20 (CLI verbs) gate on adapters being done.
Tasks 21-25 (Theme 2) are entirely independent of Theme 1 and
can land in parallel. Tasks 26-27 (Companion 2) are independent
of both. Tasks 28-31 are the wrap.
