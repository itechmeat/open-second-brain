# Recon — the MCP instruction surface, and whether `agent` can select on it

Task under verification: kanban `t_f2ede668` (priority 2), "Per-agent extraction
instruction set selectable by agent scope, with split-by-attribution".

Every claim below carries a `file:line` anchor that was read. Anchors are from
the working tree on `feat/a-label-is-not-a-boundary`.

---

## What exists

### 1. The instruction surface, end to end

`src/mcp/instructions.ts` is the whole surface. It exports one function and
holds three bodies of text.

| Piece | Anchor | Varies by |
| --- | --- | --- |
| `BuildInstructionsOpts` | `src/mcp/instructions.ts:13` | — |
| `WRITER_INSTRUCTIONS` (constant) | `src/mcp/instructions.ts:32` | nothing |
| `CATALOG_INSTRUCTIONS` (constant) | `src/mcp/instructions.ts:61` | nothing |
| `identityLine(agent)` | `src/mcp/instructions.ts:89` | `agent` only |
| `buildInstructions` full branch | `src/mcp/instructions.ts:116-138` | `agent` (one sentence) |

Assembly is a three-way branch in `buildInstructions`
(`src/mcp/instructions.ts:105`):

- `scope === "writer"` → return `WRITER_INSTRUCTIONS` verbatim
  (`src/mcp/instructions.ts:110`).
- `scope === "catalog"` → return `CATALOG_INSTRUCTIONS` verbatim
  (`src/mcp/instructions.ts:111`).
- otherwise → `identityLine(agent)` concatenated with four fixed paragraphs
  (memory contract, consolidated read views, preview budget)
  (`src/mcp/instructions.ts:116-138`).

**What varies today: exactly one sentence, and only on one of three scopes.**
`identityLine` renders either `You are @<agent> on this Open Second Brain
vault.` (`src/mcp/instructions.ts:91-94`) or a refusal naming the unreadable
config (`src/mcp/instructions.ts:96-102`). Everything else is a literal.

**`agent` is discarded on two of three scopes.** The writer and catalog
branches return before `agent` is ever read (`src/mcp/instructions.ts:110-111`).
The writer scope is the always-loaded surface an agent carries in every
session — so on the surface where agent identity matters most, the current
code does not use `agent` at all.

**`vault` is declared and never read.** `BuildInstructionsOpts.vault`
(`src/mcp/instructions.ts:26-27`) is documented as "reserved for future
per-vault customisation" and does not appear anywhere in the function body
(`src/mcp/instructions.ts:105-139`). A test passes it anyway
(`tests/mcp/mcp.test.ts:793`).

Callers of `buildInstructions`, complete:

- `src/mcp/server.ts:313` — the only production caller.
- `src/mcp/index.ts:25` — re-export.
- `scripts/measure-token-surface.ts:62-63` — token-budget report.
- `tests/mcp/mcp.test.ts:792` — writer-branch assertion.

### 2. How the block reaches a client

`initialize` is the only carrier. `MCPServer.handleInitialize`
(`src/mcp/server.ts:295`) returns `instructions: buildInstructions({ agent,
scope })` at `src/mcp/server.ts:313`. No other JSON-RPC method emits it; the
`tools/list`, `resources/list`, and `tools/call` handlers
(`src/mcp/server.ts:320`, `:335`, `:352`) never touch it.

It is **re-computed on every `initialize` request** — `resolveIdentityOrReason`
(`src/mcp/server.ts:305`, defined `src/mcp/server.ts:433`) reads the config
each time rather than caching at construction. But every input is
process-global:

- `resolveAgentName` order is `VAULT_AGENT_NAME` env → `agent_name`/`agentName`
  in the plugin config → the literal `"agent"` (`src/core/config.ts:373-380`).
- `this.scope` is fixed at construction (`src/mcp/server.ts:122`).

