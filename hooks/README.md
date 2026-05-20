# Open Second Brain — runtime hooks

Plugin-bundled lifecycle hooks for Claude Code and Codex. The hooks
make sure every turn that produces a durable artifact records the
corresponding event in `Brain/log/<date>.md` (and its JSONL sidecar).
`Brain/log/` is the single agent-facing log surface; `Daily/` remains
as the human-CLI surface — populated by `o2b append-event` from
cron-jobs and shell scripts, not by agents.

Hermes and OpenClaw deliberately do **not** load these hooks. Hermes
already injects an identity / writer-tool reminder via its
`pre_llm_call` plugin shim, so the same nudge arrives through a
different channel without duplicating subsystems. OpenClaw's native
JS plugin format predates these hooks. If either runtime grows a
Claude-style hook schema later, point its config at `hooks/hooks.json`
and the same scripts will work — they only depend on the documented
hook payload shape, not on the runtime.

## What the hooks do

| Event         | Matcher                              | Behaviour                                                                                                                                 |
|---------------|--------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `PostToolUse` | `Write\|Edit\|MultiEdit\|apply_patch` | Emits `additionalContext` pointing at the three Brain writer tools (`brain_feedback`, `brain_apply_evidence`, `brain_note`) for a durable edit. |
| `Stop`        | (every Stop)                         | If the turn produced a durable artifact and none of `brain_feedback` / `brain_apply_evidence` / `brain_note` landed, returns `decision: "block"` once, then lets the second Stop pass.       |

The Stop guardrail respects the runtime-provided `stop_hook_active`
flag: it fires at most once per turn, so the agent can deliberately
decide that an edit was trivial and skip logging by just finishing
again. No deadlocks.

## JSONL sidecar

Every event the writer lands in `Brain/log/<date>.md` is mirrored to
`Brain/log/<date>.jsonl` in the same atomic step (one
`proper-lockfile` lock for the pair). Machine consumers
(`o2b discipline report` today, future tooling tomorrow) read JSONL
through `src/core/brain/log-jsonl.ts:readLogDay`, which falls back to
parsing markdown on days that pre-date v0.10.8. Hand-editing the
markdown does not break the reader; deleting the JSONL forces the
fallback path until the next write rebuilds it.

The retired `event_log_append` MCP tool no longer exists in any
runtime as of §32 (v0.10.8). The bash CLI `o2b append-event` still
works for cron-jobs / shell scripts that target `Daily/`, but it no
longer counts as a brain event for the Stop guardrail.

As of v0.10.10 a third bash needle joins the guardrail-clearing
set: `o2b brain note` — the CLI mirror of the MCP `brain_note`
tool. Cron jobs and shell scripts can land a Brain-native
narrative-milestone event without going through the MCP surface;
the matching turn clears the Stop guardrail the same way an MCP
call would.

## Files

- `hooks.json` — lifecycle config picked up by both runtimes. Claude
  Code looks for `hooks/hooks.json` at the plugin root by convention;
  Codex auto-loads the same file when the plugin manifest's `"hooks"`
  field points at it (set in both `.codex-plugin/plugin.json` and
  `plugins/codex/.codex-plugin/plugin.json`).

  Layout caveat: Codex's marketplace source is
  `./plugins/codex/`, so the Codex side only sees what lives under
  that subdirectory. The repo exposes the hooks tree there via a
  `plugins/codex/hooks → ../../hooks` symlink (same pattern as
  `plugins/codex/skills`). The symlink target is relative, so it
  resolves correctly inside a cloned repo too — but it does assume
  the consumer copies the whole repo, not just `plugins/codex/`. If
  Codex ever switches to a "ship subtree only" extraction model, the
  symlink will dangle and the hooks tree will need to move
  physically under `plugins/codex/hooks/` (or be duplicated).
