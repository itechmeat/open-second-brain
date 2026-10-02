# Deterministic dependency facts - manifests the architect reads, Terraform seeds the pre-extractor emits, and a digest that honours reach

**Status:** draft (phase 1 spec review applied)
**Author:** release orchestrator (via feature-release-playbook)
**Audience:** implementation
**Base:** origin/main 400b20ea (v1.67.0), branch `feat/manifest-dependency-facts`

## Problem statement

The architecture scanner (`o2b brain architect`) reads one file, the root `package.json`, takes only its `dependencies` key, and turns a malformed manifest into the same `null` as an absent one (`src/core/brain/architect/scan.ts:297-318`, `catch { return null; }` at `:315-317`). Python, Go and Rust projects get no dependency facts at all, a broken manifest is never reported, and the `depends_on` relation that the graph vocabulary already defines (`src/core/graph/relation-vocab.ts:32`) is never produced for the modules the scanner finds. Separately, the deterministic pre-extractor reports `extracted: false` for every Terraform file (`src/core/brain/ingest/pre-extract.ts:81-92`), and its import seeds pass URL credentials through verbatim. Finally, three remote readers of the compiled preference digest and two health surfaces still name records the caller cannot read at its reach, the residue the v1.67.0 release left recorded.

## Premise verification (live source, 400b20ea)

Full evidence: the three reconnaissance reports of this wave (manifest facts, HCL family, reach left-overs). The orchestrator re-opened the anchors this design builds on: `architect/generate.ts:1-40, 360-425`, `graph/frontmatter-relations.ts:1-55`, `search/indexer.ts:605-630`, `graph/relation-vocab.ts:25-40`, `vault.ts:121-122`, `ingest/pre-extract.ts:76-100, 248-258, 355-372`, `redactor.ts:505-535, 815-840`, `brain/active.ts:66-92`, and ran the current CLI on a fixture (outputs in `cli-output/expected-output.md`).

### Card A (package-manifest dependency graph) - partly false, narrowed and built as narrowed

1. False as captured: "a partner-tool dependency graph with one canonical package node per package". Open Second Brain stores no code graph; the codegraph partner is read-only by contract and refuses to fabricate dependency edges (`src/core/partner/codegraph-report.ts:11-13`). What is built is the narrowed scope: deterministic manifest facts in the architect scanner.
2. Confirmed: only the root `package.json` and only `dependencies` are read (`scan.ts:297-305`); `pyproject.toml`, `go.mod`, `Cargo.toml` are read nowhere in the architect module.
3. Confirmed: a malformed manifest is swallowed silently (`scan.ts:315-317`) and then the project name falls back to the directory basename (`:372`).
4. Corrected: "the relation exists, so emitting it is wiring only". Typed edges enter the index only through frontmatter fields named after a relation (`frontmatter-relations.ts:43-55` -> `indexer.ts:613-627`, `relation: edge.relation`), and architect frontmatter is written once and never rewritten (`generate.ts:33-35`, `planNote` passes the head only on creation). Emitting `depends_on` therefore needs a declared exception to the write-once contract (decision M1).
5. Corrected (task text): "Bun has no TOML parser". `Bun.TOML.parse` exists in the CI-pinned Bun 1.4.0, is typed (`bun-types/bun.d.ts:1059-1076`) and throws `SyntaxError` on malformed input. No repo code uses it yet.
6. Reduced: "one canonical package node per package" becomes "one canonical name per dependency, deduplicated per ecosystem". External packages have no note in the vault and get none; a vault-global package directory would be a new write surface for no measured need.

### Card B (Terraform/HCL dependency graph) - partly false, narrowed and built as narrowed

1. False as captured: a tree-sitter HCL graph with attribute preservation and module-directory topology. That is partner-tool work; Open Second Brain stores no code graph.
2. Confirmed: the pre-extractor supports `.ts .tsx .mts .cts .js .jsx .mjs .cjs .py .pyi` only (`pre-extract.ts:81-92`); a fixture `.tf` file reports `unsupported source extension ".tf"`.
3. Corrected: "secret-named attribute values are redacted before anything leaves the extractor". The extractor imports no redactor and emits names only, never values, so there are no attribute values to redact. The value that does leave is a module `source` string, which can carry URL credentials.
4. Found and fixed (neutral): an import specifier that embeds URL credentials, for example `import x from "https://user:pass@host/m.js"`, is emitted verbatim as an `imports` seed today. The same URL-credential pass that protects a Terraform `source` is applied to every family's specifiers in this release.
5. Two traps confirmed in code: the dispatch is a two-way `if (language === "python") ... else parseTsJs` (`:251-255`), so a third family would fall into the TS parser silently; and `JS_FAMILY_EXTENSIONS` is derived as "every language except python" (`:98-100`), so `.tf` would become a TS relative-import target. Both are fixed by construction (decision H2).