**`handleInitialize` reads only `params["protocolVersion"]`**
(`src/mcp/server.ts:296`). `clientInfo` is never read anywhere under `src/`
(grep for `clientInfo`: zero hits). So the request carries no identity the
server consults.

Transport confirms the same:

- **stdio** — one process per client (`src/mcp/stdio.ts:46`); the process's
  env/config *is* the agent.
- **HTTP** — a single `MCPServer` instance is shared by every request
  (`src/mcp/http.ts:52`). An `mcp-session-id` is minted on `initialize`
  (`src/mcp/http.ts:166`) and **never read back** — grep shows exactly one
  occurrence. There is no per-session or per-client state of any kind.

**Consequence:** a client cannot receive a different block per agent over
either transport. "One block per agent" is already expressible today, and only
today, as "one server process per agent" — which is precisely how identity is
configured now.

### 3. Where a per-agent block would be declared — nowhere, today

Two config files exist; neither can hold the value.

**Plugin config** (`~/.config/open-second-brain/config.yaml`, located by
`resolveDefaultConfigPath`, `src/core/config.ts:120`) is parsed by
`parseSimpleYaml` (`src/core/config.ts:~148`), which is a flat `key: value`
reader: "Lines that aren't `key: value` (comments, blanks, complex YAML) are
skipped." No nesting, therefore no map of agent → block.

**Vault config** (`<vault>/Brain/_brain.yaml`, `src/core/brain/policy/load.ts`)
is parsed by `parseBrainYaml` (`src/core/brain/yaml-parse.ts:39`). Its grammar
is stated at `src/core/brain/yaml-parse.ts:9-24`: top-level scalars, one
indented block level, and lists inside a block — "This intentionally rejects
nested mappings deeper than two levels". Scalars have no escape sequences and
there is no block-scalar (`|`) form, so a multi-line instruction body is not
expressible. Every block is additionally validated against a closed
`KNOWN_KEYS` list (pattern at `src/core/brain/policy/blocks/discipline-report.ts:19`),
so an arbitrary agent-name key would be rejected as unknown.

The only agent-keyed configuration that exists:

- `primary_agent` — a single scalar (`src/core/brain/policy/primary-agent.ts:15,45`).
- `discipline_report.known_agents` — a list of strings
  (`src/core/brain/policy/blocks/discipline-report.ts:19,52`).

Neither is a map from agent to anything.

**Operator text already has two homes, both global:**

- `Brain/standing-rules.md` — `src/core/brain/standing-rules.ts:1-2`, path
  constant `src/core/brain/path-constants.ts:173`, capped at 4000 chars
  (`src/core/brain/standing-rules.ts:67`), injected first and exempt from the
  adaptive budget (`src/core/brain/standing-rules.ts:5-11`).
- `<vault>/VAULT.md`, name configurable via `link_graph.vault_instruction_file`
  — `src/core/brain/vault-instruction-file.ts:31-33`, resolved at
  `src/core/brain/vault-instruction-file.ts:100-108`, line ceiling from
  `guardrails.instruction_file_max_lines` (`src/core/brain/config-template.ts:339`,
  checked `src/core/brain/doctor.ts:305-308`).

Both are delivered by `brain_context`, a `tools/call` surface
(`src/mcp/brain/context-tools.ts:338` reads standing rules, `:408` prepends
them; the vault instruction file is read in the enrichment just below), not by
`initialize`. Neither has a per-agent axis.

### 4. `scope` — what it selects, and orthogonality

**The task's anchor is wrong.** `src/mcp/server.ts:79` is inside the
`sendNotification` doc comment. The real anchors are:

- `ToolScope = "full" | "writer" | "catalog"` — `src/mcp/tool-contract.ts:19`.
- `MCPServerRuntimeOptions.scope` — `src/mcp/server.ts:59`.
- Stored per server — `src/mcp/server.ts:104`, defaulted `src/mcp/server.ts:122`.

