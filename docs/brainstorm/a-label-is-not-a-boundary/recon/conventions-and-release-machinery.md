# Conventions and release machinery

Reconnaissance for the `a-label-is-not-a-boundary` release, on branch
`feat/a-label-is-not-a-boundary` at `package.json` version **1.48.0**.

This note is the shared contract for the nine feature units. Read it
instead of rediscovering the same rules nine times. Every claim below
carries a `file:line` anchor that was read; every command output is real.

Status of the tree as measured (see "Verified command output" for the
transcripts): `bun run lint` 0 errors / 123 warnings, `bun run fmt:check`
clean, `bun run typecheck` clean, `bun run scripts/sync-version.ts
--check` clean at 1.48.0, `git status --porcelain` empty.

---

## 1. Vocabulary idiom

The repository has one mandated shape for a closed set of string values,
and a census that reads `src/` and enrols every construct carrying it.
Writing three of the four pieces leaves the construct out of the
population; writing all four and not registering it fails the census.

### 1.1 The four pieces, all four in ONE module

Stated in the census docblock at
`tests/core/architecture/verdict-vocabulary-census.test.ts:38-47`:

1. `const NAME = Object.freeze({ … })` whose every entry is
   `key: "string literal"`;
2. a union derived from it — `(typeof NAME)[keyof typeof NAME]`;
3. a membership list built from it — a const initialised from
   `Object.values(NAME)` or from an array of `NAME.member`;
4. a guard: a function or arrow taking a parameter typed `unknown` that
   reads the membership list or the object.

They must be in the SAME file. Detection is per-file
(`verdict-vocabulary-census.test.ts:70-72`), so a vocabulary split across
modules is out of population entirely — which means the audit never runs
on it, and that is a silent hole, not a pass.

### 1.2 Canonical example from src

`src/core/doctor-readiness.ts:128-153`:

```ts
export const READINESS_STATUS = Object.freeze({
  /** The probe ran and the surface answered correctly. */
  pass: "pass",
  /** The probe ran and the surface is broken; the detail names how. */
  fail: "fail",
  /** Nothing to measure: the surface is deliberately not configured. */
  skipped: "skipped",
  /** The probe could not measure; the detail says what stopped it. */
  unknown: "unknown",
} as const);

/** Closed union over {@link READINESS_STATUS}. */
export type ReadinessStatus = (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

/** Membership list, in reporting order from best-known to least-known. */
export const READINESS_STATUSES: ReadonlyArray<ReadinessStatus> = Object.freeze([
  READINESS_STATUS.pass,
  READINESS_STATUS.fail,
  READINESS_STATUS.skipped,
  READINESS_STATUS.unknown,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === "string" && (READINESS_STATUSES as ReadonlyArray<string>).includes(value);
}
```

`src/core/brain/safeguard.ts:52-80` (`OPERATION` / `Operation` /
`OPERATIONS` / `isOperation`) and `src/core/brain/progress.ts:66-92`
(`PROGRESS_KIND`) are the same shape.

### 1.3 Casing and naming

- Object constant: `SCREAMING_SNAKE`, singular
  (`READINESS_STATUS`, `PROGRESS_KIND`, `OPERATION`).
- Keys: `lowerCamelCase` identifiers — `timedOut`, `transportSingleResponse`
  (`src/core/brain/progress.ts:104,111`).
- Values: lowercase kebab wire strings — `"timed-out"`,
  `"transport-single-response"` (same lines). Key and value need not
  match; the value is what crosses the wire.
- Derived type: `PascalCase` singular (`ReadinessStatus`, `ProgressKind`).
- Membership list: `SCREAMING_SNAKE` plural, typed
  `ReadonlyArray<TheType>`, itself `Object.freeze`d
  (`src/core/doctor-readiness.ts:143`). Plural spelling is free —
  `GRAPH_HEALTH_CODE_LIST` and `MATERIALIZE_FRESHNESS_STATES` both pass;
  the census matches on the object name, not the list name
  (`verdict-vocabulary-census.test.ts:1302-1308`).
- Guard: `isPascalCase`, parameter typed **`unknown`**, returns
  `value is TheType`.

### 1.4 What the audit asserts (7 checks)

`auditVocabulary` at `verdict-vocabulary-census.test.ts:374-404`:

1. `Object.isFrozen(values)` (line 378).
2. No duplicate value in the object (lines 380-383).
3. No duplicate entry in the membership list (lines 385-388).
4. Every declared value is a member (line 392).
5. The guard accepts every declared value (line 393).
6. No member that no value declares (line 396).
7. The guard rejects every one of `NON_MEMBERS` — `""`, `" "`,
   `"unknown-vocabulary-member"`, `null`, `undefined`, `42`, `{}`
   (`verdict-vocabulary-census.test.ts:363-371`, checked at 398-402).

Values need NOT be unique across vocabularies
(`verdict-vocabulary-census.test.ts:23-25`): two `absent` members in two
different vocabularies are fine.

### 1.5 Registration, and how discovery works after v1.48.0

`CENSUS` at `verdict-vocabulary-census.test.ts:411-1004` is a frozen array
of `{ name, values, members, guard }` (interface at lines 347-356).
`name` must be the **source identifier of the frozen object**, spelled
exactly (`verdict-vocabulary-census.test.ts:1427-1445`).

v1.48.0 made the census read the tree. `scanVocabularies`
(`verdict-vocabulary-census.test.ts:1285-1324`) walks
`SCANNED_ROOTS = ["src"]` (line 1013), lexes each `.ts` file with
`maskSource` (line 1047 — comments and string CONTENTS blanked, offsets
preserved), and enrols a construct only when all four pieces resolve.
Four assertions then bind the scan to the registry
(`verdict-vocabulary-census.test.ts:1406-1466`):

- every four-piece vocabulary in `src/` is registered, **named** in the
  failure (line 1407);
- no registration outlives its vocabulary (line 1418);
- each registration's values equal the values the source declares
  (line 1427);
- the scan is not vacuous: `SCANNED.length > 50` and
  `SOURCE_TREE.length > 500` (lines 1451-1452).

There is **no exemption list** (`verdict-vocabulary-census.test.ts:59-61`).

### 1.6 The concrete recipe for a new vocabulary

To pass, in one module under `src/`:

1. `export const NEW_THING = Object.freeze({ key: "value", … } as const);`
   with every entry a plain `key: "literal"`. A spread, a nested object,
   a computed key, or a value built by a call drops it out of population
   (`verdict-vocabulary-census.test.ts:1204-1219`).
2. `export type NewThing = (typeof NEW_THING)[keyof typeof NEW_THING];`
   — this exact text is what the scan matches
   (`verdict-vocabulary-census.test.ts:1295-1298`).
3. `export const NEW_THINGS: ReadonlyArray<NewThing> = Object.freeze([NEW_THING.a, …]);`
   or `Object.freeze(Object.values(NEW_THING))` — the multi-line
   `Object.values` form is explicitly supported and pinned by name
   (`verdict-vocabulary-census.test.ts:1455-1465`).
4. `export function isNewThing(value: unknown): value is NewThing { … }`
   reading the list. An arrow form works too
   (`verdict-vocabulary-census.test.ts:1510-1516`). A parameter typed
   `string` puts you **out** of population — a documented and deliberate
   hole (`verdict-vocabulary-census.test.ts:80-82`, negative fixture at
   1588-1595).
5. Add the import and the `{ name, values, members, guard }` entry to
   `CENSUS` in `tests/core/architecture/verdict-vocabulary-census.test.ts`,
   with a comment saying why the vocabulary exists (every existing entry
   carries one; not asserted, but universal).

Shapes deliberately kept OUT, so do not expect them to be enrolled:
a frozen object with no derived union; a curated ORDERING with no guard
(`DREAM_STEP_RUNNABLE`, `DREAM_GATE_NAMES` —
`verdict-vocabulary-census.test.ts:52-58`); a frozen lookup whose values
are not literals; a `string`-parameter guard
(`verdict-vocabulary-census.test.ts:1568-1596`).

Blind spots stated in the docblock rather than hidden
(`verdict-vocabulary-census.test.ts:63-96`): a split trio, a missing list
or guard, non-literal values, a `string` guard, trees other than `src/`
(`hooks/`, `scripts/`, `plugins/` are unscanned), and code inside a
`${…}` interpolation.

---

## 2. Censuses and their obligations

Thirteen enforced gates. Each one is a test that reads the source tree
and fails by NAME, not by count.

| Census | Path | Population | Registry lives in |
|---|---|---|---|
| verdict vocabulary | `tests/core/architecture/verdict-vocabulary-census.test.ts` | four-piece vocabularies in `src/` | the test (`CENSUS`, :411) |
| write-site | `tests/core/architecture/write-site-census.test.ts` | direct `node:fs` content writes that can address the vault | the test (`DIRECT_WRITE_EXCLUSIONS`, :243) |
| destructive-site | `tests/core/architecture/destructive-site-census.test.ts` | removal/displacement calls under `src/core/brain/` | **src** (`src/core/brain/destructive-sites.ts:125`) |
| egress | `tests/core/architecture/egress-census.test.ts` | modules declaring an out-of-vault destination | **src** (`src/core/egress/registry.ts:85`) |
| progress (source) | `tests/core/architecture/progress-census.test.ts` | options types accepting a `Safeguard` | the test (`DECLARED_EXEMPTIONS`, :106) |
| progress (execution) | `tests/cli/progress-emitter-census.test.ts` | every `progressCounter(` call site in `src/` | the test (`EMITTERS`, :201) |
| import cycles | `tests/core/architecture/import-cycles.test.ts` | the `src/` module graph | none |
| layering | `tests/core/layering.test.ts` | `src/core/` | none |
| doctor exit codes | `tests/core/brain/doctor-exit-census.test.ts` | doctor checks | see §7 |
| config template ratchet | `tests/core/brain/config-template-ratchet.test.ts` | `_brain.yaml` schema vs template | see §6 |
| help-surface parity | `tests/cli/help-surface-parity.test.ts` | the CLI command manifest | see §5.7 |
| manifest completeness | `tests/cli/manifest-completeness.test.ts` | the four CLI dispatchers | the test (four empty unlisted tables, `:50-62`) |
| terminal-state | `tests/cli/terminal-state-census.test.ts` | every CLI terminal state | the test (`CLASSIFIED_BY_MODULE_WALK`, `:33-37`) |

Note the asymmetry, because it will trip someone: the write-site
exclusions and the progress exemptions live **in the test file**, while
the destructive-site and egress registries live **in `src/`** and are
imported by their tests. When you add a declaration, put it where that
census keeps it.

### 2.1 Write-site census

`tests/core/architecture/write-site-census.test.ts`.

Population (docblock :20-29): a module is in population when it lives
under `src/core/brain/`, `src/core/search/`, `src/cli/brain/`, `src/mcp/`
(`:77-82`), or is `src/core/vault.ts` / `src/core/fs-atomic.ts`
(`:85-88`), or imports `paths.ts` from anywhere (`:91`).

A WRITE is a content write bound from `node:fs` / `node:fs/promises`:
the closed call list is at `:97-120` and includes `writeFileSync`,
`appendFileSync`, `renameSync`, `rmSync`, `unlinkSync`, `cpSync`,
`createWriteStream`, `chmodSync`, `symlinkSync` and the promise twins.
`mkdirSync` is deliberately NOT a write (`:31-41`). `Bun.write` is matched
on the receiver (`:51-52`).

Assertions (`:824-871`):
- every direct-fs write site carries an entry in `DIRECT_WRITE_EXCLUSIONS`
  (`:825`);
- no exclusion outlives its site (`:833`);
- the entry's `calls` array equals exactly the calls found, sorted
  (`:839-853`) — a NEW KIND of write in an already-excused file is a new
  decision;
- every entry has a non-empty `reason` and at least one category
  (`:855`).

**Obligation on a new feature:** route vault writes through the shared
writers (`src/core/fs-atomic.ts`, `src/core/vault.ts`). If you cannot,
add a `DIRECT_WRITE_EXCLUSIONS` entry at
`tests/core/architecture/write-site-census.test.ts:243` with
`categories` drawn from the closed `WRITE_CATEGORY` vocabulary (`:201-218`
— `shared-writer-itself`, `append-only-ledger`, `lifecycle-move`,
`retention-delete`, `machine-artifact`, `lock-primitive`,
`archive-transfer`, `metadata-only`), the exact sorted `calls`, and a
non-empty `reason`.

### 2.2 Destructive-site census

