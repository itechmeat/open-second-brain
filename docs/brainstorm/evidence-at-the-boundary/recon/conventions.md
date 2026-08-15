# Recon: project conventions and the gates that fail a pull request late

Read-only reconnaissance against `main` @ 29ea0099 (v1.45.1). Everything an
implementer on this release must know before writing a line.

## Tests

All tests live under `tests/`, none co-located in `src/` (1018 files). Top-level
directories mirror the `src/` layers. Two naming styles coexist: the current
directory form `tests/core/brain/<module>.test.ts`, and a legacy dot-flattened
form in `tests/core/` only. New files use the directory form. Python is
`tests/python/test_*.py`.

The dominant vault fixture (186 files) is not the helper: it is
`mkdtempSync(join(tmpdir(), "o2b-<suite>-"))` plus `bootstrapBrain(vault)` with
`rmSync` in `afterEach`. `tests/helpers/fixtures.ts` exists but only four files use
it. Helpers cover cross-cutting machinery instead: `run-cli.ts`,
`search-fixtures.ts`, `mock-embedding.ts`, `sqlite-vec.ts`, `fake-http.ts`.

`tests/setup.ts` is preloaded from `bunfig.toml` and guarantees two things: a
pinned `O2B_DEVICE_ID`, and a hermetic throwaway config plus vault when
`OPEN_SECOND_BRAIN_CONFIG` is unset. `bootstrapBrain` requires the default config
path to exist, which is exactly what the preload provides.

Two hazards. First, never delete `OPEN_SECOND_BRAIN_CONFIG`, `XDG_CONFIG_HOME`,
`O2B_DEVICE_ID` or `VAULT_DIR` without restoring them: `bun test` shares one
process, and a test that deletes without restoring strips the hermetic default
from every file ordered after it. That shipped, and 1.45.1 fixed it. The
save-and-restore idiom is `tests/core/config-read-failure.test.ts:45-74`. Second,
in-process `runCli()` calls cannot overlap; await each one or pass
`{ subprocess: true }`.

## Code

Every module opens with a docblock that argues the design decision rather than
describing the API, usually tagged with the release wave and unit id, and it names
the rejected alternative and the measurement that refuted it. Several modules
declare their single reason to change. Inline comments explain why the code is not
the obvious thing.

`interface` for shapes (1642 exports against 355 `type`, which is reserved for
unions), every field `readonly`, `ReadonlyArray`/`ReadonlyMap`/`ReadonlySet`, and
2145 `Object.freeze` calls in `src/`.

Closed vocabularies are always four pieces together: a frozen object with
camelCase keys and snake_case values, a derived union type, a members array, and a
type guard. Canonical form at `negative-recall.ts:115-143`.

No shared error module: roughly forty per-module exported `Error` subclasses, each
with a stable `code`, structured readonly fields, `this.name` set, and a message
that names the fix. Config errors go through `BrainConfigError(message,
"block.sub_key", source)`.

Named exports only (exactly one `export default` in all of `src/`).
`verbatimModuleSyntax` means `import type`; `allowImportingTsExtensions` means
relative imports carry `.ts`. `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`. Format
width 100.

## CI gates, in order

`validate` job: checkout, Bun, Python 3.11, `bun install --frozen-lockfile`,
`bun run sync-version:check`, the OpenClaw bundle byte-diff, `link-ratchet:check`,
`check:paths` (report only), `fmt:check`, `lint`, `typecheck`, `bun test`,
`python -m unittest discover -s tests/python -v`, `python -m compileall -q
plugins/hermes`.

Version sync runs before everything else, so a forgotten bump fails the pull
request before lint or tests start.

`bun run validate` is typecheck, lint and test; it does **not** include
`fmt:check`. The pre-commit hook does, so format separately.

Practical pre-push sequence: `bun run fmt && bun run lint && bun run typecheck &&
bun run build:openclaw && bun run sync-version && bun run link-ratchet:check &&
bun test`.

## Architectural guard tests

`tests/core/architecture/write-site-census.test.ts`. A module is in scope if it
lives under `src/core/brain/`, `src/core/search/`, `src/cli/brain/`, `src/mcp/`,
or is `vault.ts`/`fs-atomic.ts`, or imports any relative `paths.ts` from anywhere.
Fifteen sync fs calls plus their promise twins plus `Bun.write` count as writes;
`mkdirSync` is deliberately excluded. The preferred fix is routing through a
shared writer; otherwise add an entry with categories from a closed vocabulary, a
`calls` array listing exactly the calls made, sorted, and a non-empty reason. Four
assertions fail you, including an exclusion whose file no longer writes directly,
and a `calls` array that drifts in either direction.

