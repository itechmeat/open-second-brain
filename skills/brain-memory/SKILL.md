---
name: brain-memory
description: Record taste signals and apply-evidence events into the Brain observing-memory layer of Open Second Brain. INVOKE this skill (and call `brain_feedback`) the moment the user expresses a preference, dislike, correction, or rule in dialogue — "don't do X", "use A instead of B", "I prefer Y", "X is wrong here", or any explicit imperative that should outlive the current turn. SEPARATELY invoke (and call `brain_apply_evidence`) right after you produce a durable artifact (code shipped, file written, content drafted, config change) and at least one preference in `Brain/preferences/` has a `scope` that plausibly applies — record whether you `applied` or `violated` it. SKIP for casual chat, exploration without a stated rule, read-only inspection, trivial edits, and any case where you are not confident a preference applies. WRITE the `principle` and `note` fields in the same natural language the user has been speaking in this session; technical identifiers (`topic` slug, `pref_id`, `scope`) stay English. A misrecorded signal is worse than a missed one — the dream pass eventually surfaces real patterns from repeat events, so prefer precision over coverage.
---

# Brain Memory

Brain is the agent-writable observing-memory layer of Open Second Brain. It accumulates user preferences from real signals and learns from real applications. Your job is to (a) record taste signals as they arrive in conversation, and (b) record whether you applied or violated active preferences each time you produce a durable artifact in a relevant scope. The deterministic `dream` pass turns repeat signals into rules and retires what stops being applied.

## When to call `brain_feedback`

Call **once per taste signal** the user (or a teammate agent) expresses. Concrete triggers:

- Explicit corrections: "don't do X", "stop doing Y", "use A instead of B".
- Stated preferences with outlasting reach: "I prefer X over Y", "expand acronyms on first use", "always include a CHANGELOG entry".
- Pushback on a specific artifact you produced that targets a *rule*, not a one-off ("this commit message is wrong — use imperative voice").
- A teammate agent or human describing a process rule in chat that should survive future sessions.

Parameters:

- `topic`: stable kebab-slug for the rule (`no-internal-abbrev`, `imperative-prompts`, `prefer-typed-errors`). Reuse existing slugs — call `brain_query --topic <slug>` first if you are unsure. New slugs only when no existing one fits.
- `signal`: `positive` when the principle stated is the rule to follow, `negative` when the principle stated is what to avoid.
- `principle`: one-line, imperative-voice agent-readable formulation. "Do not use internal abbreviations in user-facing copy unless explained first."
- `agent`: your runtime identity (`claude`, `codex`, `hermes`, OpenClaw plugin name, or the human's name if you are recording on their behalf).

Optional but **strongly recommended**:

- `raw`: the verbatim quote that triggered the signal. Without it the
  signal file lands without a `## Raw` body — counters keep working,
  but the audit trail loses the original phrasing. Pass the exact
  sentence the user said (or the exact line of the artifact the
  signal is about). v0.10.1 dropped the `_(not provided)_` placeholder
  precisely so an absent `raw` is now visible: the file simply has no
  body, which should be the rare case, not the norm.

Optional:

- `scope`: soft category for later application-scope matching — `writing`, `coding`, `process`, `design`, `infra`, `docs`. Pick the narrowest accurate one.
- `source`: array of wikilinks to the artifacts or notes that triggered the signal — `[[Daily/2026.05.14]]`, `[[blog-header-draft]]`. Improves later auditability.

The server creates `Brain/inbox/sig-<date>-<slug>.md` and resolves collisions deterministically.

## When to call `brain_apply_evidence`

Call **once per (preference, artifact) pair**, right after a durable artifact lands. A durable artifact is anything the user would re-find by searching the vault tomorrow: code shipped, config change, deployment touched, content drafted, instruction-file edit, design decision recorded. Trivial edits (typo fix, pure formatting) do not qualify.

Discover applicable preferences first. Options:

- Read `Brain/preferences/` directly — files `pref-*.md` are tiny.
- Call `brain_query --topic <slug>` to fetch a topic-scoped slice.
- Call `brain_query --preference <id>` for a single preference plus its evidence trail.

Parameters:

- `pref_id`: id of the preference you are recording against (`pref-no-internal-abbrev`).
- `artifact`: wikilink identifying what you produced — `[[Daily/2026.05.14#section-blog-post]]`, `[[src/cli/main.ts]]`, `[[docs/release-notes/v0.9.0.md]]`. The wikilink resolves in Obsidian; use `#anchor` to point at a specific section when relevant.
- `result`: `applied` if the rule held in this artifact, `violated` if you (or another agent) broke it. Recording a `violated` event is not a failure — it is what trains the system.
- `agent`: your runtime identity.

Optional:

- `note`: one-line context if useful ("expanded 'OSB' to 'Open Second Brain' on first use", "README diff still contained unexplained 'FT'").

`applied_count` and `violated_count` on the preference are recomputed by `dream`; you write only the per-event evidence record.

## When NOT to call

- Casual chat, banter, acknowledgements ("ok", "got it").
- Brainstorming, idea exploration, design discussion that has not concluded in a rule.
- Read-only inspection (running `git log`, `o2b status`, `vault_health`).
- Trivial edits (typo, whitespace, formatting only).
- Cases where a preference *might* apply but you are not confident — skip rather than fabricate a match.

A false-positive signal eventually distorts the rule set; a missed signal is recovered on repeat. Prefer precision.

## Language

The `principle` and `note` fields must match the **natural language the user has been speaking in this session**. Technical identifiers stay English regardless: `topic` slug, `scope`, `pref_id`, `result`, `agent` name, file paths, library names, error messages quoted from logs. This mirrors the policy from the `agent-event-log` skill.

Mixed-language session → match the most recent user message at the time the artifact landed.

## Self-discovery

- `brain_query --preference pref-foo` — full preference frontmatter + every evidence record in `Brain/log/*` referencing it.
- `brain_query --topic <slug>` — all artifacts (signals, current preference, retired ones) by topic.
- `brain_query --since <ISO>` — recent log events of any type.
- `brain_digest` — daily summary of what `dream` did: new unconfirmed, confirmations, retirements, confidence shifts, contradictions.

## CLI fallback

When MCP is unavailable:

```bash
o2b brain feedback \
  --topic no-internal-abbrev \
  --signal negative \
  --principle "Do not use internal abbreviations in user-facing copy unless explained first" \
  --agent claude

o2b brain apply-evidence \
  --pref pref-no-internal-abbrev \
  --artifact "[[Daily/2026.05.14#blog-post]]" \
  --result applied \
  --agent claude
```

## Rules

- One call per signal, one call per (preference, artifact) pair.
- Imperative voice in `principle`. Specific over generic.
- Never include secrets, tokens, API keys, or credentials in `principle`, `note`, or `source`.
- Do not edit historical signals, preferences, or log entries by hand — the `dream` pass is the only writer for transitions.
- Do not write into `Brain/.snapshots/` or `Brain/retired/` directly — those are managed by `dream` and `o2b brain reject` only.
- `o2b brain reject` requires `--reason <text>` from v0.10.1 onward. The reason is persisted on the retired file as `user_rejected_reason`. The next dream pass will mark any future signal on the same `(topic, scope)` as `signal-suppressed` and move it straight to `processed/` — do not re-record the same signal hoping it will re-grow into a preference. If you genuinely disagree with a past reject, raise it with the user; do not route around it via `brain_feedback`.

## Fallback capture surfaces

When no agent is in the loop at the moment the rule is formed, the
user can write an `@osb` marker directly into any vault markdown
file — a Daily note, a project plan, a self-chat scratchpad. The
operator runs `o2b brain scan-inline` later to capture every marker
into `Brain/inbox/`. Two shapes are recognised:

```
@osb feedback negative topic=mocking principle="don't mock DB in integration tests" scope=testing
```

````
```osb
kind: feedback
signal: negative
topic: mocking
principle: don't mock DB in integration tests
scope: testing
```
````

This is a fallback path, not the default. When you (the agent) hear
a preference live, call `brain_feedback` directly — the inline
marker exists for situations where MCP is unavailable. After scan,
the source line becomes `@osb✓ [[sig-...]]` so a second run is
idempotent.

For session JSONLs (Claude / Codex / Hermes exports) the equivalent
operator command is `o2b brain import-session <path>` — it replays
both `@osb` markers in message text and live `brain_feedback`
tool_use calls. Useful for back-filling sessions where the agent
didn't make the call.