`tests/core/architecture/destructive-site-census.test.ts`, registry at
`src/core/brain/destructive-sites.ts:125`.

Rule (docblock `:11-15`): a removal site under `src/core/brain/` is either
routed through the destructive gate, or it carries a
`DESTRUCTIVE_SITES` entry — **never both, never neither**. Gating is per
SITE, not per file (`:57-60`): a `withDestructiveSnapshot(` in a comment
gates nothing (`:848`), and a function handed to the gate by name is not
lexically gated (`:858`).

`DestructiveSiteDeclaration` at `src/core/brain/destructive-sites.ts:87-94`:
`calls: ReadonlyArray<string>`, `recovery: RecoverabilityFacts`,
`reason: string`.

Assertions (`:570-678`):
- every ungated removal site is declared (`:571`);
- a fully gated site must NOT also carry a declaration (`:579`);
- no declaration outlives its site (`:589`);
- the declaration's `calls` equal exactly the ungated calls found (`:595`);
- every reason is at least `DESTRUCTIVE_SITE_MIN_REASON_LENGTH` = **60**
  characters (`src/core/brain/destructive-sites.ts:84`, asserted at
  `:614-620`);
- **no two sites share a reason** (`:622-635`) — pasting one sentence
  across entries is the cheapest fake and is detected;
- every declaration classifies to a verdict from `RECOVERABILITY_STATE` /
  `RECOVERY_COVERAGE` / `RECOVERABILITY_BLOCKER`, frozen (`:637-651`);
- a site with `recoveryPoint: false` may not reach `covered` or `partial`
  (`:653-667`);
- vacuity floors: tree > 250 files, rows > 28, declarations > 25
  (`:669-678`).

**Obligation:** any new `unlinkSync` / `rmSync` / `renameSync` under
`src/core/brain/` must go through `withDestructiveSnapshot(` or gain a
declaration with a ≥60-character reason nobody else has written.

### 2.3 Egress census

`tests/core/architecture/egress-census.test.ts`, registry at
`src/core/egress/registry.ts:85` (`EGRESS_SITES`), entry interface at
`src/core/egress/registry.ts:64-74` (`id`, `verb`, `module`, `redaction`,
`reason`).

Population, two rules (`:23-48`): (1) a module declaring a string
parameter named `out` / `outdir` / `dest` / … is in population by the
declaration alone; (2) an ambiguous name (`file`, `path`, `to`, `report`)
counts when the same module also writes bytes. Rule 2 is the route that
reaches the MCP surface, because an MCP tool declares its destination as
an `inputSchema` property with the same `name: { type: "string" }` shape
(`:43-45`).

Assertions (`:190-280`): every module in population is declared (`:191`);
no declaration outlives its module (`:197`); an entry declared as
redacting actually calls the shared guard (`:204`); every declared
destination in a redacting module is matched by a guard call (`:217`);
no entry understates what its module does (`:241`); every entry has an
`id`, a `verb` and a non-empty `reason` (`:262`); ids and module paths
are unique (`:270`).

**Obligation:** any new verb or MCP tool that writes vault-derived bytes
to an operator-named path must call the shared redactor and add an
`EGRESS_SITES` entry.

### 2.4 Progress source census

See §3.4.

### 2.5 Progress emitter (execution) census

See §3.5.

### 2.6 Import cycles

`tests/core/architecture/import-cycles.test.ts`. `src/` carries no import
cycle (`:220`). `import type … from` **IS** an edge (`:24-28`, asserted at
`:240`); a deferred `await import("…")` is **NOT** (`:30-35`, asserted at
`:250`) and is the sanctioned cure. Non-vacuity assertion at `:224`.

**Obligation:** a new module that closes a loop fails here. The fix is a
leaf module that imports nothing from the layer above it, or a deferred
`await import(…)`.

### 2.7 Layering

`tests/core/layering.test.ts:20-24`. `src/core/**` may never contain
`process.exit`, `process.stdout.write`, or `console.log(` on a
non-comment line. `process.stderr.write` and `console.error` remain
allowed and are the house fail-soft pattern (`:6-7`) — `progress.ts:283`
uses exactly that.

**Obligation:** core emits, the CLI prints and exits. A new core module
that wants to say something says it through a callback or on stderr.

---

## 3. The progress contract (v1.48.0)

`src/core/brain/progress.ts`.

### 3.1 Vocabularies

- `PROGRESS_SCHEMA = "o2b.progress.v1"` (`:56`) — the envelope
  discriminator, present on every event.
- `PROGRESS_KIND` (`:66-92`): `started`, `advanced`, `refused`,
  `stopped`, `finished`.
- `PROGRESS_REASON` (`:100-147`): `aborted`, `timed-out`,
  `transport-single-response`, `stream-buffered`, `failed`.
- `OPERATION` (`src/core/brain/safeguard.ts:52-59`): `dream`, `reindex`,
  `bridges`, `clusters`, `maintenance`, `architect`. This is the
  repository's own statement of what is long, and it is shared by the
  timeout ladder and the progress spine so the two cannot disagree
  (`verdict-vocabulary-census.test.ts:822-832`).

`ProgressEvent` (`src/core/brain/progress.ts:153-172`): `schema`,
`operation`, `kind`, `stage`, `completed`, optional `total`, optional
`reason` (present only on `stopped` and `refused`).

`ProgressSink = (event: ProgressEvent) => void` (`:175`) — **synchronous
by construction**, and the census asserts the declaration itself never
mentions `Promise<` (`progress-census.test.ts:1029-1041`).

### 3.2 The counter

`progressCounter(operation, sink, opts)` (`src/core/brain/progress.ts:235`)
returns `{ start, advance, finish, stop }` (`:185-194`). It keeps the
per-stage counter so no call site does. Enforced invariants:

- `total` must be a non-negative integer or absent — otherwise
  `RangeError` (`:228-233`);
- `advance(by)` must be a positive integer — otherwise `RangeError`
  (`:300-305`);
- `advance` before any `start`, or naming a different stage than the
  current one, throws (`:306-311`);
- any call after `finish`/`stop` throws: a run ends **once**
  (`:246-256`, 291, 299, 316, 321);
- absence of a sink means nobody asked; it is not a swallowed event
  (`:16-17`, and `emit` returns early at `:259`).

### 3.3 The sink-error policy

`emit` wraps `sink(event)` in try/catch (`src/core/brain/progress.ts:269-286`).
On a throw: the sink is **detached for the rest of the run**
(`live = false`, `:272`), the error is reported **once**, and the run
continues. If `opts.onSinkError` is supplied it receives the error;
otherwise the default writes one line to **stderr**:

```
progress: <operation> stream detached after the sink threw: <message>
```

The default is deliberately the safe one (`:210-217`): a rule every
caller must remember is a rule five of six callers will forget. Do not
re-implement this policy at a call site.

### 3.4 `withProgress` — the termination rule

`withProgress(counter, body)` (`:343-352`) and `withProgressAsync`
(`:355-367`) run `body`, call `counter.finish()` on success, and on a
throw call `counter.stop(progressReasonForError(error) ?? PROGRESS_REASON.failed)`
and rethrow. `progressReasonForError` (`:379-383`) maps
`SafeguardAbortError → aborted` and `SafeguardTimeoutError → timed-out`,
`null` otherwise.

The rule: **a stream that simply stops arriving is the shape of a
completed run, a crashed run and a hung run at once** (`:331-334`). Every
emitter must terminate exactly once. Use `withProgress`; do not hand-roll
the try/catch.

### 3.5 The rule the progress census enforces

`tests/core/architecture/progress-census.test.ts`, docblock `:12-17`:

> **a type that takes a safeguard takes a progress sink, or carries a
> written reason why it cannot.**

Assertions (`:977-1042`):
- every options type accepting a `Safeguard` accepts a progress sink,
  unless it is in `DECLARED_EXEMPTIONS` (`:978-987`; population must be
  non-empty);
- the parser sees every module that declares a safeguard, cross-checked
  against a naive search (`:989-996`);
- every exemption names a type that still exists (`:998`);
- every exemption's reason is **≥ 80 characters** and contains no
  `TODO` / `for now` / `later` (`:1004-1012`);
- **no stage is prose**, wherever the emitter keeps it (`:1014-1019`).
  The identifier shape is `/^[a-z0-9]+([-_][a-z0-9]+)*$/`
  (`progress-census.test.ts:114`). Inline literals, bare `const`s, frozen
  objects and `stage:` fields on hand-built events are all read, and an
  argument that resolves to none of those is REPORTED, not skipped
  (`:26-28`);
- the sink is synchronous everywhere it is declared (`:1021-1027`);
- `ProgressSink` itself promises nothing (`:1029-1041`).

There is exactly one exemption today: `EmbeddingPhaseOptions`
(`progress-census.test.ts:106-111`).

The execution census `tests/cli/progress-emitter-census.test.ts`
enumerates every `progressCounter(` call site in `src/` by
`<path under src/>#<enclosing top-level function>` (`:152-181`) and
requires each to appear in `EMITTERS` (`:201-242`) with an `entryPoint`,
an `operation`, and a discriminating `stage` witness. It then **drives
each entry point for real** with `--progress` and asserts records arrived,
that there is exactly one terminator, and that it is last (`:367-412`).

### 3.6 What a NEW long operation in this release must do

1. Add the operation to `OPERATION` / `OPERATIONS` in
   `src/core/brain/safeguard.ts:52-71` if it is genuinely a new long
   operation, and register the vocabulary change is already covered
   (`OPERATION` is registered at
   `verdict-vocabulary-census.test.ts:828-831`).
2. Put `readonly onProgress?: ProgressSink;` on the SAME options
   interface that carries `safeguard`, optional and readonly, invoked
   with `?.` — the house idiom (`src/core/brain/progress.ts:13-17`).
   Anything else fails `progress-census.test.ts:978`.
3. Build the counter with `progressCounter(OPERATION.x, opts.onProgress)`.
   Do **not** pass `onSinkError` unless you have somewhere better than
   stderr; the default is already safe.
4. Wrap the body in `withProgress` / `withProgressAsync` so the stream
   terminates exactly once.
5. Name every stage as a lowercase kebab/underscore identifier. No
   sentences, no spaces, no capitals.
6. Give the operation a CLI entry point that accepts `--progress`, then
   add the call site to `EMITTERS` in
   `tests/cli/progress-emitter-census.test.ts:201` and a driver to
   `ENTRY_POINTS` (`:265`), with a `(entryPoint, operation, stage)`
   witness that is unique across all emitters (`:363-364`).
7. If the emitter's fixture needs a vault, extend the `beforeAll` at
   `tests/cli/progress-emitter-census.test.ts:284-326`.

---

## 4. MCP surface

### 4.1 Registration

One assembly point: `buildToolTable(scope)` at `src/mcp/tools.ts:438`, whose
array literal begins at `src/mcp/tools.ts:439`. It composes five inline
entries (`second_brain_capabilities` `:440-451`, `second_brain_status`
`:452-468`, `second_brain_query` `:469-491`, `vault_health` `:497-511`,
`brain_artifact_get` `:512-529`) plus five spread slices: `...BRAIN_TOOLS`
(`:495`), `...SEARCH_TOOLS` (`:496`), `...SCHEMA_TOOLS` (`:530`),
`...WATCHDOG_TOOLS` (`:531`), `...SKILL_TOOLS` (`:532`). `tool_hydrate` is
pushed last for non-writer scopes over a late-bound getter (`:538`).

Slice arrays — this is where you actually add an entry:

- `BRAIN_TOOLS` = 31 per-domain arrays concatenated at
  `src/mcp/brain-tools.ts:48-80`, imports at `:13-43`. Per-domain exports
  such as `LANDSCAPE_TOOLS` at `src/mcp/brain/landscape-tools.ts:27`,
  `NOTES_TOOLS` at `src/mcp/brain/notes-tools.ts:391`.
- `SEARCH_TOOLS` `src/mcp/search-tools.ts:1730`; `SCHEMA_TOOLS`
  `src/mcp/schema-tools.ts:56`; `WATCHDOG_TOOLS`
  `src/mcp/watchdog-tools.ts:5`; `SKILL_TOOLS` `src/mcp/skill-tools.ts:123`.

Canonical smallest complete entry:
`src/mcp/brain/landscape-tools.ts:27-59` (handler signature at `:12`).

