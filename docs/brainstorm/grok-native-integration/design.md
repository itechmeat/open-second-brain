# Grok Build native integration - bundled plugin, session import, hook-payload compat

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** t_0eda929d (epic) with children t_fc98eef2, t_23cd40bc, t_b69deebd, t_8fdd6077, t_f7111278

## Problem statement

Open Second Brain integrates deeply with Claude Code, OpenAI Codex, and opencode (MCP
registration, lifecycle hooks, session import) but has no Grok Build (`grok`, xAI) support.
Grok auto-reads Claude Code and Cursor config, so a user who already runs the Claude Code
integration gets partial pickup, but pure-grok users get nothing, grok sessions are never
imported into the Brain, our hook scripts misparse grok's stdin payload, and there is no
first-class, marketplace-publishable grok unit. This ships a native grok integration matching
the depth of the existing runtimes.

## Scope

- A bundled grok plugin (`plugins/grok/open-second-brain/`): `plugin.json` manifest, `.mcp.json`
  with the two canonical Open Second Brain MCP servers, `hooks/hooks.json` with three lifecycle
  hooks (SessionStart active-context inject, PostToolUse post-write logging nudge, SessionEnd
  session capture). The plugin is the marketplace-publishable unit.
- A `grok` install target (`o2b install --target grok --apply`) that installs the plugin under
  `~/.grok/plugins/open-second-brain/` (auto-trusted), ensures it is enabled, records it in the
  install manifest, reports drift on `verify`, and reverses on `uninstall`.
- A `grok` session adapter that imports `~/.grok/sessions/<cwd>/<id>/updates.jsonl` (ACP stream)
  with lineage from `summary.json` `parent_session_id`, wired through `importSessionPath`.
