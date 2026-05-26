# Brain-centric vault layout - one root, configurable user notes, no legacy siblings

**Status:** draft
**Author:** @claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The vault currently has three top-level agent-relevant directories (`Brain/`, `AI Wiki/`, `Daily/`) inherited from successive design iterations. Only `Brain/` carries its weight; the other two are vestigial:

- **`AI Wiki/`** is empty scaffolding for most installations: `index.md`, `hot.md`, `log.md`, `identity/user.md`, `identity/agents.md`, `_OPEN_SECOND_BRAIN.md`, `_open-second-brain.yaml`. None of these are read or written by any current agent surface; they are leftovers from a v0.1-v0.5 "vault as curated knowledge base" idea that Brain replaced. The only live consumer is Pay Memory (which writes under `AI Wiki/payments/`, `AI Wiki/policies/`, ...) - and that placement is a historical accident, not a design choice.
- **`Daily/`** is hardcoded into `src/core/event-log.ts` (writes `Daily/<date>.md`), into the OPEN_SECOND_BRAIN operating manual template ("chronological event log and human narrative"), and is referenced in five other files as a special case to exclude. The name `Daily/` is a user choice - everyone names their daily-notes folder differently or skips it entirely. Hardcoding the name into the agent's write paths violates that.

Concrete pain:

1. The README and `docs/how-it-works.md` have to apologise for three top-level directories where two of them do nothing.
2. The agent's write contract is unclear: which legacy paths can it touch? The current answer ("Brain/ only - but `event_log_append` still writes `Daily/<date>.md`") is contradictory.
3. Pay Memory sits under `AI Wiki/` for no reason other than "that was the only sibling directory at the time". Operators looking for receipts under `Brain/` find nothing.

## Scope

One named subsystem migration, one breaking release (v0.11.0):

- **Pay Memory relocation** from `AI Wiki/{payments,policies,assets,drafts,reports,_pending}/` to `Brain/payments/{policies,assets,drafts,reports,_pending}/` plus the dated receipt subdirs (`YYYY-MM-DD/`).
- **AI Wiki/ removal**: `o2b init` no longer scaffolds it; existing templates (`_OPEN_SECOND_BRAIN.md`, `_open-second-brain.yaml`, `index.md`, `hot.md`, `log.md`, `identity/*`) retire. The operating manual content folds into `Brain/_BRAIN.md` (already present).
- **Daily/ de-hardcoding**: the legacy `event_log_append` write path (`appendEvent` in `event-log.ts` that creates `Daily/<date>.md`) is removed entirely. The CLI verb `o2b append-event` retires (its replacement `o2b brain note` already ships and writes to `Brain/log/<today>.md`). User-side daily notes - whatever the operator names them - become configurable read-only inputs.
- **`notes.read_paths` config**: new optional block in `_brain.yaml`:
  ```yaml
  notes:
    read_paths:
      - "Daily"          # operator chooses any path or names
      - "Journal"
      # omit the block entirely if you do not keep daily notes
  ```
  `o2b brain scan-inline` and `o2b brain import-session` honour the list; default is empty (no scanning). Agents never write to these paths - the type is `read_paths` for a reason.
- **Doctor / manifest cleanup**: remove every special-case mention of `AI Wiki/` and `Daily/`. Brain owns `Brain/`; nothing else is special. `doctor`'s vault-scope walker uses `vault.ignore_paths` (existing config) as the only exclusion mechanism.
- **Migration**: `o2b brain upgrade` (already exists for similar tasks) gains a migration step that detects an existing `AI Wiki/payments/` tree and moves it under `Brain/payments/`. The legacy AI Wiki/ root is left in place if the operator put their own notes there - only Open-Second-Brain-managed files are removed.

## Out of scope

- Replacing `o2b brain note` (already the right tool; nothing to change).
- Changing the Brain/ subdirectory layout itself (`inbox/`, `preferences/`, `retired/`, `log/`, `.snapshots/` stay byte-identical).
- Replacing `Brain/_BRAIN.md` (already the operating manual; no rename).
- Building a generic vault folder taxonomy or a multi-folder MOC system; the user can do whatever they like outside Brain/.
- Removing `second_brain_query` (read-only vault page lister) - it serves a real purpose and is not coupled to AI Wiki/.

## Chosen approach

A single layered refactor across one PR. The atom layer is `src/core/pay-memory/paths.ts` plus the new `BrainNotesConfig` type. The hub is `src/core/init.ts` (vault bootstrap) and `_brain.yaml` schema. The helpers are `scan-inline`, `import-session`, `doctor`, `manifest`. The migration is one new pass in `src/core/brain/upgrade.ts`.

