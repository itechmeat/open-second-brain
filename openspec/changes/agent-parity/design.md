# Design

## Context

From `inventory.md`, section "Change B" (each claim with its code reference there):

1. `renderCronRecipe` in `src/cli/cron-recipe.ts` prints a third block, `hermes cron create`, in every recipe, and every parsed interval carries a `hermesSchedule`. Its consumers: the maintenance lane (`maintenance-cron.ts`, whose script sources `$HOME/.hermes/.env`), the reindex (`search-cron-template.ts`, the same), the code graph resync (`partner-codegraph-cron.ts`). Their output is pinned byte for byte by `tests/cli/cron-recipe.test.ts`, `maintenance-cron.test.ts`, `search-cron-template.test.ts` (with its fixture `tests/fixtures/cron-recipe/search-reindex-30m.txt`) and `tests/cli/partner-codegraph-resync.test.ts`. `src/core/search/indexer.ts` prints a recommendation to put the embedding key in `~/.hermes/.env`, and `docs/how-it-works.md` prints a `hermes cron create` recipe.
2. `src/cli/discipline-install.ts` writes jobs into `~/.hermes/cron/jobs.json` with ids hashed from the vault and requires a Telegram delivery target; `bin/o2b-discipline-report` and `scripts/discipline-report.ts` are what those jobs run; `src/core/discipline/telegram.ts` escapes for Telegram, and `src/core/brain/capture/telegram-capture.ts` (the live verb `o2b brain telegram-capture`) imports the same helper. `tests/discipline/render.test.ts` and `tests/discipline/telegram.test.ts` pin the escaped output. The report has no JSON flag. `o2b discipline report` is the measuring command. The manifest has `report`, `install`, `uninstall`. `src/core/install/ownership.ts` lists the jobs file as this tool's surface.
3. `src/cli/uninstall.ts` always prints three Hermes commands.
4. The digest: `renderDigest` (`src/core/brain/digest.ts`), the verb `o2b brain digest`, the MCP view and the resource `osb://digest/latest`. Session start content is assembled in `hooks/active-inject.ts` under a 9,000 character ceiling, cut from the payload's tail, with one cut note pinned as the last line. The injection ledger is per session: keyed by a session id, cleared at every session start, expiring after a day; it cannot say what this machine was shown before. Hosts without a hook get only `initialize.instructions` (`src/mcp/instructions.ts`).
5. Doctor has two severities, warning and error, and one stream that never feeds the exit code (`uncertain`); every code must be placed in `doctor-exits.ts` for the exit census. The discipline report spawns git per watched path and walks transcript folders.
6. On main, since the registry package change, `package.json` `files` and the committed `package-files.txt` list `bin/o2b-discipline-report` and `scripts/discipline-report.ts` by name.
9. Nothing detects which integrations are installed as one function; the install manifest and the Hermes path logic in `src/cli/uninstall.ts` are the pieces. `tests/cli/uninstall.test.ts` pins the always-Hermes plan. The link ratchet covers the starter templates only, not documentation.
7. Conformance: the manifest completeness ratchet, the help parity test, the link ratchet, the install guide conformance test, the plugin mirror sync for skills.
8. Hermes-specific and staying: `plugins/hermes/` (the memory provider, the bridge, profile isolation), the root `__init__.py` and `cli.py`, `src/core/doctor-hermes-parity.ts`.

## Goals / Non-Goals

**Goals:**

1. No shared surface names or favours an agent.
2. Nothing a user had is orphaned without being told.
3. The digest reaches a user of any agent.

**Non-Goals:**

1. Hermes' adapter features. The README and the 2.0 documentation set. The release.

## Decisions

### D1. Recipes

`renderCronRecipe` prints two sections; `hermesSchedule` and its parsing are removed. The scheduler notes of the three consumers lose their Hermes wording. The scripts replace the Hermes env line with: source `"${OPEN_SECOND_BRAIN_ENV_FILE:-<config dir>/env}"` when it is a readable regular file. The recipe's printed notes name that file and say it is optional. The four byte-pinned tests and the fixture get their new expected text. The indexer's recommendation names the product's env file, and the recipe in `docs/how-it-works.md` loses its Hermes line.

### D2. Discipline

