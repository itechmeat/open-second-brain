# Dated commitments, capture to surface - implementation plan

Branch: `feat/dated-commitments` (already checked out in the run worktree; never create or switch branches). Version target: `1.90.0` -> `1.91.0` (minor: new MCP tools are a frozen-surface change). Every task below is TDD: write the named acceptance test first, run it, watch it fail with the expected error, implement until green, format and lint, commit as one conventional commit per task.

## Pinned cross-lane contract

Lanes A and B are parallel. They agree on the following names TODAY; no lane may rename or reshape them. Lane A task A1 commits this contract first; Lane B tasks B2 and B4 import it and must not edit any Lane A file.

- Path constants, `src/core/brain/path-constants.ts` (beside `BRAIN_OBLIGATIONS_REL` at line 49):
  - `export const BRAIN_PLEDGES_REL = posix.join(BRAIN_ROOT_REL, "pledges");`
- Path helpers, `src/core/brain/paths.ts` (obligations pattern, lines 504-517):
  - `export function pledgesDir(vault: string): string`
  - `export function pledgesArchiveDir(vault: string): string`
  - `export function pledgePath(vault: string, slug: string): string`
- Relation vocabulary, `src/core/graph/relation-vocab.ts`:
  - `export const PROMISED_TO_RELATION = "promised_to";` added to `DEFAULT_RELATION_TYPES` (one-line data-driven extension).
- Core page family, `src/core/brain/pledges.ts` (mirrors `obligations.ts`):
  - `export class PledgeError extends Error {}` and `export function noPledgeError(slug: string): PledgeError`
  - `export interface PledgePage { readonly slug: string; readonly title: string; readonly text: string; readonly due: string; readonly createdAt: string; readonly source: string; readonly evidence: ReadonlyArray<string>; readonly counterparties: ReadonlyArray<string>; readonly fulfilled: string | null; readonly agent: string; readonly notes: string; readonly path: string }`
  - `export interface AddPledgeInput { readonly title: string; readonly due: string; readonly source: string; readonly evidence: ReadonlyArray<string>; readonly text?: string; readonly counterparties?: ReadonlyArray<string>; readonly notes?: string; readonly agent: string; readonly now?: Date }`
  - `export function addPledge(vault: string, input: AddPledgeInput): PledgePage` - validates `due` via `validateIsoDate`, refuses an empty evidence list, refuses any quote that does not occur in the source page (quote-span containment), refuses a taken slug, writes atomically under `assertVaultIdentityForWrite`, renders bare frontmatter keys `title, created_at, due, source, evidence, promised_to, fulfilled, agent`.
  - `export function fulfillPledge(vault: string, input: { slug: string; date?: string; now?: Date }): PledgePage`
  - `export function showPledge(vault: string, input: { slug: string; readable?: (rel: string) => boolean }): PledgePage | null` - a withheld page answers null.
  - `export function pledgeExists(vault: string, slug: string): boolean`
  - `export interface PledgeListItem { readonly slug: string; readonly title: string; readonly due: string; readonly overdue: boolean; readonly daysUntilDue: number; readonly counterparties: ReadonlyArray<string>; readonly fulfilled: string | null; readonly source: string; readonly path: string }`
  - `export function listPledges(vault: string, input: { now: Date; readable?: (rel: string) => boolean; includeFulfilled?: boolean }): ReadonlyArray<PledgeListItem>` - sorted by due then slug; open pledges only unless `includeFulfilled`.
  - `export function removePledge(vault: string, input: { slug: string }): { slug: string; archivePath: string }` - archive rename with collision suffix, the obligations pattern.
