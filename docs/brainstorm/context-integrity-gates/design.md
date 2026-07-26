# Context integrity gates - every silent failure becomes a named one

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Ten defects in Open Second Brain's read and delivery path degrade quietly. Owner-scoped isolation is enforced on one surface out of thirteen. A context pack carries no record of the vault state it was built from, so a stale pack is indistinguishable from a fresh one. Session continuation resolves ambiguity by picking the most recent candidate instead of abstaining. The lineage ledger loses history on compaction and has no writer lock. An embedding store written against a different model, dimension, or sqlite-vec ABI returns zero or garbage neighbours on the read path with no check at all. A frontmatter line the parser does not understand is dropped without a trace. Nothing counts broken links vault-wide. Nothing measures the SessionStart injection. Nothing joins retrieval receipts across a session. A mis-resolved vault root is materialized by the first write, and the doctor reports it clean.

In every one of these cases the agent cannot distinguish a genuine miss from a broken mechanism, which is precisely the failure mode this project's design posture exists to prevent.

## Scope

Ten units, carried by two shared seams.

**Seam 1 - typed degradation channel.** One closed-vocabulary notice record (`code`, `site`, `path?`, `detail`) plus the helper that emits it, carried by the report types that already exist: `IndexStats` for index runs, `DoctorUncertainEntry` for the doctor, and conditional-spread additive fields for MCP responses.

**Seam 2 - stamp and compare.** One module owning the "record what you were derived from, verify on read" pattern: a stamp comparison over a token map, a typed mismatch, and the three-mode gate resolution (`off` / `warn` / `fail`) that lets the operator choose where refusal begins.

Units:

- **A. Owner-scope isolation across every context-delivery surface.** A shared preference collector replaces the ten independent `readdirSync(dirs.preferences)` loops and becomes the single place the owner predicate attaches. Search-backed surfaces thread `agentScope` into the existing `SearchOptions`. `expandHit` gains a per-hit owner check. A table-driven regression test asserts the rule on every content-returning surface.
- **B. Context packs bound to a source generation and a validity window.** Packs carry a provenance stamp and an expiry; the anticipatory cache refuses a stamp mismatch instead of silently rebuilding.
- **C. Fail-closed session continuation.** The crutch resolver returns a named outcome instead of a bare `null`, abstains on ambiguity rather than picking the most recent, and records repo, branch, and commit evidence with credential-free remote normalization.
- **D. Session-lineage ledger hardening.** Sequence numbers, a hash chain, a writer lock, lossless compaction, and a verification pass that reports rather than refuses.
- **E. Embedding-store ABI and dimension mismatch.** The sqlite-vec version joins the model and dimension already stamped in `index_state`; the comparison moves onto the read path, where today there is none.
- **F. Malformed frontmatter reported instead of silently dropped.** The line scanner gains a diagnostic channel; the index run, the doctor, and the fifteen swallowing call sites surface what they discarded.
- **G. Vault-wide broken-link ratchet gate.** A deterministic dangling-link counter, a committed ceiling file, and a `--check` form wired into CI, copying `scripts/sync-version.ts` exactly.
- **H. Injection-size meter for the SessionStart eager layer.** Per-source bytes and tokens measured where the sub-bodies still exist as separate strings, emitted into the receipt surface.
- **I. Session-scoped retrieval receipt.** A read-only fold over records that already exist, exposed as a new operation on an existing tool.
- **J. Guard against writes to an unexpected memory-store location.** A vault identity marker, a write-path assertion, validation in `brain_switch_vault`, and removal of the doctor early return that masks the condition.

## Out of scope

- **Durable cross-session work identity with execution lanes** (kanban `t_e6be4f6b`). The timing crutch stays; C makes its failures visible and abstains where it cannot tell, which is the prerequisite for replacing it. The replacement is architectural and needs its own design record.
- **A `--fix` consumer for the diagnostics this wave produces** (kanban `t_f35e184a`). This wave establishes the finding contract; a deterministic applier over it is a separate unit of work.
- **Shrinking the SessionStart eager layer.** H lands the meter only. Source-aware injection, spawn merge, hint dedupe, and listing collapse are optimizations that must be attributable to a measurement that does not exist yet.
- **A writer surface for `owner`.** `writePreference` already accepts `input.owner`; no MCP handler or CLI verb passes it. A adds enforcement and leaves the write plumbing as it is, so the gate defaults to `off` and no existing vault narrows.
- **Making the lineage ledger a security boundary.** D hardens integrity and concurrency; the read path stays fail-soft by contract, because continuity is best-effort and a ledger that refuses to start would break resolution rather than degrade.
- **Routing an embedding mismatch into `openReadOrSelfHeal`.** That path calls `reindexVault(config)` with no options, so the rebuild is keyword-only and would not touch the vectors. E reports; it does not pretend to heal.

## Chosen approach

Two horizontal seams, ten thin adapters (consultant Variant 1), with graded gate modes grafted from Variant 3 for the two units where the environment - not the release - should decide when refusal begins.