`scope` selects two things: which tools `buildToolTable` emits
(`src/mcp/tools.ts:438`, catalog branch `src/mcp/tools.ts:540`), and which
instruction constant is returned (`src/mcp/instructions.ts:110-111`). It is a
process-level flag, set by `--scope` / `--writer-only` / `--tool-profile`
(`src/cli/main.ts:602,614-634,667`) through `resolveToolSurface`
(`src/mcp/profiles.ts:121-145`).

**Orthogonal in principle, entangled in fact.** `scope` and agent identity are
independent inputs, but `scope` currently decides *whether the agent axis is
consulted at all*: writer and catalog discard `agent`
(`src/mcp/instructions.ts:110-111`). A per-agent block would therefore have to
be defined over `(agent × scope)`, or the two constant branches would need an
identity line they deliberately do not have today.

### 5. The intake path, and every reader of `source_agent`

Types and stamp:

- `ExtractionIntake` — `src/core/brain/intake/extract-intake.ts:61`.
- `IntakeOptions` — `src/core/brain/intake/extract-intake.ts:66`; `agent` at
  `:68`, documented as "Agent identity stamped as the entity `source_agent`".
  There is **no instruction field** on it.
- `intakeExtraction` — `src/core/brain/intake/extract-intake.ts:194`; passes
  `agent: opts.agent` into `upsertEntity` at `:219`.

Writes:

- `src/core/brain/entities/registry.ts:504` — update arm, `source_agent: input.agent`.
- `src/core/brain/entities/registry.ts:542` — create arm, `source_agent: input.agent`.
- `src/core/brain/entities/registry.ts:319` — the field's slot in
  `ENTITY_FIELD_ORDER`.
- `src/core/brain/entities/registry.ts:620` — carried forward unchanged on relate.
- `src/core/brain/entities/registry.ts:705` — carried forward unchanged on status change.

Readers, complete (grep `source_agent|sourceAgent` over `src/`):

- `src/core/brain/entities/types.ts:57` — `readonly source_agent?: string` on
  the index entry.
- `src/core/brain/entities/index-builder.ts:112,120` — parsed off frontmatter
  into that index entry.
- `src/cli/brain/verbs/entity.ts:39` — rendered in CLI output.
- `src/mcp/brain/entity-tools.ts:36` — rendered in the MCP response.
- `src/core/brain/frontmatter-tiers.ts:119` — classified as tier `"system"`
  under `brain-entity`.

**Nothing filters, gates, routes, or selects on `source_agent`.** It is written,
indexed, displayed, and tier-classified. The validator hint is correct.

Where the intake `agent` comes from at the MCP boundary:

- `src/mcp/brain/ner-tools.ts:34-36` — optional per-call `agent` argument, else
  `resolveAgentName(ctx.configPath)`.
- `src/mcp/brain/ingest-tools.ts:54-56` — the same pattern.
- Parsed at `src/mcp/brain/intake-args.ts:164`.

So intake's `agent` **is** a per-call value. The instruction surface's `agent`
is not. Same word, two axes.

### 6. The four-piece closed-vocabulary idiom

Enforced by `tests/core/architecture/verdict-vocabulary-census.test.ts`. The
four pieces, all four required and all four **in one module**
(doc block `:40-48`):

1. `const NAME = Object.freeze({ … })` whose every entry is
   `key: "string literal"`;
2. a derived union — `(typeof NAME)[keyof typeof NAME]`;
3. a membership list built from it — `Object.values(NAME)` or an array of
   `NAME.member`;
4. a guard: a function or arrow whose parameter is typed **`unknown`** and
   which reads the membership list or the object.

`auditVocabulary` (`:374-404`) enforces seven checks:

1. the values object is frozen (`:378`);
2. no duplicate value in the object (`:382`);
3. no duplicate in the membership list (`:387`);
4. every declared value is a member (`:392`);
5. the guard accepts every declared value (`:393`);
6. every member is declared (`:396`);
7. the guard rejects every `NON_MEMBERS` outsider (`:398-401`) — the outsiders
   are `""`, `" "`, `"unknown-vocabulary-member"`, `null`, `undefined`, `42`,
   `{}` (`:363-371`).

Registration is not optional: `scanVocabularies` walks `src/`
(`:1285`, invoked `:1327`) and `CENSUS` (`:411`) must account for every
vocabulary found; an entry in `CENSUS` that the scan cannot find is reported as
orphaned (`:1423`). There is **no exemption list** — the doc block states why
(`:59-63`).

Known blind spots the doc names (`:66-97`): a vocabulary split across modules,
a two-piece vocabulary, non-literal values, a guard typed `string`, trees other
than `src/`, and code inside a template interpolation.

**`ToolScope` is not in this population.** `src/mcp/tool-contract.ts:19` is a
bare union — no frozen object, no members array, no guard. So the existing
scope axis does *not* follow the idiom, and a new selector built to the idiom
would sit beside a sibling that is not.

`KNOWN_RUNTIME_TARGETS` (`src/core/identity-reminder.ts:41`) is also out of
population: array plus derived type plus guard, but no frozen object, and
`isRuntimeTarget` takes `string | undefined` (`src/core/identity-reminder.ts:45`)
rather than `unknown`. It is the nearest existing "selector" and it must not be
copied as a template.

### 7. Existing "operator supplies text the server returns" mechanisms

Three exist. **All three select on runtime or host — none on agent.**

1. **Per-runtime template files.** `templates/identity-reminder.txt` plus
   `templates/identity-reminder.<target>.txt` for `hermes` and `openclaw`
   (`src/core/identity-reminder.ts:41`). Read at
   `src/core/identity-reminder.ts:57` (common) and `:92` (per-target);
   `{agent}` is substituted at `:138,:140`; target comes from an explicit
   parameter or `O2B_TARGET` (`:108-119`); a missing per-target file silently
   falls back (`:136-140`). These files ship in the repo — they are install
   artifacts, not operator-authored vault content, and the module states that
   adding a target "is a PR-change … not a runtime decision"
   (`src/core/identity-reminder.ts:34-39`).

2. **Per-runtime hook reminder.** `postWriteReminder`
   (`hooks/lib/messages.ts:57`) with `postWriteCadenceLine`
   (`hooks/lib/messages.ts:30-55`) branching over `HookRuntime`
   (`claudecode | codex | grok | unknown`).

3. **Operator-authored vault text.** `Brain/standing-rules.md`
   (`src/core/brain/standing-rules.ts`) and `<vault>/VAULT.md`
   (`src/core/brain/vault-instruction-file.ts`), both delivered through
   `brain_context` (`src/mcp/brain/context-tools.ts:338,408`).

Mechanism 3 is the one that already answers "an operator writes text and the
server returns it". Building a per-agent instruction block on the `initialize`
path would be a fourth mechanism with a fifth text home.

---

## What does not exist

- **No per-agent configuration store, in the vault or in the device config.**
  Neither YAML grammar can represent a map from agent name to a text block
  (§3). Nothing under `src/core/brain/policy/blocks/` is keyed by agent.
- **No per-agent selection anywhere in the instruction path.**
  `BuildInstructionsOpts` (`src/mcp/instructions.ts:13`) exposes
  `agent`/`vault?`/`scope?`; only `agent` and `scope` are read, and `agent`
  reaches one sentence on one branch.
- **No per-request or per-session identity.** `clientInfo` is unread; the HTTP
  session id is minted and discarded (`src/mcp/http.ts:166`).
- **No instruction field on `IntakeOptions`** (`src/core/brain/intake/extract-intake.ts:66-80`).
- **No behavioural reader of `source_agent`** — it is a display/index field
  only (§5).