- Intake, `src/core/brain/pledge-intake.ts` (mirrors `extract-intake.ts` discipline):
  - `export class PledgeIntakeError extends Error {}`
  - `export interface PledgeIntakeItem { readonly title: string; readonly due: string; readonly evidence: ReadonlyArray<string>; readonly text?: string; readonly counterparties?: ReadonlyArray<string> }`
  - `export interface PledgeIntakeInput { readonly source: string; readonly pledges: ReadonlyArray<PledgeIntakeItem> }`
  - `export interface PledgeIntakeResult { readonly created: ReadonlyArray<string>; readonly duplicates: ReadonlyArray<string>; readonly reanchored: ReadonlyArray<string>; readonly staleEdges: ReadonlyArray<string>; readonly unanchoredCounterparties: ReadonlyArray<string> }` - pages are keyed on `slugify(title)`, so two pledges that share a title cannot both exist: the (title, due, source) hash only classifies repeats, and a second pledge with the same title but a different due/source is refused with "slug already held by a different pledge" (titles are unique among active pledges). The batch is capped by name (`MAX_INTAKE_PLEDGES = 100` pledges per intake, `MAX_INTAKE_COUNTERPARTIES = 32` counterparty names per pledge, `MAX_INTAKE_COUNTERPARTY_NAME_LENGTH = 200` characters per name); a batch over a cap refuses whole.
  - `export function intakePledges(vault: string, input: PledgeIntakeInput, opts: { agent: string; now: Date; readable?: (rel: string) => boolean }): PledgeIntakeResult` - validates EVERY item (including quote containment and source readability) before writing anything; identity = sha256 first 12 hex over the normalized `(title, due, source)` triple; same identity plus same normalized payload is a reported duplicate no-op, same identity plus different payload throws a named `PledgeIntakeError` mismatch; counterparty names anchored server-side against canonical-scope entities (`entityStatusInScope` + the shared anchoring kernel); unanchored names are reported and stored nowhere; re-posting after the entity registers adds the edge (re-anchor arm); a stored edge the readable canonical registry can no longer reproduce is reported under `staleEdges` and the page is left byte-identical - an edge that was valid when computed is not the caller's to delete, and the re-anchor arm does not grow a new edge beside a dead one.
- MCP tools, `src/mcp/brain/pledge-tools.ts`, exported as `export const PLEDGE_TOOLS: ReadonlyArray<ToolDefinition>` and concatenated into `BRAIN_TOOLS` in `src/mcp/brain-tools.ts`:
  - `brain_pledge` - operations `add | fulfill | list | show | remove`; schema mirrors `brain_obligation` (`additionalProperties: false`, `previewBudget: MCP_PREVIEW_BUDGET`, reach via `readableAtContextReachOrUndefined(ctx)`, vault-path-safe responses through `src/mcp/vault-path-field.ts`).
  - `brain_intake_pledges` - fields `source` (required), `pledges` (required array), `agent` (optional); malformed payloads surface as `MCPError(INVALID_PARAMS, "brain_intake_pledges: ...")` with typed errors preserved (`wrapToolErrors`).
- Config surface, `src/core/config.ts` (Lane B):
  - `export function resolveCounterpartyBriefEnabled(configPath?: string): boolean` - `resolveConfigFlag("OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED", "counterparty_brief_enabled", configPath)`, default off.
  - `export function resolveCounterpartyBriefTriggers(configPath?: string): ReadonlyArray<string>` - machine-local main-config key `counterparty_brief_triggers`; the shipped reader takes a COMMA-SEPARATED STRING (`config.ts:903-913`), so `[a, b]` is real YAML list syntax the flat config parser cannot represent and answers `[]`, keeping the brief inert (a bracket-shaped value is malformed, not a token). Tokens are NFC-normalized and trimmed; absent, blank or malformed answers `[]`.
  - `export function resolveEntityFactsContextPack(configPath?: string): boolean` - `resolveConfigFlag("OPEN_SECOND_BRAIN_ENTITY_FACTS_CONTEXT_PACK", "entity_facts_context_pack", configPath)`, default off (the `resolveDensityRankingContextPack` twin, config.ts:852).