The seams are chosen because they land on this wave's actual duplication. Seam 1 removes fifteen bare `catch { continue }` sites and one structural line-drop by giving them one place to report to. Seam 2 removes three independent "compare a recorded token against a live token" implementations that B, E, and J would otherwise each invent. The shared preference collector that A needs is a third, smaller consequence of the same principle: ten copies of the same directory walk become one, and the owner predicate attaches to it once.

Graded modes apply to exactly two units. **E** because `vec_version()` is not stable across environments: two peers on different sqlite-vec builds would each see a mismatch, and a hard gate could produce a rebuild loop across a synced vault. **A** because every module in that path documents a "null scope is byte-identical" contract, and defaulting a scope from the resolved agent name would silently narrow existing vaults. Everywhere else the gate is binary, because the condition is unambiguous: a pack whose stamp no longer matches is stale, a vault whose recorded identity does not match the resolved root is the wrong vault.

The fail-closed and fail-soft boundary follows the line this repository already draws and states in module docblocks: capture and injection paths swallow errors and now name what they dropped; serving gates refuse. Concretely, E's read-path check, A's delivery filter, B's cache rejection, and J's write guard fail closed; C's abstention, D's verification, F's diagnostics, and H's meter are fail-soft and report.

## Design decisions

- **The degradation vocabulary is a closed union, not a free string.** The consultant's own critique of Variant 1 is that a typed channel becomes a dumping ground. A closed `DegradationCode` union reviewed per unit is the mitigation: adding a code is a deliberate edit, and an exhaustive switch makes an unhandled code a type error.
- **`parseFrontmatterText` keeps its exact signature.** A sibling returning `[map, body, notices]` carries the diagnostics; the existing two-tuple function delegates and discards. Every one of its callers stays byte-identical until it opts in. This is why F can convert fifteen call sites without a single behavioural regression in the ones not yet converted.
- **The pack stamp pairs `corpusGeneration()` with a Brain-tree stamp.** `corpusGeneration()` alone is a lagging proxy: `packContext` walks the filesystem and never reads the index, so a hand-edited note changes the pack without bumping `index_revision`. The Brain-tree stamp is a digest over path, mtime, and size for the directories the pack actually walks - cheap, unlike `buildManifest`, which sha256-hashes every file per call.
- **The anticipatory cache schema version bumps.** Pre-existing cache files then read as misses rather than as un-stamped hits, reusing the rejection branch `readCacheFile` already has for a schema mismatch. No migration, no ambiguity.
- **E stamps and compares; it never silently rebuilds.** The precedent is the embedding prefix pair, which stamps a compat token at build time and surfaces a reindex-required warning. E follows it exactly, adds `vec_version` to the same `index_state` block with the same delete-on-change semantics, and moves the comparison to the read-mode open where today nothing checks.
- **C captures git evidence and uses it; it does not replace the timing window.** Repo, branch, and commit become additional required-match predicates alongside the existing `cwd` and freshness rules. The 15-minute window stays as the freshness bound. The change that matters more is the tie-break: two surviving candidates now abstain with `ambiguous` instead of resolving by recency.
- **The credential normalizer is a canonicalizer, not a redactor.** `BASIC_AUTH_URL_RE` rewrites credentials to a placeholder, which is correct for logs and useless as an identity key: two clones with different tokens would produce the same redacted string but a different one from a credential-free clone. C needs `scheme://host/org/repo` with userinfo, port, `.git` suffix, and trailing slash normalized away, so the same repository compares equal regardless of how it was cloned.
- **D's verification reports; it never refuses to start.** `readLineageLedger`'s catch-to-empty-map is load-bearing for both the anticipatory cache and the session-lifecycle hook. Verification is a separate exported function whose findings reach the doctor.
- **D's compaction stops summarizing.** The lossy fold to one line per session is replaced by retention of the most recent lines verbatim, so `firstSeenMs`, event history, and any field added later survive. The re-serializer that hard-codes its field list disappears with it, which removes the silent-field-loss trap rather than documenting it.
- **G counts links unresolved after the read-time ladder.** ~~The counter uses the SQL definition (`target_document_id IS NULL`) because it is the one that is stable, index-backed, and reproducible.~~ Superseded by measurement: the SQL predicate reported 55 dangling out of 55 link rows on `templates/brain-starter`, because that vault is written in basename wikilinks the ladder resolves and the column does not — so the count rose on healthy edits as much as on broken ones. The counter now shares the ladder's SQL with `resolvedDocLinkPairs` and counts what it leaves unresolved. Every rung is still index-backed and deterministic. The ceiling file records the definition token alongside the count so a change of definition cannot be mistaken for link rot; the `--check` form refuses a foreign token and the write form re-measures under the new one. The count is taken after a full resolution pass, never from a partial incremental state.
- **G's ceiling is JSON at the repository root.** Every machine-read committed invariant here is JSON at the root, and JSON gets free coverage from `fmt:check` and the release-time JSON validation step. The file carries `schema_version`, matching the convention in `schemas/brain/`.
- **H measures at emission, not at assembly.** The measurement is taken after the fail-open loader returns, so it reflects what is actually written to stdout, and it records the loader's `source` so a degraded-to-cache injection is distinguishable from a genuinely small one.
- **I adds an operation, not a tool.** The MCP tool count stays 108. The fold is read-only over `context_receipt` records that already carry every field the report needs.
- **J distinguishes "unmarked" from "mismatched".** An absent marker cannot tell an old vault from a wrong root, so it warns. A marker that is present and does not match the expectation is unambiguous, so it refuses. The init path writes the marker; the write guard is the only new assertion, and it hangs off the function every Brain writer already funnels through.
- **No new dependency, no LLM call, no natural-language word list.** Every predicate in this wave is structural: a frontmatter field, a SQL null, a hash comparison, a token count, a directory identity.