Scope filtering happens AFTER assembly (`src/mcp/tools.ts:534-544`):
`writer` filters to `WRITER_TOOL_NAMES` (`:421-427`, five names) and never
gets `tool_hydrate`; `catalog` shallow-clones everything outside
`CATALOG_ADVERTISED_NAMES` (`:432-436`) with `hidden: true` — still
callable, not listed. Dispatch is `findTool` (`:547-560`); an unknown name
in `REMOVED_TOOLS` throws `INVALID_PARAMS` naming the replacement
(`:552-555`), otherwise `METHOD_NOT_FOUND` (`:557`).

Server wiring: `MCPServer` calls `evaluateToolCapabilities(buildToolTable(...))`
at `src/mcp/server.ts:123-129`; `tools/list` filters `hidden !== true`
(`:320-333`); `tools/call` is `:352-386`; every handler passes through the
single seam `invokeToolHandler` (`:199-226`), which runs
`assertKnownArguments(tool, args)` FIRST (`:204`).

Result envelope: `buildMcpToolResult` (`server.ts:461-474`) validates the
output contract (`:466`), stringifies with a key-sorting replacer
(`:467,483-489`), applies the preview budget (`:468`). Errors go through
`toolError` (`:476-481`) — `isError: true`, message in `content[0].text`,
**no** `structuredContent`. An `MCPError` is re-thrown as a JSON-RPC error
instead (`:379`).

### 4.2 The tool contract

`interface ToolDefinition` at `src/mcp/tool-contract.ts:64-106`:

| Field | Line | Required | Meaning |
|---|---|---|---|
| `name: string` | `:65` | yes | registry key |
| `description: string` | `:66` | yes | advertised; ≤ 300 chars; line 1 becomes the catalog line |
| `inputSchema: Record<string, unknown>` | `:67` | yes | object-rooted, `properties`, `additionalProperties: false` |
| `outputSchema?: OutputSchema` | `:68` | no | validated on every response at request time |
| `previewBudget?: number` | `:69-77` | no | over-budget results are parked in the artifact store; no budget = never truncated |
| `hidden?: boolean` | `:78-83` | no | callable, omitted from `tools/list` |
| `handler(ctx, args, onProgress?)` | `:85-105` | yes | third parameter is per-REQUEST; a two-parameter handler still satisfies the type |

`ToolScope = "full" \| "writer" \| "catalog"` at `:19`. `ServerContext` at
`:35-62` — note `agentName` (`:46-61`) is a **getter** on the live server
(`server.ts:167-169`) that re-resolves per access and throws
`ConfigReadError` on an unreadable config; touch it only if the tool
genuinely needs identity.

Reuse the coercion helpers in `src/mcp/coerce.ts` (`coerceStr:11`,
`coerceInt:36`, `coerceBool:53`, `AGENT_SCOPE_SCHEMA:98-102`,
`coerceAgentScope:115`, `coerceIsoDate:125`).

### 4.3 Schema-completeness rules

`src/mcp/registry-guard.ts` — test-time only (`:44-46`); the request-path
counterpart `src/mcp/argument-guard.ts` READS the
`additionalProperties: false` this audit guarantees (`:14-17,70`).

Caps: `TOOL_DESCRIPTION_MAX = 300` (`:51`),
`PROPERTY_DESCRIPTION_MAX = 160` (`:52`),
`EXEMPTION_REASON_MIN = 10` (`:59`). There is deliberately NO exemption
table for descriptions (`:39-42`).

`SCHEMA_NODE_KIND` (`:66-75`): `root`, `property`, `items`, `values`.
`SCHEMA_COMPLETENESS_RULE` (`:188-203`), each enforced in `auditNode`
(`:263-313`):

| Rule | Value | Enforced | Rule |
|---|---|---|---|
| `nonObjectRoot` | `non-object-root` | `:284-286` | root must be exactly `type: "object"` |
| `missingProperties` | `missing-properties` | `:287` | root must carry a `properties` object (may be `{}`) |
| `openRoot` | `open-root` | `:288-290` | root must declare `additionalProperties: false` |
| `missingDescription` | `missing-description` | `:293-298` | every `property`-kind node needs a non-blank string `description` (only property nodes — not root, items, or values) |
| `missingType` | `missing-type` | `:300-302` | EVERY node must declare `type` or `enum` |
| `undeclaredRequired` | `undeclared-required` | `:304-312` | every `required` entry must name a property that node declares |
| `unsupportedComposition` | `unsupported-composition` | `:269-278` | `oneOf`, `anyOf`, `allOf`, `$ref` and tuple-form `items: [...]` are all rejected |

Scope is INPUT schemas only (`auditSchemaCompleteness` `:251-261`;
rationale `:238-250`).

Preview budgets: `PREVIEW_BUDGET_EXEMPT` name→reason map at `:327-401`;
`auditPreviewBudgets` (`:423-438`) reports unbudgeted-and-unexempted,
stale exemptions, and exemptions naming dead tools. Default constant
`MCP_PREVIEW_BUDGET = 2000` at `src/mcp/preview-budget.ts:23`.

### 4.4 How the catalog documents itself

Three surfaces, no per-tool metadata beyond name and description.

1. `second_brain_capabilities` — `evaluateToolCapabilities`
   (`src/mcp/capabilities.ts:27-69`) walks the table and emits
   `{scope, server_name, static_tool_count, available_tool_count,
   available[], withheld[]}`. Always available, never counted against
   `maxTools` (`:40-47`). A new tool appears automatically.
2. `tool_hydrate` — `src/mcp/hydrate-tool.ts:23`, built over a late-bound
   getter (`:32-81`). No args → `{count, catalog:[{name, description,
   group}]}` (`:50-61`); `names: [...]` → full schemas plus a per-name
   `unknown` list (`:62-78`).
3. `toolDescriptors` — `src/core/surface/descriptor.ts:67-81`. Two
   derivations to design around:
   - `description` = `firstLine(t.description)` (`:74`, `firstLine` at
     `:40-46`). **Put the summary sentence first; the catalog shows only
     line 1.**
   - `group` = `surfaceGroup(name)` (`:56-60`): `second_brain_*` → `core`;
     first `_`-segment in `GROUP_PREFIXES = ["brain","schema"]` (`:48`) →
     that prefix; everything else → `core`. **The name prefix is the only
     grouping mechanism.** `tags` is always `[]` for tools (`:76`).

To be always-loaded on the writer server: add to `WRITER_TOOL_NAMES`
(`src/mcp/tools.ts:421-427`) AND to `WRITER_SET` in
`src/mcp/profiles.ts:30-36` — the profile copy is separate and
hand-maintained. Profiles are `TOOL_SURFACE_PROFILES` at
`profiles.ts:38-77`; `recall` (`:59-66`) and `minimal` (`:74`) carry
hardcoded allow-lists, so a new tool is withheld from those hosts unless
added. Unknown profiles fail OPEN to full (`:121-145`).

**There is no tool-annotation surface.** No `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint` or `annotations`
anywhere in `src/`, `tests/` or `docs/`. Read-only-ness is conveyed as
prose in the description, e.g. `landscape-tools.ts:31` ends "Read-only.".

### 4.5 `_meta.progressToken` after v1.48.0

`readProgressToken(params)` at `src/mcp/progress.ts:97-114`. `_meta`
absent → `undefined` (`:99`); `_meta` non-object → `INVALID_PARAMS`
(`:100-105`); `_meta` without a token → `undefined`, not an error
(`:106-107`); the token is a string or an INTEGER number only (`:108-109`),
anything else → `INVALID_PARAMS` naming what arrived (`:110-113`).
`type ProgressToken = string | number` (`:61`).

Server plumbing in `handleToolsCall` (`src/mcp/server.ts:352`):

1. `readProgressToken(params)` at `:366`, deliberately BEFORE the handler
   runs (`:363-365`);
2. `progressSink(token, this.sendNotification)` at `:367`
   (`progress.ts:149-155` returns `undefined` when there is no token or no
   writer);
3. when the transport cannot carry it,
   `progressRefusal(token, PROGRESS_REASON.transportSingleResponse)` at
   `:371-374` (shape at `progress.ts:158-165`);
4. the sink is handed to the handler through the single seam at `:376`,
   forwarded to `tool.handler(this.context, args, onProgress)` at
   `:205,209`;
5. the refusal is attached to BOTH success and error envelopes
   (`:377,384`); `withProgressRefusal` (`progress.ts:173-179`) returns the
   result untouched when there is no refusal, so a call that asked for
   nothing is byte-identical to v1.47.

Wire format: `PROGRESS_NOTIFICATION_METHOD = "notifications/progress"`
(`progress.ts:46`); namespaced meta key
`PROGRESS_META_KEY = "open-second-brain/progress"` (`:53`); frame builder
`progressNotification` (`:125-139`) emits the spec fields `progressToken`,
`progress` (= `event.completed`), optional `total`, plus the typed event
under `_meta[PROGRESS_META_KEY]`.

`sendNotification` is an optional runtime option (`server.ts:67-81`):
stdio supplies it, HTTP does not — which is exactly what turns an HTTP
token into a NAMED refusal rather than a silent drop (`progress.ts:11-21`).

A long-running new tool must:

1. declare `onProgress?: ProgressSink` as the third handler parameter
   (pattern: `src/mcp/brain/feedback-tools.ts:346-350`,
   `src/mcp/brain/admin-tools.ts:253`);
2. forward it conditionally into the core options object:
   `...(onProgress ? { onProgress } : {})` (`feedback-tools.ts:429,522`,
   `admin-tools.ts:307`);
3. if it is a `view` dispatcher, use
   `dispatchByView(table, ctx, args, onProgress)`
   (`src/mcp/brain/shared.ts:207-231`; the docblock at `:196-206` names
   dropping the sink as the exact defect to avoid);
4. bound the call with a safeguard from
   `safeguard_timeout_<operation>_seconds`
   (`feedback-tools.ts:427` uses `toolSafeguard(ctx, OPERATION.dream)`).

### 4.6 Every test a NEW MCP tool must satisfy

- `tests/mcp/registry-guard.test.ts` — description caps (`:43-49`),
  `previewBudget` or an exemption (`:53-56`), no stale exemptions
  (`:58-62`), reason length (`:64-68`), **zero completeness violations
  across the whole table** (`:126-128`).
- `tests/mcp/agent-scope-matrix.test.ts` — the strictest gate.
  `:301-309` requires `SCOPED_SURFACES` (`:66-81`) ∪ `UNSCOPED_CONTENT`
  (`:88-114`) ∪ `NON_CONTENT` (`:117-206`) to equal the full tool table in
  BOTH directions. `:313-315` is
  **`expect(TOOLS.length).toBe(110)`** — the only hardcoded tool count in
  the suite. `:317-330` requires argument-scoped surfaces to declare
  `agent_scope`.
- `tests/mcp/brain-tools-parity.test.ts` — `FROZEN_BRAIN_TOOL_NAMES` at
  `:61-154` (93 names) must equal `BRAIN_TOOLS` exactly (`:157-160`);
  no duplicates (`:162-165`); every tool has a function handler and a
  defined `inputSchema` (`:167-172`).
- `tests/mcp/mcp.test.ts:170-353` — `tools/list` names must EQUAL an
  exhaustive inline array of all 110 names; `:351-353` every advertised
  `inputSchema.type === "object"`. `:569-593` pins the error shape:
  `isError: true`, no `structuredContent`, `content[0].text` containing
  `"<tool> output contract failed"`.
- `tests/mcp/catalog-scope.test.ts` — advertised set (`:28-32`), catalog
  length equals full length (`:34-40`), and `:62-63` every description's
  first line is non-empty and single-line.
- `tests/mcp/scope-filter.test.ts:27-40` — writer-scope entries must be
  the SAME object instances as full scope, so never clone in a filter.
- `tests/mcp/profiles.test.ts:56-73` — `minimal` equals exactly 7 names.
- `tests/mcp/argument-guard.test.ts`, `tests/mcp/output-contract.test.ts`,
  `tests/mcp/consolidated-tools.test.ts:239-270`,
  `tests/mcp/removed-tools.test.ts`,
  `tests/mcp/runtime-capabilities.test.ts`,
  `tests/mcp/brain.test.ts:816-1026`,
  `tests/cli/mcp-writer-probe.test.ts:35-42`,
  `tests/openclaw/bundle.test.ts:37-48`.
- `tests/mcp/long-running-tools.test.ts` and
  `tests/mcp/progress-token.test.ts` for anything that takes a token.
- `src/mcp/` is a declared vault-write root
  (`write-site-census.test.ts:81`), so a direct `node:fs` write in a new
  tool module needs an exclusion entry.
- Import types from `./tool-contract.ts`, never from `./tools.ts` — that
  is the whole reason the contract module exists
  (`src/mcp/tool-contract.ts:1-13`), and `import-cycles.test.ts` is what
  catches the mistake.

