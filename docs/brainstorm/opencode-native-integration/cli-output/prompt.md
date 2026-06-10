You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Add a native opencode (https://opencode.ai) integration to Open Second Brain, mirroring the depth of the existing Claude Code and Codex integrations - as native as the opencode extensibility surface allows.

Known facts, validated against opencode docs 2026-06-10:

- opencode MCP config lives in `opencode.json` (global: `~/.config/opencode/opencode.json`) under the `mcp` key with entries shaped `{ "type": "local", "command": ["o2b", "mcp", ...], "environment": {...}, "enabled": true }`. The repo's current `src/core/install/adapters/opencode.ts` writes `~/.config/opencode/mcp.json` with a `mcpServers` key - a file opencode does not read. The integration must start writing the real config and migrate/clean up the stale one.
- opencode's native extensibility surface is a plugin system: JS/TS files in `~/.config/opencode/plugins/` (global) or `.opencode/plugins/` (project), auto-loaded at startup. A plugin exports `async ({ project, client, $, directory, worktree }) => Hooks` where `client` is an SDK client to the running opencode server. Hooks include: `event` (bus: session.created / session.idle / session.compacted / session.deleted / message.updated / file.edited / ...), `chat.message`, `chat.params`, `tool.execute.before` / `tool.execute.after`, `command.execute.before`, `experimental.session.compacting`, `experimental.chat.system.transform`, custom `tool` definitions, `dispose`. Plugins can also be distributed as npm packages listed under the `plugin` key in opencode.json.
- Rules: opencode reads AGENTS.md natively and supports an `instructions` config key (file paths/globs).
- The plugin SDK `client` can read session messages via public API - a candidate for session capture without reverse-engineering opencode's on-disk storage (`~/.local/share/opencode/storage/`), whose format is undocumented and unstable.
- opencode is NOT installed on the dev server; tests must run from fixtures.

What the existing integrations provide (parity targets):

1. Claude Code: hooks (SessionStart active-context inject, session-capture on UserPromptSubmit/Stop/SessionEnd/PostCompact, post-write reminders, stop-log guardrail) via hooks/hooks.json calling a bundled `o2b-hook` binary reading a JSON payload on stdin; MCP server auto-registered via bundled .mcp.json; session import adapter parsing Claude JSONL transcripts (src/core/brain/sessions/claude.ts) registered in a 3-adapter registry (claude/codex/hermes) with first-line format autodetection.
2. Codex: same hook layer (runtime detected from payload shape, hooks/lib/detect.ts), explicit `codex mcp add` registration, session import adapter for rollout-event JSONL.
3. Install adapters framework: src/core/install/ with a registry, `createJsonMcpAdapter` factory (_json-mcp.ts, supports custom topLevelKey but currently hardcodes the `{command, args, env}` entry shape), canonical payload builder (payload.ts builds two servers: full + writer-only), manifest in install.lock.json, detect/plan/apply/verify/uninstall lifecycle per adapter, drift detection, atomic writes.

# Project context

Open Second Brain - TypeScript, Bun runtime, SQLite. An agent-owned second brain in an Obsidian-compatible Markdown vault, exposed to coding agents via MCP (stdio) plus per-runtime hook layers.

Recent commits:
0340560 feat: Continuity, Hygiene & Freshness Suite - session lineage, memory hygiene, anticipatory cache (v1.3.0) (#87)
8972f13 refactor: SOLID/DRY decomposition - domain modules, unified helpers, surface guards (v1.2.0) (#86)
6651228 refactor: language-agnostic fact extraction + README slim (v1.1.0) (#85)
9886d9a refactor: make search and classification language-agnostic (#84)
618870e refactor!: remove the pay.sh integration and the Pay Memory layer (#83)
957a403 feat!: Stability & Trust - 1.0.0 API freeze, deprecation sweep, safeguard, staged dream, timezone, report deltas (#79)
6d09d3c feat: Link & Recall Intelligence Suite - alias resolution, bridge discovery, communities, recall benchmark, self-tuning (#77)

Related files:
- src/core/install/adapters/opencode.ts (stale config-path adapter to replace)
- src/core/install/adapters/_json-mcp.ts (shared JSON-merge adapter body)
- src/core/install/payload.ts (canonical two-server MCP payload)
- src/core/install/types.ts, src/core/install/json-merge.ts, src/core/install/manifest.ts
- src/core/brain/sessions/{types,registry,claude,codex,hermes,import}.ts (session adapter contract + registry)
- hooks/hooks.json, hooks/lib/stdin.ts (HookPayloadBase), hooks/lib/detect.ts (runtime detection)
- src/mcp/server.ts, src/mcp/stdio.ts (MCP stdio server)
- install/opencode.md, install.md, README.md (docs)
- tests/core/install/adapters/*, tests/core/brain.sessions.*.test.ts, tests/fixtures/sessions/*, tests/fixtures/install/*

Conventions:
- Strict TDD: failing test first, then code; zero lint/typecheck warnings gate
- Conventional commits; one PR = one CHANGELOG version
- Session adapters: detect(firstLine) + iterate(path) -> AsyncIterable<SessionTurn>, registered in SESSION_ADAPTERS, fixtures as tests/fixtures/sessions/<id>-minimal.jsonl
- Install adapters: detect/plan/apply/verify/uninstall, idempotent apply, drift via payload re-construction, atomic writes, manifest record
- English-only repo content; full product name "Open Second Brain" in public artifacts; no exclamation marks in docs; no em-dashes

Constraints:
- Do not break the existing install targets (cursor, kiro, gemini-cli share _json-mcp.ts)
- No new heavyweight external dependencies; the opencode plugin itself should be self-contained (opencode auto-installs plugin deps via Bun, but prefer zero-dep)
- opencode absent on dev/CI machines: everything testable from fixtures; no network in tests
- The plugin must fail soft: if the vault or o2b binary is missing, opencode must keep working
- Keep the MCP server runtime-agnostic; runtime-specific logic belongs in install adapters, hooks layer, or the shipped plugin

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