- `post-write-reminder.ts` / `stop-log-guardrail.ts` — Bun entry
  scripts. They are tiny by design: they parse stdin, query
  `lib/transcript.ts` and `lib/detect.ts`, and emit the hook's JSON
  response on stdout. Never block on errors.
- `lib/stdin.ts` — read the single JSON object both runtimes send on
  stdin.
- `lib/transcript.ts` — JSONL parser that recognises both the
  Claude Code shape (top-level `{type:"user"|"assistant", message:
  {content:[...]}}`) and the Codex shape (`{type:"response_item",
  payload:{type:"function_call"|"custom_tool_call", name}}`).
- `lib/detect.ts` — canonical lists of artifact / log tool names.
- `lib/messages.ts` — reminder + block text. Kept here so it can be
  unit-tested without a hook subprocess.

## How both runtimes find the hook commands

`hooks.json` invokes the bare `o2b-hook <name>` command. That
launcher is installed on PATH by `o2b install-cli` (one of
`["o2b", "vault-log", "o2b-hook"]`) and lives at
`scripts/o2b-hook` inside the plugin checkout. The launcher follows
its own symlink, walks up one directory to find the plugin root,
runs the Bun precheck, and execs the requested `hooks/<name>.ts`.

This path resolution is intentionally PATH-based rather than relying
on `${CLAUDE_PLUGIN_ROOT}` (which Claude Code substitutes natively)
or `${CODEX_PLUGIN_ROOT}` (which doesn't exist on the Codex side as
of CLI 0.129). One PATH-discoverable shim works in both runtimes
without per-runtime branching.

If `o2b install-cli` was skipped (or the install was wiped without
running it), the hooks fail closed: the runtime sees a
`command not found`, exits non-zero with a stderr trace, and
proceeds with the turn. The Stop guardrail's `decision: "block"`
only fires when the script runs successfully.

## Local dev loop

The plugin lives at `/srv/projects/open-second-brain/` and Claude
Code / Codex are wired to that directory via local marketplaces
(`extraKnownMarketplaces` in `~/.claude/settings.json`,
`[marketplaces.open-second-brain] source_type = "local"` in
`~/.codex/config.toml`). Both runtimes cache the installed plugin,
so edits to `hooks/*.ts` don't auto-propagate.

After changing a hook script:

```bash
# Claude Code: refresh the local-marketplace cache and reinstall.
claude plugin marketplace update open-second-brain
claude plugin update open-second-brain@open-second-brain

# Codex: re-add the marketplace (there is no "upgrade" for local
# marketplaces; remove + add wipes the cache and re-stages the
# plugin tree from /srv/projects/open-second-brain/plugins/codex/).
codex plugin marketplace remove open-second-brain
codex plugin marketplace add /srv/projects/open-second-brain
```

Then exercise the hook end-to-end:

```bash
# Claude Code
claude -p 'create a tiny note.md in /tmp/x with content hello' \
    --output-format=stream-json --verbose --include-hook-events \
    --allowedTools 'Write Read' --add-dir /tmp/x

# Codex
codex exec --skip-git-repo-check 'create a tiny /tmp/x/note.md ...'
```

Expect the stream to show `hook_started` / `hook_response` events
around each Write and around the Stop event; the agent's first reply
gets `decision: "block"` and it has to either log or send a second
finishing message.

## Unit tests

`tests/hooks/*.test.ts` exercises the library and spawns the two
hook entry scripts as subprocesses with synthetic stdin / JSONL
transcripts. Run with:

```bash
bun test tests/hooks/
```

The subprocess tests inherit the test runner's cwd, not the
plugin's, which matches production behaviour: Claude Code and Codex
both spawn the hook in the user's session cwd, not in the plugin
checkout. The scripts therefore must NEVER use `process.cwd()` to
locate plugin files — resolve paths via `import.meta.url` or
relative imports, as the current code does. If you ever need to
read a vault path, take it from the hook payload or the persisted
plugin config.