### 4.7 Hardcoded lists to update, loudest first

1. `tests/mcp/agent-scope-matrix.test.ts:314` — the `110` count.
2. `tests/mcp/agent-scope-matrix.test.ts` — classify the name into
   exactly one of the three tables.
3. `tests/mcp/brain-tools-parity.test.ts:61-154` — add alphabetically,
   extend the header rationale at `:1-55`.
4. `tests/mcp/mcp.test.ts:180-346` — the exhaustive `tools/list` array.
5. `src/mcp/registry-guard.ts:327-401` — set `previewBudget` or add an
   exemption with a > 10-char reason.
6. Only if writer/catalog/profile-scoped: `src/mcp/tools.ts:421-427`,
   `:432-436`, `src/mcp/profiles.ts:30-36`, `:59-66`, `:74` — and then
   also `tests/mcp/scope-filter.test.ts:18-24`,
   `tests/mcp/catalog-scope.test.ts:18-26`,
   `tests/mcp/profiles.test.ts:64-72`,
   `tests/mcp/brain.test.ts:1013-1025`,
   `tests/cli/mcp-writer-probe.test.ts:36-42`.
7. `docs/mcp.md:145+` Tool Highlights table (documentation only, not
   test-enforced) and `CHANGELOG.md`.

There is no `.snap` file and no generated tool manifest.

---

## 5. CLI surface

### 5.1 Registration — three switch dispatchers plus a parallel manifest

There is no registry object. "The dispatcher is a small `switch`
statement, not a registry" (`src/cli/main.ts:7-8`). Four enumerable
levels, all four named as the authoritative population by
`tests/cli/manifest-completeness.test.ts:140-167`:

| Level | Dispatcher |
|---|---|
| `o2b <cmd>` | `src/cli/main.ts:964-1028` |
| `o2b brain <verb>` | `src/cli/brain.ts:174-461` (~140 verbs; ratchet floor > 130 at `manifest-completeness.test.ts:216`) |
| `o2b search <verb>` | `src/cli/search.ts:31-48` (`KNOWN_VERBS`) and `:61-97` (switch) |
| `o2b partner codegraph <verb>` | `src/cli/partner.ts` (frozen `CODEGRAPH_VERBS`) |

The machine-readable half is `src/cli/command-manifest.ts`. Types at
`:1-12`; one entry's shape at `:42-46`; constructors `command(...)`
`:717-729` and `flag(name, type)` `:731-733`; `--json` is injected onto
every node by `addInheritedFlags` (`:734-754`), exposed through
`manifestForJson()` (`:653-655`).

**A new top-level verb must supply:**

1. a `case` before `default:` in `src/cli/main.ts:964-1013` (the census
   parser bounds on `default:` —
   `manifest-completeness.test.ts:74-81`);
2. a handler taking `argv: string[]`, parsing via `parseFlags(argv,
   schema)` (`src/cli/argparse.ts:38`);
3. a `command(...)` node with a **non-empty** summary
   (`manifest-completeness.test.ts:298-302`) declaring EVERY flag it
   parses with the matching type;
4. a `--json` ownership decision (§5.2);
5. a terminal-state class (§5.7).

**A new brain verb additionally must:**

1. live in `src/cli/brain/verbs/<new>.ts`;
2. be re-exported from the barrel `src/cli/brain/verbs/index.ts`;
3. have a `case` in `src/cli/brain.ts:174-456`;
4. have a `command(...)` node under the `brain` node;
5. have a line in `BRAIN_HELP` **and** an entry in `VERB_HELP`
   (`src/cli/brain/help-text.ts:31+` and `:176`). An unmatched
   `VERB_HELP[verb]` dumps the whole `BRAIN_HELP` and returns **2**, so
   `o2b brain <new> --help` is a usage error until you add it
   (`src/cli/brain.ts:163-171`);
6. import helpers ONLY through `src/cli/brain/helpers.ts` — "never
   directly from `../argparse.ts`, `../output.ts`, `../coerce.ts`, or
   `../helpers.ts`" (`:4-11`).

A new search verb must be added to **both** `KNOWN_VERBS`
(`src/cli/search.ts:31-48`) and the switch (`:61-97`) — asserted equal at
`manifest-completeness.test.ts:221-228` — plus the `COVERED` table in
`tests/cli/search-query-flag-manifest.test.ts:32-45`.

### 5.2 `--json`

Acceptance is structural: `parseFlags` injects a boolean `json` into any
schema that omits it (`src/cli/argparse.ts:39-40`), so no verb can reject
`--json` as unknown. That backs the banner claim at
`src/cli/help-render.ts:60-62`.

Two families, one fact table. `ownsInternalJson(command, rest)`
(`src/cli/json-helpers.ts:68-73`) is "the single fact table behind two
questions" (`:60-67`): which invocations `main` must wrap, and which
stdout streams advisory chrome would corrupt. The set of 12
internal-JSON commands is at `:45-58` (`status, install, update,
tool-call, secrets, brain, search, vault, discipline, partner, doctor,
onboarding`), plus two argv-resolved extras: `mcp` only with `--probe`,
and `help` always (`:70-73`).

Everything else is wrapped: `src/cli/main.ts:957-961`.
`withJsonFallback` patches BOTH `process.stdout.write` and
`process.stderr.write` into accumulators for the whole run
(`json-helpers.ts:94-114`), restores in `finally`, then emits
`{ ok, command, code, stdout, stderr }` with `redactSecrets` applied
(`:116-120`, redaction at `:75-86,123-125`). Asserted at
`tests/cli/cli-json-contract.test.ts:35-47` and `:75-86`.

Semantic payloads use either `okJson(payload)` →
`{ ok: true, ...payload }` (`src/cli/output.ts:15-17`, the brain-verb
house style) or `JSON.stringify(payload, sortedReplacer, 2)`
(`src/cli/main.ts:102,216,403`).

`wantsJsonFlag(argv)` (`src/cli/main.ts:32-38`) is the raw-argv scan used
only at the two pre-parse call sites. **Never feed it to the rails**; they
require the verb's PARSED flag (`src/cli/advisory-rail.ts:22-25`).

**There is no per-verb `--json` census.** `cli-json-contract.test.ts`
samples four cases; `advisory-rail.test.ts:185-195` loops over
`COMMANDS_WITH_INTERNAL_JSON`. Known gaps: `o2b secrets --json` exits 2
because `cmdSecrets` dispatches on `argv[0]` before parsing
(`src/cli/main.ts:483-498`); search verbs have no per-verb `--help`.

If the verb has a registered diagnostic code, spread
`nextCommandField(code)` into the payload so `--json` carries the exit
under `next_command` (`src/core/brain/next-step.ts:80-99`; example
`src/cli/main.ts:101`; obligation stated at
`tests/cli/json-next-command.test.ts:1-20`).

### 5.3 The advisory rail

`src/cli/advisory-rail.ts` is the single emission point for every
forward-pointer line, "and through nothing else" (`:1-8`).

- Label `NEXT_STEP_LABEL = "next:"` (`:37`); line is
  `` `${NEXT_STEP_LABEL} ${step.nextCommand}` `` (`:91-93`).
- Stream is **stdout**, via `info()` (`:122`; `src/cli/output.ts:26-28`).
- **There is no parameter for prose.** The caller passes a diagnostic
  CODE, resolved through `resolveNextStep` (`:31,104`). A sentence passed
  where a code belongs resolves to nothing
  (`tests/cli/advisory-rail.test.ts:116-128`).
- `ADVISORY_OUTCOME` (`:53-60`): `emitted`,
  `suppressed-machine-stream`, `unregistered-code`. `AdvisoryEmission`
  (`:65-78`) is frozen and echoes the `code` back.
- `advisoryIsLegal(stream)` (`:85-88`): legal unless `jsonRequested` and
  the command owns internal JSON.
- `emitNextStep` (`:103-124`) never throws, and **suppression is not a
  drop** (`:26-28`) — the resolved step is still attached.
- `emitNextSteps` (`:142-161`) de-duplicates on the resolved COMMAND, not
  the code (`:126-140`).

Opt in with `emitNextStep("<registered-code>", { command, argv,
jsonRequested: Boolean(flags["json"]) })` — canonical
`src/cli/main.ts:120-126`, also `src/cli/brain/verbs/bridges.ts:145`.

Gating tests: `tests/cli/advisory-rail.test.ts` (365 lines) and
`tests/cli/advisory-claim-truth.test.ts` — **a registered terminal state
fires only where its claim holds** (`:1-15`). The trap for a new verb is
the audit at `:198-246`: a hardcoded `GUARDED` table of
`[file, code, guard]` triples (`:204-223`) asserting that EVERY
occurrence of a code string in that file is textually preceded by its
guard expression (`:232-234`). A new rail call site in an already-listed
file must add its guard text.

### 5.4 The progress rail

`src/cli/progress-rail.ts`.

- Stream is **stderr**, never stdout (`:14-16`, default writer
  `:158-160,203-205`). Format is **NDJSON**, one `JSON.stringify(event)`
  per line (`:123-125`), because a partial line is self-evidently partial
  (`:116-121`).
- `PROGRESS_OUTCOME` has exactly two members (`:55-81`): `emitted`
  (`:57`) and `suppressedBufferedStream` (`:80`). The comment at
  `:58-79` is load-bearing: **no shipped command reaches the second one
  today**, and the branch is kept because deleting it removes the check.
- The buffered-stream rule (`:109-112`) is the **exact inverse** of the
  advisory rule, deliberately (`:96-108`):

```ts
export function progressIsLegal(stream: ProgressStream): boolean {
  if (!stream.jsonRequested) return true;
  return ownsInternalJson(stream.command, stream.argv);
}
```

  Rationale: `withJsonFallback` accumulates stdout AND stderr, which makes
  an advisory line harmless but a progress line worthless — "not degraded,
  it is invisible until the run finishes and then dumped at once - which
  reads as though it had worked" (`:19-22`). The dependency is asserted,
  not trusted (`tests/cli/progress-rail.test.ts:92-113`).
- **There is no TTY detection in the progress rail.** No `isTTY`
  reference exists in the file. TTY sniffing lives only in the
  confirmation path (`src/cli/brain/verbs/lint.ts:25`, `page-dedup.ts:24`,
  `rollback.ts:162`, `upgrade.ts:72`, `merge.ts:68`,
  `import-claude-memory.ts:87`). Do not add it to a progress path.
- `attachProgress(stream, write = process.stderr.write)` (`:156-180`)
  returns a frozen attachment: refused →
  `{ outcome: suppressedBufferedStream, sink: undefined, reason:
  PROGRESS_REASON.streamBuffered }`; legal → `{ outcome: emitted, sink }`
  where the sink throws `TypeError` on an unknown `event.kind` (`:169-178`).
  `sink: undefined` on refusal is the house idiom for "nobody asked"
  (`:131-136`).
- `reportProgressRefusal(attachment | null)` (`:201-209`) writes
  `progress: not emitted (<reason>)` and must be called **before** the
  operation starts (`:190-195`).

Standard verb wiring, copy this shape
(`src/cli/brain/verbs/bridges.ts:151-176`):

```ts
const observation =
  flags["progress"] === true
    ? attachProgress({ command: "brain", argv: ["bridges"], jsonRequested: asJson })
    : null;
reportProgressRefusal(observation);
// …
...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
```

Progress is opt-in because attaching by default would change the stderr
of every existing invocation (`:152-155`). Shared search helper:
`observeIndexRun` at `src/cli/search/verbs/indexing.ts:98-107`. Declare
`flag("progress", "boolean")` in the manifest
(`src/cli/command-manifest.ts:538,548,592`).

### 5.5 Exit codes

There is **no single central registry**; codes are declared per surface
as frozen tables with a written cross-surface pinning discipline.

Dispatcher-wide (`src/cli/main.ts`): 0 success; **1 = "a machine that
cannot answer the question"** (`NoVaultConfiguredError`,
`ConfigReadError` — `:1019-1025,1030-1041`); **2 = "a mistake in the
argv"** (`CliError` — `:1014-1018,1033-1035`; unknown command
`:1009-1012`). Stated verbatim at `:1033-1035`.