- Hook-payload compatibility: the shared hook stdin parser learns grok's camelCase payload so
  the hooks run under grok (whether via native `~/.grok/hooks/` or grok's Claude-compat scan).
- Docs: `install/grok.md`, `install.md` table, `README.md` runtime list, `docs/how-it-works.md`
  integration section, `CHANGELOG.md`.

## Out of scope

- Writing `~/.claude.json` / `~/.claude/settings.json` for pure-grok users (Variant 3, rejected:
  impersonates a foreign vendor's namespace).
- A general TOML serialization layer for the MCP payload (Variant 1, rejected). MCP lives in the
  plugin's `.mcp.json` (standard JSON), so the canonical `McpServerEntry` is reused verbatim and
  no TOML touches the MCP payload.
- `grok mcp add` shelling and `grok plugin install` shelling for the install path: rejected to
  keep the adapter offline-unit-testable and free of a hard runtime dependency on the grok
  binary. (`grok` IS used in QA smoke tests, just not as an apply-time dependency.)
- LSP server registration (`.lsp.json`), `commands/`, `agents/` plugin components: not needed.
- PreCompact extraction parity: handled by session capture; revisit if a gap shows in the field.

## Chosen approach

Variant 2 from `variants.md` (consultant-recommended, accepted without override).

The bundled plugin is the single first-class artifact, mirroring the opencode bundled plugin.
`src/core/install/grok-plugin-asset.ts` resolves the bundled plugin tree and a version stamp
(mirroring `opencode-plugin-asset.ts`). The plugin directory holds:

- `plugin.json` - name `open-second-brain`, version mirrored from `package.json` via the
  version-sync script, description, metadata. Passes `grok plugin validate`.
- `.mcp.json` - MCP standard format `{ "mcpServers": { ... } }`. STATIC and vault-agnostic,
  mirroring the repo's existing Claude plugin file `./.mcp.json`: `command`
  `${CLAUDE_PLUGIN_ROOT}/scripts/o2b`, args `["mcp"]` and `["mcp", "--scope", "writer"]`. Grok
  populates `${CLAUDE_PLUGIN_ROOT}` via its documented alias of `GROK_PLUGIN_ROOT`, and `o2b mcp`
  resolves the vault from the persisted config (no `--vault` arg, no install-time generation).
  This is the plugin-scoped MCP form already proven by the Claude integration, NOT the
  `buildPayload` (`--vault <path>`) form the file-config adapters use; the two forms are
  intentionally different and the grok plugin reuses the plugin-scoped one.
- `hooks/hooks.json` - mirrors the repo's existing Claude plugin `./hooks/hooks.json` (same
  `o2b-hook active-inject | post-write-reminder | session-capture` commands, same
  `$CLAUDE_PLUGIN_ROOT`-then-PATH fallback), with grok-specific adjustments:
  - Lifecycle events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`) carry NO
    `matcher` - grok rejects a matcher on those events. Tool events (`PostToolUse`) keep theirs.
  - `PostToolUse` matcher lists both the Claude-style names (`Write|Edit|MultiEdit|apply_patch`)
    and grok's aliased `search_replace`, since grok maps Claude tool names to its own.
  - Session capture is wired on `SessionEnd` (grok's terminal lifecycle event).
  - The commands bake in no vault path, so one bundle serves every vault and the content is
    deterministic for drift detection.

The `grok` install adapter (`src/core/install/adapters/grok.ts`) does NOT use the JSON-MCP
factory for MCP (MCP ships inside the plugin, not in a grok config file). Its plan/apply/verify/
uninstall manage the plugin tree:

- `apply`: copy the bundled plugin tree into `~/.grok/plugins/open-second-brain/` (creating dirs),
  record every written path under the manifest `owned_paths`, and refresh an outdated copy.
  `GROK_HOME` overrides the base dir; honor it. NO `config.toml` touch is needed: verified
  against live grok 0.2.45 that a user-scope plugin under `~/.grok/plugins/<name>/` is
  auto-enabled and auto-trusted (`grok inspect` shows `enabled: true` with its MCP servers and
  hooks active, `grok mcp doctor` starts the server and discovers its tools), with config.toml
  carrying only `[cli]`. The docs' "plugins disabled by default" applies to marketplace and
  project-scope plugins, not user-scope ones. This drops the planned TOML enable helper entirely.
- `verify`: flag a missing, edited, or non-file (stray directory) plugin file as drift, with a
  `o2b install --target grok --apply` fix hint.
- `uninstall`: remove exactly the `owned_paths` and the now-empty plugin directory, leaving
  unrelated grok config untouched.

The `grok` session adapter (`src/core/brain/sessions/grok.ts`) detects on the ACP `updates.jsonl`
structure, yields `SessionTurn`-shaped turns, and resolves lineage from a sibling `summary.json`
`parent_session_id`. A newer/unknown ACP shape fails with a versioned PARSE error.

Hook-payload compat (`hooks/lib/stdin.ts` + `detect.ts`): a single declarative field-mapping
normalizes grok's `{hookEventName, sessionId, cwd, workspaceRoot, toolName, toolInput}` into the
internal shape the Claude/Codex paths use; runtime detection recognizes grok via `GROK_*` env and
payload shape. Where grok omits a Claude field (`transcript_path`), the type stays optional and
the code branches explicitly rather than faking a default.

## Design decisions

- **Plugin is the MCP vehicle, not config.toml.** `.mcp.json` is standard JSON - zero TOML, and
  (per the verified enable finding below) zero `config.toml` touch at all.
- **Reuse the Claude plugin artifacts; the whole plugin tree is static and vault-agnostic.** The
  grok `.mcp.json` and `hooks/hooks.json` mirror the repo's existing `./.mcp.json` and
  `./hooks/hooks.json`. Grok sets `CLAUDE_PLUGIN_ROOT` as an alias for `GROK_PLUGIN_ROOT` and
  reads the Claude-shape hook JSON, so those artifacts work under grok almost verbatim. No
  `buildPayload`, no install-time generation, no vault path baked into the bundle. A unit test
  asserts the grok artifacts stay in sync with their Claude-plugin sources (the only allowed
  divergences are the documented grok adjustments: lifecycle-event matchers removed, `SessionEnd`
  capture), so the two never drift.
- **File-copy install, no `config.toml` touch, no `grok plugin install --trust` shell.** Verified
  on live grok: dropping the tree into `~/.grok/plugins/<name>/` is sufficient (auto-enabled and
  auto-trusted). The adapter stays offline-unit-testable and free of an apply-time grok-binary
  dependency, and the planned TOML enable helper proved unnecessary and was dropped.
- **Hook env vars over payload fields where grok provides both.** `GROK_SESSION_ID` /
  `GROK_WORKSPACE_ROOT` / `CLAUDE_PROJECT_DIR` are stable; the parser prefers them and falls back
  to payload fields, matching how the Claude layer already reads env first.
- **Capture via SessionEnd hook, import via adapter.** The hook only triggers capture; the
  adapter owns parsing `updates.jsonl`. Same separation the opencode spool used, but grok's own
  session store is the source of truth (no spool file to own), so the adapter reads grok's files
  directly.
- **Matcher lists both tool-name spellings.** grok maps Claude names to its own, but listing both
  `Edit|Write|MultiEdit` and `search_replace` makes the hook robust whether grok applies the alias
  before or after matcher evaluation; verified in QA.

## File changes

New:
- `plugins/grok/open-second-brain/plugin.json`, `.mcp.json`, `hooks/hooks.json` - the bundled
  plugin tree (hooks use inline `o2b-hook` commands; no `hooks/bin/` scripts needed).
- `src/core/install/grok-plugin-asset.ts` - renders the grok artifacts from the Claude sources +
  exposes the committed bytes for the adapter.
- `src/core/install/adapters/grok.ts` - the install adapter (plugin-tree lifecycle).
- `src/core/brain/sessions/grok.ts` - the ACP session adapter.
- `tests/core/install/adapters/grok.test.ts`, `tests/core/brain.sessions.grok.test.ts`,
  `tests/plugins/grok-plugin.test.ts`, `tests/hooks/grok-stdin.test.ts` - per-unit tests.
- `tests/fixtures/sessions/grok-minimal.jsonl` (real `updates.jsonl` captured from live grok),
  `tests/fixtures/install/grok/` fixtures.
- `install/grok.md` - install guide.

Modified:
- `src/core/install/registry.ts` (or adapter self-register) - register `grok`.
- `src/core/install/adapters/types.ts` if a target-id union exists - add `grok`.
- `src/core/brain/sessions/registry.ts` (`SESSION_ADAPTERS`) + `types.ts` (`SessionAdapterId`) -
  add `grok`.
- `hooks/lib/stdin.ts`, `hooks/lib/detect.ts` - grok payload normalization + runtime detection.
- The version-sync script's manifest list, if `plugin.json` version must mirror `package.json`.
- `README.md`, `install.md`, `docs/how-it-works.md`, `CHANGELOG.md`.

## Risks and open questions

- Enable semantics: RESOLVED in Phase 2 against live grok 0.2.45. A user-scope plugin under
  `~/.grok/plugins/<name>/` is auto-enabled and auto-trusted with no `config.toml` entry
  (`grok inspect` reports `enabled: true`, MCP + hooks active; `grok mcp doctor` handshakes and
  discovers 71 tools). The planned `[plugins] enabled` TOML helper was therefore dropped.
- `updates.jsonl` ACP event schema: typed from grok's ACP docs but must be pinned to a real
  captured session; the `format`/version gate surfaces a shape mismatch as a versioned error,
  not silent corruption.
- Whether grok applies matcher tool-name aliasing before or after matcher evaluation: the matcher
  lists both spellings to be safe; QA confirms which fires.
- `plugin.json` version mirroring: RESOLVED. `plugins/grok/open-second-brain/plugin.json` was
  added to `scripts/sync-version.ts` JSON_TARGETS (and the CLAUDE.md mirrored-manifest list), so
  CI gates it against `package.json`.