- entity_facts pack option, `src/core/brain/context-pack.ts` + `src/mcp/brain/pack-tools.ts` (Lane B):
  - `readonly entityFacts?: boolean` in `ContextPackOptions`; conditional report member `readonly entityFacts?: ContextPackEntityFactsReport` in `ContextPackReport`, where `export interface ContextPackEntityFactsReport { readonly entities: ReadonlyArray<{ readonly entityId: string; readonly name: string; readonly itemIds: ReadonlyArray<string> }> }` (canonical-scope entities anchored from the pack query, cap 3 entities, item ids drawn only from already-kept candidates, entity pages failing the caller's view treated as absent); conditional output key `entity_facts` in the tool projection. Off, every default pack is byte-identical.
- Injection ledger, `hooks/lib/injection-ledger.ts` (Lane B):
  - `export function readBriefDelivered(vault: string, sessionId: string, nowMs?: number): string | null` / `export function recordBriefDelivered(vault: string, sessionId: string, entityId: string, nowMs?: number): boolean` - the `readRecallInjected`/`recordRecallInjected` pattern, keyed by the whole brief (not a per-entity set), gated by `isRealSessionId`, with the ledger's standard TTL and a failed record answering `false` (the hook treats that as a possible one-brief repeat, never a reason to withhold a brief it already printed).
- Brief core, `src/core/brain/counterparty-brief.ts` (Lane B):
  - `export interface CounterpartyBriefItem { readonly date: string; readonly text: string; readonly sourceRel: string }`
  - `export interface CounterpartyBrief { readonly entityId: string; readonly entityName: string; readonly items: ReadonlyArray<CounterpartyBriefItem>; readonly skippedReads: number; readonly notices: ReadonlyArray<DegradationNotice> }` (`skippedReads` counts a preference page the walk could not read - counted, never swallowed - and `notices` carries one typed degradation notice per such page; `CounterpartyBriefItem.date` is `""` for an undated preference and renders as `undated`)
  - `export function buildCounterpartyBrief(vault: string, input: { text: string; triggers: ReadonlyArray<string>; now: Date; readable?: (rel: string) => boolean; itemLimit?: number }): CounterpartyBrief | CounterpartyBriefAbstention` - abstains with a typed reason (`export type CounterpartyBriefAbstention = { readonly abstain: "no_trigger" | "no_match" | "ambiguous" }`) unless triggers are non-empty AND at least one trigger token occurs in the text AND exactly one canonical-scope entity matches by name or alias: an empty trigger list or a prompt carrying no trigger token abstains as `no_trigger`, zero canonical-scope matches as `no_match`, several as `ambiguous`; items: open pledges promised to the entity (due-sorted, from `listPledges`) then recent non-private preference pages whose bodies anchor the entity, bounded walk with named-constant caps (`DEFAULT_BRIEF_ITEM_LIMIT = 3`, a named char budget, a named page-read cap); a page whose `visibility:` carries the reserved token is excluded regardless of reach; withheld pages contribute nothing and are not counted.
  - `export function renderCounterpartyBrief(brief: CounterpartyBrief): string` - `""` when the item list is empty (the hook then emits nothing).

## Shared-module-first instruction (both lanes)

Lane A executes A1 as the first implementation commit of the wave and nothing else before it. Lane B executes B1 immediately (config resolvers touch no Lane A file), then waits for A1 before B2. Neither lane edits a file owned by the other lane; if a task seems to need a cross-lane file, the lanes extend the pinned contract instead. Lane C runs only after A and B are both complete.

## Lane A - substrate: pledge family, intake, projection, CRUD (t_da8673aa)

### A1: pledge page family core

- **Files**: `src/core/brain/path-constants.ts`, `src/core/brain/paths.ts`, `src/core/graph/relation-vocab.ts`, `src/core/brain/pledges.ts`, `tests/core/brain/pledges.test.ts`, `tests/core/graph/relation-vocab.test.ts` (extend the vocabulary pin deliberately).
- **Acceptance (red-first)**: `tests/core/brain/pledges.test.ts` fails with "Cannot find module .../pledges.ts"; then passes: mkdtemp vault per test with an injected `NOW` constant (the `tests/core/brain/obligations.test.ts` fixture pattern); parse/render round-trip; `addPledge` refuses a taken slug, a non-ISO due, an empty evidence list, and a quote absent from the source page (each refusal named); `fulfillPledge` stamps the date; `listPledges` sorts by due then slug with overdue flag and `daysUntilDue` boundaries (yesterday/today/tomorrow); a hand-edited frontmatter date soft-parses like `parseIsoDate`; `removePledge` archives with a collision-suffixed name.
- **Depends on**: none. This is the wave's first implementation commit.

### A2: extraction intake

- **Files**: `src/core/brain/pledge-intake.ts`, `tests/core/brain/pledge-intake.test.ts`.
- **Acceptance (red-first)**: `tests/core/brain/pledge-intake.test.ts` fails on the missing module; then passes: an intake containing one invalid item writes NO page (validate before write, no partials); duplicate no-op reports the slug under `duplicates`; same identity with a changed payload throws the named mismatch; counterparty names anchor to `promised_to` entity ids through a fixture registry and appear in the page frontmatter; an unanchored name lands in `unanchoredCounterparties` and is absent from frontmatter; re-post after the entity registers moves the pledge to `reanchored`; a `readable` predicate that refuses the source page refuses the whole intake.
- **Depends on**: A1.

### A3: MCP tools

- **Files**: `src/mcp/brain/pledge-tools.ts`, `src/mcp/brain-tools.ts`, `tests/mcp/pledge-tools.test.ts`.
- **Acceptance (red-first)**: `tests/mcp/pledge-tools.test.ts` fails because the tool names are absent from the table; then passes: both tools appear in `buildToolTable` output; schemas reject unknown properties (`additionalProperties: false`); `brain_pledge` add/fulfill/list/show/remove behave through the handler with a minimal `ServerContext`; `list` honors the overdue filter and the readable predicate; `brain_intake_pledges` maps `PledgeError`/`PledgeIntakeError` to `INVALID_PARAMS` with the error name preserved and never wraps an already-typed `MCPError` twice.
- **Depends on**: A1, A2.

### A4: reach behavior

- **Files**: `tests/mcp/pledge-reach.test.ts`.
- **Acceptance (red-first)**: the suite fails until the reach fixture proves the contract; then passes: two-vault fixture via `tests/helpers/reach-log-fixture.ts` (`buildReachLogFixture`, `maskVolatile`, `reachServer`); below local reach a withheld pledge page answers `show` as absent (`present: false` semantics), drops from `list`, and refuses `fulfill`/`remove` with the same `no pledge` error an absent slug gets, with a local control proving the page exists; the archive name stays out of a withheld `remove` answer.
- **Depends on**: A3.

### A5: tool-surface census registrations (card A checklist, items 1-7 and 10-15 of the recon census)

- **Files**: `tests/mcp/brain-tools-parity.test.ts` (docblock history entry plus the frozen name-set pin picking up both tools), `src/core/search/visibility-surface-registry.ts` (one `covered` row per new tool, `brain_obligation` row at :810 as the wording template), `tests/core/architecture/visibility-surface-census.test.ts` (sweep population gains the defining file, history count note), `tests/core/architecture/write-site-census.test.ts` (categorized exclusion entry for the archive rename plus the pinned direct-row count bump in the docblock history), `src/core/brain/destructive-sites.ts` plus `tests/core/architecture/destructive-site-census.test.ts` (entry with recovery pointer, pinned-count docblock bump), `tests/helpers/tool-probe-catalogue.ts`, `tests/mcp/agent-scope-matrix.test.ts`, `tests/mcp/visibility-matrix.test.ts` (one invocation recipe and exactly-one classification per new tool), `tests/core/architecture/vault-path-census.test.ts` (no change expected; run to confirm responses use the vault-path field), `tests/core/architecture/import-cycles.test.ts` (run to confirm the new modules stay acyclic).
- **Acceptance**: each named census suite passes after its deliberate edit; any equality-pinned count is bumped in the same commit as its entry; `bun test tests/core/architecture tests/mcp/brain-tools-parity.test.ts` is green.
- **Depends on**: A3 (rows name real tools), A1 (write and archive sites exist).

### A6: today dashboard section

- **Files**: `src/core/brain/today-dashboard.ts`, `tests/core/brain/today-dashboard.test.ts` (extend), `src/mcp/brain/brief-tools.ts` and its today-view test (`toolBrainToday` at brief-tools.ts:581 embeds the whole dashboard, so the projection gains a `pledges` member beside `obligations` and the text renders the new section), `tests/mcp/today-open-loops-reach.test.ts` (extend for the withheld-pledge case).
- **Acceptance (red-first)**: the dashboard test fails on the missing section; then passes: the section-name union gains `"pledges"`; the section renders due-sorted open pledges with overdue and days-until-due, inside its own try/catch (a throwing builder yields an explicit error entry, not a silently empty section); `totals` gains `pledgesTotal` and `pledgesOverdue` derived from the already-built section (no second scan); the `readable` predicate removes withheld pledge pages before totals; empty vault renders an empty section with no error; `brain_brief view=today` returns the `pledges` member and the section text, honoring the same readable predicate.
- **Depends on**: A1.

## Lane B - delivery: entity_facts pack section and the counterparty brief (t_43b0a379)

### B1: config resolvers

- **Files**: `src/core/config.ts`, `tests/core/config-counterparty-brief.test.ts` (new, following `tests/core/config-recall-inject.test.ts`), plus the `resolveEntityFactsContextPack` cases in the same new suite.
- **Acceptance (red-first)**: the suite fails on the missing resolvers; then passes: default off with no config; env override wins; a `counterparty_brief_triggers` list is read, trimmed and normalized; absent or malformed lists answer `[]`; `entity_facts_context_pack` defaults off with the env override honored. No `_brain.yaml` template change is needed (machine-local keys; the config-template ratchet does not apply - asserted by running `tests/core/brain/config-template-ratchet.test.ts` unchanged).
- **Depends on**: none. Runs as Lane B's first commit, in parallel with A1.

### B2: counterparty brief core

- **Files**: `src/core/brain/counterparty-brief.ts`, `tests/core/brain/counterparty-brief.test.ts`.
- **Acceptance (red-first)**: the suite fails on the missing module; then passes (fixture vault with pledges from A1, preference pages, and a small canonical entity registry): at most `DEFAULT_BRIEF_ITEM_LIMIT` items, each carrying its source path and a date (a pledge's due date or the day a preference page was created - a preference with no calendar date is an undated item that sorts last and renders `undated`); a page whose visibility carries the reserved token never surfaces, even though the hook runs locally; an item drawn from two source pages is dropped when their token intersection is empty (strictest-visibility semantics); an empty result renders `""`; abstention on zero matches, on multiple entity matches, on an empty trigger list, and on prompts containing no trigger token; the page-read caps bound both walks in the vault's stable (code-unit) name order BEFORE the recency/due sort, so past the cap the globally newest preferences or soonest-due pledges can fall outside the window; pledges promised to the entity sort before preference facts; a `readable` predicate removes pages before anything counts them (identical-to-absent: no counts, no names).
- **Depends on**: A1 (imports `listPledges` and `PledgeListItem` only), B1.

### B3: entity_facts pack section

- **Files**: `src/core/brain/context-pack.ts`, `src/mcp/brain/pack-tools.ts`, `tests/core/brain/context-pack-entity-facts.test.ts` (new, sibling of the seven context-pack suites), `tests/mcp/context-pack-tool.test.ts` (extend for the config-key seam and the `entity_facts` output projection).
- **Acceptance (red-first)**: the new suite fails on the missing option; then passes: without the option the pack is byte-identical to before (snapshot comparison); with it, the report carries `entityFacts` entries only for canonical-scope entities anchored from the query, each listing only ids already present in `items`; a quarantined entity never appears; an entity page that fails the caller's view is treated as absent (its rollup is dropped silently, nothing counts it); at remote reach the section respects the same view the items do; the tool emits `entity_facts` only when the config key resolves on; the other three `packContext` callers are untouched (their suites stay green unchanged).
- **Depends on**: B1 only (no dependency on Lane A; ships independently per the validator comment).

### B4: counterparty brief hook

- **Files**: `hooks/counterparty-brief.ts`, `hooks/hooks.json` (UserPromptSubmit row, exact existing command shape: `$CLAUDE_PLUGIN_ROOT`, `/scripts/o2b-hook`, `command -v o2b-hook`, `exit 0`, `timeout: 10`, statusMessage), `hooks/README.md` (table row documenting the flag and the triggers requirement), `src/core/install/grok-asset.ts` (register the hook or declare why not, per the parity test contract), `plugins/codex/hooks/hooks.json` (regenerated via `scripts/sync-plugin-mirrors.ts`, never hand-edited), `tests/hooks/counterparty-brief.test.ts`.
- **Acceptance (red-first)**: the hook suite (spawn-based, `runHook` pattern of `tests/hooks/gap-loop.test.ts`, temp vault, isolated HOME via `homeEnv`) fails on the missing script; then passes: flag off emits byte-identical empty stdout; flag on with a qualifying prompt and a matched counterparty emits exactly one `hookSpecificOutput.additionalContext` envelope with at most three dated items; a second run in the same session emits nothing (ledger); no real session id means no ledger write and no emission; flag on with an empty trigger list emits nothing; a prompt with no counterparty match emits nothing; the process ceiling holds (slow vault, exit 0, no output); `tests/hooks/hooks-json-shape.test.ts`, `tests/core/install/adapters/grok-hook-parity.test.ts`, `tests/core/install/grok-hook-timeout.test.ts` and `tests/scripts/sync-plugin-mirrors.test.ts` are all green after registration.
- **Depends on**: B1, B2, A1 (dated-item supply for the acceptance fixtures).

### B5: entity-read census compliance

- **Files**: `tests/core/brain/entities/entity-read-census.test.ts` only if the inventory needs the new reader named; `src/core/brain/counterparty-brief.ts` must already use `entityStatusInScope` (B2).
- **Acceptance**: the entity-read census suite passes (the new module reads entity records only through the one status predicate, or is added to the exclusion inventory with a reason); `tests/core/architecture/import-cycles.test.ts` and `tests/core/architecture/state-surface-census.test.ts` stay green (the ledger file lives beside the existing injection-ledger state, same surface).
- **Depends on**: B2, B4.

## Lane C - whole-tree closure: census sweep, docs, CHANGELOG, version (runs last)

### C1: whole-tree census and registry sweep

- **Files**: none expected (a verification task; fixes land in the owning lane's files if a census names one).
- **Acceptance**: with A and B complete, run and pass, in one `bun test` invocation: `tests/mcp/brain-tools-parity.test.ts`, `tests/core/architecture/visibility-surface-census.test.ts`, `tests/core/architecture/write-site-census.test.ts`, `tests/core/architecture/destructive-site-census.test.ts`, `tests/core/architecture/vault-path-census.test.ts`, `tests/core/architecture/import-cycles.test.ts`, `tests/core/architecture/progress-census.test.ts`, `tests/core/architecture/append-shard-census.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`, `tests/core/architecture/origin-channel-census.test.ts`, `tests/core/architecture/harness-identity-census.test.ts`, `tests/core/architecture/state-surface-census.test.ts`, `tests/core/brain/entities/entity-read-census.test.ts`, `tests/core/brain/sync-lockfile.test.ts`, `tests/mcp/agent-scope-matrix.test.ts`, `tests/mcp/visibility-matrix.test.ts`, `tests/hooks/hooks-json-shape.test.ts`, `tests/core/install/adapters/grok-hook-parity.test.ts`, `tests/scripts/sync-plugin-mirrors.test.ts`, `tests/core/brain/config-template-ratchet.test.ts` - the recon A seventeen-entry checklist items 1-17 and the recon B hook parity list, all satisfied with named evidence.
- **Depends on**: A5, A6, B3, B4, B5.

### C2: docs and behavior disclosure

- **Files**: `docs/mcp.md` (tool-table rows for `brain_pledge` and `brain_intake_pledges`; the `brain_context_pack` entry names the `entity_facts` conditional option and the new tools' reach behavior, including the inherited second-hand-text limit; the `brain_brief` entry names the pledges section), `docs/cli-reference.md` (the `brain today` output gains the pledges section), `docs/updating.md` (behavior-break disclosure for the conditional pack member, the dashboard totals extension and the `brain_brief view=today` shape change, per `tests/docs/behaviour-break-disclosure.test.ts`), `README.md` only if its feature list names the today sections.
- **Acceptance**: `tests/docs/behaviour-break-disclosure.test.ts` passes; every doc edit names features that exist in the diff (no aspirational rows).
- **Depends on**: C1.

### C3: CHANGELOG and version bump

- **Files**: `CHANGELOG.md` (new `## [1.91.0]` heading with date, Added/Changed entries in house style, compare-link reference), `package.json` (`1.90.0` -> `1.91.0`), version mirrors via `bun run scripts/sync-version.ts`.
- **Acceptance**: the parity docblock history and the CHANGELOG agree on what the minor adds; `bun run scripts/sync-version.ts` reports no drift; the link reference resolves.
- **Depends on**: C2.

## Commit sequencing

1. A1 (contract first), then B1 in parallel.
2. Lane A: A2 -> A3 -> A4 -> A5 -> A6. Lane B (after A1): B2 -> B3 -> B4 -> B5.
3. Lane C: C1 -> C2 -> C3.
4. Format (`./node_modules/.bin/oxfmt`) and lint (`oxlint`) on changed files before every commit; the pre-commit hook runs them whole-tree.
