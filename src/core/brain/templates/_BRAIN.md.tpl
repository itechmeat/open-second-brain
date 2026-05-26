---
kind: brain-manual
vault_name: {{vault_name}}
schema_version: {{schema_version}}
---

# Brain — operating manual

Brain is the observing-memory layer of Open Second Brain. It records what
the user likes and dislikes by watching what they accept and reject, then
distils that into rules the next agent session can read and apply.

Read this file at the start of every session that may write to the vault.
Cross-reference: `Projects/OpenSecondBrain/Plan` if the vault carries the
design notes.

## Layout

```
Brain/
  _brain.yaml          # configuration; hand-editable
  _BRAIN.md            # this file
  inbox/               # raw signals captured during work
    processed/        # signals already folded into a preference
  preferences/         # active rules (unconfirmed or confirmed)
  retired/             # superseded / expired / rebutted / rejected rules
  log/                 # daily ledger of every state change
  .snapshots/          # pre-`dream` archives for rollback
```

The directory a note sits in encodes its lifecycle state. The frontmatter
`status` field duplicates it for convenience. `o2b brain doctor` reports
mismatches.

## Lifecycle of one preference

```
inbox/sig-*           dream              unconfirmed
  (taste signal) ───► (cluster) ───► preferences/pref-*
                                          │
            apply-evidence (applied) ─────┤
                                          ▼
                                       confirmed
                                          │
       no evidence within window  ───────►│
       rebuttal signals reach threshold  ─┤
       stale_evidence_days passed  ──────►│
       o2b brain reject  ────────────────►▼
                                       retired/ret-*
```

Promotion happens automatically when N positive same-topic signals
accumulate (`_brain.yaml: dream.candidate_threshold`, default 3). First
real-work application flips a preference from `unconfirmed` to
`confirmed`. No human approval step exists in the default loop.

## When to call `brain_feedback`

After a taste signal — the user accepted or rejected a stylistic choice,
a structural decision, a tone, a naming convention.

- Sign: `positive` (user liked it) or `negative` (user pushed back).
- `topic` is the dedup anchor: same `topic` accumulates toward promotion.
  Pick a stable, hyphenated slug (`no-internal-abbrev`, not `abbreviations`).
- `principle` is one short imperative sentence — what rule should emerge.
- Skip pure preferences with no action attached, idle banter, and
  repeated agreement on a topic that already has an active preference
  (the next `dream` run notes the redundancy automatically).

## When to call `brain_apply_evidence`

After producing a durable artifact whose form was governed by an active
preference. Two outcomes:

- `applied` — the artifact followed the rule.
- `violated` — the artifact contradicted it (rare, but record it; the
  log keeps both columns).

The `preference` argument is the wikilink target (`pref-no-internal-abbrev`),
the `artifact` argument is the wikilink to the produced note / file /
PR / message. Confirmation, confidence, and retire eligibility are
recomputed by the next `dream` run from log evidence — there is no
separate "promote" call.

Apply-evidence is only meaningful for `confirmed` preferences and for
`unconfirmed` ones that the artifact actually exercised. Stay quiet
otherwise — noise drowns the signal.

## `dream` — the batch pass

`dream` is the one mutating operation. It is deterministic given inputs
and `--now`. It:

- groups signals by topic, promotes those that cross the threshold;
- recomputes `applied_count` / `violated_count` / `last_evidence_at`
  from `log/`;
- flips first-applied unconfirmed prefs to confirmed;
- retires expired, stale, rebutted, or user-rejected prefs;
- moves consumed signals into `inbox/processed/`;
- archives Brain into `.snapshots/<run_id>.tar.zst` before mutating;
- appends one summary entry to `log/<today>.md` if anything changed.

Rerunning `dream` without new inputs is a no-op (including in the log).
Schedule it on a cron with confidence — duplicate runs do not pollute.

## What NOT to do

- Do not hand-edit files under `log/` — they are append-only ledgers.
  `dream`, `apply-evidence`, `feedback`, and the CLI escape hatches are
  the only writers.
- Do not rename preference or signal files. The `id` field is duplicated
  in frontmatter to survive `mv`, but slugs are stable for a reason;
  changing them breaks every wikilink and every log reference.
- Do not write into `.snapshots/`. `dream` produces archives there;
  `o2b brain rollback` consumes them; nothing else touches the directory.
- Do not edit files in `retired/` to undo a retirement. The reason is
  preserved on purpose; a rule that should return becomes a new
  preference with `supersedes: [[ret-...]]`.
- Brain operations stay scoped to `Brain/`. Pay Memory writes under
  `Brain/payments/` (receipts, policies, assets, drafts, reports) -
  the same root, different subtree. User-authored notes (daily
  journals, etc.) are read-only inputs whose folders are listed in
  `_brain.yaml:notes.read_paths`; the agent never writes there.
- Do not invent topics. Reuse an existing topic slug if the rule space
  is the same; `dream` collapses near-duplicates only by exact match.

## Escape hatches

These are CLI-only, intended for rare manual intervention. Do not call
them as part of normal agent work.

- `o2b brain reject <pref-id>` — explicit user-driven retirement. Moves
  the preference to `retired/` with reason `user-rejected`. A pinned
  preference requires `--yes` and prints a warning.
- `o2b brain rollback <run_id>` — restore Brain from a snapshot.
  Interactive by default; `--list` enumerates available snapshots.
  From v0.10.6 a snapshot ships with a sha256 sidecar manifest so
  rollback aborts when the live tree drifted from the snapshot moment;
  pass `--force-rollback` to override.
- `o2b brain pin <pref-id>` / `unpin <pref-id>` — protect a preference
  from automatic retirement (still subject to explicit reject).
- `o2b brain upgrade` — migrate the release-owned files (`_brain.yaml`,
  `_BRAIN.md`) forward when a new
  open-second-brain version ships. `--dry-run` (default) prints a
  per-file plan; `--apply` rewrites the files after taking a snapshot
  named `upgrade-<ts>`.
- `o2b brain export --format json|llms-txt` — read-only dump of active
  preferences (`confirmed | unconfirmed | quarantine`) for backup,
  prompt injection, or sharing.

The full CLI surface is documented in `docs/plans/2026-05-15-brain-observing-memory.md`
section 9; the MCP tool surface mirrors it for the most common verbs
(`brain_feedback`, `brain_apply_evidence`, `brain_dream`, `brain_digest`,
`brain_query`, `brain_doctor`).

## Reading order for a new agent

1. This file (`Brain/_BRAIN.md`).
2. `Brain/_brain.yaml` for threshold values currently in effect.
3. `Brain/preferences/` for active rules; `confirmed` first, then
   `unconfirmed` (in trial).
4. `Brain/retired/` only when checking why a rule no longer applies.

Brain is filesystem-first. A `cp -r Brain/` is a complete backup; a
`git diff` shows the exact state delta. Trust the files.