### Fold-in (v1.67.0 reach left-overs) - confirmed, folded as recommended

1. Confirmed: `brain_context`, the `osb://preferences/active` resource and `brain_pre_compress_pack` serve the shared digest bytes (`active.ts:217-235` renders unscoped; `context-tools.ts:395, 407-412`; `resources.ts:336-354`; `pre-compress-pack.ts:114, 177-191`), so a private preference's principle reaches a remote caller. The visibility matrix already names two of them in `STILL_NAMED_AT_REMOTE` (`tests/mcp/visibility-matrix.test.ts:503-522`).
2. Confirmed: `brain_health` findings (`health-tools.ts:307-311`) and the `brain_doctor` repair plan and apply (`health-tools.ts:121-135`, `diagnostics.ts:1283-1295`) are bounded by the owner scope only.
3. Not folded, recorded: (d) `brain_status` aggregate counts, (e) the one-bit refusal of create and move onto a hidden path, (f) basename ambiguity counted over hidden pages. See "Out of scope".
4. Unverified, probed in task D4: whether `Brain/active.md`, `Brain/lessons.md` and the digest are indexed as ordinary pages and reachable through a remote `brain_search` (`DEFAULT_SKIP_FILES` is only `index.md`, `log.md`, `vault.ts:122`).

## Scope

1. A Node-safe shared manifest vocabulary: the project-detection file list (used by codegraph project detection) and the dependency-bearing subset with ecosystem tags. Replaces the private `CODE_MANIFESTS` list.
2. Manifest readers in the architect module for `package.json`, `pyproject.toml` (PEP 621, Poetry), `Cargo.toml` and `go.mod`, with a closed per-manifest status vocabulary (`read`, `malformed`, `unreadable`, `unsupported`) registered in the vocabulary census. `pom.xml`, `build.gradle`, `Gemfile`, `composer.json` are detected and reported `unsupported` by name.
3. Root manifests and per-module manifests (at the detected module paths) read from the walk's path list; the overview's `dependencies` region lists runtime dependencies per ecosystem, the manifests read and their statuses, and one count line per ecosystem for the groups not listed.
4. Inter-module dependency facts: a module whose manifest declares a runtime dependency on the manifest name of exactly one other module gets a `depends_on` edge. Rendered as a new `module-dependencies` region (Mermaid, its own claim sentence) in the overview, as a `dependencies` region on each module note, and as a generator-owned `depends_on` frontmatter key on module notes, which the indexer turns into typed `depends_on` links.
5. An additive `manifests` field in the `o2b brain architect --json` envelope and one text line when a manifest was not read.
6. A Terraform family (`hcl`, `.tf` and `.tfvars`) in the pre-extractor: block entities in Terraform address syntax, `depends_on` and `references` edges, module `source` as an `imports` seed. Names only.
7. URL credentials redacted in every import specifier the pre-extractor emits (all families).
8. The active digest, the resource and the pre-compress pack treat a preference the caller cannot read at its reach as absent; `brain_health` findings and `brain_doctor` repair do the same; the registry rows flip to covered.
9. Docs: `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md`.

## Out of scope

- A partner-tool dependency graph, package notes, a vault-global package directory, version-constraint facts, lockfile reading.
- Maven, Gradle, Bundler and Composer dependency reading (reported `unsupported` by name: no XML reader in the runtime, and Maven semantics such as parent POMs, `dependencyManagement` and property interpolation cannot be read honestly from one file).
- Workspace member discovery (`package.json#workspaces`, Cargo `[workspace] members`, `go.work`) and new module bases (`crates/`, `cmd/`, `internal/`). `MODULE_BASES` is unchanged, so no existing note path moves.
- HCL: `.hcl` files (Terragrunt, Packer, Nomad, Vault policies, `.terraform.lock.hcl` use other block vocabularies), `.tf.json`, attribute values, nested blocks (`lifecycle`, `dynamic`, `provisioner`, `connection`) as entities, multi-line `depends_on` lists and expressions, references inside heredocs or template files, `for_each`/`count` expansion, `moved`/`import`/`check`/`removed` blocks, `terraform {}` settings and `required_providers`, resolution of a local module `source` to a directory. Batch-plan admission of `.tf` (code files are not batch-planned today; `.ts` and `.py` are not admitted either).
- Left-overs (d), (e), (f) as product decisions:
  - (d) `brain_status` doctor and preference counts stay whole-layer aggregates: no path, title or body leaves, the v1.67.0 dispositions already accept aggregate counts, and a partial fix would still leave the stale-scan and review-queue aggregates, so the registry row stays excluded either way.
  - (e) `brain_create_note` and lifecycle move or rename onto a hidden existing path keep their refusal: any other answer either overwrites a page or reports a write that did not happen. Pinned by `tests/mcp/note-write-reach.test.ts:99-104` and `tests/mcp/note-lifecycle-references-reach.test.ts:115-135`.
  - (f) a hidden page sharing a basename with a moved note still turns the link rewrite ambiguous: counting only readable files would rewrite `[[Old]]` to a link that is ambiguous for every reader who can see the hidden page.
