# Context integrity gates - variant audit trail

Consultant: Claude Code (`claude -p`), primary. Exit 0, three parseable variants and one recommendation returned on the first invocation, so the Codex fallback was not run. The prompt is at `cli-output/prompt.md`; the raw response is at `cli-output/claude.md` and is reproduced verbatim below.

Reconnaissance preceding the consultation was carried out by three parallel read-only agents against the live codebase. It corrected three premises carried in the tracker, and those corrections are reflected in the prompt rather than the tracker:

1. A note with malformed frontmatter is not dropped from the index. `parseFrontmatterText` is a line-based `key: value` scanner that cannot throw; it silently discards the lines it does not understand, so individual fields vanish while the note still indexes.
2. The "frontmatter is not valid YAML" branch in `claude-memory-parser.ts` is unreachable dead code - the function it guards contains no `throw`.
3. No vault-wide broken or dangling link count exists anywhere in the codebase. The tracker's anchors pointed at graph-degree filter machinery, so the ratchet needs a counter as well as a ceiling.

---

## Consultant response, verbatim

### Variant 1: Two seams, ten adapters

- **Approach**: Build exactly two horizontal shared modules and reduce each of the ten units to a thin adapter onto one or both. Seam 1 is a **typed degradation channel** — a non-throwing, named outcome record (`{code, site, path, detail}`) with three carriers already present in the repo: `IndexStats` (new `scanned`/`skipped` fields), `DoctorUncertainEntry`/`CheckResult` for diagnostics, and the conditional-spread MCP field for serving time. Seam 2 is a **stamp-and-verify provenance record**, generalized from the existing `computeSourceStamp` idiom (`freshness.ts:89`) with its `missing`/`unreadable` sentinels, carrying `{corpusGeneration, brainStamp, embeddingAbi, vaultIdentity}` written at build time and compared on read. A third, smaller piece falls out of both: one shared preference collector replacing the ten `readdirSync(dirs.preferences)` loops, which is the single place owner filtering and read diagnostics attach.
  - Seam 1 carries **F** (all ~15 bare `catch { continue }` sites and the `vault.ts:113` line-drop, following the `dream.ts:974` precedent), **C** (the four null causes become a `LineageOutcome` discriminated union), **D** (compaction records what it discarded instead of dropping `firstSeenMs` silently), **G** (the dangling-link count is a degradation aggregate over `target_document_id IS NULL AND target_path IS NOT NULL`, with the read-time-resolvable ladder recorded as a second, separately-named code), and **A**'s legibility half (an owner-hidden count so a thin pack is distinguishable from an empty vault).
  - Seam 2 carries **B** (pack stamp plus validity window; `corpusGeneration` alone is a lagging proxy because `packContext` walks the filesystem, so the pack stamp pairs it with a Brain-tree mtime/size stamp rather than a full sha256 manifest), **E** (a `vec_version` + model + dimension ABI token compared on read-mode open, surfaced as a reindex-required warning exactly like `EMBEDDING_PREFIX_QUERY_STATE_KEY`, never routed into `openReadOrSelfHeal` since that path rebuilds keyword-only), **J** (a vault-identity marker file, with `resolveVault` refusing rather than materializing an unmarked root), **H** and **I** (both are the stamp plus a token count riding `emitContextReceipt`, whose trigger enum widens to include a hook-layer value).
  - Fail boundary follows the line the repo already declares: serving gates fail closed (E's read-mode ABI check, J's write guard, A's filter), capture and injection stay fail-soft but now name what they dropped. **A**'s enforcement half rides an explicit flag so a null scope stays byte-identical; **C** ships abstain-on-ambiguity plus git repo/branch/commit **capture only** (recorded on the lineage event, not yet used for matching); **D** ships sequence numbers, non-lossy compaction, and a `withFileLock` around the read-modify-write, but verification reports rather than refuses to start.
- **Trade-offs**:
  - Matches the house release shape exactly: a multi-unit wave with one or two shared seams named in the changelog as carrying it (1.37.0, 1.36.0).
  - Satisfies the DRY constraint at its sharpest point — the ten-loop duplication and the fifteen swallowing catch sites are removed once, not patched per site.
  - Each unit stays independently testable and independently revertable, so unit-by-unit TDD on one branch works without a big-bang integration step.
  - The degradation channel risks becoming a dumping ground: without a closed enum reviewed per unit, "named" degrades back into "generic warning".
  - Seam-first work delays the first visibly shipped unit; the two seams must be designed against all ten consumers before any adapter lands.
  - Large test surface: every one of the ten units needs a byte-identical-when-absent test in addition to its behavior test.
- **Complexity**: large
- **Risk**: medium

### Variant 2: One delivery envelope

- **Approach**: Collapse the read path into a single mandatory chokepoint. Every content-returning surface — the nine that bypass `isOwnerVisible` plus `search()` — builds its payload, then hands it to one `deliverContext(request, payload)` pass that resolves caller identity from a new `agent` field on `ServerContext` (via `resolveAgentName`), applies the isolation rule, attaches the provenance stamp and validity window, meters the emitted token count, and optionally emits a receipt. **A**, **B**, **H**, and **I** stop being four units and become four responsibilities of one function; **E**, **F**, **G**, and **J** become preconditions asserted at the envelope's entry (store ABI verified before any semantic hit is admitted, parse diagnostics riding the payload, vault identity checked at open); **C** and **D** shrink to the single job of producing a trustworthy session key the anticipatory cache path is derived from. **G**'s CI ratchet and **D**'s compaction rewrite are deliberately deferred to 1.40.0 as the two pieces that do not touch the envelope.
- **Trade-offs**:
  - The fail-closed boundary becomes a single line anyone can point at: inside the envelope closed, outside it soft. No per-unit judgment calls, no policy sprawl.
  - Structurally forecloses the whole defect class rather than the ten instances — a future eleventh delivery surface cannot bypass isolation, because bypassing the envelope means returning nothing.
  - Fixes `brain_search_expand`'s `chunk_id` enumeration surface as a consequence rather than a special case, since `expandHit` results must also transit the envelope.
  - Highest threat to the byte-identical contract: nine surfaces change shape in one PR, and `brain_context` takes no arguments at all, so identity must be injected rather than passed.
  - Fights the stated implementation model — unit-by-unit TDD is hard when eight of ten units are facets of one function that is only correct once all eight land.
  - Blast radius is total: an envelope bug is a simultaneous outage of every context-delivery surface across a 108-tool MCP server.
  - Deferring **D** and **G** leaves the ledger's clobbering read-modify-write and the absent link counter shipping nothing in this wave.
- **Complexity**: large
- **Risk**: high

### Variant 3: Evidence plane now, enforcement by policy

- **Approach**: Split the wave along the axis of *does it refuse*. Plane one is evidence and ships complete for all ten units: every defect gets a detector that names it — F's parse diagnostics, G's dangling-link counter, H's injection meter, I's session receipt fold, B's stamp recorded, C's outcome union, D's sequence numbers, E's ABI token stamped and surfaced, A's owner-hidden count, J's identity marker written — all additive, all fail-soft, all byte-identical when unread. Plane two is a single new `gates:` config block with per-gate `off | warn | fail` modes (invalid value raises `BrainConfigError` at load, per the config contract), where only three gates gain a working `fail` mode in 1.39.0: **E** on read-mode dimension mismatch, **J** on vault-identity mismatch at write, **A** on delivery-surface owner scope. **G** additionally ships the committed baseline plus a `--check` npm script wired into `ci.yml` and `release.yml`, copying `scripts/sync-version.ts` exactly and establishing that convention. **C**'s git repo/branch/commit identity and **D**'s hash chain are explicitly deferred to 1.40.0 and named as deferred in the changelog; **C** ships only the abstain-on-ambiguity tie-break, **D** only non-lossy compaction plus a writer lock.
- **Trade-offs**:
  - Lowest-risk path to the wave's thesis: a silent failure becomes a named one on day one even where nobody is ready to refuse on it yet.
  - The `gates:` block gives the operator, not the release, authority over the fail-closed line — which is the honest position for **E**, where `vec_version()` instability across Syncthing peers could otherwise produce a rebuild loop.
  - Detection-first ordering means the counters and diagnostics exist before any gate is tuned against them, so **G**'s ceiling is derived from a measured baseline rather than guessed.
  - Half-realizes the thesis in default installs: warn-by-default means the agent still cannot tell a genuine miss from a broken mechanism unless the operator opts in.
  - A policy plane is itself an untested seam, and gate-mode combinatorics multiply the test matrix faster than the per-unit tests it replaces.
  - Deferring two of ten units under-delivers against a wave framed as ten units, and **D**'s deferred hash chain leaves the ledger's silent-loss-at-compaction contract only partly closed.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 1

**Rationale**: It is the only variant that ships all ten units while matching the house release shape — a multi-unit wave carried by one or two shared seams named in the changelog — and its two seams land precisely on the wave's actual duplication (the ten preference loops, the fifteen swallowing catches), which is what the DRY constraint demands and what Variant 3's per-unit detectors would leave in place. Variant 2's chokepoint is the structurally cleanest end state but puts nine delivery surfaces and the byte-identical contract at risk in a single pull request, and it contradicts the stated unit-by-unit TDD model. Variant 1 should absorb Variant 3's one genuinely better idea: give **E** and **A** graded modes rather than a binary gate, since `vec_version()` instability across peers and the "null scope is byte-identical" contract are both cases where the operator, not the release, should choose when refusal begins.

---

## Orchestrator decision

**Accepted: Variant 1, with the consultant's own recommended graft from Variant 3.**

The recommendation is adopted rather than overridden. Variant 1 is the only option that ships all ten units, and its two seams land on this wave's real duplication - the ten independent preference-directory walks and the fifteen bare `catch { continue }` sites - which is exactly what the DRY constraint targets and what Variant 3's per-unit detectors would have left in place. Variant 2's single delivery envelope is the cleanest end state on paper, but it puts nine delivery surfaces and the byte-identical contract into one pull request and makes eight of the ten units correct only once all eight land, which contradicts the unit-by-unit test-driven model this wave is committed to.

The graft is applied as the consultant proposed: graded `off | warn | fail` modes for the two units where the environment rather than the release should decide when refusal begins. Unit E because `vec_version()` is not stable across environments and a hard gate could produce a rebuild loop across a synced vault; unit A because every module in that path documents a "null scope is byte-identical" contract, so enabling enforcement by default would silently narrow existing vaults.

Four decisions go beyond what the consultant proposed, each forced by a reconnaissance finding the consultant was given but did not resolve:

- **The pack stamp is not `corpusGeneration()` alone.** `packContext` walks the filesystem and never reads the search index, so the index generation is a lagging proxy: a hand-edited note changes the pack without bumping `index_revision`. The stamp pairs it with a cheap Brain-tree digest over path, mtime, and size for the directories the pack actually walks. `buildManifest` was rejected for this role because it sha256-hashes every file on every call.
- **Unit E reports and never routes into the existing self-heal.** `openReadOrSelfHeal` calls `reindexVault(config)` with no options, so the rebuild is keyword-only and would leave the stale vectors in place. Routing a vector mismatch there would have produced a heal that does not heal - the exact anti-pattern this wave exists to remove.
- **The credential normalizer is a canonicalizer, not a redactor.** The existing `BASIC_AUTH_URL_RE` rewrites credentials to a placeholder, which is correct for logs and useless as an identity key: two clones carrying different tokens would compare equal to each other and unequal to a credential-free clone of the same repository. Unit C needs a comparable identity, so userinfo, port, `.git` suffix, and trailing slash are normalized away instead.
- **The degradation vocabulary is a closed union.** The consultant identified the risk that a typed channel becomes a dumping ground and named no mitigation. A closed code union makes adding a code a deliberate edit and an unhandled code a type error at the consumer.

Two units are trimmed against their tracker descriptions, both on reconnaissance evidence rather than on effort grounds:

- **The retrieval receipt** is reduced to a read-only fold plus one new operation on an existing tool. Every primitive it needs - per-item identity, tokens, tier, evidence refs, text hashes, and a per-artifact reliance score - already exists and is durable; only the session-scoped join is missing. Building a new record kind would have duplicated three existing ones.
- **The injection meter** lands the measurement only. Source-aware injection, spawn merge, hint dedupe, and listing collapse are optimizations that cannot be attributed without a measurement that does not exist yet, and the tracker note itself says to land the meter first.

One unit named in the same tracker cluster is deliberately excluded from this wave: durable cross-session work identity with explicit execution lanes. Replacing the fifteen-minute timing crutch is architectural and needs its own design record. Unit C makes the crutch's failures visible and abstains where it cannot tell, which is the prerequisite for that replacement rather than a substitute for it.