- **No server-side extraction prompt to instruct.** Extraction is agent-side;
  the module header states the boundary explicitly:
  "the model that produced the extraction lives on the agent side of the
  MCP/CLI boundary. This primitive never calls a model"
  (`src/core/brain/intake/extract-intake.ts:10-12`), echoed at
  `src/mcp/brain/ner-tools.ts:5`.

---

## Corrections to the premise

1. **`src/mcp/server.ts:79` does not define `scope`.** That line is inside the
   `sendNotification` doc comment. `ToolScope` is `src/mcp/tool-contract.ts:19`;
   the runtime option is `src/mcp/server.ts:59`; the stored field is
   `src/mcp/server.ts:104`.

2. **`recall-tools.ts:720` has nothing to do with `agent` stamping.** That line
   is inside `brain_context_pack_outcome`'s `post` branch
   (`src/mcp/brain/recall-tools.ts:700-735`), returning `evidence` on a
   context-pack outcome. No `agent`, no `source_agent`.

3. **"`agent` is only a LABEL" is right for intake and wrong for instructions.**
   In `IntakeOptions` it is a pure stamp (§5). In `BuildInstructionsOpts` it is
   not a label at all — it is rendered into a directive sentence
   (`src/mcp/instructions.ts:91-94`) or replaced by a refusal
   (`src/mcp/instructions.ts:96-102`). And on the writer and catalog scopes it
   is **dropped entirely** (`src/mcp/instructions.ts:110-111`), which is a
   sharper finding than "it is only a label": the always-loaded surface has no
   identity line whatsoever.

4. **These are two different `agent` axes, not one.** Intake's `agent` is a
   per-call tool argument with a server-resolved default
   (`src/mcp/brain/ner-tools.ts:34-36`, `src/mcp/brain/ingest-tools.ts:54-56`).
   The instruction surface's `agent` is a process-level config value read at
   handshake (`src/core/config.ts:373-380`, `src/mcp/server.ts:305`). Turning
   the first into a selector says nothing about the second, and vice versa.
   The task treats them as the same field.

5. **"Selectable by agent" is not reachable over the transport as designed.**
   Both transports resolve identity from process env/config, never from the
   request (§2). Per-agent selection today collapses to per-process selection,
   which the install already provides by giving each agent its own
   `VAULT_AGENT_NAME` or config file. There is no new capability in "select by
   agent" unless a new identity channel is introduced — and introducing one
   (trusting a client-declared name) would put the identity an agent writes
   under into the agent's own hands, which
   `src/mcp/instructions.ts:17-23` argues against by name.

6. **"Give the block a home" is the real precondition, and it is not free.**
   The task's own hedge is correct but understated: no operator can write a
   per-agent block anywhere today, and neither YAML grammar can be extended to
   hold one without either a third-level map (`src/core/brain/yaml-parse.ts:23`
   rejects it by design) or a new file-per-agent convention that would be a
   fourth operator-text mechanism alongside `standing-rules.md`, `VAULT.md`,
   and the `templates/identity-reminder.*.txt` set (§7).

---

## Smallest native unit that is true against this codebase

**None of the shapes in the task body is a native unit as stated.** The honest
finding is that "select a per-agent instruction block" has no supplier, no
home, and no transport channel. Stating that is the correct output.

Ranked by how native they are:

**A. The true zero-invention unit — the writer scope has no identity line.**
`src/mcp/instructions.ts:110` returns `WRITER_INSTRUCTIONS` before `agent` is
read, so the always-loaded surface — the one an agent carries into every
session — never says which name to log under, while the full surface insists on
it (`src/mcp/instructions.ts:91-94`). The writer tools are exactly the
identity-bearing writers. This is a real gap in the existing design, needs no
new config, no new vocabulary, and no new file: prepend `identityLine(agent)`
to the writer (and catalog) branches. It also removes the entanglement noted in
§4. This is the smallest thing that is both true and worth doing here.