- CHANGELOG and the version bump (PR preparation), the OpenClaw bundle rebuild (integrator).

## Chosen approach

Variant 2 of the consultant ("manifest registry, fact-bearing module edges, reach-rendered digest"), adjusted: one shared Node-safe vocabulary module, one readers module with a closed status vocabulary, the scanner composing them, the generator rendering regions plus one generator-owned frontmatter key; the pre-extractor gains an `hcl` family in its own module behind a typed switch, with one specifier step that runs the redactor's URL-credential pass for every family; the active digest is re-rendered for a remote reader only when something is withheld. The consultant's status vocabulary `ok | malformed | unsupported` is replaced by `read | malformed | unreadable | unsupported` because an unreadable file (permission, I/O) and a malformed one are different operator actions.

## Design decisions

One vocabulary note: wherever this release names a dependency (architect manifests and Terraform seeds alike) it uses one canonical name per ecosystem: the name as the ecosystem defines identity (npm and Go as declared, PyPI normalised per PEP 503, a Cargo dependency renamed with `package =` resolved to the real crate name, a Terraform module by its `module.<name>` address). The manifest status vocabulary and the pre-extractor's `extracted: false` reason stay separate: they belong to different subsystems with different consumers.

### Manifest facts (cards A, lanes A and B)

- **M1 (D1) Typed `depends_on` is emitted.** Inter-module edges go into a generator-owned frontmatter key `depends_on` on module notes, rewritten on every run. This is the third declared exception in the `generate.ts` header list: the generator owns exactly that key, never touches any other frontmatter key, removes the key when a module has no edge, and writes it as a YAML block list of quoted wikilinks to the target module notes. An unchanged project rewrites identical bytes (the merge returns the input when the rendered key is equal), so the byte-identity guarantee still holds. Evidence: the indexer reads every page's frontmatter, including notes under `Brain/projects/arch/`, which is not a skipped directory (`vault.ts:121`), and pushes each relation field as a link with `relation` set (`indexer.ts:613-627`); `normalizeRelationTarget` peels `"[[...]]"` (`frontmatter-relations.ts`). Task B3 proves the round trip with an index test. External packages have no note and stay a rendered list.
- **M2 (D2) `module-map` stays containment-only.** Module dependencies render in a separate `module-dependencies` region with its own claim sentence: edges are declared by manifests, not measured from imports. The `module-map` claim and its tests (`architect-module-map.test.ts:4-9, 91, 137`) stay true. On a new overview the region follows `dependencies` (both are dependency facts); on an existing overview `mergeRegions` appends a new region at document end (`regions.ts:20-26`), stated in the docs.
- **M3 (D3) Record, never throw.** `MANIFEST_STATUS` (`read`, `malformed`, `unreadable`, `unsupported`) follows the four-piece idiom and is registered in `CENSUS`. A `malformed` or `unreadable` reading carries a location-free `detail` (the parser's message, or the errno code) and its project-relative path. One bad manifest never aborts the run: the run fails closed only on vault corruption (`RegionError`), as today.
- **M4 (D4) TOML through `Bun.TOML.parse`**, inside `src/core/brain/architect/` only (not in the OpenClaw bundle). `SyntaxError` maps to `malformed` with its message. `readCargoWorkspace` in the partner module is left alone (different module, own tests).
- **M5 (D5)** `pom.xml`, `build.gradle`, `Gemfile`, `composer.json` are detected and reported `unsupported` by name with their ecosystem, no dependencies.
- **M6 (D6) One shared vocabulary.** `src/core/project-manifests.ts` holds the detection list and the dependency-bearing subset with ecosystem tags; it uses no `Bun.*` API because `src/core/partner/codegraph.ts` imports it and is bundled into `openclaw/index.js`. The detection set stays exactly the nine files of today, so `isCodeProject` behaves identically.
- **M7 (D7) Runtime dependencies are listed; other groups are counted.** Listed: npm `dependencies`; PEP 621 `project.dependencies` plus Poetry `tool.poetry.dependencies` minus `python`; Cargo `[dependencies]` plus `[target.*.dependencies]`; go.mod `require` entries without `// indirect`. Counted on one line per ecosystem, not listed: `dev` (npm `devDependencies`, Poetry dev groups, PEP 735 `dependency-groups`, Cargo `dev-dependencies`), `build` (Cargo `build-dependencies`), `optional` (npm `optionalDependencies`, PEP 621 `optional-dependencies`), `indirect` (go.mod `// indirect`). `peerDependencies` is counted as `peer`.
- **M8 (D8) Per-module manifests** are read at each detected module path from the walk's path list (no second traversal; `WalkStats.paths`). Edge binding uses exactly-one matching (`resolveUniqueMatch`, the v1.63.0 binding rule): a declared name that matches two modules' manifest names binds nothing. Self-edges are dropped. `MODULE_BASES` is unchanged.
- **M9 (D9) All root manifests are read.** `name`, `version`, `description` come from the first `read` root manifest in the fixed precedence `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` (go: the module path is the name). `facts.manifest` keeps today's shape and stays `null` when no root manifest is read, so the flat-layout test (`architect.test.ts:142`) and every JS vault's project name are unchanged.
- **M10 Wording.** "stdlib-only" is replaced by "built-in runtime only, no dependency" in `scan.ts`, the help text, `docs/how-it-works.md` and `docs/cli-reference.md`.
- **M11 CLI envelope.** `manifests` is always present in `--json` (a scan fact like `module_paths`, empty array when no manifest exists): `[{ path, ecosystem, status, detail? }]`, sorted by path. Text mode adds one line only when some manifest is not `read`.

### Terraform family (card B, lane C)

- **H1 Language `hcl`** for `.tf` and `.tfvars` only; `.hcl` keeps the existing unsupported reason.
- **H2 Dispatch becomes an exhaustive `switch` on the language** with a `never` check; `JS_FAMILY_EXTENSIONS` filters for `typescript` and `javascript` explicitly.
- **H3 Seeds use Terraform address syntax.** New entity kinds `resource` (`<type>.<name>`), `data` (`data.<type>.<name>`), `module` (`module.<name>`), `variable` (`var.<name>`), `output` (`output.<name>`), `provider` (`provider.<name>`), `locals` (`local.<name>`, one per declared local). New edge kinds `depends_on` (address to address, single-line lists) and `references` (block address to a cited `var.`, `local.`, `module.`, `data.` address, or a bare `<type>.<name>` declared as a resource in the same file). A module `source` becomes an `imports` seed from the file path to the redacted source string, never with `resolvedTo` (a directory is not a file).
- **H4 Names only, never values.** `.tfvars` yields `variable` seeds for depth-0 assignment names only, which is where literal secrets live.
- **H5 A per-line scanner** tracks brace depth outside quoted strings (with `\"` escapes), heredoc terminators (`<<EOF`, `<<-EOF`) and `#`, `//` and `/* */` comments, so braces and text inside strings and heredocs never count. It lives in `src/core/brain/ingest/pre-extract-hcl.ts` to keep the line-grammar module readable; it is the first stateful family in the module.
- **H6 URL credentials** are redacted by exporting the redactor's existing URL-credential pass (`redactUrlCredentials`, `redactor.ts:524`) and applying it in the one specifier step (`importSeed` and the HCL `source`). The full `redactRawOutput` is not used because its key-value passes would rewrite specifier text.
- **H7 Out-of-scope constructs are declared by name** in the module comment and in `docs/cli-reference.md`, as the JSX limits are today (`pre-extract.ts:201-207`).

### Reach left-overs (lane D)

- **L1 Read-time filter.** `RenderActiveOptions` gains `readable?: (rel: string) => boolean` applied to the active and recently-retired sets; counts and most-applied follow from the render. The shared write stays unscoped (`active.ts:69-82`). A remote reader re-renders only when at least one record is withheld, passing the on-disk `generated_at`; otherwise it serves the file bytes, so vaults with nothing withheld stay byte-identical (`tests/mcp/brain-context.test.ts:168, 176-196`).
- **L2 All three readers:** `brain_context`, the `osb://preferences/active` resource (through `requestView(ctx)`, which also brings the owner gate to the resource; stated in the docs as a behaviour change under `owner_scope_delivery: fail`), and the `brain_pre_compress_pack` head and top-K walk.
- **L3 `brain_health`** composes `everyArtifactRefView(owner, reachView(vault, contextReach(ctx)))` in place of the owner view; the verdict is refolded over the kept families as today.
- **L4 `brain_doctor` repair** filters doctor issues by the same composed view before `planRepair(vault, { issues })`, so fixes, needs-review and `unfixable` counts are all bounded and nothing withheld is written at remote reach. The issue-ref extraction used by the report branch is hoisted into `diagnostics.ts` so both branches share it.
- **L5** Registry rows `brain_context`, `brain_pre_compress_pack`, `osb://preferences/active`, `brain_health`, `brain_doctor` flip to covered; `"brain_context"`, `"brain_pre_compress_pack"`, `"brain_doctor #2"` leave `STILL_NAMED_AT_REMOTE`. Public wording extends the v1.67.0 phrasing: these tools now also "treat a page the caller cannot read at its reach as absent".
- **L6 Derived pages probe (D4).** If `Brain/active.md`, `Brain/lessons.md` or the digest are indexed and a remote `brain_search` returns a withheld preference's text through them, and the fix is at most two files (apply the same read-time rule to their chunks, or keep the derived files out of the index), it is included; otherwise the finding is recorded in this document's risks and in the PR.

## File changes

New: `src/core/project-manifests.ts`, `src/core/brain/architect/manifests.ts`, `src/core/brain/ingest/pre-extract-hcl.ts`; tests `tests/core/project-manifests.test.ts`, `tests/core/brain/architect-manifests.test.ts`, `tests/core/brain/architect-dependencies.test.ts`, `tests/core/brain/architect-depends-on.test.ts`, `tests/core/brain/ingest/pre-extract-hcl.test.ts`, `tests/mcp/active-digest-reach.test.ts`, `tests/mcp/health-repair-reach.test.ts`.

Modified: `src/core/partner/codegraph.ts`, `src/core/brain/architect/scan.ts`, `src/core/brain/architect/generate.ts`, `src/cli/brain/verbs/architect.ts`, `src/cli/brain/help-text.ts`, `src/core/brain/ingest/pre-extract.ts`, `src/core/redactor.ts`, `src/mcp/brain/ingest-tools.ts`, `src/cli/brain/verbs/pre-extract.ts`, `src/cli/command-manifest.ts`, `src/core/brain/active.ts`, `src/mcp/brain/context-tools.ts`, `src/mcp/resources.ts`, `src/core/brain/pre-compress-pack.ts`, `src/mcp/brain/pack-tools.ts`, `src/mcp/brain/health-tools.ts`, `src/core/brain/diagnostics.ts`, `src/core/search/visibility-surface-registry.ts`, and the tests and docs listed under "File ownership" in `plan.md`. Exact ownership per lane is in `plan.md`.

Bundled modules: `src/core/partner/codegraph.ts` and the new `src/core/project-manifests.ts` (lane A) enter `openclaw/index.js`; the architect and the pre-extractor are not bundled. The integrator rebuilds the bundle once after all lanes.

## Risks and open questions

- Existing overviews gain `module-dependencies` at document end, and module notes gain a `dependencies` region at document end, once (expected `updated` on the first run after upgrade).
- The generator-owned `depends_on` key overwrites any value an operator typed under that key on a module note; documented in the header exception and in `docs/how-it-works.md`.
- `Bun.TOML.parse` is a runtime built-in; if a future build bundles the architect for Node, the readers must move behind a runtime check. The readers module states this in its header.
- PEP 508 name extraction is a prefix rule (up to the first of `[ ( < > = ! ~ ; @` or whitespace); exotic direct references are named by that prefix only.
- The HCL scanner is a line grammar: a block header split across lines is not seen. Declared by name.
- Derived-page indexing (L6), verified by task D4: the compiled digest pages (`Brain/active.md`, `Brain/lessons.md`) are ordinary pages to the index. This release withholds them from generic page readers below local reach in the shared reach predicate (`isPathReadableAtReach`, with the pages named once in `BRAIN_COMPILED_DIGEST_RELS`); the dedicated readers (`brain_context`, the `osb://preferences/active` resource, `brain_pre_compress_pack`, `osb://lessons`, `brain_brief` `view=digest` and `view=morning`, `osb://digest/latest`) serve a per-reader render instead. Local reach and the index are unchanged; the D4 test is an A/B between local and remote reach. The count views and the status counts remain registered as excluded readers.
- Manifest input is untrusted text from a cloned repository. A name that is not a plausible package name is counted as `unrepresentable` and never written; head fields are folded to one line with `[[` escaped; a parser failure is recorded with a fixed reason, never the parser's message; a nesting depth the parser cannot hold is `malformed` (`nesting too deep`); a manifest larger than `MANIFEST_MAX_BYTES` or not a regular file is `unreadable`. None of these aborts the run.