No new abstractions: the existing `BrainConfig` already carries optional sub-blocks (`temporal:`, `link_graph:`, `discipline_report:`); `notes:` is one more. Pay Memory's `paths.ts` swaps a string constant. Migration is a deterministic file-mover plus a sidecar manifest entry so re-running is a no-op.

## Design decisions

- **Pay Memory under `Brain/payments/`, not its own root.** Brain is the agent-writable area; Pay Memory writes (receipts, asset notes, reports). Putting them under `Brain/` makes the write contract trivial: "the agent writes only under Brain/". A separate `Payments/` root would re-introduce the same "many top-level dirs" problem this refactor is solving.
- **No `notes.write_paths` field.** The type carries the rule. If a future feature genuinely needs the agent to write to user-facing notes (`brain_capture` rebirth?), it is a separate design conversation, not a hidden expansion of this config.
- **`notes.read_paths` defaults to empty, not to `["Daily"]`.** Hardcoding a default would silently re-introduce the same hardcoded path. Empty default means new vaults opt in.
- **`event_log_append` and `appendEvent` are removed, not deprecated-with-shim.** Both have replacements that ship for years (`brain_note` MCP tool, `o2b brain note` CLI). A shim that writes `Daily/<date>.md` "for backward compatibility" would be a crutch and contradict the rule that the agent does not write to user-named notes.
- **AI Wiki/ removal is irreversible for new vaults but non-destructive for old ones.** `o2b init` no longer creates AI Wiki/ at all. `o2b brain upgrade` moves only OSB-managed files out of an existing AI Wiki/, leaves the empty directory or any user-authored content alone. Operators reading the migration log see exactly which files moved.
- **`Brain/_BRAIN.md` already exists** - no new operating manual file, no rename. The current `_OPEN_SECOND_BRAIN.md` template is deleted; its non-overlapping content gets folded into `Brain/_BRAIN.md` (one-paragraph headline + pointer to docs).
- **Doctor's exclusion list shifts to one mechanism.** Today `doctor` has an in-code "deliberately do NOT pull in legacy AI Wiki/ or Daily/" comment block. After this refactor, the only exclusion is `vault.ignore_paths` (a config-driven list). No path is special by name.

## File changes

### Atoms and config

- **Modify:** `src/core/brain/types.ts` - add `BrainNotesConfig { read_paths: ReadonlyArray<string> }` and slot it into `BrainConfig.notes?` + `ResolvedBrainConfig.notes`.
- **Modify:** `src/core/brain/policy.ts` - add `BRAIN_NOTES_DEFAULTS` (empty), `resolveNotes(cfg)`, validator (`notes.read_paths` is an array of vault-relative non-empty strings; rejects absolute paths and `..` traversal).
- **Modify:** `src/core/pay-memory/paths.ts` - swap `"AI Wiki"` constant for `posix.join("Brain", "payments")`.

### Init / scaffolding

- **Modify:** `src/core/init.ts` - drop the seven `AI Wiki/...` template registrations; bootstrap stops at `Brain/` (already handled by `o2b brain init`). The CLI verb `o2b init` now only writes the profile config + `.open-second-brain/` index dir.
- **Delete:** `src/core/brain/templates/_OPEN_SECOND_BRAIN.md.tpl` and `_open-second-brain.yaml.tpl` (move any unique content into `Brain/_BRAIN.md.tpl`).
- **Modify:** `src/core/brain/templates/_BRAIN.md.tpl` - remove `Daily/` and `AI Wiki/` paragraphs; add a one-line pointer to the configurable `notes.read_paths` block (with one example name like `"Daily"` clearly framed as "if you keep daily notes, list their folder here").

### Legacy event log removal

- **Delete:** the `appendEvent` function in `src/core/event-log.ts` (writes `Daily/<date>.md`). The file retains only the redactor + path safety helpers if they are reused elsewhere; otherwise the file goes too.
- **Delete:** the `o2b append-event` CLI verb (`src/cli/append-event.ts` or equivalent) and its tests.
- **Modify:** `src/cli/main.ts` - drop the subcommand registration.

### Migration

- **Modify:** `src/core/brain/upgrade.ts` - add a new step: detect `<vault>/AI Wiki/payments/`, `policies/`, `assets/`, `drafts/`, `reports/`, `_pending/`; atomically move each into `<vault>/Brain/payments/`. Detect and remove the seven OSB-managed scaffolding files; leave anything else under `AI Wiki/` untouched. Idempotent via sidecar `Brain/.upgrade-history.json` entry.
- **Modify:** `src/core/brain/upgrade.ts` - same step removes top-level `Daily/<date>.md` files that were authored by `appendEvent` (detected by a marker comment we wrote at the top). User-authored daily notes are recognised by the absence of that marker and are left alone.

