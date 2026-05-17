# v0.10.4 — Brain onboarding quality

Status: draft
Owners: TBD
Source: `/root/vault/Projects/OpenSecondBrain/Features/_summary.md` §4 (partial), §15 (partial), §18

## Context

The Open Second Brain features summary identifies an "onboarding quality" cluster of work that lowers the cost of bringing a new vault, a new runtime, or a new contributor online. This design covers three items from that cluster — the protect-Brain mechanic (§18) and the first halves of the per-target identity reminder family (§4) and the starter-bundle (§15). The second halves of §4 (full multi-runtime installer with config autodetect and steering shims) and §15 (interactive `o2b init` wizard) are intentionally **deferred** — see *Goals / non-goals* below for why.

The three items ship in **one PR**, under a single `v0.10.4` CHANGELOG entry. They share the same surface (runtime adapters), the same documentation pages (`install.md` branches), and the same review concerns (idempotency, no-LLM, no-network). Splitting them into three PRs would triple `install.md` churn for no engineering gain.

## Goals

- **G1.** Machine-enforced write protection for `Brain/preferences/`, `Brain/retired/`, `Brain/log/`, `Brain/.snapshots/` against Claude Code and Codex agents, via each runtime's native permission mechanism. `Brain/inbox/` stays writable (agents legitimately drop signals there through `brain_feedback`).
- **G2.** Per-runtime identity reminder templates for the two runtimes that actually call `buildReminder` per-turn / per-action: **Hermes** (Python shim, per `pre_llm_call` hook) and **OpenClaw** (native JS plugin, per `before_prompt_build` hook). The current common template stays as a fallback — back-compat is unconditional. Claude Code and Codex are explicitly **out of scope here** — their per-tool-call steering lives in `hooks/lib/messages.ts:postWriteReminder`, which is a different mechanism (post-write hook reminder, not per-turn identity injection). Adding per-target text for those two requires touching `hooks/lib/messages.ts` and is tracked under deferred work.
- **G3.** A bundled starter pack — 8 confirmed preferences (mixed confidence, scope, pinned), 3 retired (mixed retire reasons), 1 inbox signal, 6 log days — that `o2b brain init --starter` drops into a fresh vault. The pack doubles as a "this is how a healthy Brain looks" reference for both humans and onboarding agents.

## Non-goals (explicitly deferred)

- **D1 — full `o2b install` orchestrator.** The single-command, autodetect-the-config, idempotent-managed-block, parsed-back-out-by-uninstall, supports-all-known-runtimes installer that §4 envisions is *not* part of this design. Trigger to revisit: ≥3 onboarding complaints from non-primary users, OR a request for a runtime not in {hermes, claudecode, codex, openclaw}.
- **D2 — multi-tool steering shims.** Per-target shim files in `~/.cursor/skills/`, `~/.kiro/`, `~/.aider/`, etc., that point at the canonical `brain-memory` skill (§4, [[memoria]]). Deferred behind D1 — the shim infrastructure is a sub-feature of the installer.
- **D3 — interactive `o2b init --interactive` wizard.** The wizard logically wraps the installer (it has to register runtime configs to be useful); building it before D1 produces a survey with no follow-through. Trigger to revisit: after D1 ships.
- **D4 — "good vs bad" SKILL section.** The contrastive 3–5 pairs of well-/poorly-formed `principle` / `topic` / `note` examples (§15, [[megamemory]] §3). The starter-bundle files themselves are reference material; we add the SKILL section if onboarding feedback shows the starter pack alone is insufficient.
- **D5 — per-runtime hook reminder text for Claude Code and Codex.** Both runtimes deliver their post-Write steering through `hooks/lib/messages.ts:postWriteReminder` (single universal string today), not through `buildReminder`. Adding per-runtime cadence text there is a separate mechanism with separate test coverage. Trigger to revisit: observable difference in how Claude Code vs Codex sessions miss `brain_feedback` calls, OR a request to differentiate the post-write nudge per runtime.

The deferred items are also recorded in the vault summary under a new "Deferred work" section so they survive across planning sessions.

## §18 — `o2b brain protect` / `o2b brain unprotect`

### Surface

```
o2b brain protect   --target {claudecode|codex} [--vault <path>] [--apply | --print]
o2b brain unprotect --target {claudecode|codex} [--vault <path>]
```

