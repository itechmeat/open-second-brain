You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release for Open Second Brain that carries ten tracker items. Reconnaissance against the real source has already been done and it CORRECTED most of the tracker bodies; what follows is the corrected framing, not the original wording. Every claim below carries a file:line anchor that was opened and read, and several were reproduced by execution.

The ten items share one shape: **a boundary that is declared but not enforced**. In each case the product carries a label - a bucket name, a vocabulary member, a config gate, a scope field, a registry - and behind the label there is either no check, no reader, no writer, or a check that measures something other than what the label claims.

## The ten findings, as measured

1. **The owner-isolation layer is unconditioned.** `writePreference` emits an `owner:` field only when the caller supplies one (`src/core/brain/preference.ts:446,553`), and no production caller supplies it - not the MCP feedback tools (`src/mcp/brain/feedback-tools.ts:231-251`), not the CLI (`src/cli/brain/verbs/feedback.ts:139`), not derived-fact, merge, or the preference transaction. On any vault written through shipped surfaces every page is ownerless, `isOwnerVisible` returns true universally, and the whole filter passes everything. Separately, the MCP scope matrix (`tests/mcp/agent-scope-matrix.test.ts:301-303`) partitions 110 tools into three buckets and asserts only that each tool is classified exactly once - never that a classification is correct. Ten tools in the unasserted bucket return other agents' document identity on a bare `{}` call; one of them returns whole source lines of body text, and another returns full preference principle text plus a path.

2. **A gate that enforces self-declaration.** With `integrity.owner_scope_delivery` set to fail, `coerceAgentScope` (`src/mcp/coerce.ts:120-121`) returns the caller-supplied `agent_scope` unconditionally and `resolveOwnerScopeDelivery` (`src/core/brain/preferences-collect.ts:182`) enforces the *requested* scope, so any caller reads any owner's private preferences by naming that owner. The gate implies a check that is never performed.

3. **Four absolute thresholds compared against a pinned number.** `rankResults` min-max-normalises the keyword lane, so on a keyword-only vault (the default install, no embeddings) the top result is a constant 0.6000 to 0.6500 regardless of match quality. The recall confidence floor is 0.35, so it never rejects a weak match - but it DOES fire at 0.0000 when a `visibility:` filter removes the pool's BM25 maximum, and at 0.3000 with supersede fade on, i.e. it fires for reasons unrelated to match quality. `assessRecallAdequacy.sufficient` is 0.6 (`src/core/brain/recall-adequacy.ts:46`), exactly equal to the keyword weight, so every keyword hit grades `sufficient` and the `weak` and `insufficient` verdicts are unreachable; two shipped MCP tools sit on that. A gap-loop auto-close floor of 0.5 is always cleared, so gap tasks close on hits of arbitrary quality. A tier multiplier is wired into the ranker but `tierByDoc` has no producer anywhere in `src/`, so notes stamped `tier: peripheral` measure a multiplier of exactly 1. An absolute, pool-independent match-quality signal is already computed and then discarded (`idfWeightedCoverage`, `src/core/brain/coverage.ts:162-187`), and the vector lane's cosine is absolute and works correctly - the default install just has no vector lane.

4. **A write-only sink.** `src/core/brain/shared-namespace.ts` mirrors explicit remember-writes into a shared vault with contributor attribution carried twice (`agent` and `origin_vault`). `origin_vault` has zero readers repo-wide. `listSearchOrigins` (`src/core/brain/portability/origins.ts:34-73`) is the single place that enumerates which vaults participate in a read, and the shared namespace is not among them. Worse, that function silently drops an unreachable origin at `:63` before the search layer can see it, so a search across N origins with one dead origin returns as though the dead one honestly contributed nothing - and the `warnings` array that exists to report this (`src/core/search/cross-vault.ts:110`) cannot be populated because the information was already destroyed one layer up. A sibling module one layer down gets it right and documents the rule as "reported, never dropped".

5. **A mode switch whose modes already exist, unlabelled.** The tracker asked for `managed` / `passthrough` / `off` identity modes. Passthrough is the shipped, ungated default: 21 MCP tools accept a caller-supplied `agent` and stamp it verbatim, filtered only by a 22-string placeholder blocklist. Managed exists in exactly one tool. `off` has no subject, because the bottom of the resolution chain is the literal string `"agent"`, itself a placeholder.

6. **A per-agent selector that the transport cannot carry.** The instruction block returned at MCP `initialize` resolves the agent name from process env and config, never from the request; both transports share one server instance. "Per agent" therefore collapses to "per process", which the installer already provides. The sharper finding underneath: on the writer and catalog scopes the agent name is dropped before it is read (`src/mcp/instructions.ts:110-111`), so the always-loaded surface carrying the five identity-bearing writers never states which name to log under, while the full surface insists on it.

