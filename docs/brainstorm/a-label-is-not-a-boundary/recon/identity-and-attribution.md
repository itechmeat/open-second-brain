# Recon: identity and attribution — who a write says it is, and who may read it

Read-only reconnaissance against `feat/a-label-is-not-a-boundary` @ `280469d2`
(v1.48.0). Covers kanban `t_3ebb6e0e` (agent identity modes) and `t_0c6f31ee`
(`on_delegation` episodic capture). Every claim below carries a `file:line`
anchor that was opened; three findings were reproduced by execution and say so.

Both task bodies are wrong in the same direction. They assume the missing thing
is a way to CARRY identity across a boundary. What is missing is a boundary at
all: identity is already carried, freely, by whoever asks.

## What exists

### The identity path, end to end

**Resolution.** One function: `resolveAgentName(configPath?)`
(`src/core/config.ts:373-380`). Order is `VAULT_AGENT_NAME` env → config
`agent_name` / `agentName` → the literal string `"agent"`. Nothing else resolves
an identity. `openclaw/index.js:1683` is a vendored duplicate in the bundled
plugin, not a second source.

Two derivations sit on top:

- `normalizeAgentArgument(value)` (`src/core/agent-identity.ts:44-55`) strips a
  leading `@`, trims, canonicalises `_`→`-`, and returns `null` for anything in
  `PLACEHOLDER_AGENT_VALUES` (`:19-42`) so a model that guessed `claude` or
  `assistant` falls through to the server value.
- `deriveRuntimeAgentName(runtimeId, operatorName)`
  (`src/core/agent-identity.ts:84-93`) rewrites `claude-vps-agent` into
  `openclaw-vps-agent` for a non-primary runtime. Callers:
  `src/openclaw/index.ts:58`, `src/core/install/identity.ts:29,51`.

**Where it is stamped.** Every writer takes the same shape — an optional caller
argument, then the resolved server value:

| Surface | Anchor |
|---|---|
| MCP feedback / evidence | `src/mcp/brain/feedback-tools.ts:114,368,600` |
| MCP admin | `src/mcp/brain/admin-tools.ts:81,234,290` |
| MCP knowledge | `src/mcp/brain/knowledge-tools.ts:527,600` |
| MCP write-batch | `src/mcp/brain/write-batch-tools.ts:167` |
| MCP synthesis (`brain_session_checkpoint`) | `src/mcp/brain/synthesis-tools.ts:224` |
| MCP context (`brain_write_session`) | `src/mcp/brain/context-tools.ts:80` |
| Core note | `src/core/brain/note.ts:64-65` |
| Core decisions | `src/core/brain/decisions/record.ts:397-398,476-477,528-529` |
| Core tombstone / temporal-replace | `src/core/brain/lifecycle/tombstone.ts:236-237`, `lifecycle/temporal-replace.ts:218-219` |
| Core tensions | `src/core/brain/tensions.ts:375` |
| Core diagnostics | `src/core/brain/diagnostics.ts:1166` |
| Entity registry (`source_agent`) | `src/core/brain/entities/registry.ts:504,542` |
| Claude-memory import | `src/core/brain/import-claude-memory.ts:250` |
| Session lifecycle hook | `hooks/session-capture.ts:51` |
| Shared-namespace mirror | `src/core/brain/shared-namespace.ts:50,77` |
| CLI verbs | `apply-evidence.ts:29`, `dream.ts:200`, `handoff.ts:32`, `import-session.ts:51`, `maintenance.ts:166`, `session-hook.ts:23` |

**Where it is read back.**

- `src/core/brain/agent-source/vault-provider.ts:28,117,142-149,169-175` — the
  only reader that turns a stored `agent` string into a queryable roster
  (signals' `agent`, log entries' `agent`).
- `src/core/brain/agent-source/registry.ts:39-80` folds that into
  `AgentSourceSummary`; `query.ts:46-70` filters it; `diff.ts:38-63` is the
  per-agent view `brain_agent_diff` serves — `per_agent` counts, `shared_topics`,
  `unique_topics`, `topic_map`.