| Table | Anchor | Members |
|---|---|---|
| `DOCTOR_EXIT` | `src/cli/main.ts:298-302` | `ok:0, failed:1, probeIncomplete:6`; precedence `:314-321` |
| `SEARCH_CHECK_EXIT` | `src/cli/search/verbs/check.ts:107-113` | `ok:0, fatal:1, providerUnreachable:5, probeIncomplete:6`; precedence `:129-144` |
| `MAINTENANCE_EXIT` | `src/cli/brain/verbs/maintenance.ts:81-86` | `ok:0, failed:1, usage:2, refused:7` (7 not 6, argued at `:55-80`) |
| `INSTALL_EXIT` | `src/cli/install/install.ts:58-65` | `ok:0, runtimeError:1, usage:2, drift:3, userModifiedBlock:4, mcpUnreachable:5` |
| signals | `src/cli/interrupt.ts:84-102` | `EXIT_INTERRUPTED=130`, `EXIT_TERMINATED=143` |

**Sub-dispatcher divergence, worth knowing:** `src/cli/brain.ts:462-467`
maps `CliError → 1`, while `src/cli/main.ts:1014-1018` maps
`CliError → 2` and `src/cli/search.ts:98-117` maps `CliError → 2`,
`SafeguardTimeoutError → 1`, `SearchError → 2 | 1`.

Rule for a new code (`main.ts:284-297`, `check.ts:100-106`,
`maintenance.ts:55-80`, enforced at `tests/cli/doctor-exit.test.ts:78-85`):

1. name it once in a frozen table with a
   `type X = (typeof X)[keyof typeof X]` alias;
2. **reuse the number if the meaning already exists** — one number means
   one thing across this CLI;
3. write the agreement assertion plus a uniqueness check;
4. follow `exitCodeForCheck` precedence — the proved fault keeps the
   generic code, the specific code never masks it;
5. never take 2 for anything but an argv error, nor 130/143.

### 5.6 The confirmation ladder and `--expect N` / `--strict`

The ladder, stated canonically at
`src/core/brain/notes/lifecycle.ts:19-22`, in execution order:

1. **Dry run is the default**; `--apply` / `--confirm` is required to
   mutate (`src/cli/brain/verbs/note-lifecycle.ts:14-17`,
   `forget-source.ts:5-11`).
2. **Preview, then guard, then mutate**: run the operation with
   `confirm: false` to compute the blast radius, assert the guard against
   it, and only then re-run with `confirm: true`
   (`src/cli/brain/verbs/forget-source.ts:51-71`).
3. **A second confirmation for the irreversible arm** — a named refusal,
   not a bare throw
   (`src/core/brain/notes/lifecycle.ts:775-781`, code in the closed
   vocabulary at `:313-314`).
4. **Non-interactive guard**: `--yes` is mandatory under `--json` or a
   non-TTY stdin (`src/cli/brain/verbs/lint.ts:25-27`, same shape in five
   other verbs).
5. **Recovery point**: `withDestructiveSnapshot(vault, reason, op, opts)`
   takes the archive BEFORE `op` runs
   (`src/core/brain/snapshot-gate.ts:360-377`); a throw in `takeSnapshot`
   aborts before any destructive work (`:366-369`).
6. **Report the verdict**: surface `recoverability.state` and `blockers`
   on both output shapes (`forget-source.ts:113-125`,
   `note-lifecycle.ts:43-47`).

`src/core/brain/count-guard.ts`:

- `CountGuardError` carries `code = "COUNT_GUARD"`, `matched`,
  `expected`, `matchList` (`:12-25`).
- `assertExpectedCount(opts)` (`:48-72`): `expected !== matched` →
  `--expect N but the operation matched M; aborting without writing.`
  (`:52-60`); `strict && expected === null && willMutate` →
  `--strict refuses a guardless mutation: pass --expect M …` (`:62-71`).
- The matched list is inlined, capped at `MATCH_LIST_PREVIEW = 20`
  (`:41,74-82`).
- Both guards default off, so a verb passing neither is byte-identical to
  before (`:8-9`).

CLI-side pattern: `expect: { type: "string" }`,
`strict: { type: "boolean" }`, then `Number(...)` with
`!Number.isInteger(n) || n < 0` → usage error
(`note-lifecycle.ts:106-107,123-127`, `forget-source.ts:23-24,35-43`).
Then `assertExpectedCount({ matched: preview.blastRadius, expect, strict,
willMutate: confirm, matchList: [...] })` (`forget-source.ts:58-68`) —
note `willMutate` is the confirm flag, not `true`.

**A new destructive verb must** take dry-run-by-default plus `expect` and
`strict`; compute the blast radius with a non-mutating probe; call
`assertExpectedCount` before any write; catch `CountGuardError` and
report it parseably under `--json`; put the removal lexically inside
`withDestructiveSnapshot(` if it lives under `src/core/brain/`, or accept
a `DESTRUCTIVE_SITES` entry (§2.2); and surface the recoverability
verdict.

Two gating subtleties from the destructive census: a removal extracted
into a named helper handed to the gate is **not** lexically gated and
must declare (`destructive-site-census.test.ts:65-73`, pinned `:858-868`);
a gate named only in a comment gates nothing (`:848-856`). The census
reaches only `src/core/brain/` (`:110-114`) — CLI verbs and the MCP
surface are a separate population, held by the write-site census instead.

### 5.7 Help-surface parity, and the terminal-state census

`tests/cli/help-surface-parity.test.ts`. The files that must agree are
exactly **two, both derived from one source**: the human `o2b help`
rendered by `src/cli/help-render.ts:110-118`, and `o2b help --json`
serialising `manifestForJson()` (`src/cli/main.ts:893-894`). Both derive
from `CLI_COMMAND_MANIFEST` (`src/cli/command-manifest.ts:26`).
**README.md, `skills/*`, `docs/cli-reference.md` and the plugin manifests
are NOT in this test.**

Assertions: path sets equal in both directions (`:87-95`); every summary
verbatim (`:97-108`); every declared flag list verbatim and in order
(`:110-124`); anti-vacuity `human.size > 180` and > 10 flagged entries
(`:126-131`); `o2b help --json` deep-equals `manifestForJson()`
(`:133-137`). Plus spot checks at `:140-172` and, at `:174-185`, an
unknown command's stderr must list EVERY top-level manifest command and
mention `o2b help`.

The parse contract: `ENTRY_RE` two-space indent and ≥ 2-space gutter
(`:31`), `FLAGS_RE` six-space indent (`:33`), matched by
`help-render.ts:51-55,84-88`. Inherited `--json` is excluded on both
sides (`:68-72`, `help-render.ts:69-73`).

**Do not hand-edit `help-render.ts`** — the human surface is derived, and
hand-editing it is the exact defect the derivation removed
(`help-render.ts:1-19`).

`tests/cli/terminal-state-census.test.ts` (573 lines) enumerates from the
same three dispatchers and requires each terminal state to hold exactly
one of three classes (`:1-21,75-79`): `names-an-exit` (detected by
`/emitNextSteps?\(/`, `:66`), `names-a-refusal` (detected by
`/\bfail\(|\bfailWith\(|usageError\(|CliError|throw new |process\.stderr\.write\(/`,
`:69-71`), or `deliberately-silent` — which currently has **zero
members** (`:531`). The import walk follows one hop into sibling modules
(`:24-38`), and anything classified only via that hop needs a
`CLASSIFIED_BY_MODULE_WALK` entry with a reason (`:33-37`, gated
`:456-481`). Floors: > 160 rows, > 8 exits, > 120 refusals (`:485-487`).

**Practical consequence: a new verb that can only `return 0` silently
fails this census by name** until it gains an exit, a refusal, or a
written exclusion.

`tests/cli/manifest-completeness.test.ts` closes the loop
dispatcher↔manifest in both directions (`:170-193`). The four
unlisted-exclusion tables (`:50-62`) are all currently **empty**, so any
exclusion is a new precedent and needs a reason of at least
`MIN_REASON_LENGTH = 10` chars (`:196-209`).

## 6. Config — adding a `Brain/_brain.yaml` key

### 6.1 Where the pieces live

- Typed shape: `BrainConfig` at `src/core/brain/types.ts:1577`; per-block
  optional members (e.g. `health?: BrainHealthConfig` at `:1669`), block
  types near `:1925` and `:1955`.
- Re-export surface: `src/core/brain/policy.ts:36-127` (pure re-exports;
  the implementation is split under `src/core/brain/policy/`, explained
  at `policy.ts:21-33`).
- Validator: `src/core/brain/policy/validate.ts:75`
  (`validateBrainConfigDetailed`); ordered block calls at `:98-122`;
  assembled literal at `:126-153`; mandatory `schema_version` seeded at
  `:91`; unknown top-level keys are a WARNING, never an error
  (`validate.ts:191`, `warnUnknownTopLevelKeys`).
- Key vocabulary, by construction:
  `src/core/brain/policy/key-index.ts:21` (`BrainConfigKeyIndex`),
  `:100` (`warnUnknownKeys`). Enumeration entry point used by the
  ratchet: `brainConfigKnownKeys()` at
  `src/core/brain/policy/validate.ts:220` — a two-pass probe (`:208-233`).

**Two homes for a default, and the distinction is load-bearing**:

1. Write-side (what `brain init` writes, and the merge base):
   `DEFAULT_BRAIN_CONFIG` at `src/core/brain/policy/defaults.ts:40`.
   Only the grandfathered live blocks are here.
2. Read-side (block absent → this table decides): beside the block
   parser in `src/core/brain/policy/blocks/*.ts`, e.g.
   `BRAIN_HEALTH_DEFAULTS` at
   `src/core/brain/policy/blocks/health.ts:54`, resolver `:68`, parser
   `:92`, sub-key registration `:124-129`.

`defaults.ts:5-8` states the rule: a read-side-only default must NOT go
in `defaults.ts`.

### 6.2 The template is generated TypeScript, not a file under `templates/`

There is no YAML config template on disk. `templates/` holds only
`brain-starter/`, `brain-explorer.html`, `identity-reminder.*` and
`install/`. The `_brain.yaml` template is generated by
`src/core/brain/config-template.ts`, terminating at
`src/core/brain/config-template.ts:676`
(`export const DEFAULT_BRAIN_CONFIG_YAML = renderBrainConfigTemplate();`).
Rationale for the location — a module-init cycle if it lived in the
config layer — at `src/core/brain/policy/defaults.ts:67-71`.

Structure:

- Emission vocabulary at `config-template.ts:83`:
  `"live" | "commented-default" | "commented-example"`, each meaning
  documented at `:72-82`.
- `BrainTemplateKey` at `:87`, `BrainTemplateBlock` at `:100`,
  `BrainTemplateOmission` at `:110`.
- Constructors: `live()` `:125`, `def()` `:134` (commented AT the
  resolver default), `example()` `:142` (no default exists; the value is
  an illustration).
- `BRAIN_CONFIG_TEMPLATE` at `:155` — the whole file, block by block.
  **Values are read from the default tables, never re-literalled**
  (e.g. `:180` reads `DEFAULT_BRAIN_CONFIG.dream.candidate_threshold`).
- The live/commented boundary is a literal comment line at `:275-276`.
  Above it: the seven grandfathered live blocks (`schema_version`,
  `primary_agent`, `dream`, `retire`, `confidence`, `snapshots`,
  `vault`). Below it: everything is commented.
- `BRAIN_CONFIG_TEMPLATE_OMISSIONS` at `:574` — one entry today,
  `hygiene.dedup_threshold` (`:576-581`).
- `renderBrainConfigTemplate({ allDefaultsLive? })` at `:642`.
- Rationale for commented-not-live (a live default pins today's value
  into every new vault and defeats a future default change) at `:16-41`.

### 6.3 The four ratchet assertions

`tests/core/brain/config-template-ratchet.test.ts`,
`describe("config template ratchet — coverage")`, `:192-240`:

1. `:197` every top-level key the resolver understands is templated or
   justified by an omission.
2. `:204` every sub-key the resolver understands is templated or
   justified (an omission may be keyed `block.sub` or the whole `block`,
   `:212`).
3. `:219` the template names no key the resolver does not understand —
   the reverse direction, top level and sub-key.
4. `:234` every omission carries a non-empty reason and is not also
   templated.

### 6.4 The commented-vs-live rule

`config-template-ratchet.test.ts:255-264`, test
`"newly exposed keys are emitted commented, never live"`: for every
template key whose `emit !== "live"`, no line of
`DEFAULT_BRAIN_CONFIG_YAML` may match `^\s*<key>\s*:`.

**A newly added key may only be `commented-default` or
`commented-example`.** Adding a `live()` key fails this test AND the
live-surface byte-identity test at `:251`, which compares
`liveSurface(DEFAULT_BRAIN_CONFIG_YAML)` against the v1.38.0 template
text inlined on purpose at `:68-112`.