7. **An eighth egress site outside a registry built to prevent exactly that.** The repository has a mature egress boundary: `redactForEgress` (`src/core/egress/guard.ts:147`) with a three-value fail-closed verdict, a registry of seven declared sites each carrying a mandatory reason, and a census that derives the population structurally from source. `o2b brain explorer --export <path>` makes zero guard calls and is not in the registry; the census misses it because the flag name `export` is in neither of its two destination-name lists. Reproduced: an exported HTML file contained `OPENAI_API_KEY=sk-proj-...` verbatim where every other export path emits a redaction. Also reproduced: a page marked `private: true` in frontmatter with `tags: [private, confidential]` exports in full - only the inline region marker is honoured. Meanwhile the largest continuous egress in the product, raw vault chunk bodies POSTed to an operator-configured embedding endpoint, is outside the registry entirely and scanned by nothing.

8. **A census with a hole of the class its own docblock claims to have closed.** Four tests hand-roll a source lexer that blanks comments and literal contents while preserving byte offsets. One of them excludes the newline guard for backticks, so a backtick inside a regex literal opens a phantom template: measured, 9,706 of 31,608 bytes (31%) of one shipped module are blanked, and the only frozen binding in the entire tree that the vocabulary census cannot see is inside the blanked region. A positive control was built: a synthetic module containing a complete, correct four-piece vocabulary scans to empty today and is found under the shared lexer. Two of the four lexers are byte-identical copies of one another, differing only in a return type.

9. **A hook the host delivers and the repository does not register.** No delegation-boundary capture exists. `SubagentStop` is in the host's official event list and nothing subscribes. Also reproduced: sub-agent transcript lines carry the parent's session id and the adapter reads neither the agent id nor the sidechain flag, so a sub-agent transcript parses as 85 ordinary parent turns; and the tool-boundary "(task, result) pair" the tracker assumed does not exist, because the launch returns a receipt and the result arrives later out of band.

10. **A fail-closed ladder with nothing to guard.** The tracker asked for repo-visibility verification before data leaves the machine. There is no git transport in the product and the egress registry's own prose states there deliberately never will be; every `git` call in `src/` is read-only. Similarly, the tracker asked for a personal-to-team sanitisation pipeline with a history purge; there is no history to purge and the export bundle IS the staging copy. Two bidirectional bundle formats already exist, with importers on both sides.

# Project context

Open Second Brain: TypeScript on Bun, about 2,100 source files and 1,100 test files, roughly 10,300 tests. A hand-rolled JSON-RPC 2.0 MCP server with no SDK and exactly one runtime dependency. Also a Python plugin and a committed JavaScript bundle that CI byte-diffs.

Recent releases and their theses:

- v1.45.0 "silence is not an answer" - an empty result must say why it is empty.
- v1.46.0 "evidence at the boundary" - a claim crossing a surface carries what backs it.
- v1.47.0 "wiring what exists" - connect the mechanisms already built rather than adding new ones.
- v1.48.0 "nothing runs unwatched" - long operations report progress; a documented deadline that four call paths lacked; and the discovery that the census the previous release's argument rested on read no source at all.

Conventions this repository enforces mechanically, each by a test that fails the build:

- **The four-piece closed-vocabulary idiom**: a frozen object, a derived union type, a members array, and a type guard whose parameter is `unknown`, all in one module and registered in a census that scans `src/`. A guard typed `string` instead of `unknown` silently drops the vocabulary out of the audited population.
- **Census-as-durability**: a fix is considered durable only when a test enumerates the population structurally from source, so the next instance of the defect fails the build rather than relying on a reviewer noticing. Existing censuses cover write sites, destructive sites, doctor exit codes, vocabularies, progress emitters, egress sites, help-surface parity, import cycles, and layering.
- **Progress contract**: any options type accepting a deadline must also accept a progress sink, and every progress emitter must appear in a census with a drivable entry point.
- A new MCP tool trips four hardcoded lists including an exact tool count of 110.
- A new CLI verb that merely returns success fails a terminal-state census by name.
- Byte-identity of generated output is measured against the whole tree, never asserted per-file.

Constraints, from the operator, non-negotiable:

- No fallback that quietly does nothing. If there is an error, show the error explicitly.
- No stubs, no placeholders, no half-wired features. A mechanism that cannot change an outcome is the defect under review, not an acceptable outcome.
- Maximally native integration: no parallel idiom beside an existing one, no second registry where one exists, no new vocabulary shape.
- SOLID, KISS, DRY. Anything extractable becomes a named constant or variable.
- No hardcoded natural-language word lists in any language; language-dependent behaviour must be expressed structurally.
- Everything user-facing in English.
- The release must be implementable test-first, unit by unit, in one branch, by several agents working in parallel on separate files.

# Required output format

Produce exactly 3 distinct architectural variants for how to organise this release. The variants should differ in what the ORGANISING PRINCIPLE is - what unifies ten findings into one release, what mechanism (if any) is built to hold them together, and what is deliberately left out - not merely in which files get touched.

For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