- `src/core/graph/agent-scope.ts:104` `isOwnerVisible(owner, scope)` — the read
  side, comparing a page's `owner:` frontmatter against a requested scope.
- `src/mcp/server.ts:167-169` — `ServerContext.agentName`, a getter so a config
  edit takes effect without a restart, and so `ConfigReadError` reaches only the
  handlers that actually need an identity.
- `src/mcp/server.ts:295-316,433-435` — the `initialize` handshake renders the
  identity into the instructions, or renders the reason there is none.
- `templates/identity-reminder.txt:1`, `.hermes.txt:1`, `.openclaw.txt:1` via
  `buildReminder(agent, target)` (`src/core/identity-reminder.ts:134-141`).

**Per-turn injection.** Hermes `prefetch` (`plugins/hermes/provider.py:503-505`)
and OpenClaw `before_prompt_build` (`src/openclaw/index.ts:47-59`). Claude Code
and Codex get no identity reminder at all — their nudge is
`hooks/lib/messages.ts:postWriteReminder`, which carries no `@agent`
(`src/core/identity-reminder.ts:12-14`, `hooks/README.md` "What the hooks do").

### Hook events: what this repo registers, what the host delivers

`hooks/hooks.json` registers seven event names: `PostToolUse` (two matchers:
`brain_feedback`, `Write|Edit|MultiEdit|apply_patch`), `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `Stop`, `SessionEnd`, `PostCompact`. Nine entry
scripts back them (`hooks/active-inject.ts`, `gap-agenda.ts`, `gap-promote.ts`,
`nav-inject.ts`, `post-write-reminder.ts`, `pretool-orient.ts`,
`recall-inject.ts`, `session-capture.ts`, `stop-log-guardrail.ts`).

The host's full event list is
`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/README.md:63`:
`PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd,
UserPromptSubmit, PreCompact, Notification`.

Cross the two lists:

- **`SubagentStop` is delivered and not registered.** It is the delegation
  boundary event, and it exists today. `~/.claude/cache/changelog.md:1315,1672`
  confirms it is live and carries the same input shape as `Stop`.
- `PreCompact` and `Notification` are likewise delivered and not registered.
- `PostCompact` is registered and is **not** in the host's list —
  `hooks/README.md` and `hooks/lib/context-events.ts:12-19` already say so
  ("current Claude Code has no PostCompact hook event"), keeping the
  registration as a deliberate no-op.

### What a sub-agent leaves behind today (reproduced)

Against a real transcript tree in
`~/.claude/projects/-srv-projects-open-second-brain/c67b3203-ea88-4049-9972-12d0a00c0448/`:

1. Sub-agent turns are written to a **separate file**,
   `<parent-session-id>/subagents/agent-<id>.jsonl`. The parent transcript
   contains none of them.
2. Every line in that file carries `sessionId` **equal to the parent's session
   id**, plus its own `agentId` and `isSidechain: true`.
3. `claudeAdapter.detect()` returns `true` on it and
   `claudeAdapter.iterate()` yields 85 turns and 25 tool calls (executed).
   `turnFromLine` (`src/core/brain/sessions/claude.ts:32-82`) reads only
   `type`, `uuid`, `timestamp`, `message` — it reads neither `agentId` nor
   `isSidechain`. A sub-agent transcript imports as an ordinary session of the
   parent.
4. `importSessionPath` (`src/core/brain/sessions/import.ts:637-676`) walks a
   directory recursively for `*.jsonl`, so pointing it at a project directory
   ingests parent and sub-agent transcripts into one flat stream.
5. In this harness the delegation tool is named `Agent` (21 calls in that
   transcript), and it is **asynchronous**: the `tool_result` at the call site is
   `"Async agent launched successfully… agentId: …"` (1112 bytes of launch
   metadata), not the sub-agent's answer. The answer arrives later as a synthetic
   user turn `<task-notification>` carrying `<task-id>`, `<tool-use-id>`,
   `<output-file>` (a path under `/tmp/claude-…/tasks/`), `<status>` and
   `<summary>`.

So the parent transcript alone already holds both halves of the pair, joinable on
`tool-use-id`: the task (the `Agent` tool_use `input.prompt`) and the completion
record (the `<task-notification>` turn). The full result body lives in a `/tmp`
file that is not part of the transcript.

### Continuity records and the `agent` field

`docs/observability.md:73` (the task body cites `:66`; the line is **73**) says:
"Multi-agent vaults attribute writers via per-agent identity
(`brain_agent_query`); continuity records do not yet thread parent/child agent
ids". **Still true, and understated.**

- `session_turn` payload (`src/core/brain/session-recall.ts:350-364`) and
  `session_summary_node` payload (`:400-410`) carry `session_id`, `turn_id`,
  `timestamp`, `role`, `text`, hashes, lineage — and **no agent field at all**.
  Not "no parent id": no id.
- `CONTINUITY_AGENT_ID_KEY = "agent_id"` exists
  (`src/core/brain/continuity/types.ts:15`) and is clip-protected (`:38-42`), but
  the only writer is `brain_context_pack_outcome`, from a caller **argument**
  (`src/mcp/brain/recall-tools.ts:760`).
- The envelope is pinned at eight fields
  (`docs/observability.md:32`, `tests/core/brain/continuity/record-envelope.test.ts`),
  so an agent id can only ride inside `payload` as an additive field — which is
  exactly what `docs/observability.md:73` already promises.
- Session lineage (`src/core/brain/lineage/resolve.ts:1-19`) threads
  `parent_session_id` / `root_session_id` / `compression_depth`
  (`hooks/lib/stdin.ts:28-30`), but the docblock is explicit that this answers
  "which conversation does this session id belong to" for **compression chains**.
  It cannot separate a sub-agent anyway: finding 2 above shows the sub-agent
  reuses the parent's `sessionId`.

### Shared-namespace attribution

`src/core/brain/shared-namespace.ts` mirrors explicit remember-writes into a
second vault named by the `shared_namespace` config key (`:31-35`). Attribution
is carried twice: the existing `agent` field and `origin_vault`, the basename of
the primary vault (`:50`, `:77`). Writers: `src/cli/brain/verbs/feedback.ts:97-101`
and `src/mcp/brain/feedback-tools.ts:59` for signals, `src/core/brain/note.ts:75-79`
for notes. Self-mirror is refused as `"failed"` rather than silently duplicated
(`:92-94`).

## What does not exist

- **No `on_delegation` hook, in any spelling.** A repository-wide search for
  `delegation`, `on_delegation`, `subagent`, `sub-agent`, `SubagentStop` (all
  file types, excluding `node_modules` and `docs/brainstorm/`) returns only
  docblocks about *dispatching* work outward — `ingest/batch-plan.ts:10-11`,
  `ingest/checkpoint.ts:172`, `sync-lockfile.ts:232`, `health/reconcile.ts:7` —
  and generic "delegates to" prose. Nothing captures a returning sub-agent.
- **No identity mode switch.** No config key, env var, tool argument, or CLI flag
  selects between identity behaviours. `resolveAgentName` has one code path.
- **No `off`.** There is no way to suppress identity. The bottom of the chain is
  the literal string `"agent"` (`src/core/config.ts:379`), which is itself in
  `PLACEHOLDER_AGENT_VALUES` (`src/core/agent-identity.ts:20`) — so the "no
  identity configured" state is a value that every argument-normalising surface
  rejects, and `src/openclaw/index.ts:53` special-cases by comparing to it.
- **No `tool_response` consumer in capture.** `hooks/lib/stdin.ts:41` declares
  the field and `:57` maps grok's `toolResponse` onto it, but
  `normalizePayload` (`src/core/brain/session-lifecycle.ts:528-570`) lifts
  `tool_name` and `tool_input` and **not** `tool_response`. The only reader
  anywhere is `hooks/post-write-reminder.ts:100`, and it only asks whether the
  call errored.
- **No reader for `origin_vault`.** Grep across `src/`, `tests/`, `docs/`: it is
  written at `shared-namespace.ts:50,77`, persisted into signal frontmatter at
  `src/core/brain/signal.ts:403-404`, asserted present by
  `tests/core/brain/shared-namespace.test.ts:67,94`, and read by nothing. No
  query filter, no display field, no roster dimension. `brain_agent_diff` cannot
  tell a mirrored contribution from a native one.
- **No credential.** `src/core/write-binding/index.ts:12-22` states the position
  in the source: there is no credential in this system to key a fence to, and a
  caller who can call the tool can name itself anything. `initialize` discards
  `clientInfo`; `handleToolsCall` performs no JSON-schema validation, so
  `required` and `additionalProperties: false` are advisory to the model.

## Correction to premise (A) — `managed` / `passthrough` / `off`

**`passthrough` is not missing. It is the default, it is unconditional, and it is
the defect.**

Enumerated by loading the shipped schemas (executed against
`src/mcp/brain-tools.ts`, 92 tools, plus `search-tools`/`skill-tools`/
`schema-tools`/`watchdog-tools`, 12 tools):

- **21 tools accept a caller-supplied `agent`** and stamp it verbatim onto the
  record: `brain_apply_evidence`, `brain_dead_ends`, `brain_decision`,
  `brain_delete_by_source`, `brain_derive_fact`, `brain_distill_source`,
  `brain_dream`, `brain_feedback`, `brain_generation_reports`,
  `brain_ingest_source`, `brain_intake_entities`, `brain_labels`,
  `brain_lifecycle`, `brain_maintenance`, `brain_note`, `brain_research_report`,
  `brain_secrets`, `brain_session_checkpoint`, `brain_tension`, `brain_truth`,
  `brain_write_session`.
- **12 tools accept a caller-supplied `agent_scope`**: `brain_agent_query`,
  `brain_anticipatory_context`, `brain_brief`, `brain_context_pack`,
  `brain_deep_synthesis`, `brain_file_context`, `brain_pre_compress_pack`,
  `brain_query`, `brain_retrieval_plan`, `brain_search`, `brain_search_expand`,
  `brain_search_by_source`.

The only filter on a supplied `agent` is `normalizeAgentArgument`
(`src/core/agent-identity.ts:44-55`), which rejects 22 well-known placeholder
strings and accepts every other string on sight. A sub-agent can already write
under the orchestrator's identity today by passing `agent: "<parent-name>"`. That
is `passthrough`, shipped, with no switch and no verification. The project has
written the reason down itself: `src/mcp/brain/recall-tools.ts:738-750` argues
that "the identity a client asserts is exactly as self-asserted as the one the
config holds".

**`managed` does not exist except in one place.** `brain_context` is the single
surface with no `agent` argument, so `ServerContext.agentName` is its only source
of identity (`src/mcp/server.ts:151-169`, `src/mcp/brain/context-tools.ts:388-397`).
Everywhere else, the config value is a default, not an owner.

**The read side has the same hole, and it is worse because it is sold as
isolation.** `coerceAgentScope(ctx, args, fallbackToServerIdentity)`
(`src/mcp/coerce.ts:115-123`) returns an explicit argument **unconditionally**;
the server identity is consulted only when the argument is absent. Six gated
call sites pass `true` (`recall-tools.ts:379`, `pack-tools.ts:151,567,656`,
`brief-tools.ts:74,150`). `resolveOwnerScopeDelivery`
(`src/core/brain/preferences-collect.ts:171-185`) then sets
`enforcedScope = requestedScope` under `owner_scope_delivery: fail` — the scope
enforced is the one the caller asked for, never checked against the caller. So
with the isolation gate ON, any caller reads any owner's owner-private
preferences by naming that owner in `agent_scope`. The label is the boundary.

**`off` has no subject.** There is no identity behaviour to disable — no
per-record cost, no per-turn injection on Claude Code / Codex at all. Suppressing
"identity noise in a single-agent vault" would mean not rendering
`templates/identity-reminder.txt` on Hermes/OpenClaw, which is one string in one
prompt, and the operator already gets that by leaving `agent_name` unset
(`src/openclaw/index.ts:53` returns `undefined` and injects nothing).

## Correction to premise (B) — `on_delegation`

The validator's finding is confirmed — no hook, no capture — but the framing is
wrong on three counts.

1. **"The capture point sits on the HOST runtime's delegation boundary, not
   inside Open Second Brain."** Half right. The host exposes exactly the boundary
   this repo needs and this repo does not register it: `SubagentStop`. It carries
   `session_id` and `transcript_path` like `Stop` does, and the sub-agent
   transcript it names is a real file on disk that `claudeAdapter` already parses
   (reproduced above: 85 turns, 25 tool calls).

2. **"Captures each delegated sub-agent's (task, result) pair."** At the
   delegation tool boundary in this harness there is no result to capture. The
   `Agent` tool is async; its `tool_result` is a 1112-byte launch receipt. A hook
   built on `PostToolUse`/`Agent` would persist a task and a receipt — a capture
   that captures nothing, which is precisely the do-nothing fallback this
   repository forbids. The result is recoverable only from (a) the
   `<task-notification>` turn later in the parent transcript, or (b) the
   sub-agent's own transcript file, or (c) the `/tmp` output file, which is
   ephemeral.

3. **"Scoped to the PARENT agent's namespace."** There is no namespace to scope
   to. `sessionId` is identical for parent and sub-agent (finding 2), and the
   `agent` label is a per-adapter constant (see the defect below), so both halves
   of the intended key are already collapsed before any hook runs.

**Does an orchestrator's later turn recall what a dispatched worker found?
No — and the mechanism that would carry it erases the distinction rather than
losing it.** Today the only route is `o2b brain import-session` over the
transcript tree, which flattens sub-agent turns into the parent session id under
the label `"claude"`. `brain_session_checkpoint`
(`src/mcp/brain/synthesis-tools.ts:213-230`) and `brain_write_session`
(`src/mcp/brain/context-tools.ts:60-160`) are voluntary: the agent must decide to
call them, and a sub-agent that finishes without calling one leaves nothing.
`brain_pre_compact_extract` (`src/mcp/brain/pack-tools.ts:604-620`) requires
`session_id`, `turn_start`, `turn_end` and `text` from the caller — it is a
kernel for text the caller already holds, not a capture.

## Smallest native unit per task

### For `t_3ebb6e0e` — the honest unit is a REFUSAL, not a mode

The three-mode vocabulary does not map. `passthrough` ships as the ungated
default; `off` has no subject. The one mode that does not exist is `managed`, and
naming it "a mode" hides that today's behaviour is the unsafe one.

Smallest native unit: **a config key that makes the server-resolved identity
authoritative, and refuses a conflicting caller-supplied one.**

- One key, default off so existing vaults are byte-identical. When on,
  `normalizeAgentArgument(args.agent)` that resolves to something other than the
  server identity becomes an `INVALID_PARAMS` error naming both values, rather
  than being silently accepted (21 write tools) or silently honoured (12 read
  tools).
- The read side is the load-bearing half: under `owner_scope_delivery: fail`,
  `coerceAgentScope` (`src/mcp/coerce.ts:120-121`) must stop letting an explicit
  argument outrank `ctx.agentName`. Today the isolation gate isolates by
  self-declaration, which is not isolation. This is a real behaviour change and
  belongs in the release notes as one.
- It changes something observable in both directions, so it is not a mode that
  changes nothing.

What it does not buy, stated honestly: nothing here authenticates a caller. A
process that can reach the MCP socket can edit `agent_name` or set
`VAULT_AGENT_NAME`. The value is that a *cooperating* multi-agent setup stops
being able to cross the line by accident, and a crossing becomes an error with a
name instead of a record.

### For `t_0c6f31ee` — register the boundary the host already fires

The premise "an `on_delegation` hook … writes a (task, result) pair" does not
hold as written: the delegation call site has no result. What does hold:

Smallest native unit: **a `SubagentStop` registration in `hooks/hooks.json`
routing to `session-capture`, plus the two fields that make a sub-agent
distinguishable.**

1. Register `SubagentStop` in `hooks/hooks.json` alongside `Stop`, same
   launcher shape, same fail-soft contract. The event is delivered today and this
   repo ignores it.
2. Lift the sub-agent discriminators the transcript already carries into
   `SessionTurn`: `agentId` and `isSidechain` in
   `src/core/brain/sessions/claude.ts:32-82`, and a corresponding optional field
   in `sessions/types.ts`. Without this, step 1 records a second session under
   the parent's id and the boundary is still erased.
3. Persist the sub-agent's turns as `session_turn` continuity records under a
   payload that names both ids — the additive-field path
   `docs/observability.md:73` already commits to, no schema bump. The parent
   recalls the worker through `searchSessionRecall`
   (`src/core/brain/session-recall.ts:190-200`), which is the read surface that
   already exists.

Bounded and fail-soft come free: `armProcessCeiling`
(`hooks/session-capture.ts:20-37`) and the capture boundary
(`src/core/brain/session-lifecycle.ts:186-190`) already govern every lifecycle
event.

If `SubagentStop` cannot be relied on across the host matrix, the fallback that
is still honest is the `<task-notification>` turn in the parent transcript — it
is ordinary transcript text, already parsed into a `SessionTurn`, and joinable to
the `Agent` tool_use on `tool-use-id`. That records the summary and the status,
never the full result, and should say so.

## Defects noticed

1. **`--agent` on `o2b brain import-session` is accepted, validated, and
   discarded.** `agentLabelForTurn`
   (`src/core/brain/sessions/import.ts:601-604`) is
   `getAdapter(adapter).defaultAgent.trim() || fallback`. Every shipped
   `defaultAgent` is a non-empty constant, so `fallback` — the `opts.agent` that
   `src/cli/brain/verbs/import-session.ts:47-51` computed from `--agent` or
   `resolveAgentName(config)` — is unreachable. Executed: with
   `--agent claude-vps-agent` on a claude transcript the emitted label is
   `"claude"`. Four call sites are affected (`import.ts:427,458,490,520`). The
   docblock at `:597-600` documents the precedence as intentional; the CLI flag
   contradicts it, and one of the two is wrong.

2. **Three of five session adapters stamp a label that every other surface
   treats as "no identity".** Executed against
   `src/core/brain/sessions/registry.ts:36-42`:
   `normalizeAgentArgument("claude") → null`, `"codex" → null`,
   `"hermes" → null`; `"opencode"` and `"grok"` survive. So session-imported
   signals are attributed to a string that `normalizeAgentArgument` rejects
   everywhere else, and `brain_agent_query` rosters an agent named `claude` that
   no writer could ever have named itself.

3. **`origin_vault` is write-only.** Written at
   `src/core/brain/shared-namespace.ts:50,77`, persisted at
   `src/core/brain/signal.ts:403-404`, read by nothing in `src/`. The module
   docblock (`:9-10`) advertises it as one of two attribution carriers. A
   contributor field no reader consults is attribution in name only.

4. **`tool_response` is declared and dropped.** `hooks/lib/stdin.ts:41` and
   `:57` carry it to `captureSessionLifecycleEvent`, and
   `normalizePayload` (`src/core/brain/session-lifecycle.ts:563-568`) lifts
   `tool_name` and `tool_input` past it. Any capture of what a tool *returned* —
   including the delegation unit above — starts by fixing this line.

5. **`agentLabelForTurn` takes a `turn` it discards.**
   `src/core/brain/sessions/import.ts:602` is `void turn; // reserved for future
   per-turn role-aware fallback`. It is the exact seam where a sub-agent turn
   would need to be labelled differently, and it is currently a parameter that
   exists to be ignored.

6. **`resolveOwnerScopeDelivery` enforces the requested scope, not the caller's.**
   `src/core/brain/preferences-collect.ts:182`:
   `enforcedScope: mode === GATE_MODE.fail ? requestedScope : null`. Combined
   with `src/mcp/coerce.ts:120-121`, turning the isolation gate on gives a caller
   the ability to select which owner's private memory it receives. This is the
   sharpest instance of the release's thesis and the one place where the current
   behaviour is worse than having no gate, because the gate's presence implies a
   check that is not performed.
