You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave of eight kanban units in Open Second Brain, selected because they share one seam: **a state that cannot be verified, is absent, or has gone stale is currently reported as silence, and silence is indistinguishable from health.**

A read-only grounding pass over the current code preceded this brief. Every claim below is verified at `file:line` against HEAD. Several of the original task descriptions were falsified by that pass and the corrected findings are what appear here.

## The eight units

**U1 — Schema-pack integrity tri-state.** The `schema:` block of `Brain/_brain.yaml` is the operator-curated ontology that gates every write. `applySchemaMutations` records *which mutations were requested* into an audit shard but never a digest of the pack that resulted, so no recorded expectation exists to compare against. Four distinct states — sealed-and-intact, hand-edited-since-apply, never-audited, config-file-absent — render identically on every read surface (`schema_inspect view: active_pack` / `view: packs`, `o2b brain schema report`). Needs: a digest of the rendered schema block written at apply time, and an `ok` / `modified` / `unverified` status with a named reason for each unverifiable case. Note: there is exactly one pack; `listSchemaPacks` returns a hardcoded one-element list and there is no registry, no external pack, and no signature machinery anywhere in the project (a prior release explicitly refused pack-by-URL for this reason).

**U2 — Typed negative recall with a coverage receipt.** Every negative the system can produce today is a statement about the *retrieval attempt*, never about the *corpus*. A typed 3-state negative already exists on the injection path (`empty_prompt` / `no_matches` / `below_floor`, with a separate `error` arm), so the often-repeated claim that absence collapses into one empty result is already false there. What is genuinely missing: a "no" derived from a stale, partial, or embedding-disabled index is byte-identical to a "no" derived from a complete one. Needs: `not_found` / `unknown` / `did_not_happen`, where a complete negative claim is inadmissible without a digest-bound receipt over the document set actually searched. Complication: two candidate universes disagree — the *authorized* set (configured note roots minus ignores) and the *searched* set (what the index actually covers). A receipt over the authorized set overclaims; one over the index alone hides the divergence. `did_not_happen` can only be grounded in stored evidence (existing tombstone / `superseded_by` / `valid_until` edges in the claim graph), never inferred from absence.