- `--print` (default) writes the rendered snippet to stdout and exits 0. No filesystem writes.
- `--apply` idempotently patches the target's config file. Re-running is a no-op if the managed block is already current; if the OSB-managed block is present but stale, it is replaced in place. User-authored content outside the block is preserved byte-for-byte.
- `unprotect` removes the managed block (`--print` shows what would be removed; `--apply` removes it). If the block is absent, exits 0 with a one-line "not present" notice.
- `--vault <path>` overrides the configured vault (the machine config is the default source).

### Targets and their native mechanisms

| Target | Config file | Mechanism |
|---|---|---|
| `claudecode` | `<vault>/.claude/settings.json` (project scope) | `permissions.deny: ["Write(<vault>/Brain/preferences/**)", "Edit(<vault>/Brain/preferences/**)", … ]` |
| `codex` | `~/.codex/config.toml` (user scope) | `[permissions.osb_protected.filesystem]` block with `":project_roots" = { "Brain/preferences/**" = "none", … }` plus `default_permissions = "osb_protected"` |

Project-scope `.claude/settings.json` is chosen over user-scope `~/.claude/settings.json` because the vault is unique per host; a user-scope deny would forbid writes globally and break work in other projects. Project scope applies only when Claude Code runs from inside the vault.

Codex does not support a project-scope `.codex/config.toml` matching the Claude Code shape, so `osb_protected` lives at user scope. The glob patterns are vault-relative; if the user has multiple vaults, each vault adds its own entries to the same profile (the patterns simply accumulate — Codex evaluates them all).

### Managed-block markers

The patch is fenced so `unprotect` can remove exactly what `protect` added, and re-runs of `--apply` are byte-identical (idempotency).

- **TOML (Codex):** standard `# >>> open-second-brain managed >>>` and `# <<< open-second-brain managed <<<` line comments enclosing the OSB block. Outside-block content is untouched on re-run; inside-block content is regenerated each `--apply`.
- **JSON (Claude Code):** `settings.json` rejects line comments, so the line-comment fence used for TOML does not transfer. Instead, a sidecar manifest `<vault>/.open-second-brain/protect.lock.json` lists the `permissions.deny` / `permissions.allow` entries OSB owns. `unprotect` consults the manifest to know which entries to remove; the manifest is rebuilt on every `--apply`. The user can read the manifest to see what we changed.

### Rule set (both targets)

The same six logical rules, rendered into each target's syntax:

1. Deny `Write` / `Edit` under `<vault>/Brain/preferences/**`.
2. Deny `Write` / `Edit` under `<vault>/Brain/retired/**`.
3. Deny `Write` / `Edit` under `<vault>/Brain/log/**`.
4. Deny `Write` / `Edit` under `<vault>/Brain/.snapshots/**`.
5. Deny `Write` / `Edit` on `<vault>/Brain/_brain.yaml`.
6. Allow `Write` under `<vault>/Brain/inbox/**` (explicit allow to override any broader deny the user may have).

For Codex, the same six rules are expressed as `"<path-glob>" = "none"` (for denies) and `"Brain/inbox/**" = "write"`. The leading `":project_roots"` block tells Codex the patterns are vault-relative.

### Pre-apply safety

- `--apply` refuses to overwrite a target config that has an OSB-managed block from a *newer* schema than the current binary knows about. The block carries a `schema_version` line; mismatch on `--apply` exits with an error suggesting `o2b update` or `--print` (so the user can compare).
- `--apply` writes a sibling backup `<file>.bak.<unix-ts>` before mutating. Backups are not pruned automatically — the user owns config history.
- The vault must be initialised (`<vault>/Brain/` must exist). `protect` against an unbootstrapped vault exits with an error pointing at `o2b brain init`.

### Tests

- Unit: rule renderer produces stable byte output for both targets, given a fixed vault path.
- Unit: marker parser correctly extracts an existing managed block (both TOML line-comment and JSON-via-manifest), preserves outside-block content on re-render.
- Integration: round-trip `protect --apply` → `unprotect --apply` → `protect --apply` leaves the config bytewise equal to the first `--apply` result.
- Integration: `--print` and `--apply` produce the same logical content (`--apply` then `diff` against `--print` stripped of file headers).
- E2E (skipped on CI, manual): on a real Claude Code project, `protect --apply` followed by an attempt to `Edit Brain/preferences/pref-X.md` from inside Claude Code is blocked by the runtime's permission check.

### Files touched

- New: `src/core/brain/protect.ts` (rule renderer + apply/unprotect for both targets + manifest read/write).
- New: `src/cli/brain-protect.ts` (CLI surface; argparse glue).
- Modify: `src/cli/brain.ts` (wire the two new subcommands).
- New: `tests/core/brain/protect.test.ts`, `tests/cli/brain-protect.test.ts`.
- Modify: `install.md` (add a "Step 5b — optional `o2b brain protect`" note to branches A, C, D, E — i.e. all branches whose runtime is one of the two supported targets, plus generic).

