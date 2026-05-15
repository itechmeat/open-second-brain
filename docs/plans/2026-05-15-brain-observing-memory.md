# Brain — Observing Memory Layer

Status: design
Target: Open Second Brain v0.9.0
Authors: Sergey Eroshenkov (product), Claude (drafting)

## 1. Overview

Open Second Brain prior to Brain is a deterministic storage layer: a vault, an event log, a Pay Memory audit trail. Agents write durable artifacts; the system makes them inspectable. It does not *learn* anything.

This document specifies a new layer — **Brain** — that turns the vault from a storage system into an observing one. Brain accumulates taste signals, promotes them into rules under deterministic thresholds, links rules to real applications during work, and retires rules that decay or get rebutted. The agent gets better at the user's preferences without anyone re-training a model and without a human running an admin workflow.

Brain is filesystem-first, deterministic, Obsidian-native, and isolated from the existing `AI Wiki/` and `Daily/` areas. It contains no LLM logic. Semantic merging, if needed, is delegated to external agents calling the same deterministic CLI/MCP surface.

The design is anchored in two prior arts. The internal one is the *Improvement* note (Sergey's vault, `Projects/OpenSecondBrain/Plan/2. Improvement`), which proposed nine extensions to OSB. Those proposals are folded into three deeper architectural ideas (graph of typed links, accreted truth, behaviour-evidence loop) and realised as a single primitive loop. The external anchor is Anthropic's *Dreaming* feature, announced 2026-05-06 as research preview inside Claude Managed Agents: an asynchronous dreaming pass over an agent's memory store, producing a curated layer that humans can review before deployment. Brain is the open-source, runtime-agnostic, deterministic counterpart.

## 2. Scope of v0.9.0

In scope:

- A new top-level directory `Brain/` inside the vault.
- File formats for signals, preferences (in two trial states), retired entries, and a daily log.
- A deterministic dreaming pass exposed as `o2b brain dream`.
- CLI namespace `o2b brain *` (11 verbs).
- MCP tool namespace `brain_*` (6 tools).
- One new skill `brain-memory` that instructs agents when to record signals and apply evidence.
- A short Brain-aware digest, suitable for terminal output and Hermes cron delivery to Telegram.
- Deprecation of agent-facing write paths in the legacy OSB surface (`event_log_append`, `second_brain_capture`, `agent-event-log` skill). The code stays; only the agent-facing surfaces stop advertising it.

Out of scope, deferred to follow-up releases:

- OpenClaw-native JavaScript parity for Brain tools (v0.9.1).
- Pay Memory integration with Brain (Pay Memory remains an orthogonal layer).
- Hard removal of deprecated legacy OSB write code from the pre-Brain era (v0.10 or later, decided by usage evidence).
- LLM-driven semantic merging of similar topics (intentionally out of scope; external agents may perform it via the same CLI/MCP surface).
- Hook-enforced reminders for Brain operations (added only if observed misses justify it).
- Auto-detection of preference signals from free-form conversation by the runtime itself (the skill instructs agents, but no automatic NLP heuristic ships).

## 3. Architectural Principles

These are constraints the implementation must respect, not aspirational goals.

**Filesystem-first.** Every Brain artifact is a Markdown file with YAML frontmatter. State changes are filesystem operations (write, rename, move between directories). No embedded database, no required indexing service, no daemon. Backup equals `cp -r` or `tar`.

**Deterministic.** `dream` is a pure function of inputs (signals, preferences, log, configuration, current time). Identical inputs produce byte-identical outputs. No randomness, no LLM calls, no network. This is the property that lets the system be trusted as the source of truth.

**Passive human participation.** The human never runs an approval workflow. Preferences are promoted to confirmed status when they are applied at least once in real work; they are retired when they go un-applied or when contradictory signals reach the rebuttal threshold. Optional escape hatches exist (`--force-confirmed`, `o2b brain reject`) but are not part of the default loop.

**Obsidian-native.** Cross-references are Obsidian wikilinks (`[[basename]]`). Backlinks and graph view work out of the box. Tags follow Obsidian's nested format. No required plugins (Dataview, Templater, Canvas). What Obsidian gives for free is used; what it adds via plugins is not depended on.

**Isolation from legacy areas.** No Brain operation writes to `AI Wiki/` or `Daily/`. No legacy operation writes to `Brain/`. The two systems coexist; one is the future, the other is read-only legacy.

**Idempotency of state-changing batch operations.** Running `dream` twice in a row without new input or expired timestamps is a no-op, including in the log. This makes scheduling safe (cron every hour produces noise-free output).

## 4. Vault Layout

```text
<vault>/
├── AI Wiki/                     (legacy, read-only for agents)
├── Daily/                       (legacy event-log + human narrative)
└── Brain/                       (new in v0.9)
    ├── _brain.yaml              schema + configuration
    ├── _BRAIN.md                operating manual rendered for agents
    ├── inbox/
    │   ├── sig-2026-05-14-no-internal-abbrev.md
    │   └── processed/
    │       └── sig-2026-05-13-no-internal-abbrev.md
    ├── preferences/
    │   └── pref-no-internal-abbrev.md
    ├── retired/
    │   └── ret-prefer-bullets-over-prose.md
    ├── log/
    │   └── 2026-05-14.md
    └── .snapshots/
        └── dream-2026-05-14-104200.tar.zst
```

The directory a file lives in encodes its current lifecycle state. The frontmatter `status` field duplicates this for convenience. `o2b brain doctor` reports any mismatch.

`inbox/processed/` is a holding area for signals that have already contributed to a preference (or have been folded into an existing one). Files there remain valid wikilink targets — Obsidian resolves by basename regardless of folder.

## 5. File Formats

### 5.1 Common conventions

- Filename: `<prefix>-<slug>.md`, where prefix is `sig`, `pref`, or `ret`. The slug is chosen at creation and never edited.
- All Brain notes have frontmatter fields: `kind`, `id`, `created_at` (ISO-8601 UTC), `tags`.
- `id` equals the filename basename (without `.md`). It is duplicated in frontmatter so it survives manual `mv` operations.
- All cross-references are Obsidian wikilinks, `[[basename]]` or `[[basename|alias]]`. No relative paths.
- `tags` always include `brain` plus a kind-specific path: `brain/signal`, `brain/preference`, `brain/retired`, `brain/log`. Optional `brain/topic/<slug>` and `brain/scope/<scope>` tags improve Obsidian tag pane navigation.

### 5.2 Signal (`sig-...`)

A raw taste signal. Immutable after creation.

Location: `Brain/inbox/sig-<date>-<slug>.md` (or `Brain/inbox/processed/...` after dreaming).

```yaml
---
kind: brain-signal
id: sig-2026-05-14-no-internal-abbrev
created_at: 2026-05-14T10:15:00Z
tags: [brain, brain/signal, brain/topic/no-internal-abbrev, brain/scope/writing]
topic: no-internal-abbrev            # required, dedup anchor for dream
scope: writing                        # optional, soft category
signal: negative                      # required: positive | negative
agent: claude                         # required: source agent or human name
source:                               # optional list of wikilinks to context artifacts
  - "[[Daily/2026.05.14]]"
  - "[[blog-header-draft]]"
principle: Do not use internal abbreviations in user-facing copy unless explained first
---

## Raw

Sergey pointed out that "OSB" appeared as an abbreviation in the blog header
without prior explanation. Agreed it should be spelled out on first use.
```

Required: `kind`, `id`, `created_at`, `tags`, `topic`, `signal`, `agent`, `principle`. Optional: `scope`, `source`. Missing any required field is a write-time error.

`principle` is a one-line, agent-readable formulation of the rule that should emerge if this signal joins others. It is what later becomes the `principle` of a preference.

### 5.3 Preference (`pref-...`)

A rule. Two states: `unconfirmed` (just promoted from signals, not yet applied) and `confirmed` (applied at least once in real work).

Location: `Brain/preferences/pref-<slug>.md`.

```yaml
---
kind: brain-preference
id: pref-no-internal-abbrev
created_at: 2026-05-14T10:42:00Z
confirmed_at:                          # null until first applied evidence
unconfirmed_until: 2026-05-28T10:42:00Z   # window expires; pref retires if no applied evidence by this time
tags: [brain, brain/preference, brain/topic/no-internal-abbrev, brain/scope/writing]
topic: no-internal-abbrev
scope: writing
status: unconfirmed                    # unconfirmed | confirmed
principle: Do not use internal abbreviations in user-facing copy unless explained first
evidenced_by:                          # origin signals; fixed at creation
  - "[[sig-2026-05-13-no-internal-abbrev]]"
  - "[[sig-2026-05-14-no-internal-abbrev]]"
  - "[[sig-2026-05-14-spelled-out-osb]]"
applied_count: 0                       # computed from log/
violated_count: 0                      # computed from log/
last_evidence_at: 2026-05-14T10:42:00Z # computed from log/
confidence: low                        # computed: low | medium | high
pinned: false                          # if true, exempt from automatic retire
supersedes:                            # optional wikilink to retired pref
aliases: [no-internal-abbrev rule]
---

## Principle

Do not use internal abbreviations in user-facing copy unless explained first.

## How to apply

When writing public-facing copy (blog posts, README, marketing pages, public
documentation), expand acronyms on first use. Internal docs and code comments
are exempt.
```

`evidenced_by` is fixed at promotion time and does not grow. Ongoing applications are tracked in `Brain/log/` and aggregated into `applied_count` / `violated_count` during `dream`. Obsidian backlinks from log entries surface them in the preference's backlink pane.

If `pinned: true`, the preference is exempt from the three automatic retire reasons (`stale-no-evidence`, `expired-unconfirmed`, `rebutted`). Only an explicit `o2b brain reject` can retire it. Pinning does not affect evidence accumulation, confidence updates, or rebuttal counters — only the final retire decision. Pinning is set and cleared by CLI-only verbs (`o2b brain pin` / `o2b brain unpin`); autonomous agents cannot change the protected set through MCP.

### 5.4 Retired (`ret-...`)

A preference that left the active loop. Same `id` (renaming keeps the slug but flips the prefix). Lives in `Brain/retired/`.

```yaml
---
kind: brain-retired
id: ret-no-internal-abbrev
status: retired
retired_at: 2026-08-12T05:00:00Z
retired_reason: stale-no-evidence       # stale-no-evidence | expired-unconfirmed | rebutted | user-rejected
retired_by: "[[Brain/log/2026-08-12]]"   # the dream run that retired it
superseded_by:                          # optional wikilink to newer preference
# remaining fields inherited from preference (topic, principle, evidenced_by, etc.)
---
```

Retired entries are never deleted. They are the audit trail of what the system once believed.

### 5.5 Log entry

One file per UTC day. Append-only. Events written by every state-changing Brain operation.

Location: `Brain/log/<YYYY-MM-DD>.md`.

```yaml
---
kind: brain-log
date: 2026-05-14
tags: [brain, brain/log]
---

# Brain log — 2026-05-14

## 10:42:00Z — dream
- run_id: dream-2026-05-14-104200
- input_signals: 7
- new_unconfirmed: 1
  - [[pref-no-internal-abbrev]] (topic: no-internal-abbrev, signal_balance: -3)
- confirmed: 0
- retired: 0
- moved_to_processed: 5

## 14:22:00Z — apply-evidence
- preference: [[pref-no-internal-abbrev]]
- artifact: "[[Daily/2026.05.14#section-blog-post]]"
- agent: claude
- result: applied
- note: Expanded "OSB" to "Open Second Brain" on first use.

## 14:55:00Z — apply-evidence
- preference: [[pref-no-internal-abbrev]]
- artifact: "[[Daily/2026.05.14#section-readme-update]]"
- agent: codex
- result: violated
- note: README diff contained unexplained "FT" abbreviation.
```

Each entry is a level-2 heading with `<UTC time> — <event type>` and a bullet list of key/value lines. The event types are: `dream`, `feedback`, `apply-evidence`, `force-confirmed`, `reject`, `promote`, `retire`. Log files are themselves never edited; new events append.

## 6. State Machine

```text
inbox(sig)+ ─── dream, threshold reached ───▶ preferences/  status: unconfirmed
                                                              │
                                                              ├── first apply-evidence (applied) ──▶ status: confirmed
                                                              │
                                                              ├── rebuttal signals reach threshold ─▶ retired/  reason: rebutted
                                                              │
                                                              └── no evidence within trial window ──▶ retired/  reason: expired-unconfirmed

                preferences/ status: confirmed
                                  │
                                  ├── apply-evidence applied  >> violated, fresh evidence ──▶ confidence climbs
                                  │
                                  ├── stale_evidence_days passes ───────────────────────────▶ retired/  reason: stale-no-evidence
                                  │
                                  └── rebuttal signals reach threshold ──────────────────────▶ retired/  reason: rebutted

                preferences/ * ── o2b brain reject ─────────────────────────────────────────▶ retired/  reason: user-rejected
```

The transitions are driven entirely by `dream` plus `apply-evidence` log entries. No manual approval step exists in the default flow.

## 7. dream Algorithm

`dream` is the only mutating batch operation. It reads the current Brain state and decides which transitions to apply. It is deterministic given the inputs and the configured time.

### 7.1 Inputs

- `Brain/inbox/sig-*.md` (active)
- `Brain/inbox/processed/sig-*.md` (historical, contributes to signal counts where referenced)
- `Brain/preferences/pref-*.md`
- `Brain/retired/ret-*.md` (for supersede checks)
- `Brain/log/*.md` (for `applied`/`violated`/`last_evidence_at`)
- `Brain/_brain.yaml`
- Current time (parameter `--now`, defaults to system time)

### 7.2 Outputs

- New or updated files in `preferences/`
- Moves into `retired/`
- Moves from `inbox/` into `inbox/processed/`
- One appended event in `Brain/log/<today>.md` summarising the run, but only if any state actually changed

### 7.3 Pseudocode

```text
dream(now):
    cfg              = load(_brain.yaml)
    active_signals   = scan(inbox/, not processed/)
    processed        = scan(inbox/processed/)
    preferences      = scan(preferences/)
    retired          = scan(retired/)
    log_entries      = scan(log/)

    # 1. Group all signals by topic
    by_topic = group_by(active_signals + processed, key='topic')

    # 2. Per-topic processing
    for topic, sigs in by_topic:
        pref = find_preference(topic)

        if pref and pref.status in (unconfirmed, confirmed):
            handle_signals_on_active_pref(pref, sigs_active(topic), now, cfg)
            continue

        # No active preference for this topic — consider promotion
        if dominant_sign_count(sigs_active(topic), cfg.contradiction_window_days) >= cfg.candidate_threshold:
            create_unconfirmed_preference(topic, sigs, cfg, now)

    # 3. Refresh active preferences from log/
    for pref in scan(preferences/):
        applied, violated, last_evidence = count_evidence_from_log(pref.id, log_entries)
        pref.applied_count    = applied
        pref.violated_count   = violated
        pref.last_evidence_at = last_evidence
        pref.confidence       = compute_confidence(pref, cfg, now)
        # Status promotion: first applied evidence flips unconfirmed -> confirmed
        if pref.status == unconfirmed and applied >= 1:
            pref.status        = confirmed
            pref.confirmed_at  = first_applied_at(pref.id, log_entries)
        write_atomic(pref)

    # 4. Retire stale or expired
    for pref in scan(preferences/):
        if pref.status == unconfirmed and now > pref.unconfirmed_until:
            move_to_retired(pref, reason='expired-unconfirmed', now)
            continue
        if pref.status == confirmed and days_between(pref.last_evidence_at, now) > cfg.stale_evidence_days:
            move_to_retired(pref, reason='stale-no-evidence', now)

    # 5. Move consumed signals out of inbox
    for sig in active_signals:
        if is_referenced_by_pref_or_retired(sig):
            move(sig.path, inbox/processed/sig-...)

    # 6. Append a log entry only if anything changed
    if changes:
        append_log_entry(now, run_id, summary)
```

### 7.4 Rules

**Threshold by dominant sign.** `candidate_threshold` requires that many signals of the **same** sign for one topic. Mixed signals do not sum; they cancel within `contradiction_window_days`. Three negatives and one positive within the window equal signal balance -2, below the threshold.

**One preference per topic.** A topic with an existing active preference (unconfirmed or confirmed) never spawns a second one. New signals on the same topic with the same sign refresh evidence; opposite-sign signals start accumulating toward a rebuttal.

**Rebuttal threshold.** Signals contradicting an active preference are counted separately. When their count of the dominant opposite sign reaches `candidate_threshold`, the active preference moves to `retired/` with reason `rebutted`. A fresh `unconfirmed` preference for the new direction is created from the rebuttal signals.

**Unconfirmed-to-confirmed promotion.** The first `apply-evidence` entry with `result: applied` for an `unconfirmed` preference flips its status to `confirmed` and stamps `confirmed_at` with the timestamp of that log entry.

**Confidence formula.**

```text
applied   = count(log entries with kind=apply-evidence, result=applied, pref=X)
violated  = count(log entries with kind=apply-evidence, result=violated, pref=X)
fresh     = (now - pref.last_evidence_at) < cfg.stale_evidence_days * cfg.high_freshness_factor

if applied <= cfg.low_max_applied or (applied > 0 and violated >= applied):
    confidence = low
elif applied >= cfg.high_min_applied and violated == 0 and fresh:
    confidence = high
else:
    confidence = medium
```

**Retirement reasons** are mutually exclusive:
- `stale-no-evidence`: confirmed preference with `last_evidence_at` older than `stale_evidence_days`.
- `expired-unconfirmed`: unconfirmed preference whose `unconfirmed_until` passed without any `applied` evidence.
- `rebutted`: rebuttal signals reached threshold.
- `user-rejected`: explicit `o2b brain reject` command.

**No semantic merging.** Two topics with different slugs (`no-internal-abbrev` and `avoid-abbreviations`) are different counters. Merging is a human decision or an external agent's call, performed by manually editing frontmatter or by submitting new signals with the canonical topic and a `supersedes:` field on the resulting preference. The dream algorithm never guesses.

**Same-sign signals on an active preference.** When a signal arrives on a topic that already has an active preference (unconfirmed or confirmed) and the signal's sign matches the preference, the signal is noted by `dream` (moved to `processed/` with a log entry of type `noted-redundant`) but does not generate a new preference and does not increment `applied_count`. The latter is reserved for `apply-evidence` log entries from real work. Same-sign signals are user reiteration; their value is the reassurance that the topic is still relevant, not a counted application.

**Corrupted frontmatter.** A signal, preference, or retired file whose YAML cannot be parsed is skipped with a warning entry in the run log (`event: skip-corrupted-frontmatter`, `path: <relative path>`). The remaining files are processed normally. Corruption never aborts a run; `o2b brain doctor` is the right tool to surface and resolve it.

**Pre-run snapshot.** Before any state-changing operation in a `dream` run, the algorithm writes `Brain/.snapshots/<run_id>.tar.zst` containing the entire `Brain/` tree (excluding `.snapshots/` itself). Retention: the `snapshots.retention_count` newest files (default 10); older snapshots are pruned at the end of the run. Snapshots are local-only and small (typical compressed size well under 1 MB). They exist solely to enable `o2b brain rollback <run_id>`. If the snapshot itself fails to write, the run aborts before any other change — the safety net cannot be bypassed silently.

**Pin protection.** A preference with `pinned: true` in its frontmatter is exempt from the three automatic retire reasons (`stale-no-evidence`, `expired-unconfirmed`, `rebutted`). The only path to retire a pinned preference is explicit `o2b brain reject --id`, which prints a warning before proceeding. Pinning does not affect evidence accumulation, confidence computation, or rebuttal-counter accumulation — only the final retire decision is suppressed. Pinning and unpinning are CLI-only operations; the MCP surface intentionally does not expose them, so autonomous agents cannot alter the protected set.

**Atomicity per file, not per run.** Each write uses `fs-atomic` (write to temp file in the same directory, then rename). If `dream` crashes mid-run, the filesystem reflects the operations that completed; rerunning dream converges (idempotency guarantees no duplicates).

## 8. Digest Format

Read-only output, sourced from current state and recent log entries. Default window: last 24 hours.

Five sections, each appearing only when non-empty:

1. New (unconfirmed, in trial)
2. Confirmed during the window
3. Retired during the window
4. Confidence shifts during the window
5. Contradictions detected during the window

If all five are empty, the digest collapses to a single line: `Brain digest — <date>: no changes`. With `--silent-if-empty` it produces no output.

### 8.1 Markdown

```markdown
# Brain digest — 2026-05-14T20:00Z (24h)

## New (unconfirmed, in trial)

- [[pref-no-internal-abbrev]] — writing, 3 signals, trial ends 2026-05-28
- [[pref-imperative-prompts]] — coding, 4 signals, trial ends 2026-05-28

## Confirmed

- [[pref-prefer-typed-errors]] — coding, first applied in [[Daily/2026.05.14]]

## Retired

- [[ret-prefer-bullets-over-prose]] — writing, stale-no-evidence (91 days)
- [[ret-old-comment-style]] — coding, rebutted (3 negative signals)

## Confidence shifts

- [[pref-no-internal-abbrev]] medium → high (applied: 11, violated: 0)
```

### 8.2 JSON

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-14T20:00:00Z",
  "window": {
    "since": "2026-05-13T20:00:00Z",
    "until": "2026-05-14T20:00:00Z"
  },
  "summary": {
    "new_unconfirmed_count": 2,
    "confirmed_count": 1,
    "retired_count": 2,
    "confidence_shift_count": 1,
    "contradiction_count": 0,
    "empty": false
  },
  "new_unconfirmed": [
    {
      "id": "pref-no-internal-abbrev",
      "topic": "no-internal-abbrev",
      "scope": "writing",
      "signal_count": 3,
      "signal_balance": -3,
      "unconfirmed_until": "2026-05-28T10:42:00Z",
      "path": "Brain/preferences/pref-no-internal-abbrev.md"
    }
  ],
  "confirmed": [
    {
      "id": "pref-prefer-typed-errors",
      "confirmed_at": "2026-05-14T11:00:00Z",
      "first_applied_artifact": "[[Daily/2026.05.14]]"
    }
  ],
  "retired": [
    {
      "id": "ret-prefer-bullets-over-prose",
      "retired_at": "2026-05-14T05:00:00Z",
      "reason": "stale-no-evidence",
      "days_stale": 91
    }
  ],
  "confidence_shifts": [
    {
      "id": "pref-no-internal-abbrev",
      "from": "medium",
      "to": "high",
      "applied_count": 11,
      "violated_count": 0
    }
  ],
  "contradictions": []
}
```

Exit codes: `0` normal, `1` error, `2` empty and `--silent-if-empty` is set.

## 9. CLI and MCP API

### 9.1 Summary

| Command | Writes | MCP | Idempotent | Read-only |
|---|---|---|---|---|
| `o2b brain init` | Brain/ skeleton | no | yes | no |
| `o2b brain feedback` | inbox/sig-* | yes | no | no |
| `o2b brain dream` | preferences/, retired/, log/, inbox/processed/, .snapshots/ | yes | yes (no-op on rerun) | no |
| `o2b brain apply-evidence` | log/<day>.md (append) | yes | no | no |
| `o2b brain digest` | — | yes | yes | yes |
| `o2b brain query` | — | yes | yes | yes |
| `o2b brain reject` | retired/, log/ | no | no | no |
| `o2b brain pin` | preferences/<id>.md (frontmatter) | no | yes (no-op if already pinned) | no |
| `o2b brain unpin` | preferences/<id>.md (frontmatter) | no | yes (no-op if not pinned) | no |
| `o2b brain rollback` | Brain/ overwritten from snapshot | no | no | no |
| `o2b brain doctor` | — | yes | yes | yes |

`brain init`, `brain reject`, `brain pin`, `brain unpin`, and `brain rollback` are intentionally CLI-only. `init` is a one-time setup; `reject` is a destructive admin action; `pin`/`unpin` change the protected set; `rollback` overwrites the entire `Brain/` tree. Their absence from MCP protects against autonomous mistakes.

### 9.2 Argument and behaviour reference

`o2b brain init [--vault <path>] [--force]`
- Creates `Brain/` skeleton. Requires that machine-local config (`~/.config/open-second-brain/config.yaml`) exists; without it, exits with a message pointing to `o2b init`.
- Without `--force`, refuses if `_brain.yaml` already exists.
- Idempotent without `--force`: re-running is a no-op.

`o2b brain feedback --topic <slug> --signal positive|negative --principle "<text>" [--scope <slug>] [--source "<wikilink>"]+ [--agent <name>] [--raw <text>|--raw-file <path>] [--force-confirmed] [--vault <path>]`
- Creates one `sig-*` in `Brain/inbox/`. With `--force-confirmed`, creates a `pref-*` directly with `status: confirmed`.
- Collisions on slug are resolved by appending `-2`, `-3`, ….
- MCP form: `brain_feedback({topic, signal, principle, scope?, source?, agent?, raw?, force_confirmed?}) -> {path, id}`.

`o2b brain dream [--vault <path>] [--dry-run] [--now <ISO-8601>] [--json]`
- Runs the algorithm in section 7. `--dry-run` prints what would happen without writing.
- Idempotent. Returns `0` on success including no-op runs.
- MCP form: `brain_dream({dry_run?, now?}) -> {run_id, new_unconfirmed, confirmed, retired, contradictions, moved_to_processed}`.

`o2b brain apply-evidence --pref <pref-id> --artifact "<wikilink>" --result applied|violated [--agent <name>] [--note "<text>"] [--vault <path>]`
- Appends a single event to `Brain/log/<today>.md`. Does not modify the preference file directly; the next `dream` aggregates.
- If `<pref-id>` does not exist (typo, already retired), exits `2` with an informative message. This is not an error condition.
- MCP form: `brain_apply_evidence({pref_id, artifact, result, agent?, note?}) -> {logged_at, log_path}`.

`o2b brain digest [--vault <path>] [--since <ISO>] [--until <ISO>] [--json] [--silent-if-empty]`
- See section 8.
- MCP form: `brain_digest({since?, until?, format?}) -> {content}`.

`o2b brain query [--vault <path>] [--preference <id>|--topic <slug>|--since <ISO>] [--json]`
- Read helper. Aggregates a preference with its evidence trail, or all artifacts under a topic, or all log events after a timestamp.
- For interactive inspection prefer Obsidian backlinks; this command exists for cron, scripts, and headless agents.
- MCP form: `brain_query({preference?, topic?, since?, format?}) -> {content}`.

`o2b brain reject --id <pref-id> [--reason "<text>"] [--vault <path>]`
- Moves a preference to `Brain/retired/` with reason `user-rejected`. CLI-only. If the preference is `pinned: true`, prints an extra warning and requires `--yes` to proceed.

`o2b brain pin --id <pref-id> [--vault <path>]`
- Sets `pinned: true` in the preference frontmatter; the preference becomes exempt from automatic retire. Idempotent (no-op if already pinned). Logs a `pin` event in `Brain/log/<today>.md`. CLI-only.

`o2b brain unpin --id <pref-id> [--vault <path>]`
- Clears `pinned: true`; the preference becomes subject to automatic retire again. Idempotent. Logs an `unpin` event. CLI-only.

`o2b brain rollback <run_id> [--vault <path>] [--yes]`
- Restores `Brain/` from `Brain/.snapshots/<run_id>.tar.zst`. `<run_id>` appears in `Brain/log/<date>.md` `dream` headers; `o2b brain rollback --list` enumerates available snapshots with their timestamps. Without `--yes` the command prints a diff summary (counts of preferences / retired / signals that will change) and prompts interactively. After restoration, appends a `rollback` event to `Brain/log/<today>.md`. CLI-only; destructive.

`o2b brain doctor [--vault <path>] [--json] [--strict]`
- Checks invariants: status-vs-folder consistency, wikilink resolution, frontmatter validity, ISO parsing, duplicate ids, log header parsing.
- Without `--strict`, warnings exit `0`; with `--strict`, warnings exit `2`. Errors always exit `1`.
- MCP form: `brain_doctor({strict?, format?}) -> {content}`.

### 9.3 General rules for all commands

- No command writes outside `Brain/`. The `path-safety` module enforces this.
- All writers use `fs-atomic` (temp + rename in the same directory).
- All commands resolve vault path from machine-local config when `--vault` is omitted.
- State-changing commands log a single event to `Brain/log/<today>.md` of the corresponding type.
- Environment variable `AGENT_NAME` is honoured by `--agent` defaults; no other env-bound secrets are read.

## 10. Configuration: `Brain/_brain.yaml`

```yaml
schema_version: 1

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  low_max_applied: 2
  high_min_applied: 10
  high_freshness_factor: 0.8