Three further pinned properties in the same file: the generated YAML
round-trips with zero warnings (`:243`); resolved-behaviour identity
between `renderBrainConfigTemplate({ allDefaultsLive: true })` and a bare
`schema_version: 1` (`:268`, compared through the **hand-maintained**
`resolvedView` at `:132-190`); and a pre-generation config resolves
identically (`:274`).

### 6.5 Exact steps for a new sub-key `foo` on an existing block `X`

1. `src/core/brain/types.ts` — add the optional field to `BrainXConfig`
   (and to the resolved twin if the block has one).
2. `src/core/brain/policy/blocks/X.ts` — add the default to
   `BRAIN_X_DEFAULTS`, read it in `resolveX`, validate it in
   `parseXBlock`, and **add the key name to the `warnUnknownKeys(...)`
   known-list**. That call is what registers the sub-key in the key
   index; skip it and the validator accepts the key while
   `brainConfigKnownKeys()` never reports it, so ratchet assertion 3
   fires on the template entry.
3. Only if `brain init` must WRITE the key into a live block, also add it
   to `DEFAULT_BRAIN_CONFIG` (`policy/defaults.ts:40`). For a commented
   key, do not.
4. `src/core/brain/config-template.ts` — add
   `def("foo", <DEFAULT_FROM_THE_TABLE>, [...doc])` (or `example(...)`)
   to block `X`'s `keys` array in `BRAIN_CONFIG_TEMPLATE` (`:155`).
   **Never `live(...)`.** Import the default constant; do not repeat the
   literal. The alternative is a `BRAIN_CONFIG_TEMPLATE_OMISSIONS` entry
   (`:574`) with a substantive reason.
5. If the key participates in resolution, extend `resolvedView` in
   `tests/core/brain/config-template-ratchet.test.ts:132` (and its
   imports at `:33-59`), or the all-defaults-live identity test silently
   stops covering it.
6. For a NEW top-level block, additionally: write
   `policy/blocks/<block>.ts`, call its parser from
   `validate.ts:98-122`, spread it into the literal at `:126-153`,
   re-export from `policy.ts:36-127`, and add a whole
   `BrainTemplateBlock` with `emit: "commented-default"` or
   `"commented-example"`.
7. Run `bun test tests/core/brain/config-template-ratchet.test.ts
   tests/core/brain.policy.test.ts tests/core/brain/upgrade.test.ts`.

`upgrade.ts:357` (`mergeBrainYaml`) is purely additive (`:355`): missing
keys are appended or spliced; nothing is deleted, reordered, or
rewritten.

**Docs are not gated.** `README.md:31,125`,
`skills/open-second-brain/SKILL.md:15`, `docs/how-it-works.md`,
`docs/architecture.md`, `docs/updating.md` mention config keys in prose,
and no test asserts them against the schema. The generator plus the
ratchet is the only mechanized key inventory; prose is updated by
judgement.

---

## 7. Doctor — adding a check

### 7.1 Registry and check shape

`src/core/brain/doctor.ts` is the registry only (`:9-14`); the 20 check
modules live under `src/core/brain/doctor/`.

- `DOCTOR_CHECKS` at `src/core/brain/doctor.ts:134-170`, 30 entries.
  **Order is contract** (`:127-133`): findings report in discovery
  order, and `duplicateIdCheck` (`:141`) must follow the record checks
  that fill `ctx.idIndex`. Imports at `:49-92`.
- Run loop `:268-281`: a `failSoft: false` check propagates a throw out
  of `runDoctor`; `failSoft: true` is wrapped in try/catch.
- Two pre-registry early returns: unreadable Brain root `:209-227`,
  absent Brain root `:228-260` (`BRAIN_ROOT_ABSENT_CODE` at `:175`).
- `checkSemanticHealth` sits outside the registry at `:283-295`.

Contract at `src/core/brain/doctor/check.ts`: `DoctorCheckContext` `:23`
(note `now` at `:26` — read time from `ctx.now`, never `new Date()`, so
age lints are pinnable), `DoctorFindings` `:59` (two streams: `issues`
and `uncertain`), `DoctorCheck` `:64` (exactly `failSoft: boolean` and
`run(ctx, out): void`; the `failSoft` semantics are documented at
`:65-73`). `check.ts:8-9`: "A new check joins the pass by being added to
the registry array in `doctor.ts`."

Canonical simple check: `src/core/brain/doctor/config-checks.ts:27`.
Canonical recent check with hoisted code constants:
`src/core/brain/doctor/embedding-sunset-check.ts:78-84`.

### 7.2 `DOCTOR_REGISTERED_CODES`

Defined at `tests/core/brain/doctor-exit-census.test.ts:177-202` — a
24-entry frozen list living in the TEST, not in `src/`. Why, at
`:163-176`: `DIAGNOSTIC_SIGNALS` holds far more than doctor codes, so
nothing derivable from it says which entries the doctor still spells.

Asserted at `:252-260` as a set equality against `doctorCodes()`, which
is a syntactic scan (`:225`) over `DOCTOR_SOURCE_PATHS` (`:119-122` —
`doctor.ts` plus a recursive walk of `doctor/` plus every module reached
through a `*_CODE` import) matching `code: "<literal>"` (`:127`) and
`const <NAME>_CODE = "<literal>";` (`:130`).

### 7.3 The doctor exit census

`tests/core/brain/doctor-exit-census.test.ts`. "Exit" here means the
`next:` command an operator runs, not a process exit code.

| Line | Assertion |
|---|---|
| `:237` | no code is in neither `DIAGNOSTIC_SIGNALS` nor `DOCTOR_EXIT_EXCLUSIONS` |
| `:245` | no code is in both |
| `:252` | the registered subset equals `DOCTOR_REGISTERED_CODES` exactly |
| `:262` | no exclusion outlives the code it explains |
| `:268` | every exclusion reason is ≥ 80 chars (`MIN_REASON_LENGTH`, `:205`) |
| `:276` | **no exclusion reason may contain an `o2b <verb>` invocation** (`INVOCATION_RE`, `:208`) — if a command fits, it is a registration, not an excuse |
| `:283` | non-vacuity floors: source paths > 10, codes > 35, constant codes > 3, registered > 14, excluded > 20 |
| `:298` | every `code:` value is a string literal, a `*_CODE` identifier, or a declared `NON_LITERAL_CODE_SITES` entry (`:145`) |
| `:307` | every `*_CODE` identifier used as a value was read by the constant scan |
| `:320` | every `NON_LITERAL_CODE_SITES` entry still exists and carries a ≥ 80-char reason |
| `:330` | shape-guard non-vacuity: > 30 literal sites, > 2 identifier sites |

**Obligation:** every code a new check spells must be classified in
exactly ONE table, in the SAME commit.

- With a command → add a `DiagnosticSignal` to
  `src/core/brain/diagnostics.ts:125` (interface at `:77`) AND add the
  literal to `DOCTOR_REGISTERED_CODES`.
- Without one → add `{ code, reason }` to `EXCLUSIONS` at
  `src/core/brain/doctor-exits.ts:54`; ≥ 80 chars, no `o2b` invocation,
  and it must fall into one of the two admitted shapes documented at
  `doctor-exits.ts:19-32` (a JUDGEMENT over content, or an EDIT whose
  target shape is not derivable from the finding).

Published surface: `DOCTOR_EXIT_EXCLUSIONS` `doctor-exits.ts:291`
(duplicate code throws at import, `:279`), `doctorExitReason` `:306`,
`NO_EXIT_KEY = "no_exit"` `:316`, `noExitReasons` `:329`. Rendered by
`src/cli/brain/verbs/doctor.ts:70` (human) and `:174,186` (`--json`).
CLI behaviour pinned by `tests/cli/brain-doctor-next-step.test.ts:106-221`,
including byte-identity of a clean vault's output at `:212-221`.

**Do not confuse this with process exit codes.**
`tests/cli/doctor-exit.test.ts` covers `o2b doctor --readiness` (the
top-level verb): `DOCTOR_EXIT` / `doctorExitCode` from
`src/cli/main.ts` (`:22`), 0 = clean, 1 = proved failure, 6 = probe
incomplete (`:58-73`), failure outranks unmeasured (`:74-79`), and 6/0
are byte-equal to `SEARCH_CHECK_EXIT.probeIncomplete` / `.ok` (`:81-87`).
A new `brain doctor` check does not touch that table.

### 7.4 The `nextCommand` structural assertion

