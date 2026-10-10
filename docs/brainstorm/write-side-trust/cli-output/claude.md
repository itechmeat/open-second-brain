# Consultant output - write-side trust

Produced in-session by the design orchestrator (host mode: the consultant run and the orchestrator are the same session; no external process was spawned). The prompt used is at `cli-output/prompt.md`; the analysis below is the verbatim variant output, also mirrored in `variants.md`.

### Variant 1: Substrate-first spine - one permissions document, one chokepoint, gates as consumers

- **Approach**: Land identity and authorization as pure leaf modules first: a token store that maps hash-at-rest credentials to agent names, and a permissions document (`Brain/_permissions.yaml`) with a pure resolver returning allow/ask/deny per (subject, action, target). Every action gate - the staged-review lanes, the owner-write gate, the force-confirmed rule - becomes a consumer of one disposition function that consults the document, or the legacy per-feature keys when no document exists. Ask stages into a generalized multi-lane pending queue (the A3 precedent: staging is a change of directory), deny refuses with a named token, and every non-allow verdict appends one row to a decision ledger that records the rule that decided. Ambient capture ships last, strictly behind the gates. Landing order: document + resolver + ledger + token store (pure, disjoint) -> transport auth, recall exclusion, signal chokepoint, owner-write preference lane, multi-lane staging, open decisions, ambient consent (parallel, disjoint files) -> document-backed dispositions, note-lane owner guard, bootstrap (integration) -> reconciliation.
- **Trade-offs**:
  - Pro: every card inherits the same substrate, so "who was allowed, asked, or denied what, by which rule" has one answer and one record. The t_29798f41 requirement (a queryable ledger replacing scattered point checks) is satisfied by construction rather than by a later reporting pass over heterogeneous gates.
  - Pro: default-identity is trivially auditable: with no document, no tokens, and no keys, every consumer short-circuits to today's behavior, so the existing suites are the byte-identity proof.
  - Pro: the chokepoints already exist and are proven - `writeSignal` for signals (the `targetDir` staging seam), `createNote`/`applyWriteBatch` for notes, `resolvedOwnerFor` for preferences, `admitToIndex` for recall. The wave adds predicates beside them, it does not reroute traffic.
  - Pro: the ask verdict reuses the pending queue's apply/reject semantics, so the human approval door is the existing CLI door with a widened id grammar - one review UX, not one per lane.
  - Con: the document resolver must be a true leaf module or the import-cycle ratchet (`tests/core/architecture/import-cycles.test.ts`) blocks the gates from consulting it; this constrains what the substrate may reuse.
  - Con: five lanes touching one spine need the contract pinned in the plan (signatures, config keys, shared-append files), or the merge is where the design actually happens.
  - Con: two staging sources (document vs `write_approval.*` keys) need an explicit precedence rule or operators get different answers on different days; the design pays this with "document present = document only".
- **Complexity**: medium-high
- **Risk**: low-medium (byte-identity is per-consumer and independently testable; the substrate is pure and small)

### Variant 2: Gate-local first, document later

- **Approach**: Ship each card on its own config keys exactly as the existing gates work: staged review extends via `write_approval.*` lane keys, the owner-write gate via a new integrity key, tokens via the transport, bootstrap as orchestration. Defer the permissions document to a later wave that retrofits a policy layer over the now-existing gates, mapping each key into a document entry.
- **Trade-offs**:
  - Pro: each task is independently shippable with the smallest possible blast radius; no substrate commit needs to land first, so lanes never wait.
  - Pro: no new operator-facing document to design, validate, and fail-close this wave; the `write_approval` and `integrity` key patterns are established and understood.
  - Con: the approval door gets built twice - the pending queue generalization and the ledger need a verdict vocabulary now, and a later document has to either subsume the keys (a second migration) or live beside them (two sources of truth for the same question, the exact "scattered point checks" shape the card exists to remove).
  - Con: the ledger records gate verdicts that have no rule identity beyond a config key; retrofitting entry/role/default provenance onto rows written by key-driven gates means a schema migration on an append-only store.
  - Con: `force_confirmed` and the role-matrix gap stay unanswerable: without a document there is no principal model to hang the "requires allow" rule on, so the one bypass the recon proved ships unchanged with no decision recorded.
  - Con: identity does not compose - a token identity with no document gives per-caller `brain_context` attribution and per-caller owner-scope refusal, but no per-caller write policy, so the t_85059d6d and t_29798f41 cards land as strangers.
- **Complexity**: medium (per task) but higher cumulative (double build of the door)
- **Risk**: medium (the deferred document wave re-opens every file this wave touches)

### Variant 3: Transport middleware - decide at the dispatch boundary

- **Approach**: Put identity, policy, and staging in one middleware layer at the MCP/CLI boundary: `authenticateRequest` resolves identity, a policy check runs before every tool handler from a table keyed by tool name, and mutating calls are redirected into review by the wrapper rather than by the write primitives. Core modules stay untouched; the permissions document is read only by the wrapper.
- **Trade-offs**:
  - Pro: smallest core diff - one wrapper, one policy table, no changes to write primitives; trivially reversible.
  - Pro: the dispatch seam already records refusals (the `mapFrozen` pattern at `src/mcp/server.ts:336`), so denial logging has an existing home.
  - Con: the boundary is not the write seam, which this project has already learned the hard way: internal writers (dream apply, hygiene, write-session commit, session import, inline scan, capture lifecycle) never cross the dispatch wrapper, so staged review would miss exactly the bulk lanes the card names. The t_107cac80 recon shows the same lesson on the read side: the gate lives at `coerceAgentScope` because that is the one reader, not because the boundary is privileged.
  - Con: CLI verbs bypass the wrapper entirely, so the operator's own paths and any script calling core directly would need a parallel enforcement story.
  - Con: staging needs the resolved target path, which exists only inside the write primitives (`resolveNoteTarget`, `resolveEffectiveScope`); a wrapper can only see raw arguments, so it would re-implement path resolution or stage the unresolved name - both drift from what publish would actually write.
  - Con: per-lane review granularity (stage creates, allow updates of published notes) is a property of the operation, not the tool; a tool-name table cannot express it.
- **Complexity**: small
- **Risk**: high (repeats the `o2b brain protect` failure the wave exists to fix: enforcement at a layer the writers bypass)

## Recommendation

Variant 1, the substrate-first spine. The wave's seven cards share one question - "may this principal do this write, and who says so" - and only Variant 1 answers it in one place. The chokepoints the gates need already exist and are census-pinned, so the spine is predicates beside proven seams rather than new plumbing; the pending queue generalization gives the ask verdict a human door that already has apply/reject semantics, tests, and a CLI. Variant 2 is honest about sequencing but builds the approval door and ledger twice and leaves `force_confirmed` unanswerable; Variant 3 is the smallest diff and the wrong layer, missing the internal and CLI writers that make up most of the write surface.