snapshots:
  retention_count: 10                  # keep this many newest .snapshots/*.tar.zst
```

All values may be edited by hand. `o2b brain doctor` validates ranges and types. Schema version is checked at every read; an unknown version exits `1`.

## 11. Deprecation Policy

OSB prior to Brain ships several agent-facing write paths that overlap conceptually with Brain. The policy is **soft deprecation**: code stays, but agents no longer learn about the legacy paths through the plugin surface.

### 11.1 What becomes invisible to agents

| Surface | Before | After v0.9.0 |
|---|---|---|
| `skills/agent-event-log/SKILL.md` | the agent's main durable-artifact logging skill | moved to `docs/legacy-skills/` and excluded from the loaded skill set |
| `skills/open-second-brain/SKILL.md` | describes writing to `AI Wiki/` and `Daily/` | rewritten to point at Brain; legacy areas mentioned only as read-only |
| MCP tool `event_log_append` | advertised | removed from the exported tools list in `src/mcp/tools.ts`; handler retained |
| MCP tool `second_brain_capture` | advertised | removed from advertised list; handler retained |
| MCP tool `second_brain_query` | advertised | retained (read-only; agents read legacy data through it) |
| Hook `PostToolUse` reminder | "call event_log_append after a durable artifact" | rewritten: signals → `brain_feedback`, applicable preferences → `brain_apply_evidence` |
| Hook `Stop` guardrail | blocked once on missing `event_log_append` | removed in v0.9; no Brain-specific guardrail added in v0.9 |
| Vault file `AI Wiki/_OPEN_SECOND_BRAIN.md` | describes agent-owned AI Wiki rules | overwritten by `o2b brain init` to a Brain-first manual; legacy area listed as read-only |

### 11.2 What remains visible

- Pay Memory: all 11 CLI commands and 8 MCP tools unchanged. Pay Memory is an audit layer for paid actions, orthogonal to the learning loop. A future task can wire payment receipts into Brain (e.g., as a signal scope `paid-action`), but that is out of v0.9 scope.
- Read-only legacy surfaces: `second_brain_query`, `o2b status`, `o2b doctor`, `o2b export-config`, `o2b index`.
- CLI commands for legacy writes (`o2b append-event`, `vault-log`, AI Wiki bootstrap inside `o2b init`) remain callable by a human in a shell; they are not advertised to agents.

### 11.3 Code retention

- `src/core/event-log.ts` writers stay.
- `src/core/init.ts` AI Wiki bootstrap stays.
- `src/mcp/handlers/event_log_append.ts` and `second_brain_capture.ts` stay; only the entries in the exported tools array are removed.
- Old skill files are moved into `docs/legacy-skills/` so the runtime skill scanner does not load them. The Markdown remains accessible as documentation.

Hard removal is deferred to v0.10 or later, gated on observed usage of Brain (no calls to legacy `event_log_append` / `second_brain_capture` MCP tools recorded after v0.9 has accumulated a sustained activity volume in `Brain/log/`).

## 12. Migration and Release

### 12.1 Migration

For an existing vault, the migration is a single command:

```bash
o2b brain init --vault /path/to/vault
```

This creates `Brain/` and overwrites `AI Wiki/_OPEN_SECOND_BRAIN.md` with the Brain-first manual. With approximately zero current users beyond the project owner, no backup of the previous `_OPEN_SECOND_BRAIN.md` is kept; the design source-of-truth for the new file is this document and the implementation's template.

No data migration is performed. Existing `AI Wiki/` notes and `Daily/` entries remain on disk; agents read them via `second_brain_query`.

### 12.2 Plugin manifests

All four runtime manifests (Hermes `plugin.yaml`, Claude `.claude-plugin/plugin.json`, Codex `.codex-plugin/plugin.json`, OpenClaw `openclaw.plugin.json`) receive:

- Version bump to `0.5.0` (synced via `bun run sync-version`).
- Advertised tool list updated: remove `event_log_append` and `second_brain_capture`, add the six Brain MCP tools (Hermes, Claude, Codex; OpenClaw's native JS implementation is deferred to v0.9.1 and its `contracts.tools[]` keeps the legacy set until then).
- New advertised CLI commands `o2b brain init|feedback|dream|apply-evidence|digest|query|reject|doctor` in the manifests that enumerate commands.

### 12.3 CHANGELOG

A single entry under existing version headers, following the project's "no Unreleased section" convention:

```markdown
## 0.9.0 — YYYY-MM-DD