Field at `src/core/brain/diagnostics.ts:83` ("a structural CLI string,
never prose"). Serialized key `NEXT_COMMAND_KEY = "next_command"` at
`src/core/brain/next-step.ts:80`; `nextCommandField(code)` `:95`;
`resolveNextStep` `:36` (returns `null`, never a fabricated command);
`requireNextStep` `:68` throws `UnregisteredNextStepError` (`:47`).

Enforced at `tests/core/brain/next-step.test.ts:59-69` over EVERY entry
of `DIAGNOSTIC_SIGNALS`. All five must hold:

1. `command === command.trim()`;
2. no `\n`;
3. no double space;
4. no sentence punctuation — `SENTENCE_PUNCTUATION_RE = /[.!?;,:]/`
   (`:33`);
5. matches `STRUCTURAL_COMMAND_RE` (`:29-30`):

```
/^o2b(?: [a-z][a-z0-9-]*){1,3}(?: (?:--[a-z][a-z0-9-]*(?:=\S+)?|<[a-z][a-z0-9-]*>))*$/
```

Literal `o2b`, one to three bare lowercase verb words, then only long
flags and `<placeholder>` arguments. No bare word may follow a flag.
Conforming examples: `diagnostics.ts:132`
(`o2b brain doctor --repair --apply`), `:188`
(`o2b brain merge <keep> <drop>`), `:233`, `:489`. Counter-example
battery at `next-step.test.ts:71-85`.

### 7.5 Exact steps for a new doctor check

1. Write `src/core/brain/doctor/<name>.ts` exporting a `DoctorCheck`.
   Choose `failSoft` deliberately per `check.ts:65-73`. Read time from
   `ctx.now`.
2. Spell each code readably: `code: "<literal>"` at the push site, or
   `export const <NAME>_CODE = "<literal>";` at module scope. Avoid a
   computed code (it needs a `NON_LITERAL_CODE_SITES` entry).
3. Import in `src/core/brain/doctor.ts:49-92` and append to
   `DOCTOR_CHECKS` (`:134-170`), respecting the ordering contract.
4. Classify every code exactly once (§7.3).
5. If any applier acts on the code, add an entry to `APPLIER_CAPABILITY`
   (`src/core/brain/applier-capability.ts:147`, published at `:299`)
   declaring it `mechanical` (naming the fixer) or `refused` (naming the
   reason); otherwise `requireRepairCapability` throws
   `UnclassifiedRepairCodeError` (`:115`). Bound both ways by
   `tests/core/brain/applier-capability.test.ts:104-155`. This answers a
   different question from `doctor-exits.ts` (`doctor-exits.ts:35-42`);
   a code may legitimately be in both.
6. If the check needs a config knob, do all of §6 first. Worked
   precedent: `policy/blocks/embeddings.ts` +
   `config-template.ts:370-389` (`commented-example`) +
   `doctor/embedding-sunset-check.ts`.
7. Add `tests/core/brain/doctor/<name>.test.ts`, then run
   `bun test tests/core/brain/doctor-exit-census.test.ts
   tests/core/brain/next-step.test.ts
   tests/cli/brain-doctor-next-step.test.ts
   tests/core/brain/applier-capability.test.ts
   tests/core/brain.doctor.test.ts`.

---

## 8. Release machinery

### 8.1 The version is `package.json`, and nothing else

`CLAUDE.md:7-11` names `package.json` `version` as the single source of
truth, mirrored into six manifests plus `pyproject.toml`. Never
hand-edit a mirror (`CLAUDE.md:13-14`).

`scripts/sync-version.ts` writes exactly **seven** targets — the brief's
"seven manifests plus pyproject" is off by one; there are six manifests
plus `pyproject.toml`:

| # | Target | Declared at | Path in file |
|---|---|---|---|
| 1 | `plugin.yaml` | `scripts/sync-version.ts:26` | top-level `version:` (`plugin.yaml:2`) |
| 2 | `plugins/hermes/plugin.yaml` | `scripts/sync-version.ts:26` | top-level `version:` (`plugins/hermes/plugin.yaml:2`) |
| 3 | `.claude-plugin/plugin.json` | `scripts/sync-version.ts:28` | `$.version` (`:3`) |
| 4 | `.codex-plugin/plugin.json` | `scripts/sync-version.ts:29` | `$.version` (`:3`) |
| 5 | `plugins/codex/.codex-plugin/plugin.json` | `scripts/sync-version.ts:30` | `$.version` (`:3`) |
| 6 | `openclaw.plugin.json` | `scripts/sync-version.ts:31` | `$.version` (`:5`) |
| 7 | `pyproject.toml` | `scripts/sync-version.ts:33` | `[project] version = "…"` (`:13`) |

Deliberately NOT touched (`scripts/sync-version.ts:9-13`): `CHANGELOG.md`,
`install.md`, `docs/architecture.md`, `tests/`.

`--check` (`scripts/sync-version.ts:77-107`) writes nothing, prints
`ok:` / `DRIFT:` / `WARN no version line in …` per target, and exits **1**
when anything drifted or was unmatched (`:99-105`), else 0. Asymmetry
worth knowing: an unmatched target is fatal only under `--check`; the
write form warns and returns 0.

Scripts: `bun run sync-version` and `bun run sync-version:check`
(`package.json:47-48`).

### 8.2 When to bump — inside the feature PR

`CLAUDE.md:25-50` overrides the generic `feature-release-playbook`. The
bump rides in with the feature, before the first push, because `main` is
protected and the bump cannot be a post-merge step. Concretely:

1. Insert `## [X.Y.Z] - YYYY-MM-DD` into `CHANGELOG.md` immediately after
   line 6 (there is no `## [Unreleased]` section; the top version heading
   follows the Keep a Changelog boilerplate directly — current top
   heading is `CHANGELOG.md:8`).
2. Insert `[X.Y.Z]: https://github.com/itechmeat/open-second-brain/compare/v1.48.0...vX.Y.Z`
   as the new first line of the compare-link block, which begins at
   `CHANGELOG.md:7126`.
3. Edit `version` in `package.json:3` only.
4. `bun run scripts/sync-version.ts`, then confirm with
   `bun run scripts/sync-version.ts --check`.
5. Commit both, push, open the PR.
6. `gh release create vX.Y.Z` only AFTER the PR merges; it tags the
   already-bumped commit and never changes the version (`CLAUDE.md:48-50`).

### 8.3 `openclaw/index.js` is a committed build artifact

CI byte-diffs it: `.github/workflows/ci.yml:46-59`, step "OpenClaw bundle
is in sync with sources", rebuilds to `/tmp/openclaw-rebuild.js` and runs
`diff -q`. On drift it prints `openclaw/index.js is out of date; run: bun
run build:openclaw` and exits 1. Duplicated in
`.github/workflows/release.yml:76-87`.

Exact rebuild command (`package.json:38`):

```
bun run build:openclaw
# = bun build src/openclaw/index.ts --outfile openclaw/index.js --target=node --format=esm --external openclaw/plugin-sdk/plugin-entry
```

The flag list is copy-pasted in three places (`package.json:38`,
`ci.yml:54-57`, `release.yml:82-85`) with no shared source. The bundle is
excluded from formatting (`package.json:42-43`) so `oxfmt` cannot break
the byte-diff. `tests/openclaw/bundle.test.ts:28-73` additionally asserts
every tool registration is present and retired tools are absent — a new
MCP tool exposed through OpenClaw must be added there.

**If you touch anything under `src/openclaw/`, rebuild and commit the
bundle in the same commit.**

### 8.4 Other committed artifacts CI checks

- `link-ratchet.json` — dangling-link ceiling. Gate:
  `.github/workflows/ci.yml:61-62` (`bun run link-ratchet:check`), also
  `release.yml:50-51`. Scripts at `package.json:49-50`. Exit 1 on a rise,
  on an unmeasurable subject, or when the ceiling file is not comparable
  (`scripts/link-ratchet.ts:21-27,110-117`). **`templates/brain-starter`
  sits exactly at its ceiling of 22 with zero headroom** — one new
  dangling wikilink in that template reddens CI.
- `check:paths` — `.github/workflows/ci.yml:64-65`, report-only: it always
  exits 0 (`scripts/check-hardcoded-paths.ts:51` — `--strict` is not
  passed in CI). The enforcing gate is `hardcoded-paths.test.ts` under
  `bun test`.
- `schemas/` — four committed JSON Schemas with no dedicated CI step;
  covered only by `bun test`.

### 8.5 CI — `.github/workflows/ci.yml`

Triggers: `pull_request` on all branches, `push` to `main` (`:7-11`).
Permissions `contents: read` (`:13-14`). Concurrency
`ci-${{ github.ref }}`, cancel-in-progress (`:16-18`).

**One job, `validate`** (`:21-23`), strictly sequential; any failing step
aborts the rest. There are no `needs:` edges because there is only one job.

| # | Step | Command | Gates |
|---|---|---|---|
| 1 | Check out repository (`:25-28`) | `actions/checkout@v4` | — |
| 2 | Set up Bun (`:30-33`) | `oven-sh/setup-bun@v2`, `latest` | unpinned; a Bun release can redden CI with no repo change |
| 3 | Set up Python (`:35-38`) | `actions/setup-python@v5`, 3.11 | — |
| 4 | Install JS dependencies (`:40-41`) | `bun install --frozen-lockfile` | lockfile drift |
| 5 | **Verify manifest version sync** (`:43-44`) | `bun run sync-version:check` | version drift; **first substantive gate, blocks everything below** |
| 6 | OpenClaw bundle is in sync (`:46-59`) | inline `bun build` + `diff -q` | stale committed bundle |
| 7 | Broken-link ratchet (`:61-62`) | `bun run link-ratchet:check` | dangling links above ceiling |
| 8 | Hardcoded path hygiene (`:64-65`) | `bun run check:paths` | **nothing** — report-only |
| 9 | Formatting check (`:67-68`) | `bun run fmt:check` | oxfmt 0.47.0 |
| 10 | Lint (`:70-71`) | `bun run lint` | oxlint 1.62.0, errors only |
| 11 | Typecheck (`:73-74`) | `bun run typecheck` | `tsc --noEmit` |
| 12 | TypeScript test suite (`:76-77`) | `bun test` (raw, not `bun run test`) | the whole TS suite |
| 13 | Python plugin tests (`:79-80`) | `python -m unittest discover -s tests/python -v` | Hermes plugin |
| 14 | Python package compiles (`:82-83`) | `python -m compileall -q plugins/hermes` | Python syntax |

`.github/workflows/release.yml` has two jobs: `verify` (`:27-96`) and
`release` (`:98-174`, `needs: verify`). `verify` re-runs sync-version
check, link ratchet, typecheck, `bun test`, Python tests, manifest
validation, the OpenClaw byte-diff and an OpenClaw packaging check, plus
`./scripts/o2b doctor --vault . --repo .` (`:62-74`). It does **not** run
`fmt:check`, `lint`, or `check:paths` — the release gate is weaker than
the PR gate on formatting and lint, and stronger on doctor and packaging.

Local hooks (bypassable, not CI): `.githooks/pre-commit` runs `fmt:check`
then `lint`; `.githooks/pre-push:17` runs `typecheck` only.

## 9. Test conventions

### 9.1 Isolation — correcting the "clean HOME" premise

The brief (and a widely-repeated note) says `scripts/test` gives you a
clean HOME. **It does not.** `scripts/test` is 13 lines: it sources
`scripts/_bun-precheck.sh` (`:8`), sources `scripts/_macos-sqlite.sh`
(`:11`), and `exec bun test "$@"` (`:13`). It sets **no** env var.

- `scripts/_bun-precheck.sh:17-53` verifies `bun` is on PATH and
  ≥ 1.1.0, exiting 127 / 1 otherwise. No exports.
- `scripts/_macos-sqlite.sh:71` exports the wrapper's ONLY env var,
  `DYLD_LIBRARY_PATH`, and only on Darwin (`:43`), only when the var is
  unset (`:53`), and only when a Homebrew sqlite lib prefix exists
  (`:63-66`). Reason at `:3-13`: Apple's system libsqlite3 is built with
  `SQLITE_OMIT_LOAD_EXTENSION`, so `db.loadExtension()` for `sqlite-vec`
  fails.

**The real global isolation is `OPEN_SECOND_BRAIN_CONFIG`, and it lives
in a bun preload, not the script.** `bunfig.toml:1-3` sets
`[test] preload = ["./tests/setup.ts"]`. `tests/setup.ts:31-38`: if
`OPEN_SECOND_BRAIN_CONFIG` is unset, mkdtemp an `osb-test-default-*`
root, create `<root>/vault/Brain`, write `<root>/config.yaml` with
`vault: <vault>`, and point the env var there. Rationale at `:9-15`: on a
bare runner ~136 tests threw "plugin config not found"; on a configured
machine those same tests read — and could write — the operator's real
vault. `tests/setup.ts:27-29` also pins `O2B_DEVICE_ID` to `""`.

**HOME is pinned per test file, never globally.** No helper in
`tests/helpers/` touches HOME. Call sites that do it themselves:
`tests/cli/cli.test.ts:212-224` (`readinessEnv()` returns
`{OPEN_SECOND_BRAIN_CONFIG:"", XDG_CONFIG_HOME:"", VAULT_DIR:"",
OPEN_SECOND_BRAIN_SEARCH_SEMANTIC:"false", HOME: tmp}` — the
installed-runtimes probe reads real runtime configs out of HOME, so a
developer's own install would otherwise decide the exit code),
`tests/cli/doctor-exit.test.ts:89-100`,
`tests/cli/install-json-shape.test.ts:59-67`,
`tests/cli/install-ownership-close.test.ts:49`,
`tests/core/config-read-failure.test.ts:386`. The phrase "this suite
mandates a clean HOME" appears only as prose in three MCP test comments
(`tests/mcp/mcp.test.ts:28-35`, `config-read-failure-tools.test.ts:54`,
`config-read-failure-server.test.ts:57`). Nothing enforces it.

**Run `bun run test` locally** (`package.json:39` → `bash scripts/test`).
Bare `bun test` still gets full config isolation via the preload and
works on Linux — CI itself runs bare `bun test`
(`.github/workflows/ci.yml:76-77`). What you lose without the wrapper is
the Bun-version precheck and, on macOS only, `DYLD_LIBRARY_PATH` —
without which `sqlite-vec` cannot load and every vec-dependent test
silently **no-ops** rather than failing
(`tests/helpers/sqlite-vec.ts:5-22` returns `false`, and call sites do
`if (!sqliteVecLoadable()) return;`, e.g.
`tests/core/search/store.vec.test.ts:111,154,199,225,253,279`).

**If you write a test that reads the operator's home — an install probe,
a runtime detector — pin `HOME` yourself. Nothing does it for you.**

### 9.2 `runCli`

`tests/helpers/run-cli.ts:261-271`:

```ts
export async function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult>
```

`RunResult` (`:18-22`) is `{ stdout: string; stderr: string; returncode: number }`
— the field is **`returncode`**, not `exitCode`. `RunCliOptions`
(`:59-72`): `env?`, `stdin?`, `cwd?`, `subprocess?`.

Two modes (`:267-270`). The default is **in-process**: it imports `main`
from `src/cli/main.ts` (`:15`) and calls `await main(args)` (`:239`),
swapping `process.env`, `process.chdir` and both write streams and
restoring them in a `finally` (`:245-258`). A child `bun run
src/cli/main.ts …` is spawned only when `subprocess: true` or `stdin` is
passed (`:140-146`).

**Concurrency is refused, not tolerated** (`:183-202`): a second
overlapping in-process run throws `ConcurrentInProcessRunError` (`:186`),
pinned by `tests/cli/run-cli-helper.test.ts:21-25`. Concurrent runs must
pass `{ subprocess: true }` (`:44-52` of that test; live example
`tests/cli/brain-feedback-race.test.ts:67`).

`RUNTIME_OVERRIDABLE_ENV` (`:37-57`) is DELETED from the child env unless
the caller passes the key (`:83-85`): `VAULT_DIR`, `VAULT_AGENT_NAME`,
`VAULT_TIMEZONE`, `OPEN_SECOND_BRAIN_CONFIG`,
`OPEN_SECOND_BRAIN_SEARCH_SEMANTIC`, `OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER`,
`PARTNER_CODEGRAPH_DISABLED_ENV` and six more. Then two defaults are
injected: the codegraph switch is forced on (`:97`, §9.4) and, absent a
caller value, a throwaway `mkdtemp("o2b-test-")/isolated-config.yaml`
(`:99-103,158,256`). It does **not** manage `HOME`.

**There is no JSON assertion helper.** Tests do
`JSON.parse(r.stdout) as SomeInterface` against a locally declared
interface (`tests/cli/brain-lint.test.ts:34,113-136`,
`tests/cli/brain-hygiene.test.ts:32-53`). A good diagnostic idiom for the
exit assertion is at `tests/cli/install-json-shape.test.ts:73`: compare
`"<args> exit <code>\n<stderr>"` against `"<args> exit 0\n"` so a failure
prints stderr. For stderr progress streams use `progressRecords()`
(`tests/helpers/progress-records.ts:23-42`), which selects lines by the
`schema === PROGRESS_SCHEMA` discriminator rather than by position.

### 9.3 The vault digest — measured over the whole tree

`tests/helpers/vault-digest.ts` exports three functions:

- `digestVaultFiles(root): Map<string,string>` (`:20-37`) — sha256 per
  file, keys POSIX-normalised vault-relative (`:30`), directories walked
  in `localeCompare` order (`:23-25`);
- `digestVaultTree(root): string` (`:43-51`) — one sha256 over
  `` `${path}\0${digest}\n` `` for every entry, so **a created or deleted
  file changes the value as surely as an edited one** (`:39-42`);
- `changedPaths(before, after): string[]` (`:58-66`) — sorted symmetric
  difference, including appeared and vanished files.

The documented rule (`vault-digest.ts:5-13`) is: *"the dry run wrote
nothing" is only worth asserting if it covers the whole tree* —
spot-checking the two files a preview named cannot catch an audit record,
a leftover lock, or a rebuilt projection. The "measured, not
spot-checked" wording lives in the consumers
(`tests/cli/brain-lint.test.ts:10-15`,
`tests/cli/brain-hygiene.test.ts:12-13`). The strongest form is at
`brain-lint.test.ts:126-136`:

```ts
expect(changedPaths(before, digestVaultFiles(vault))).toEqual(reported);
```

— an apply changes EXACTLY the set the dry run reported; the set is
compared, not merely its size.

Other consumers worth copying:
`tests/core/brain/architect-progress.test.ts:130-142` —
`expect(digestVaultTree(watched)).toBe(digestVaultTree(silent))`, i.e.
attaching a progress observer changes not one byte;
`tests/core/brain/dream-progress.test.ts:117-155` — compares against a
`cpSync` copy of the seeded vault (a fresh bootstrap carries its own
vault id) and excludes two prefixes with stated reasons,
`Brain/.snapshots/` (tar carries mtimes) and `Brain/log/dream-runs/`
(journal stamps real wall-clock even under an injected clock),
`:141-152`.

### 9.4 The v1.48.0 partner-binary switch

`OPEN_SECOND_BRAIN_PARTNER_CODEGRAPH_DISABLED` — `src/core/config.ts:1038`,
exported as `PARTNER_CODEGRAPH_DISABLED_ENV`. Config-key twin
`partner_codegraph_disabled` at `:1039`; resolver
`resolvePartnerCodegraphDisabled()` at `:1060-1066`; default OFF in
production (`:1042-1043`). It gates **only** `doctor()`'s automatic
consultation of the third-party `codegraph` CLI; `o2b partner codegraph
report` is never suppressed (`:1054-1058`). The doctor quotes both
spellings in the row it prints for a check it did not run
(`src/core/partner/codegraph.ts:503-504`). Measured effect:
`tests/cli/cli.test.ts` went 96.03 s → 1.09 s (`CHANGELOG.md:67`).

`runCli` sets it to `"true"` for you unless you pass the key
(`tests/helpers/run-cli.ts:86-97`). **Any test that invokes `doctor()` or
`vault_health` WITHOUT going through `runCli` must set it itself** in
`beforeEach` and restore in `afterEach` — `tests/mcp/mcp.test.ts:34-36,41-44`,
`tests/mcp/config-read-failure-tools.test.ts:59-60`,
`tests/mcp/config-read-failure-server.test.ts:30`. The exception is a test
asserting about the switch, which deletes it first
(`tests/core/doctor-codegraph-switch.test.ts:73-82`, using a fake
`codegraph` on PATH that records invocations, `:47-60`).

### 9.5 General conventions

**Temp vaults, three tiers.** Lightweight, no Brain bootstrap:
`createSandboxVault(root, name?)` at `tests/helpers/fixtures.ts:11-25`
(companion `createPluginRepo` at `:27-89`). Real vault:
`bootstrapBrain(vault, { configPath })` from `src/core/brain/init.ts`
after writing a config with `atomicWriteFileSync`
(`tests/cli/brain-hygiene.test.ts:55-62`) — pair it with
`resetVaultIdentityPins()` in **both** `beforeEach` and `afterEach`
(`:56` and `:65`) or vault-identity pins leak across files. Universal
wrapper: `mkdtempSync(join(tmpdir(), "<prefix>-"))` in `beforeEach`,
`rmSync(tmp, {recursive:true, force:true})` in `afterEach`
(`tests/cli/cli.test.ts:25-31`). Search fixtures:
`tests/helpers/search-fixtures.ts`.

**Location mirrors `src/`**: `tests/cli/` (176 files, drives the CLI
through `runCli`), `tests/core/` (758, calls core directly),
`tests/mcp/` (124, drives `MCPServer.handleRequest` with raw JSON-RPC
envelopes — `tests/mcp/mcp.test.ts:47-60`), `tests/hooks/`,
`tests/discipline/`, `tests/scripts/`, `tests/docs/`, `tests/openclaw/`,
`tests/plugins/`, `tests/e2e/` (suffix `*.integration.test.ts`), and
Python separately in `tests/python/`.

**Every file opens with a docblock stating what defect it exists to
catch.** This is the strongest stylistic convention in the tree
(`tests/cli/run-cli-helper.test.ts:1-9`,
`tests/helpers/cli-timeout.ts:1-44`,
`tests/core/doctor-codegraph-switch.test.ts:1-19`).

**Filesystem yes, under `os.tmpdir()` only. Network loopback only.**
Embedding providers are replaced by `MockEmbeddingProvider`
(`tests/helpers/mock-embedding.ts:14-32`, sha256-derived unit vectors) or
an ephemeral `Bun.serve({port:0})` on `127.0.0.1`
(`tests/helpers/fake-http.ts:52-90`). Rationale at
`tests/helpers/run-cli.ts:47-53`.

**Timeouts.** bun's default is 5 s. Any file that drives the real CLI
must put `setDefaultTimeout(CLI_SPAWN_BUDGET_MS)` at module top level,
importing from `tests/helpers/cli-timeout.ts`
(`CLI_SPAWN_BUDGET_MS = 60_000` at `:45`). The docblock (`:1-44`) records
the experiment: `bunfig.toml [test] timeout` is parsed and **ignored**;
`setDefaultTimeout()` from a preload applies only to whichever file bun
runs first; `bun test --timeout` works but CI runs bare `bun test`. Only
the per-file form behaves identically under `bun test`,
`bun test <file>` and `bun run test`. Current adopters:
`tests/cli/cli.test.ts:21`, `cli-json-contract.test.ts:9`,
`doctor-exit.test.ts:29`, `install-verb.test.ts:29`,
`config-read-failure-surfaces.test.ts:37`, `run-cli-helper.test.ts:19`.
For one slow test, use the third `test()` argument instead.

### 9.6 Invocation

- CI: `.github/workflows/ci.yml:76-77`, bare `bun test`, no wrapper, no
  flags. Python at `:79-80`.
- Local: `bun run test` → `package.json:39` → `bash scripts/test`. Full
  gate: `bun run validate` = `typecheck && lint && test`
  (`package.json:45`). Single file: `bun test tests/cli/cli.test.ts`.
- Git hooks deliberately do NOT run the suite: `.githooks/pre-commit`
  runs `fmt:check` + `lint`; `.githooks/pre-push:2-4` states the full
  suite is intentionally skipped because CI's required `validate` check
  runs it on the PR.

**Do not run the full suite casually — it takes minutes.** Run the
targeted census files named in each section above.

---

## 10. Verified command output

All run on branch `feat/a-label-is-not-a-boundary`, working tree clean.

```
$ bun run lint
… (truncated: 123 warning bodies) …
Found 123 warnings and 0 errors.
Finished in 817ms on 2103 files with 110 rules using 4 threads.
EXIT=0
```

Warnings do not fail CI — `oxlint` exits 0. Only errors gate
(`.github/workflows/ci.yml:70-71`).

```
$ bun run fmt:check
$ oxfmt --check '**/*.{ts,js,json}' '.oxfmtrc.json' '!**/openclaw/index.js' '!.claude/**' --no-error-on-unmatched-pattern
Checking formatting...

All matched files use the correct format.
Finished in 1770ms on 2110 files using 4 threads.
EXIT=0
```

```
$ bun run typecheck
$ tsc --noEmit
EXIT=0
```

```
$ bun run scripts/sync-version.ts --check
canonical version: 1.48.0
  ok:    plugin.yaml
  ok:    plugins/hermes/plugin.yaml
  ok:    .claude-plugin/plugin.json
  ok:    .codex-plugin/plugin.json
  ok:    plugins/codex/.codex-plugin/plugin.json
  ok:    openclaw.plugin.json
  ok:    pyproject.toml
EXIT=0
```

Seven `ok:` lines — six manifests plus `pyproject.toml`.

```
$ bun run link-ratchet:check
$ bun run scripts/link-ratchet.ts --check
canonical definition: ladder:links-unresolved-after-read-resolution@2
  ok:           templates/brain-starter (dangling 22 of 55 link row(s), ceiling 22)
EXIT=0
```

**Zero headroom.** One new dangling wikilink in `templates/brain-starter`
reddens CI.

```
$ bun run check:paths
$ bun run scripts/check-hardcoded-paths.ts
check-hardcoded-paths: clean — no hardcoded home paths in shipped surfaces
EXIT=0
```

```
$ git status --porcelain
(no output — clean)
```

**Version:** `package.json` `version` = `1.48.0` (`package.json:3`).
**Top CHANGELOG heading:** `## [1.48.0] - 2026-08-15`
(`CHANGELOG.md:8`).

The full test suite is invoked as `bun run test` locally
(`package.json:39` → `bash scripts/test`) and bare `bun test` in CI
(`.github/workflows/ci.yml:77`). It was NOT run for this reconnaissance —
it takes minutes.

---

## 11. Where two conventions conflict

Six places where the obvious reading is wrong. Each has cost somebody a
red build.

1. **"Clean HOME" is folklore for the wrapper, real for individual
   tests.** `scripts/test` sets no env var at all (§9.1). Global config
   isolation comes from `bunfig.toml:1-3` + `tests/setup.ts:31-38`. HOME
   pinning is per-file. Do not assume a helper is doing it for you.

2. **The two rails have exactly inverted legality rules.** Advisory is
   legal unless the command owns internal JSON
   (`src/cli/advisory-rail.ts:85-88`); progress is legal only IF the
   command owns internal JSON (`src/cli/progress-rail.ts:109-112`). The
   inversion is deliberate and argued at `progress-rail.ts:96-108`.

3. **Census registries live in two different places.** Write-site
   exclusions and progress exemptions live in the TEST file
   (`write-site-census.test.ts:243`, `progress-census.test.ts:106`);
   destructive-site and egress registries live in `src/`
   (`src/core/brain/destructive-sites.ts:125`,
   `src/core/egress/registry.ts:85`). `DOCTOR_REGISTERED_CODES` lives in
   the test (`doctor-exit-census.test.ts:177`) while
   `DOCTOR_EXIT_EXCLUSIONS` lives in `src`
   (`src/core/brain/doctor-exits.ts:54`).

4. **`CliError` maps to a different exit code depending on the
   dispatcher**: 2 in `src/cli/main.ts:1014-1018` and
   `src/cli/search.ts:98-117`, but **1** in `src/cli/brain.ts:462-467`.
   A brain verb that throws `CliError` for an argv mistake exits 1, not 2.

5. **CI and the release workflow gate different things.**
   `ci.yml` runs `fmt:check`, `lint` and `check:paths`;
   `release.yml` does not, but adds `o2b doctor` and an OpenClaw
   packaging check. A branch green on CI is not proof the release job is
   green, and vice versa.

6. **`CLAUDE.md` overrides `feature-release-playbook` on when to bump.**
   The playbook says bump in a release phase; this repo bumps inside the
   feature PR before the first push (`CLAUDE.md:45-48`). Follow
   `CLAUDE.md`.