### Scan / import

- **Modify:** `src/core/brain/inline-scan.ts` - resolve scan roots from `notes.read_paths`; default to empty (no work to do, no error).
- **Modify:** `src/core/brain/sessions/import.ts` - same pattern for the legacy session-import path scanner if it used `Daily/`.

### Doctor / manifest

- **Modify:** `src/core/brain/doctor.ts` - drop the AI Wiki/ + Daily/ exclusion paragraph; the only exclusion mechanism is `vault.ignore_paths`.
- **Modify:** `src/core/brain/manifest.ts` - same cleanup.
- **Modify:** `src/core/path-safety.ts` - the safety helper no longer needs the `AI Wiki/` allow-list.

### MCP

- **Modify:** `src/mcp/tools.ts` - drop the `event_log_append` historical comment block; rewrite the `second_brain_query` description to remove the AI Wiki framing.
- **Modify:** `src/mcp/instructions.ts` - remove AI Wiki / Daily references.
- **Modify:** `src/mcp/brain-tools.ts` - drop the `Daily/` fallback comment in `brain_note`'s docstring.

### Tests

- 24 tests touch `"AI Wiki"` or `"Daily/"`. Each one either:
  - Updates expected paths from `AI Wiki/payments/...` to `Brain/payments/...`.
  - Drops the test entirely if it covered the deleted `event_log_append` or `o2b append-event`.
  - Adds a new test under `tests/core/brain/upgrade-aiwiki-migration.test.ts` that exercises the migration step.
- New test: `tests/core/brain/notes-config.test.ts` covers the config block validator, defaults, and the `read_paths`-driven `scan-inline` resolution.

### Docs

- **Modify:** `README.md` - drop the `AI Wiki/` and `Daily/` mentions, including the line about `Brain/`, `AI Wiki/`, `Daily/` in the top features table row 1.
- **Modify:** `docs/how-it-works.md` - rewrite the vault layout diagram (only `Brain/` + the derived index dir + an optional user-notes section); rewrite "Capture surfaces" so that "Inline" reads from `notes.read_paths` and stops naming `Daily/`.
- **Modify:** `docs/pay-memory.md` - swap every `AI Wiki/...` path for `Brain/payments/...`.
- **Modify:** `docs/cli-reference.md` - update the Pay Memory verb descriptions and the `init-pay-memory` command's docstring; drop `o2b append-event` from the helper section.
- **Modify:** `docs/architecture.md` - drop AI Wiki/ and Daily/ from the layer diagram if mentioned.
- **Modify:** `docs/mcp.md` - drop AI Wiki/notes/ from the `second_brain_query` description; drop the historical `event_log_append` references.
- **Modify:** `install/prerequisites.md` - update the "what gets created in your vault" section.

### Release

- **Modify:** `package.json` - version `0.11.0` (breaking change).
- **Modify:** `CHANGELOG.md` - one `[0.11.0]` entry summarising: removed AI Wiki/, removed Daily/ hardcoding, moved Pay Memory to Brain/payments/, removed `event_log_append` / `o2b append-event`, added `notes.read_paths` config, `o2b brain upgrade` migrates existing installations.
- **Modify:** runtime manifests via `bun run sync-version`.

## Risks and open questions

- **Existing operators with custom content under `AI Wiki/`.** The migration moves only OSB-managed files; anything user-authored stays. Documented in the `[0.11.0]` CHANGELOG entry and the post-update doctor warning.
- **Hermes / Claude Code / Codex plugins on older versions might still reference the retired MCP tool names.** The MCP server itself drops the registrations; clients that call `event_log_append` or `second_brain_capture` get a clean tool-not-found error, not a silent no-op. The corresponding tool was already removed from the surface in v0.10.8; this PR removes the now-dead historical comments and the internal `appendEvent` function it documented.
- **`o2b brain upgrade` idempotency under partial failure.** If the migration crashes mid-move, re-running picks up where it left off via the sidecar manifest. A pre-run snapshot already covers full rollback.
- **Naming `Brain/payments/` vs `Brain/pay/`.** Going with `payments/` (more explicit, matches the existing subdir name under AI Wiki/, eases the migration mental model).
- **Should `notes.read_paths` accept globs (`Daily/*.md`)?** No. Each entry is a directory; the scanner walks it. Globs add complexity without solving a real need - if the operator wants to exclude files, `vault.ignore_paths` already exists.
- **Backward compatibility for users still running `o2b append-event` from a shell script.** The verb is removed; the script breaks loudly with "unknown subcommand". Better than silently writing to a path the agent contract forbids.