## §4 (partial) — per-runtime identity reminder templates

### Scope correction

The first draft of this section listed four targets (`hermes`, `claudecode`, `codex`, `openclaw`). Cross-checking call sites of `buildReminder` shows it is exercised on a per-turn / per-action basis by only two runtimes:

- **OpenClaw** — native JS plugin, calls `buildReminder` from `src/openclaw/index.ts` inside the `before_prompt_build` hook.
- **Hermes** — Python shim (`plugins/hermes/__init__.py`) reads `templates/identity-reminder.txt` directly inside the `pre_llm_call` hook.

For **Claude Code** and **Codex**, the per-tool-call steering text is owned by `hooks/lib/messages.ts:postWriteReminder` and ships as a single universal string. Adding per-runtime cadence text for those two means editing `messages.ts`, which is a different mechanism (post-write reminder) with different tests. Shipping `identity-reminder.claudecode.txt` and `identity-reminder.codex.txt` files that no runtime currently reads would be a misleading fallback — an inspector would find their target's filename in `templates/` and assume the runtime uses it. Excluded here, tracked in D5.

### File layout

```
templates/
  identity-reminder.txt              # common fallback (existing, unchanged)
  identity-reminder.hermes.txt       # NEW — short multi-turn
  identity-reminder.openclaw.txt     # NEW — in-process plugin
```

Each file is plain text with a single `{agent}` placeholder, matching the current contract. No new template syntax — the renderer remains `replace(/\{agent\}/g, …)`.

### Resolver

`src/core/identity-reminder.ts` gains:

```ts
export const KNOWN_RUNTIME_TARGETS = ["hermes", "openclaw"] as const;
export type RuntimeTarget = (typeof KNOWN_RUNTIME_TARGETS)[number];

export function buildReminder(agent: string, target?: RuntimeTarget): string;
```

Resolution order:

1. Explicit `target` parameter → `identity-reminder.<target>.txt` if present, else common fallback.
2. `target` omitted → `process.env.O2B_TARGET` (if it is one of the known values) → same lookup.
3. Neither → common `identity-reminder.txt` (current behaviour, preserves call sites that have not been updated).

Unknown / malformed env value: logged once to stderr, treated as `undefined`. We do not silently coerce — an unknown target points at either a typo or a missing template, both of which a future contributor should see.

### Template content (drafts)

Both templates target ~5–7 lines, share the leading clause from the common template, and add a runtime-specific cadence note.

- **hermes.txt:** "Identity: @{agent}. After every durable artifact this turn — call `event_log_append`. Hermes turns are short; do not batch the log calls across turns."
- **openclaw.txt:** "Identity: @{agent}. After every durable in-process action — call `event_log_append`. OpenClaw has no session boundary; log immediately."

Each adds the same "Skip pure discussion, exploration, read-only queries, and planning that hasn't yet produced an artifact." closing line from the common template, so the *what counts as durable* contract is identical across targets.

Finalised text lands in the PR; the drafts above are the design-time skeleton.

### Wiring

- `src/openclaw/index.ts` — passes `target: "openclaw"` to `buildReminder`. No env dependency.
- `plugins/hermes/__init__.py` — Python shim mirrors the TS resolver: reads `templates/identity-reminder.hermes.txt` when the file exists, otherwise falls back to `identity-reminder.txt`. The Python and TS resolvers must produce identical text given the same inputs; a fixture test pinned across both languages enforces this.

The MCP server (`src/mcp/instructions.ts`) does **not** route through `buildReminder` — its `initialize.instructions` payload is independent prose describing the Brain tool surface. No changes there.

### Tests

- Unit (TS): both `RuntimeTarget` values resolve to the correct file; explicit param beats env; unknown env value warns + falls back; missing per-target file falls back without warning (file-not-present is a valid state for a partially-deployed template set).
- Unit (Python): hermes-only matrix on the shim.
- Fixture parity: `tests/fixtures/identity-reminder/{hermes,openclaw}.txt` records the expected output for `agent="test-agent"`; the TS test asserts both and the Python test asserts hermes against the same fixture bytes.

### Files touched

- New: `templates/identity-reminder.{hermes,openclaw}.txt`.
- Modify: `src/core/identity-reminder.ts` (resolver + `RuntimeTarget` type).
- Modify: `src/openclaw/index.ts` (call site).
- Modify: `plugins/hermes/__init__.py` (Python parity).
- New: `tests/fixtures/identity-reminder/{hermes,openclaw}.txt`.
- Modify: `tests/core/identity-reminder.test.ts`, `tests/python/test_hermes_plugin.py`.