### Added
- Brain: observing memory layer at `Brain/` with deterministic dream.
- CLI namespace `o2b brain *` (11 verbs).
- MCP tool namespace `brain_*` (6 tools).
- Pre-run snapshot of `Brain/` to `.snapshots/<run_id>.tar.zst` before each `dream`; `o2b brain rollback <run_id>` restores. Retention configurable in `_brain.yaml`.
- Pin protection: preferences marked `pinned: true` skip automatic retire (stale, expired, rebutted). CLI verbs `o2b brain pin` / `o2b brain unpin`.
- Skill `brain-memory` instructing agents when to record signals and apply evidence.
- Digest output (Markdown + JSON) for terminal and Hermes cron delivery.

### Changed
- `_OPEN_SECOND_BRAIN.md` rewritten by `o2b brain init` to point agents at Brain.
- `PostToolUse` and `Stop` hooks reminders re-targeted to Brain.
- `Stop` guardrail removed in v0.9; no Brain-specific guardrail added.

### Deprecated (agent-facing only, code retained)
- MCP tool `event_log_append` — agents are guided to `brain_feedback` and `brain_apply_evidence`. CLI `o2b append-event` and `vault-log` remain callable for humans.
- MCP tool `second_brain_capture` — agents write to `Brain/` only.
- Skill `agent-event-log` moved to `docs/legacy-skills/`.