`tests/core/architecture/import-cycles.test.ts`. Zero cycles in `src/`.
`import type` is an edge; `await import()` is not, and deferred import is the
sanctioned cure. A new leaf module must import nothing from the layer above it.

`tests/core/architecture/verdict-vocabulary-census.test.ts`. Every closed
vocabulary in the "silence is not an answer" family, or whose values are copied
out of TypeScript into a tool schema or a persisted file, must register as
`{name, values, members, guard}` with a comment. The audit demands a frozen values
object, no duplicates, members and values in bijection, a guard that accepts every
member and rejects the empty string.

Others that fail a pull request: `tests/core/layering.test.ts:45` bans
`process.exit`, `process.stdout.write` and `console.log(` anywhere under
`src/core/`; `tests/core/brain/vault-guard-census.test.ts` requires every
write-capable module under `src/core/brain/` to name
`assertVaultIdentityForWrite` or `brainDirsForWrite` or appear in the exclusion
inventory, with exact set equality; `config-template-ratchet.test.ts` requires
every resolver key to be templated or omitted-with-reason and pins the live
surface byte-identical to the frozen v1.38.0 template;
`doctor-exit-census.test.ts` requires every doctor code to be in
`DIAGNOSTIC_SIGNALS` or `DOCTOR_EXIT_EXCLUSIONS`, never both and never neither;
`tests/cli/terminal-state-census.test.ts` requires every reachable CLI verb to
name an exit, name a refusal, or be listed as deliberately silent;
`tests/cli/help-surface-parity.test.ts` requires the human help and the JSON
manifest to match exactly; `tests/mcp/registry-guard.test.ts` enforces the
description caps and the preview-budget exemption table;
`tests/mcp/brain-tools-parity.test.ts` pins the exact set of tool names;
`tests/core/hygiene/hardcoded-paths.test.ts` scans `src/`, `docs/`, `README.md`,
`templates/`, `plugins/` and `install/` for home paths (use `~/vault`, `$HOME`,
`/home/user`, or annotate with `hygiene:allow-path`); `tests/version.test.ts`
checks every manifest plus `SERVER_VERSION` against `package.json`.

## Config keys

Five artifacts per new key: the field on the `BrainConfig` block interface in
`types.ts`, the block parser under `policy/blocks/` (exporting defaults, a
resolver and a parse function, wired into `policy/validate.ts` and re-exported
from the barrel), the frozen defaults table, the template generator in
`config-template.ts`, and the operator-facing `doc:` comment lines on the template
key, which are the documentation.

Block entry must go through `openBlock`/`hasBlock`/`warnUnknownKeys` from
`policy/key-index.ts`, because the known-key index is built by construction from
those calls: a key checked with a bare `in` becomes an unknown-field warning for
valid config. A newly exposed key must be emitted commented, never live, and its
commented value must equal the resolver default because the ratchet renders every
commented key live and requires the result to resolve identically to an empty
config.

## Docs and CHANGELOG

`docs/` is eleven flat pages plus `docs/plans/` and `docs/brainstorm/<slug>/`. The
index is the README Documentation table; no test enforces it. There is no
`docs/index.md` and no dedicated config-reference page.

CHANGELOG voice: Keep a Changelog structure, but each bullet leads with a bolded
one-sentence statement of the failure as an observed fact, then names the exact
mechanism, the version it regressed in, and why nobody noticed. Minor releases
open with unheaded prose stating the single theme and include a paragraph naming
what was asked for and deliberately not shipped, with the reason.

## Link ratchet

The ceiling file names exactly one subject, `templates/brain-starter`, at 22
dangling links. Adding pages to `docs/` cannot fail it. What does: pushing the
starter above its ceiling, adding an unindexable subject, or an unrecognised
definition token.

## Late failures nothing local catches

Git hooks are installed by `prepare`: pre-commit runs `fmt:check` then `lint`,
pre-push runs `typecheck` only. Neither runs `bun test`, `sync-version:check`,
`link-ratchet:check`, or the OpenClaw bundle diff, and those four are exactly the
last-minute failures.

`openclaw/index.js` is a committed build artifact. Any edit to a module
transitively reachable from `src/openclaw/index.ts` (which imports `core/config`,
`core/vault`, `core/doctor`, `entities/page-scope`, `agent-identity`,
`path-safety`) changes the bundle and fails the byte-diff. Fix with
`bun run build:openclaw` and commit the result. It is excluded from formatting and
linting, so nothing else reminds you.

Rewording an MCP tool or property description requires re-vendoring
`plugins/hermes/_schemas.py`; that gate silently failed across 1.45.0 and was
fixed in 1.45.1.