`install.md` is **not** touched by §4 — the new templates plug into Hermes and OpenClaw automatically (Hermes shim auto-detects via the constant target, OpenClaw call site is hard-coded).

## §15 (partial) — starter bundle

### Bundle layout (in repo)

```
templates/
  brain-starter/
    preferences/
      pref-imperative-commit-messages.md     # confirmed, high, scope=process
      pref-no-unexplained-abbreviations.md   # confirmed, high, scope=writing, pinned
      pref-prefer-typed-errors.md            # confirmed, medium, scope=coding
      pref-explicit-imports-only.md          # confirmed, medium, scope=coding
      pref-changelog-every-release.md        # confirmed, high, scope=process
      pref-russian-in-chat.md                # confirmed, low, scope=writing
      pref-test-before-refactor.md           # unconfirmed (trial window open), scope=coding
      pref-prefer-bun-over-npx.md            # confirmed, low, scope=infra
    retired/
      ret-tabs-over-spaces.md                # user_rejected_reason: "mixed allowed"
      ret-no-emojis-in-code.md               # rebutted: 5 contradictory signals
      ret-prefer-curl-over-wget.md           # stale-no-evidence (60 days)
    inbox/
      sig-2026-05-10-strict-types.md         # one pending signal
    log/
      2026-05-15.md                          # day with apply-evidence events
      2026-05-16.md                          # day with one retire event
```

Each file is hand-authored Markdown with the exact frontmatter schema the dream pass writes (v0.10.x). Files reference each other through stable wikilinks (signals → preferences, retired → preferences via `supersedes:`, log entries → preferences); the doctor lint pass on the assembled bundle must be clean.

Frontmatter dates are baked at template-author time — they do not move forward, because the bundle is a *demonstration*, not a *live state*. The unconfirmed preference is dated so its `unconfirmed_until` is in the past relative to typical install time; the user will see `unconfirmed_until: 2026-05-25` and understand the trial window concept by inspection.

### CLI

```
o2b brain init [--starter] [--starter-path <dir>]
```

- Without `--starter` — existing behaviour (directories, `_brain.yaml`, `_BRAIN.md`, legacy overview).
- With `--starter` — after the existing init steps run successfully, copy `templates/brain-starter/**` into `<vault>/Brain/`.
- `--starter-path <dir>` — override the source directory. Defers user-authored starter packs without committing to a starter registry / marketplace. Useful for teams who want a house style starter.

### Collision policy

`--starter` refuses to copy if any of `Brain/preferences/`, `Brain/retired/`, `Brain/inbox/`, `Brain/log/` is non-empty. The check runs before any file is written; if it fails, exit code is 2 (vs 1 for a generic init failure), and the message is:

```
Brain/ already has content — `--starter` is intended for fresh vaults.
Inspect the bundle at <repo>/templates/brain-starter/ and copy individual
files manually if you want to backfill a non-empty Brain.
```

The check is symmetric across all four subdirs: a non-empty `log/` is as much a "this Brain is in use" signal as a non-empty `preferences/`, and we refuse on either.

### Tests