1. Removed: `src/cli/discipline-install.ts`, the `install` and `uninstall` cases and manifest entries, `bin/o2b-discipline-report`, `scripts/discipline-report.ts`, the Telegram escaping in the discipline renderer, the ownership entry, `tests/cli/discipline-install.test.ts`, the comment in `cron-recipe.ts` that names the installer, the rows of `docs/cli-reference.md` (and the word MarkdownV2 in the report's row), the two paths from `package.json` `files`, then `bun run scripts/pack-manifest.ts --write`. The escape helper itself is not deleted: it moves beside its remaining user, the Telegram capture, and `tests/discipline/telegram.test.ts` moves with it.
2. `o2b discipline report` renders plain Markdown; `tests/discipline/render.test.ts` is rewritten for it. No JSON flag is added.
3. Doctor: a check `discipline` in the store-side pass only that, when `discipline_report.enabled`, shows the verdict for yesterday through the stream that does not feed the exit code (`discipline-alert`, `discipline-info`), with the report command. It does not run the report on every doctor call: the verdict for a day is computed once and cached in a device-local file keyed by that day, so doctor pays for it once a day. A report that cannot run is silent in doctor.
4. Leftover jobs: `src/core/discipline/legacy-jobs.ts` reads `~/.hermes/cron/jobs.json` (the path override the installer honoured) when it exists and lists jobs whose id has this product's prefix. Doctor emits `discipline-legacy-jobs` (advice: the file, the ids, "remove these entries or run `hermes cron remove <id>`"). The uninstall plan prints the same. Nothing writes that file.

### D3. The digest at session start

1. What was shown is a fact about the machine, not about a session, so it has its own small device-local file, `<state root>/dream-trigger/<store root hash>.digest.json`: the keys of the digests this machine delivered (the last twenty). A digest key is the covered interval of a pass that changed something, read from the newest `dream` audit events this machine holds.
2. `hooks/active-inject.ts`, on session start: when the newest digest key is not in that file, render a short digest (`renderDigestBrief`: counts and at most five lines of new, confirmed and retired rules, then "full: o2b brain digest", within 600 characters) and pass it through the runtime notices channel, where the notes of the trigger change travel; when the payload is otherwise empty it is printed alone. Its 600 characters are reserved before the memory bodies are budgeted, so the ceiling's tail cut does not fall on it and the pinned cut note stays last. If it still cannot fit, it is left out and not recorded; otherwise the key is recorded after the payload is written.
3. `src/mcp/instructions.ts`: when the newest digest key is not in the file, one line: "A dream digest is available: read osb://digest/latest or call brain_brief with view=digest." Reading the resource or the view records the key.
4. In a process with the dream session marker nothing of this runs.

### D4. The uninstall plan

A new function `installedIntegrations()` (in `src/core/install/`) answers from the install manifest's entries and, for Hermes, from its plugin directory under the Hermes home (the path logic `uninstall.ts` already has). `src/cli/uninstall.ts` prints an agent's section only when the function finds it; with none found it prints the product's own steps only. `tests/cli/uninstall.test.ts` gets both cases.

### D5. Guides

1. `after-install.md`: rewritten as neutral finishing steps (check, set the dream agent, choose the dream owner, where the human view is), with one line per agent pointing at its guide for anything specific. Its address is kept. Nothing in the repository links into it and no test pins it; the expected-output blocks of the install guides, which `tests/docs/install-verify-conformance.test.ts` compares byte for byte, are not touched.
2. `skills/embeddings-setup/SKILL.md`: the key goes to the product's env file; the reindex schedule is "any scheduler, see the printed recipe"; the Codex mirror is regenerated with `bun run sync-plugin-mirrors`.
3. `docs/hermes-cron.md`: kept at its address, titled as a guide for Hermes users, without the discipline installer, with a first paragraph saying dream runs through the owner's maintenance lane via the scheduled `o2b brain maintenance run` recipe or explicit CLI/MCP calls, and needs no Hermes-specific schedule.
4. `install.md` and `install/hermes.md`: the wording that makes Hermes the primary installation is removed; the dream owner section of `agent-neutral-dream` already says how the owner is chosen.

### D6. The journey test

`tests/e2e/no-hermes-journey.test.ts`, with HOME and state under a temp directory, PATH without `hermes` and `python`, and network access not needed: set up for the `cursor` target with a temp vault (through `o2b setup` if that verb is in the branch, otherwise `init` and `install --target cursor --apply --yes`); write three matching signals and two evidence events through the command line; run a live pass with a decision model configured to a stub server the test starts on the loopback address (a pass driven through the command line cannot take an in-process provider) and, if the agent executor is in the branch, the fake agent; assert a promoted rule; run the session start hook and assert the digest lane names it and a second run does not; move the owner role to a second device of the two-device fixture and back; print the uninstall plan; assert that no output and no written file of the whole run holds the word Hermes or a path under `.hermes`.

## Risks / Trade-offs

1. A Hermes user's scheduled scripts stop reading `~/.hermes/.env`. The changelog and the recipe notes say to point `OPEN_SECOND_BRAIN_ENV_FILE` at it or copy the keys.
2. The digest competes for the session start ceiling. It is the first lane cut, and a cut digest is tried again at the next session.
3. Hosts with no hook get an announcement, not a push. Stated in the docs.
4. Deleting byte-pinned text touches many tests; they change in this change and nowhere else.