**U3 — Reverse stale-dependency audit.** Given a preference retired or a fact superseded at time T, nothing enumerates the downstream consumers written before T that cited it: context receipts naming it in `items[].id`, decision-change receipts naming it in `evidence_triggers`, live Brain artifacts still linking to it. All the edges are already durable and already normalized across the `pref-` → `ret-` rename (retirement writes the old id into the new file's `aliases:`), so this is a time-ordered join over existing data, not a new store. Two constraints: one coarse prior art exists (a whole-corpus tree digest that invalidates one cache) and must be named rather than reinvented; and receipt emission is opt-in, so a vault with telemetry off has zero receipts — the audit must distinguish "measured nothing" from "found nothing" or it reports a clean bill of health for a vault that measured nothing.

**U4 — Codegraph resync recipe.** The system detects that an external code-index is empty, edge-collapsed, or built for the wrong root, and its only exit is prose inside a warning string. A hard module invariant forbids ever writing into the external tool's store; the project has also explicitly refused daemons and file watchers. The sanctioned mechanism is the existing "emit a cron recipe to stdout, write nothing" pattern — but that renderer is welded to the search index (script name, command and change-detection expression are hardcoded), so a second consumer cannot reuse its interval-to-cron kernel. Also blocking: the report verb returns exit 0 unconditionally, including when health is bad, so nothing can gate on it.

**U5 — Trigger suppress / unsuppress.** The proactive-finding queue is a one-way funnel with a clock on the exit: every terminal state either re-opens after a cooldown or immediately, and there is no edge back out. An operator who judges a finding structurally benign can buy seven days of silence and then it re-nags forever; a mistaken judgement can only be undone by hand-editing Markdown frontmatter. A new non-open status is indefinite for free because expiry is applied only to open statuses. The task assumes an occurrence counter it can preserve; no such counter exists — recurrence lives as a transient per-scan value and is discarded, so the audit trail has to be built. The status partition is currently hand-maintained in three separate copies across core, CLI and the MCP layer.

**U6 — Derived-store coverage in the snapshot archive.** The snapshot/rollback family (checksum sidecar, drift refusal, pre-restore diff, confirmation, retention) already ships and is complete for the Markdown tree. It archives exactly the top-level entries of `Brain/`; the derived SQLite store is a sibling directory away and is in no snapshot, no manifest and no rollback — and nothing says so, so the pre-restore diff renders a complete-looking picture while embeddings silently stay at whatever the live store holds. What is at stake is spend, not information: a rebuild restores everything except the embeddings, which cost money. The store is WAL-mode so a file copy is not consistent; the runtime exposes no online-backup API but does support a compacting `VACUUM INTO`. The sibling directory also holds encrypted secrets and lock files, so only the one store file may ever be archived. Retention defaults to ten copies and the snapshot directory is inside a peer-to-peer-replicated vault, so inclusion multiplies disk and network cost.

**U7 — Typed lifecycle history with a log surface.** Two histories exist and do not join. The event log is richly typed (41 kinds, machine-primary JSONL, per-device sharded, filterable) and records a *rollback* but has no kind for the *snapshot* it rolls back to. The snapshot family is the only revertible history and each entry is an opaque run id plus an mtime — no reason, no type — so an operator cannot ask which recovery point covers a given boundary or filter the revertible history by why it happened. Snapshot reasons exist de-facto as run-id prefixes at five call sites, three of them inline string literals, and nothing parses them back. Hard architectural constraint: the vault is plain Markdown replicated peer-to-peer with no git transport, so a `.git` directory under the synced path is forbidden; the existing snapshot family is the native journal.

**U8 — Operator standing rules.** There is no lane in the session preamble whose content the operator authors, whose position is guaranteed ahead of everything the agent learned about itself, and whose presence is independent of whether the memory layer assembled successfully. The one operator-authored file the system reads is delivered on a single pull surface, positioned last, silently dropped on any read error, and freely rewritable by four write tools because it sits outside the path-prefix refusal that protects everything else. A budget-exempt lane already exists as precedent (runtime notices are never budgeted). When the budget bites, the injection shrinks behind a notice that says *that* content was dropped but never *which* — even though the drop list is computed and discarded one line earlier.

## The architectural question you are being asked

Every one of the eight independently reinvents the same primitive: **a closed verdict vocabulary in which "could not check" is a first-class value distinct from both "checked and clean" and "checked and bad", carrying a named machine-readable reason.**

Concretely the eight want: `ok`/`modified`/`unverified` (+reason); `not_found`/`unknown`/`did_not_happen` (+reason, +coverage digest); `recorded: false` vs `rows: []`; `included`/`excluded_because`/`unknown-because-predates-the-feature`; a bad-health exit code; a `suppressed` state plus a recurrence count; a truncation notice that names what it dropped; a snapshot reason vocabulary.

The codebase already contains at least three partial precedents: a frozen `pass`/`warn`/`fail` verdict with a mismatch-report type and a renderer; a closed "could-not-check condition" code vocabulary consumed by exhaustive switches; and a typed fold-empty error asserting that no-mechanism-ran must never read as no-findings. It also contains roughly ten private copies of the same SHA-256 helper, sixteen further inline digest sites with three ad-hoc truncation lengths, and two independent reimplementations of canonical JSON serialization — and two of the eight units need a digest.

Produce variants for **how to structure this wave**: whether to introduce a shared kernel for the verdict-and-reason primitive and the digest helper before the eight units, to extend one of the existing precedents to serve all eight, or to keep every vocabulary local to its unit and accept the repetition. Consider ordering, blast radius, and what happens to the wave if the shared piece turns out to be wrong halfway through.

# Project context

Open Second Brain — TypeScript on the Bun runtime. A CLI (`o2b`) plus an MCP server over an Obsidian-compatible Markdown vault. The vault is the source of truth and is replicated peer-to-peer between machines by Syncthing; there is no git transport for it. A derived SQLite store beside the vault holds the search index and embeddings. The kernel never calls a language model; the operator owns configuration.

Recent commits:

```
34f96b84 fix: reuse and reap Hermes MCP bridges (v1.44.1)
3ee1963a feat: what the index already knew (v1.44.0)
0ae4b097 feat: provenance at the boundary (v1.43.0)
7e6a5672 refactor: module boundaries and the fallbacks behind them (v1.42.0)
5ac866eb feat: signals that survive (v1.41.0)
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0)
f91a698b feat: context integrity gates (v1.39.0)
c31a2574 feat: semantic-health baseline watermark (v1.38.0)
b0c37977 feat: retrieval quality and context delivery (v1.37.0)
842d690f feat: knowledge intake and consolidation (v1.36.0)
95dc8577 feat: trusted recall and memory write surface (v1.35.0)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0)
77513f2b feat: belief lifecycle and decision memory (v1.33.0)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1)
```

Related areas, by unit: schema pack storage and the mutation-audit shard (U1); the recall gate, the index-status snapshot and the note-root resolver (U2); the doctor check registry, the backlink index, context receipts and decision receipts (U3); the partner code-index health module and the cron-recipe renderer (U4); the trigger store, its frontmatter reader/writer and two duplicated verb tables (U5); the snapshot engine, its manifest and the destructive-snapshot gate (U6); the log event-kind table and the snapshot manifest (U7); the session-start injection hook, the section-budget primitive and the note-target path refusal (U8).

Conventions:

- Every check that can fail to run reports that it did not run, distinctly from reporting a pass. A prior release states the rule as: never-checked must never read as healthy, and only refusals are recorded, so the absence of a fault is not a pass.
- Refusals are shipped as first-class release content. Release notes name what was asked for and deliberately not built, with the reason.
- Closed vocabularies are frozen objects with a companion `Set` and a type guard, consumed by exhaustive switches that fail to compile when a member is added.
- Pure kernel plus impure collector: the joinable logic is a pure function with no I/O and the caller does the reads.
- Config keys are declared in a template that a ratchet test enforces; adding a key without a template entry or a written omission reason fails the build.
- Diagnostic codes are registered in a signal table that a census test enforces.
- Tests build disposable vaults in a temp directory; there are no network calls in tests.
- Documentation and all identifiers are English. Natural-language phrases are never hardcoded and content authored by the operator is treated as opaque bytes — never inspected for particular words, in any language.

Constraints:

- No misleading fallback of any kind. A path that returns empty, null, zero or ok when it actually failed is forbidden; the failure must surface. No stubs and no placeholders.
- Prefer extending an existing surface to adding a parallel one. No new subsystem where an existing one can carry the capability.
- Additive-only on persisted formats where a version bump would make older peers in a replicated set silently lose a guarantee.
- The wave ships as one pull request and one release version.
- Anything repeated goes into a named constant. No magic strings and no magic numbers.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