- Unit: starter copy on an empty Brain produces exactly the manifest listed above.
- Unit: starter on a Brain with one preference file exits with code 2 and the message above; no files are written.
- Smoke: `o2b brain doctor` on the assembled starter passes with no warnings. This is also a CI gate — the starter must never contain a malformed link or out-of-range value (treating the starter as a frozen test fixture).
- Smoke: `o2b brain dream --now 2026-05-17T12:00:00Z` on the starter is a no-op (the one unconfirmed preference's trial window has not expired at the pinned `--now`, and no apply-evidence is recent enough to refresh counters past their starter values).

### Files touched

- New: `templates/brain-starter/**` (the 14 bundled Markdown files).
- Modify: `src/core/brain/init.ts` — add `starter: boolean` and `starterPath?: string` options; new helper `copyStarterBundle`.
- Modify: `src/cli/brain.ts` — surface the two flags.
- New: `tests/core/brain/starter.test.ts`.
- Modify: `install.md` — `o2b brain init` step description in all five branches gets a one-line "or `o2b brain init --starter` if you want example preferences to learn the shape" addition.

## Test plan summary

Cross-feature checks beyond the per-feature tests above:

- **Doctor cleanliness.** A fresh vault with `o2b brain init --starter` followed by `o2b brain protect --target claudecode --apply` followed by `o2b brain protect --target codex --apply` passes `o2b brain doctor` and `o2b doctor --repo` (the latter validates that the new templates and the new starter files are well-formed).
- **Idempotency loops.**
  - `protect --apply` × 3 → final state byte-identical to first.
  - `init --starter` on already-populated Brain → no writes, exit 2.
  - `unprotect --apply` immediately after `protect --apply` → config bytes identical to pre-protect.
- **No-network invariant.** All three features run with no network calls (verified by running tests with `NODE_OPTIONS=--no-network`-style guard, or — failing that — by a code-level assertion that none of the new modules import `node:net`, `node:https`, `node:http`, `fetch`, or `node-fetch`).
- **Cross-language parity (identity reminders only).** TS and Python resolvers produce the same bytes for every (agent, target) pair represented in `tests/fixtures/identity-reminder/`.

## Open questions

1. **Backup file lifecycle for `protect --apply`.** The current proposal writes `<file>.bak.<unix-ts>` and never prunes. Should `protect` accept `--no-backup` for users who pipe these into source control and don't want clutter? Default-on / opt-out is the safer call; flagging here for explicit decision at impl time.
2. **Codex managed-block uniqueness.** `~/.codex/config.toml` is user-scope. If a user runs `protect --target codex` against vault A and later against vault B, the second run extends the same `[permissions.osb_protected.filesystem]` block with vault-B-relative globs. Question: do we keep one block per host (current proposal), or one block per vault (would require dynamic profile names like `osb_protected_<vault-hash>`)? Recommended answer: one block per host, names of vaults stored as comments in the managed fence. Surface this for review.
3. **Starter pack i18n.** The bundled preferences mix English and a Russian-language pref (`pref-russian-in-chat`). Question: do we want a `--starter-lang ru` switch that swaps the english-language sample principles for Russian phrasings? Recommended: not in v0.10.4 — the user's *real* preferences will land in the language of their actual sessions; starter mixes both intentionally to demonstrate the language-policy from the `brain-memory` skill.

## CHANGELOG entry (draft)

```markdown
## v0.10.4 — Brain onboarding quality

- §18 — `o2b brain protect --target {claudecode|codex}` writes a managed,
  idempotent block into the runtime's native permissions config that
  denies writes to `Brain/preferences/`, `retired/`, `log/`,
  `.snapshots/`, and `_brain.yaml` while leaving `Brain/inbox/`
  writable. Pair `o2b brain unprotect` removes the block. `--print`
  outputs the snippet without touching disk; `--apply` writes and
  backs up the prior config.
- §4 (partial) — per-runtime identity reminder templates for the two
  runtimes that call `buildReminder` per-turn / per-action:
  `templates/identity-reminder.{hermes,openclaw}.txt`. Resolver in
  `buildReminder` accepts an explicit `target`, falls back to
  `O2B_TARGET`, and finally to the common template. Hermes Python
  shim has parity. Common `identity-reminder.txt` is unchanged.
  Claude Code and Codex steer through `hooks/lib/messages.ts`, which
  is a separate mechanism not addressed here.
- §15 (partial) — `o2b brain init --starter` drops a curated bundle of
  8 confirmed preferences, 3 retired, 1 inbox signal, and 6 log days
  into a fresh Brain. The bundle passes `o2b brain doctor` cleanly and
  is a no-op under `o2b brain dream` at install time. Refuses to run
  on a non-empty Brain.
- Deferred: full multi-runtime `o2b install` orchestrator (§4 second
  half), interactive `o2b init --interactive` wizard (§15 second
  half), `brain-memory` SKILL "good-vs-bad" examples section. See
  vault `Projects/OpenSecondBrain/Features/_summary.md` Deferred work
  section for triggers to revisit.
```

## References

- Vault summary: `Projects/OpenSecondBrain/Features/_summary.md` (§4, §15, §18).
- Claude Code permissions: `permissions.deny` / `permissions.allow` in `settings.json`.
- Codex permissions: `[permissions.<name>.filesystem]` and `default_permissions` keys, documented at <https://developers.openai.com/codex/config-advanced>.
- Prior Brain plans for structural reference:
  `docs/plans/2026-05-17-tier-a-snapshot-confidence-pointer-design.md`,
  `docs/plans/2026-05-16-brain-search-design.md`.
- Current identity-reminder source of truth: `templates/identity-reminder.txt`, `src/core/identity-reminder.ts`, `plugins/hermes/__init__.py`.
- Current init source of truth: `src/core/brain/init.ts`,
  `src/core/brain/templates/_BRAIN.md.tpl`.