**B. If a per-agent block is genuinely wanted, the home comes first and it is
the whole unit.** The only native home is the one that already exists: an
operator-authored file delivered through `brain_context`, alongside
`standing-rules.md` and `VAULT.md` (§7, `src/mcp/brain/context-tools.ts:338,408`).
Not `initialize.instructions` — that path is process-global, capped by a token
budget the repo actively measures (`scripts/measure-token-surface.ts:83-84`),
and has no per-agent axis to hang anything on. Framing it as "extend the
existing operator-text lane with an agent-scoped variant" keeps one mechanism;
framing it as "per-agent block in `initialize`" invents a parallel one, which
this repo forbids.

**C. What must NOT be built.** A `ToolScope`-style selector union for
instruction sets, with no operator able to supply a second set, is a
do-nothing fallback with a type attached. Under the census rules (§6) it would
also have to ship the full four pieces plus a `CENSUS` registration for a
vocabulary whose only member is `"default"`.

**Recommendation:** ship A, and reframe the kanban task from "select a block"
to "the writer surface states no identity" plus a separate, later question
about whether operator text needs an agent-scoped variant at all.

---

## Defects noticed

1. **Dead option field.** `BuildInstructionsOpts.vault`
   (`src/mcp/instructions.ts:26-27`) is declared, documented as reserved, and
   never read in `buildInstructions` (`src/mcp/instructions.ts:105-139`). A
   test supplies it (`tests/mcp/mcp.test.ts:793`), which makes it look load-
   bearing. Delete it, or the next unit will "extend" it.

2. **Dead legacy-compat branch.** `buildInstructions` accepts
   `BuildInstructionsOpts | string` with a documented legacy string path
   (`src/mcp/instructions.ts:105-108`). All three call sites pass an object
   (`src/mcp/server.ts:313`, `scripts/measure-token-surface.ts:62-63`,
   `tests/mcp/mcp.test.ts:792`); grep finds no string-argument call anywhere
   outside `.claude/worktrees/`. The union widens the signature for nothing and
   forces two `typeof opts === "string"` reads per call.

3. **`ToolScope` members are copied by hand into four places, with nothing
   asserting they agree.** The type at `src/mcp/tool-contract.ts:19`; a literal
   `enum: ["full", "writer", "catalog"]` in the capabilities output schema at
   `src/mcp/tools.ts:378`; a re-declared inline union at `src/cli/main.ts:762`;
   and a hand-written list in the CLI error message at `src/cli/main.ts:629`.
   This is verbatim the drift class the census doc calls out — "a status list
   copied as a literal into a tool schema with nothing asserting the two agree"
   (`tests/core/architecture/verdict-vocabulary-census.test.ts:16-18`) — and
   `ToolScope` is out of the census population because it has neither a frozen
   object nor a guard. Promoting `ToolScope` to the four-piece idiom and
   registering it in `CENSUS` is a small, self-contained fix that any work on
   this axis would benefit from.

4. **HTTP mints a session id it never reads.** `src/mcp/http.ts:166` sets
   `mcp-session-id` on the `initialize` response; grep finds exactly one
   occurrence in the file. The header advertises per-session state that does
   not exist — which is also why per-agent instructions cannot ride the HTTP
   transport without real work.

5. **`isRuntimeTarget` guard takes `string | undefined`, not `unknown`**
   (`src/core/identity-reminder.ts:45`). It is out of the census population
   (no frozen object), so nothing fails — but it is the nearest thing to an
   existing selector and it diverges from the idiom the repo enforces
   elsewhere.

Not a defect, corrected for the record: codegraph reports `buildInstructions`
as having "no covering tests". That is a false negative — the catalog branch is
covered at `tests/mcp/catalog-scope.test.ts:104-113` and the unresolved-identity
branch at `tests/mcp/config-read-failure-server.test.ts:134-143`, both through
`handleInitialize` rather than by calling the function directly.