### Notes
- Pay Memory unchanged; remains agent-visible.
- `AI Wiki/` remains on disk; agents read via `second_brain_query`, do not write.
- OpenClaw native parity for Brain deferred to v0.9.1.
```

### 12.4 GitHub release

Title: `v0.9.0 — Observing memory layer (Brain)`. Body: the CHANGELOG entry above, with the conceptual framing from section 1 condensed.

## 13. Testing Strategy

Tests target invariants of the loop and the fact of deprecation, not coverage percentages.

### 13.1 Unit

- Frontmatter parsing for every kind; required fields raise specific errors.
- Slug collision: a second `brain feedback` with the same slug receives `-2`.
- Confidence formula at boundary cases: `low_max_applied`, `high_min_applied`, `violated >= applied`, freshness boundary.
- Wikilink serialisation and resolution.
- Atomic write failure modes: temp written but rename interrupted leaves vault consistent.
- `_BRAIN.md.tpl` template is under 200 lines (compliance ceiling for agent-facing operating manuals).
- Snapshot rotation: after `snapshots.retention_count + N` dream runs, only `retention_count` newest snapshot files remain in `.snapshots/`.

### 13.2 Integration scenarios

- Happy path: 3 signals → `dream` → unconfirmed preference → `apply-evidence applied` → `dream` → confirmed preference with `applied_count: 1`.
- Rebuttal: confirmed preference + 3 opposite-sign signals → retired with `reason: rebutted`.
- Expired-unconfirmed: unconfirmed preference + `--now` past `unconfirmed_until` → retired with `reason: expired-unconfirmed`.
- Stale-no-evidence: confirmed preference + `last_evidence_at` past `stale_evidence_days` → retired with `reason: stale-no-evidence`.
- Contradiction window: 2 negative + 1 positive within `contradiction_window_days` → no unconfirmed preference created.
- `--force-confirmed`: bypasses inbox; preference created with `status: confirmed`.
- `brain reject`: preference moved to retired with `reason: user-rejected`.
- Pin protection: confirmed preference with `pinned: true`, clock past `stale_evidence_days` — `dream` does NOT retire; preference stays in `preferences/`. Same assertion for `expired-unconfirmed` and `rebutted` paths.
- Rollback: take vault snapshot A; run `brain feedback` + `brain dream` producing state B; `o2b brain rollback <run_id> --yes` restores byte-identical state A in `Brain/` (excluding `.snapshots/` retention bookkeeping).

### 13.3 Determinism

- Idempotency: two consecutive `dream` runs without new input or expired timestamps produce no log entry on the second run.
- Replay byte-determinism: with `--now` fixed, two runs on a fresh copy of the same fixture produce byte-identical output.

### 13.4 Schema and configuration

- `_brain.yaml` missing `schema_version` → exit `1`.
- Threshold out of bounds (negative or non-integer) → exit `1`.
- Corrupted YAML in one signal file → skipped with a warning; other signals processed.

### 13.5 Doctor

- Status-vs-folder mismatch reported.
- Broken wikilink in `evidenced_by` reported.
- Duplicate `id` across files → error.
- Invalid ISO in `unconfirmed_until` → error.

### 13.6 Digest

- Empty window with default mode → one-line output.
- Empty window with `--silent-if-empty` → exit `2`, no output.
- Each section renders correctly when its data is present.
- JSON output validates against a checked-in schema.

### 13.7 CLI

- Each `o2b brain *` command: happy path; missing required argument exits `1` naming the field; missing vault config exits `1` with a hint pointing to `o2b init`.

### 13.8 MCP

- Each `brain_*` tool returns the documented structure; descriptors are valid JSON Schema.

### 13.9 Deprecation

- `src/mcp/tools.ts` exported list does not contain `event_log_append` or `second_brain_capture`.
- Plugin manifests (`plugin.yaml`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) do not advertise the deprecated tools.
- `hooks/hooks.json` PostToolUse prompt does not contain the string `event_log_append`; contains `brain_feedback` or `brain_apply_evidence`.
- `hooks/hooks.json` Stop hook has no blocking logic on `event_log_append`.
- `skills/` does not contain `agent-event-log/`; the file lives in `docs/legacy-skills/`.
- `skills/open-second-brain/SKILL.md` body does not include legacy write instructions for `AI Wiki/notes/`, `event_log_append`, or `vault-log`.

### 13.10 Migration

- `o2b brain init` on an empty vault creates the skeleton; rerun is a no-op.
- `o2b brain init --force` overwrites `_brain.yaml`.
- `o2b brain init` without prior `o2b init` exits `1` with a hint.

### 13.11 End-to-end lifecycle

A single timed scenario, fixture-based, asserting the full loop:

```text
day 1:  o2b init && o2b brain init
day 1:  brain feedback ×3 (negative, topic X)
day 1:  brain dream          → 1 unconfirmed preference
day 2:  brain apply-evidence applied
day 2:  brain dream          → confirmed, applied_count=1
day 3:  brain apply-evidence applied ×9
day 3:  brain dream          → confidence: high
day 30: brain dream          → still in preferences/
day 95: brain dream          → retired with reason stale-no-evidence
```

This is the golden snapshot. Any dream regression fails it.

### 13.12 Fixtures

`tests/fixtures/brain/` contains static vault snapshots: `empty/`, `populated-loop/`, `contradicted/`, `stale-pref/`, `corrupted-frontmatter/`. Tests copy to tmp before running.

### 13.13 Out of v0.9 test scope

- Performance and load (expected file count under 1000).
- LLM-driven semantic merging (not implemented).
- OpenClaw native JS path (shipped in v0.9.1 with its own tests).
- Hook enforcement for Brain (no enforcement in v0.9; only reminder text is tested).
- Cross-runtime integration (Hermes scanner, Claude marketplace) — exercised manually post-release.

## 14. File Structure

**New files:**

- `src/core/brain/index.ts` — re-exports of the public Brain API.
- `src/core/brain/types.ts` — shared interfaces for signal, preference, retired, log event, config; status and retire-reason enums.
- `src/core/brain/paths.ts` — `brainDirs(vault)`, `signalPath`, `preferencePath`, `retiredPath`, `logPath`, slug-allocator with collision suffixes.
- `src/core/brain/policy.ts` — `loadBrainConfig`, `validateBrainConfig`, `DEFAULT_BRAIN_CONFIG`, threshold and confidence constants.
- `src/core/brain/signal.ts` — `parseSignal`, `writeSignal`, signal frontmatter contract.
- `src/core/brain/preference.ts` — `parsePreference`, `writePreference`, `moveToRetired`.
- `src/core/brain/log.ts` — `parseLogDay`, `appendLogEvent`, event-type enums.
- `src/core/brain/dream.ts` — the deterministic algorithm in section 7.
- `src/core/brain/apply-evidence.ts` — appends one `apply-evidence` log entry.
- `src/core/brain/digest.ts` — Markdown and JSON renderers.
- `src/core/brain/query.ts` — `queryByPreference`, `queryByTopic`, `queryByLogSince`.
- `src/core/brain/doctor.ts` — invariant checks.
- `src/core/brain/init.ts` — `bootstrapBrain(vault, opts)`.
- `src/core/brain/snapshot.ts` — `createSnapshot(vault, run_id)`, `listSnapshots(vault)`, `pruneSnapshots(vault, retention_count)`, `restoreSnapshot(vault, run_id)`. Pre-run safety net for `dream`.
- `src/core/brain/pin.ts` — `setPinned(vault, pref_id, value)`, `isPinned(pref)`.
- `src/core/brain/templates/_BRAIN.md.tpl` — operating manual rendered into the vault (must stay under 200 lines).
- `src/core/brain/templates/_OPEN_SECOND_BRAIN.md.tpl` — Brain-first replacement for the legacy file.
- `src/cli/brain.ts` — `o2b brain *` subcommand dispatcher.
- `src/mcp/brain-tools.ts` — six `ToolDefinition` entries: `brain_feedback`, `brain_dream`, `brain_apply_evidence`, `brain_digest`, `brain_query`, `brain_doctor`.
- `skills/brain-memory/SKILL.md` — agent instruction for when to call `brain_feedback` and `brain_apply_evidence`.
- `tests/core/brain.types.test.ts`, `brain.policy.test.ts`, `brain.paths.test.ts`, `brain.signal.test.ts`, `brain.preference.test.ts`, `brain.log.test.ts`, `brain.dream.test.ts`, `brain.apply-evidence.test.ts`, `brain.digest.test.ts`, `brain.query.test.ts`, `brain.doctor.test.ts`, `brain.init.test.ts`, `brain.snapshot.test.ts`, `brain.pin.test.ts`.
- `tests/cli/brain.test.ts` — exercises every `o2b brain *` verb via `main(argv)`.
- `tests/mcp/brain.test.ts` — exercises all six tools via `MCPServer.callTool`; asserts deprecated tools absent from advertised list.
- `tests/e2e/brain-lifecycle.test.ts` — 95-day timed scenario from section 13.11.
- `tests/fixtures/brain/empty/`, `populated-loop/`, `contradicted/`, `stale-pref/`, `corrupted-frontmatter/` — static vault snapshots.

**Modified files:**

- `src/cli/main.ts` — register `brain` subcommand and extend `HELP`.
- `src/mcp/tools.ts` — register six Brain tools in `buildToolTable()`; remove `event_log_append` and `second_brain_capture` entries from the exported list (handlers retained on disk but not advertised).
- `src/mcp/instructions.ts` — replace the paragraph that points agents at `event_log_append`/`second_brain_capture` with one describing Brain tools.
- `hooks/hooks.json` — rewrite `PostToolUse` reminder text; remove `Stop` guardrail block gating on missing `event_log_append`.
- `skills/open-second-brain/SKILL.md` — body rewritten to point agents at Brain as the writable layer; legacy `AI Wiki/` mentioned only as read-only.
- `package.json`, `plugin.yaml`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `openclaw.plugin.json` — version bump to `0.5.0`; advertised tools/commands updated. OpenClaw `contracts.tools[]` retains legacy Brain-absent set until v0.9.1.
- `README.md` — new `## Brain (observing memory)` section with CLI usage and a link to this plan.
- `docs/architecture.md` — new "Brain layer" subsection; update the layer diagram.
- `docs/hermes-cron.md` — ready-to-paste `hermes cron create` recipe for daily digest delivery.
- `CHANGELOG.md` — `## 0.9.0 — YYYY-MM-DD` entry per section 12.3.

