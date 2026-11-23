# Proposal

## Why

Open Second Brain started on one agent, and that agent still shows through where it should not: every scheduler recipe prints a Hermes line, the scripts read Hermes' environment file, the discipline report installs itself into Hermes' cron and speaks Telegram, the uninstall plan always lists Hermes steps, and two guides tell every user to do what only a Hermes user needs. Version 2.0 is the same product for every supported agent. This change removes the privilege and keeps the adapter.

## What Changes

1. Scheduler recipes print crontab and systemd forms only. Their scripts source the product's own optional env file. **BREAKING** for a user who relied on the scripts reading `~/.hermes/.env`: the recipe output says which file to use.
2. **BREAKING**: `o2b discipline install` and `o2b discipline uninstall` are removed, with the packaged report script and the Telegram format. `o2b discipline report` prints plain Markdown. Doctor reports the discipline verdict as advice. Jobs the removed installer left in Hermes' jobs file are detected and named, with how to remove them.
3. The digest of the last pass is shown once at session start on hosts with a session hook, and announced in the MCP instruction text on hosts without one.
4. The uninstall plan lists Hermes steps only when a Hermes integration is installed.
5. `after-install.md`, the embeddings skill and the install guides no longer assume Hermes; `docs/hermes-cron.md` becomes a guide for Hermes users only.
6. One end-to-end test of the whole journey with no Hermes.

This is the last of the eight changes of the series. The 2.0 README, the remaining documentation and the release follow it as their own work.

## Capabilities

### New Capabilities

- `agent-parity`: which surfaces every supported agent gets equally, and which are features of one adapter.

## Impact

1. Code: `src/cli/cron-recipe.ts`, `maintenance-cron.ts`, `search-cron-template.ts`, `partner-codegraph-cron.ts`; `src/cli/discipline.ts`, `discipline-install.ts` (removed), `src/core/discipline/` (the renderer), `bin/o2b-discipline-report` and `scripts/discipline-report.ts` (removed), the command manifest, `src/core/install/ownership.ts`, `src/cli/uninstall.ts`, `hooks/active-inject.ts` and the injection ledger, `src/mcp/instructions.ts`, doctor, `package.json` `files` and the package manifest.
2. Docs: `after-install.md`, `skills/embeddings-setup/SKILL.md` (and its Codex mirror through the sync), `docs/hermes-cron.md`, `docs/cli-reference.md`, `install.md`, the link ratchet.
3. Tests that pin the removed text byte for byte change with it (`inventory.md` section 14).
4. Risks: a Hermes user's scheduled scripts stop finding their keys; orphaned Telegram jobs; the session start budget.
5. Not in this change: the README, the rest of the 2.0 documentation, the release.