## File changes

New modules:

- `src/core/integrity/degradation.ts` - the notice record, the closed code union, the emit helper.
- `src/core/integrity/stamp.ts` - stamp comparison, typed mismatch, gate-mode resolution.
- `src/core/brain/preferences-collect.ts` - the shared preference collector with the owner predicate.
- `src/core/brain/lineage/verify.ts` - ledger chain verification.
- `src/core/brain/vault-identity.ts` - marker read, write, and comparison.
- `src/core/search/link-ratchet.ts` - the dangling-link counter and ceiling comparison.
- `scripts/link-ratchet.ts` - the write and `--check` forms.
- `link-ratchet.json` - the committed ceiling, repository root.

Modified, by unit:

- **Seam 1 / F**: `src/core/vault.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/core/brain/doctor.ts`, and the fifteen swallowing call sites.
- **Seam 2 / config**: `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `src/core/brain/index.ts`.
- **A**: `src/core/brain/context-pack.ts`, `pre-compress-pack.ts`, `morning-brief.ts`, `digest.ts`, `active.ts`, `file-recall.ts`, `deep-synthesis.ts`, `src/core/search/cards.ts`, `src/cli/search.ts`, `src/cli/brain/verbs/sgrep.ts`, `src/mcp/tool-contract.ts`, `src/mcp/brain/pack-tools.ts`, `brief-tools.ts`, `context-tools.ts`, `src/mcp/search-tools.ts`.
- **B**: `src/core/brain/context-pack.ts`, `anticipatory-cache.ts`, `src/mcp/brain/pack-tools.ts`.
- **C**: `src/core/brain/lineage/crutch.ts`, `resolve.ts`, `ledger.ts`, `types.ts`, `src/core/brain/session-lifecycle.ts`, `src/core/brain/git/reader.ts`, `src/core/redactor.ts`.
- **D**: `src/core/brain/lineage/ledger.ts`.
- **E**: `src/core/search/store.ts`, `indexer.ts`, `types.ts`, `src/cli/search.ts`.
- **G**: `src/core/search/store.ts`, `src/mcp/brain/hygiene-tools.ts`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- **H**: `hooks/active-inject.ts`, `src/core/brain/context-receipts.ts`.
- **I**: `src/core/brain/context-receipts.ts`, `observed-use.ts`, `src/mcp/brain/pack-tools.ts`.
- **J**: `src/core/brain/paths.ts`, `init.ts`, `doctor.ts`, `src/core/brain/portability/profiles.ts`, `src/mcp/brain/entity-tools.ts`.

Docs: `CHANGELOG.md`, `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/how-it-works.md`.

## Risks and open questions

- **Byte-identical regression surface.** Ten units each need an assertion that output is unchanged when the new field, flag, or config key is absent. This is the largest single share of the test budget and is non-negotiable: the contract is stated in module docblocks throughout the repository.
- **A touches ten preference-reading call sites at once.** The mitigation is that the collector is introduced first with identical behaviour and no predicate, so the refactor and the enforcement are separately reviewable and separately revertable.
- **`vec_version()` instability across peers** is the reason E defaults to `warn`. If the observed value proves stable enough in practice, the default can tighten in a later release; tightening it in this one would risk a rebuild loop on a synced vault.
- **G's first ceiling is a measurement, not a target.** It is generated from the current vault state, which means the initial value encodes whatever link rot exists today. That is the point of a ratchet, but the changelog must say so plainly rather than implying the vault is clean.
- **D's writer lock has no retry in its synchronous form.** An `ELOCKED` throw lands in the existing outer catch and drops the observation - which the new sequence numbers would then correctly flag as a gap. The implementation must decide between a bounded retry and recording the gap explicitly; recording it is preferred, since a named gap is exactly what this wave is for.
- **H fires on PostCompact as well as SessionStart**, so two measurements per compacted session are expected. The record carries the hook event name so the two are distinguishable rather than double-counted.
- **The `gates` vocabulary must not grow past the two units that need it.** Every additional mode multiplies the test matrix; units whose condition is unambiguous stay binary.