**Moved files:**

- `skills/agent-event-log/` → `docs/legacy-skills/agent-event-log/` (entire directory move).

---

## 15. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

### Task 1: Core types, paths, config

**Files:**
- Create: `src/core/brain/index.ts`, `types.ts`, `paths.ts`, `policy.ts`.
- Create: `tests/core/brain.types.test.ts`, `brain.paths.test.ts`, `brain.policy.test.ts`.

Types in `types.ts` include the `pinned: boolean` field on `BrainPreference` (default `false` when parsing notes that lack it). `paths.ts` introduces `snapshotsDir(vault)` and `snapshotPath(vault, run_id)`. `policy.ts` validates the new `snapshots.retention_count` config field (positive integer, default 10).

- [ ] **Step 1: define interfaces in `types.ts` — `BrainSignal`, `BrainPreference`, `BrainRetired`, `BrainLogEvent`, `BrainConfig`; status and retire-reason enums.**
- [ ] **Step 2: implement `paths.ts` with all path helpers and slug-collision allocator; pin behavior with tests.**
- [ ] **Step 3: implement `policy.ts` — `DEFAULT_BRAIN_CONFIG`, YAML loader and validator. Tests cover happy path, missing `schema_version`, out-of-bounds thresholds, `high_freshness_factor` range.**
- [ ] **Step 4: `index.ts` re-exports the public surface.**
- [ ] **Step 5: run `bun test tests/core/brain.{types,paths,policy}.test.ts`.**

