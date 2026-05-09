---
name: agent-event-log
description: Append-only operational event logging for Open Second Brain. Daily Markdown notes are the default backend. INVOKE this skill (and call `event_log_append`) immediately after producing any durable artifact in the current turn — code shipped, bug fixed, refactor merged, config or deployment change, instruction-file edit (CLAUDE.md / AGENTS.md / plugin docs / system prompts), content artifact created (post, draft, documentation, marketing copy, release notes), research or investigation that produced a concrete finding or decision worth recalling later, or discovery of an external fact (CLI behaviour change, API quirk, undocumented edge case) that future sessions should know. SKIP for pure discussion, exploration, read-only queries, and planning that has not yet produced an artifact. If unsure, ask "would future-me want to find this in the log by searching for it later?" — if yes, log it. WRITE the `message` in the same natural language the user has been speaking with you in this session — never default to English when the user has been writing in a different language; mixed-language sessions follow the most recent user message at the time the artifact landed. This skill description is intentionally in English so it travels across runtimes; the locale of the description is unrelated to the locale your log entry must take.
---

# Agent Event Log

Open Second Brain ships an `event_log_append` tool (via the MCP server registered by this plugin) that records what happened, when, and which agent did it. The tool writes one line into the day's Markdown note (`<vault>/Daily/YYYY.MM.DD.md`) under a `## Raw events` heading.

## When to call `event_log_append`

Call it **once per durable artifact produced in the current turn**. A durable artifact is anything you would want to find again by searching the vault tomorrow, next week, or six months from now. Concrete triggers:

- **Code:** code shipped, bug fixed, refactor merged, dependency bumped, schema migration applied.
- **Config / deployment:** any change to `config.yaml`, `~/.codex/config.toml`, systemd unit, Caddy snippet, environment variable, secret rotation, infra rollout.
- **Instructions / docs:** edit to `CLAUDE.md`, `AGENTS.md`, project README, plugin docs, system prompt, runbook, onboarding guide.
- **Content artifacts:** new post draft, documentation page, marketing copy, release notes, public-facing communication.
- **Research / investigation findings:** a concrete answer, root cause, design decision, or trade-off resolution. Not the act of searching — the conclusion you reached.
- **External-fact discoveries:** a CLI now requires a flag it didn't before, an API rejects a payload it used to accept, a documented behavior diverges from observed behavior. Worth logging because the next session won't re-discover it.

## When NOT to call it

- Pure discussion or brainstorming with no conclusion.
- Read-only queries (running `git log`, `o2b status`, `vault_health`, `second_brain_query`).
- Planning that has not yet produced a written artifact.
- Acknowledgement-only replies ("ok", "got it").

If you are unsure: ask yourself "would future-me want to find this in the log by searching for it later?". If yes, call the tool.

## How to call it

The MCP server resolves the agent identity from `~/.config/open-second-brain/config.yaml` automatically; you do **not** pass `agent` unless you are deliberately logging on someone else's behalf. Pass only `message`:

```
event_log_append({ "message": "migrated CLI from Python to Bun, all 175 tests green" })
```

Server prepends `HH:MM` and `@<agent-name>` itself. Never bake those into your message.

## CLI fallback

When MCP is unavailable, the same operation is reachable from the shell:

```bash
o2b append-event "migrated CLI from Python to Bun, all 175 tests green"
# or, the legacy alias:
vault-log "migrated CLI from Python to Bun, all 175 tests green"
```

## Language

The `message` body must match the **natural language the user has been speaking with you in this session**. Identity prefix (`@agent-name`) and timestamp are server-supplied and stay locale-independent — only the message body localises.

Concrete rules:

- **Match the user.** Whatever language the current user message is in, that is the language the log entry goes in. If the user's message is in some language X, the entry is in language X. The English example below is illustrative only — replace its prose with prose in language X when X ≠ English; do not switch the technical identifiers.
- **Mixed-language session → match the most recent user message at the time the artifact landed.** A user who switches mid-session expects the new entries in the new language.
- **Technical identifiers stay verbatim regardless of surrounding language**: command names (`bun test`, `o2b doctor`), file paths (`src/core/event-log.ts`), package and library names (`proper-lockfile`, `@anthropic-ai/sdk`), API symbols, error messages quoted from logs. Never translate `event_log_append` (or any other identifier) into a different word.
- **Default-to-English bias is the failure mode.** This skill description is written in English so it travels across runtimes — but the message you write into Daily is the user's language, not the language of this instruction.

Illustrative shape, English example (substitute the user's language for the prose):

```
fixed event_log_append race: dailyNotePath now validates date via validateEventDate, blocking path traversal via "../"
```

If you genuinely cannot infer the user's language (single-message session, no clear signal, ambiguous greeting only), default to English and keep the entry concise.

## Rules

- Append only — never edit historical lines.
- One line per event, factual and terse.
- Never write secrets, tokens, API keys, passwords, or connection strings containing credentials. The server redacts assignments of those names to `[REDACTED]`, but do not rely on it as the only line of defence.
- Prefer specific over generic ("renamed `pre_llm_call` hook to `before_prompt_build` per OpenClaw 0.5 SDK rename" beats "updated hook").