### Task 2: Frontmatter parsers and writers

**Files:**
- Create: `src/core/brain/signal.ts`, `preference.ts`, `log.ts`.
- Create: `tests/core/brain.signal.test.ts`, `brain.preference.test.ts`, `brain.log.test.ts`.

- [ ] **Step 6: implement `signal.ts` — `parseSignal`, `writeSignal`. Tests cover required-field validation, roundtrip byte-equality, wikilink preservation, slug collision suffixes.**
- [ ] **Step 7: implement `preference.ts` — `parsePreference`, `writePreference`, `moveToRetired`. Tests cover both `unconfirmed` and `confirmed` states; status-vs-folder invariant on read.**
- [ ] **Step 8: implement `log.ts` — `parseLogDay`, `appendLogEvent` (atomic). Tests cover append-only invariant, multi-event days, malformed-entry tolerance, ISO time parsing.**

### Task 3: dream algorithm and apply-evidence

**Files:**
- Create: `src/core/brain/dream.ts`, `apply-evidence.ts`, `snapshot.ts`, `pin.ts`.
- Create: `tests/core/brain.dream.test.ts`, `brain.apply-evidence.test.ts`, `brain.snapshot.test.ts`, `brain.pin.test.ts`.

- [ ] **Step 9: implement `apply-evidence.ts` — appends one event to `Brain/log/<today>.md`; returns logged_at and log_path; exits informatively when preference absent. Tests cover happy path, missing pref, log file creation on first event of day.**
- [ ] **Step 9a: implement `snapshot.ts` — `createSnapshot`, `listSnapshots`, `pruneSnapshots`, `restoreSnapshot`. Uses `tar` + `zstd` available on the host (or the project's existing archive helper). Tests cover create→restore byte-equality, rotation per `retention_count`, refusal to include `.snapshots/` itself, and snapshot-write-failure → dream aborts cleanly.**
- [ ] **Step 9b: implement `pin.ts` — `setPinned(vault, pref_id, true|false)` rewrites only the `pinned` frontmatter field via `fs-atomic`; `isPinned(pref)` reads the field with default `false`. Tests cover idempotent set, no body modification, log-event emission.**
- [ ] **Step 10: implement `dream.ts` step group A — group signals by topic, create unconfirmed prefs on dominant-sign threshold. Tests cover threshold edge cases and contradiction window collapse.**
- [ ] **Step 11: extend with step group B — refresh `applied_count`/`violated_count` from log, promote unconfirmed→confirmed on first `applied` evidence, compute `confidence`. Tests cover the full confidence formula by boundary cases.**
- [ ] **Step 12: extend with step group C — retire `expired-unconfirmed`, `stale-no-evidence`, and `rebutted` paths, each gated by `isPinned(pref)` (pinned preferences are exempt from all three automatic reasons). Tests cover all four retirement reasons (incl. `user-rejected` exercised via `reject` CLI in Task 6) and the pin-skip path for each automatic reason.**
- [ ] **Step 12a: integrate `createSnapshot` as the first state-changing step inside `dream` (after computing the planned changes, before writing any file). Snapshot failure aborts the run with exit 1 and no state changes. After successful run, `pruneSnapshots` enforces retention. Tests assert snapshot presence before any mutation and snapshot absence on a no-op run.**
- [ ] **Step 13: implement signal-move to `processed/` and `noted-redundant` log events for same-sign signals on active prefs; `skip-corrupted-frontmatter` warning entries. Tests cover same-sign-on-active-pref and corrupted YAML tolerance.**
- [ ] **Step 14: determinism test — fixture with frozen `--now` produces byte-identical filesystem output across two runs.**

### Task 4: Read helpers (digest, query, doctor)

**Files:**
- Create: `src/core/brain/digest.ts`, `query.ts`, `doctor.ts`.
- Create: `tests/core/brain.digest.test.ts`, `brain.query.test.ts`, `brain.doctor.test.ts`.

- [ ] **Step 15: implement `digest.ts` — Markdown and JSON renderers per section 8. Tests cover per-section rendering, empty-window collapse, JSON-schema validation of the structured form.**
- [ ] **Step 16: implement `query.ts` — `queryByPreference`, `queryByTopic`, `queryByLogSince`. Tests cover evidence-trail aggregation and topic spans.**
- [ ] **Step 17: implement `doctor.ts` — every invariant from section 13.5 as a discrete check. Tests cover each invariant in isolation plus a full run on the `populated-loop` fixture.**

### Task 5: Init and templates

**Files:**
- Create: `src/core/brain/init.ts`, `templates/_BRAIN.md.tpl`, `templates/_OPEN_SECOND_BRAIN.md.tpl`.
- Create: `tests/core/brain.init.test.ts`.

- [ ] **Step 18: write `_BRAIN.md.tpl` — operating manual covering folder roles, signal/preference lifecycle, escape hatches; reviewed for clarity since this is what agents read every session. Hard constraint: under 200 lines (empirical compliance ceiling for agent-facing manuals). A test asserts the line count.**
- [ ] **Step 19: write `_OPEN_SECOND_BRAIN.md.tpl` — Brain-first replacement; legacy `AI Wiki/` noted as read-only.**
- [ ] **Step 20: implement `bootstrapBrain(vault, opts)` — creates `Brain/{inbox/,inbox/processed/,preferences/,retired/,log/}`, writes `_brain.yaml` from default constant, renders both templates. Idempotent without `--force`; `--force` re-renders templates and resets `_brain.yaml`. Overwrites `AI Wiki/_OPEN_SECOND_BRAIN.md` to Brain-first version.**
- [ ] **Step 21: tests cover empty-vault bootstrap, idempotent rerun, `--force` overwrite, prior-config-missing error case (`o2b init` not run yet).**

### Task 6: CLI dispatcher

**Files:**
- Modify: `src/cli/main.ts`.
- Create: `src/cli/brain.ts`, `tests/cli/brain.test.ts`.

- [ ] **Step 22: scaffold `src/cli/brain.ts` — subcommand parser, shared `--vault` and `--json` flags, dispatch by verb.**
- [ ] **Step 23: implement handlers for `init`, `feedback`, `dream`, `apply-evidence`, `digest`, `query`, `reject`, `doctor`. Each handler returns the exit codes documented in section 9.**
- [ ] **Step 23a: implement `pin` and `unpin` handlers — wrap `setPinned`; idempotent; append `pin`/`unpin` event to `log/<today>.md`. CLI-only, not exposed in MCP.**
- [ ] **Step 23b: implement `rollback` handler — wraps `listSnapshots` (for `--list`) and `restoreSnapshot`. Default interactive: print diff summary of preferences/retired/signal counts and prompt y/N; `--yes` skips prompt. Append `rollback` event to `log/<today>.md` after successful restore. `reject` handler also gains a guard: if target preference has `pinned: true`, require `--yes` and print a warning naming the pin.**
- [ ] **Step 24: wire `brain` into `main.ts` dispatcher; extend `HELP` text.**
- [ ] **Step 25: CLI tests — happy path for each verb (incl. `pin`, `unpin`, `rollback`), missing required argument exits `1` naming the field, missing vault config exits `1` with a hint, full exit-code matrix. Rollback test exercises `--list` and `--yes` paths and asserts the pinned-protection warning in `reject`.**

### Task 7: MCP tools and deprecation cleanup

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/instructions.ts`.
- Create: `src/mcp/brain-tools.ts`, `tests/mcp/brain.test.ts`.
- Modify: `hooks/hooks.json`.
- Move: `skills/agent-event-log/` → `docs/legacy-skills/agent-event-log/`.
- Modify: `skills/open-second-brain/SKILL.md`.
- Create: `skills/brain-memory/SKILL.md`.

- [ ] **Step 26: implement six `ToolDefinition` entries in `brain-tools.ts` mirroring the CLI inputs per section 9.**
- [ ] **Step 27: register Brain tools in `buildToolTable()`; remove `event_log_append` and `second_brain_capture` entries from the exported list. Handlers remain on disk.**
- [ ] **Step 28: rewrite `instructions.ts` — drop the legacy paragraph; add a paragraph describing Brain tools and the record-then-apply loop.**
- [ ] **Step 29: MCP tests — e2e exercise of six Brain tools; assertion that `event_log_append` and `second_brain_capture` are not in the advertised list.**
- [ ] **Step 30: rewrite `PostToolUse` hook reminder text per section 11.1; remove `Stop` guardrail block. Hook tests assert the new text and the removed block.**
- [ ] **Step 31: move `skills/agent-event-log/` directory to `docs/legacy-skills/agent-event-log/`. Rewrite `skills/open-second-brain/SKILL.md` body. Create `skills/brain-memory/SKILL.md` instructing agents per the loop in section 6.**

### Task 8: Manifests, docs, release, and PR

**Files:**
- Modify: `package.json`, `plugin.yaml`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `openclaw.plugin.json`, `README.md`, `docs/architecture.md`, `docs/hermes-cron.md`, `CHANGELOG.md`.

- [ ] **Step 32: README — add `## Brain (observing memory)` section with CLI usage block and the principle from section 1; cross-link to this plan.**
- [ ] **Step 33: `docs/architecture.md` — add Brain layer subsection and update the layer diagram.**
- [ ] **Step 34: `docs/hermes-cron.md` — append the `hermes cron create` recipe for daily digest delivery.**
- [ ] **Step 35: `CHANGELOG.md` — add `## 0.5.0 - 2026-MM-DD` per section 12.3 (no `Unreleased` section).**
- [ ] **Step 36: version bump to `0.5.0`; `bun run sync-version` propagates to all manifests. OpenClaw `contracts.tools[]` keeps the legacy set until v0.9.1.**
- [ ] **Step 37: run `bun run typecheck && bun test` end-to-end. All tests including `brain-lifecycle` e2e must be green.**
- [ ] **Step 38: branch `feature/v0.9.0-brain`; commit; push; open PR `feat: brain observing memory layer (v0.9.0)`.**

---

## 16. Post-v0.9 Roadmap

Future work for Brain is tracked in a dedicated, trigger-based document:

- **File:** `docs/plans/2026-05-15-brain-roadmap.md`
- **ID scheme:** `BRAIN-FUT-NNN` (immutable across the lifetime of an item).
- **Indexing:** items are grouped by category (Engine, Capture, Surface, Integration, Lifecycle).
- **Prioritisation rule:** each item has an explicit **trigger condition** based on observed data in the running Brain (`Brain/log/`, `preferences/`, …) or on dependencies between items. No calendar-based scheduling.
- **Lifecycle:** items move out of the roadmap into their own design doc (`docs/plans/<topic>.md`) when work begins. Removed items keep their ID retired (not reused).

Permanently out of scope (recorded here for posterity; not in the roadmap): on-chain anchoring of Brain hashes (Solana memo, web3 RPC). Brain's audit trail is the vault itself; this aligns with the OSB-wide policy noted in the Pay Memory plan.

## 17. References

- *Improvement* note in Sergey's vault: `Projects/OpenSecondBrain/Plan/2. Improvement`. Source of the nine extension proposals folded into this design.
- Forbes, *Claude's New Dreaming Feature Builds Self-Improving AI Agents*, Jon Markman, 2026-05-11. Conceptual anchor: asynchronous dreaming pass over an agent's memory store, with a separate staging layer reviewable by humans before deployment.
- Existing OSB design documents: `docs/idea.md`, `docs/architecture.md`, `docs/roadmap.md`. Brain extends but does not replace these.
- Existing OSB plan documents: `docs/plans/2026-05-06-cli-foundation.md`, `docs/plans/2026-05-10-pay-memory.md`. This document follows the same plans-folder convention.
