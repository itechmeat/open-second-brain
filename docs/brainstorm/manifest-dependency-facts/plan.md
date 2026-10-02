# Deterministic dependency facts - implementation plan

Design: `docs/brainstorm/manifest-dependency-facts/design.md` (decision ids M*, H*, L* below refer to its "Design decisions").

## How to run this plan

Four lanes with DISJOINT file ownership run concurrently in the one worktree. Lane A (shared substrate) commits first; every other lane waits only on lane A and, where named, on one upstream task. A lane edits only the files listed for it under "File ownership". Every task is TDD: write the named test first, run it and see it fail for the stated reason, implement, see it pass, then `bunx oxfmt` and `bunx oxlint -c oxlint.json` on the lane's own files only, then `git add <own paths>` and one conventional commit (`feat(architect): ...`, `feat(pre-extract): ...`, `fix(reach): ...`, `docs: ...`). Retry on `index.lock`. Gates per task: `bun test <the task's test files>` and `bun run typecheck`. Tests use forward-slash relative paths and never compare absolute paths (Windows CI); credential-shaped literals come from `fakeCredential()`.

CHANGELOG, the version bump and the OpenClaw bundle belong to no lane (PR preparation and the integrator handle them). Bundled modules touched: `src/core/project-manifests.ts` and `src/core/partner/codegraph.ts` (lane A, task A1) only. The architect and the pre-extractor are not bundled.

Dependencies:

- A1 -> A2 -> A3 (A2 imports A1's vocabulary; A2 and A3 share a test file).
- A3 (lane A complete) -> B1, C1, D1.
- B1 -> B2 -> B3 -> B4 (one lane, in order).
- C1 -> C2 -> C3 -> C4 (one lane, in order). Lane C does not need lane A's code; it waits on A3 only so lane A's census edit lands first.
- D1 -> D2 -> D3 -> D4 -> D5 (one lane, in order). D5 (docs) names B4 as its one upstream task: the architect wording depends on B4's envelope and help text; the pre-extractor wording is fixed by this contract and by design decision H7, so D5 does not wait on lane C.

## Cross-lane contract (pinned now; no lane renames or re-spells any of this)

### `src/core/project-manifests.ts` (lane A, A1; Node-safe, no `Bun.*`)

- `MANIFEST_ECOSYSTEM = Object.freeze({ npm: "npm", pypi: "pypi", cargo: "cargo", go: "go", maven: "maven", gradle: "gradle", rubygems: "rubygems", composer: "composer" } as const)`; `type ManifestEcosystem`.
- `interface ManifestSpec { readonly file: string; readonly ecosystem: ManifestEcosystem; readonly dependencyReadable: boolean }`
- `DEPENDENCY_MANIFESTS: ReadonlyArray<ManifestSpec>` in precedence order: `package.json` (npm, true), `pyproject.toml` (pypi, true), `Cargo.toml` (cargo, true), `go.mod` (go, true), `pom.xml` (maven, false), `build.gradle` (gradle, false), `Gemfile` (rubygems, false), `composer.json` (composer, false).
- `CODE_MANIFEST_FILES: ReadonlyArray<string>` = the eight files above plus `tsconfig.json` (the detection set, identical to today's nine).
- `manifestSpecFor(basename: string): ManifestSpec | undefined`.

### `src/core/brain/architect/manifests.ts` (lane A, A2 and A3; may use `Bun.TOML`)

- `MANIFEST_STATUS = Object.freeze({ read: "read", malformed: "malformed", unreadable: "unreadable", unsupported: "unsupported" } as const)`, `type ManifestStatus`, `MANIFEST_STATUSES: ReadonlyArray<ManifestStatus>` (frozen), `isManifestStatus(value: unknown): value is ManifestStatus`. Registered in `CENSUS` (`tests/core/architecture/verdict-vocabulary-census.test.ts`).
- `DEPENDENCY_GROUP = Object.freeze({ dev: "dev", build: "build", optional: "optional", peer: "peer", indirect: "indirect" } as const)`, `type DependencyGroup` (no guard; not a reason vocabulary).
- `interface GroupCount { readonly group: DependencyGroup; readonly count: number }`
- `interface ManifestFact { readonly name: string | null; readonly version: string | null; readonly description: string | null; readonly dependencies: ReadonlyArray<string> }` (moved here from `scan.ts`; `scan.ts` re-exports it).
- `interface ManifestReading { readonly path: string; readonly ecosystem: ManifestEcosystem; readonly status: ManifestStatus; readonly detail?: string; readonly fact: ManifestFact | null; readonly otherGroups: ReadonlyArray<GroupCount>; readonly raw: Readonly<Record<string, unknown>> | null }`. `path` is project-relative with `/`; `detail` only for `malformed` and `unreadable`; `fact` is `null` unless `read`; `dependencies` are runtime, canonical, deduplicated, codepoint-sorted; `otherGroups` sorted by group, zero counts omitted; `raw` only for a read `package.json` (entry-point detection).
- `readManifestAt(root: string, relPath: string): ManifestReading` - dispatches on `manifestSpecFor(basename)`; throws `TypeError` naming the path when the basename is not a dependency manifest (caller error, never project content).
- `canonicalDependencyName(ecosystem: ManifestEcosystem, declared: string): string` - PEP 503 for `pypi`, identity otherwise.

### `src/core/brain/architect/scan.ts` (lane B, B1)

- `ProjectFacts.manifest: ManifestFact | null` (unchanged shape; precedence per M9).
- New `ProjectFacts.manifests: ReadonlyArray<ManifestReading>` (root and module manifests, sorted by `path`).
- New `ModuleFact.manifests: ReadonlyArray<ManifestReading>` (readings at that module path).
- New `interface ModuleDependency { readonly from: string; readonly to: string }` (module names) and `ProjectFacts.moduleDependencies: ReadonlyArray<ModuleDependency>` (sorted by `from`, then `to`).

### `src/core/brain/architect/generate.ts` (lane B, B2 and B3)

- Region ids: overview `dependencies` (rewritten body), new overview `module-dependencies` (placed directly after `dependencies` in a new overview), new module-note `dependencies`.
- Frontmatter key `depends_on` (module constant `DEPENDS_ON_KEY = "depends_on"`; B3's test asserts it is a member of `DEFAULT_RELATION_TYPES`): YAML block list of `"[[Brain/projects/arch/<repo-key>/modules/<name>|<name>]]"`, sorted; absent when empty.
- `replaceGeneratorOwnedKey(text: string, key: string, lines: ReadonlyArray<string>): string`, module-private, tested through `generateArchDocs` only.

### CLI envelope (lane B, B4)

- `o2b brain architect --json` gains `manifests: Array<{ path: string; ecosystem: string; status: ManifestStatus; detail?: string }>`, always present, sorted by `path`.

### `src/core/redactor.ts` (lane C, C1)

- `export function redactUrlCredentials(text: string): string` (the existing private function, exported unchanged).

### `src/core/brain/ingest/pre-extract.ts` and `pre-extract-hcl.ts` (lane C, C2 and C3)

- `type Language = "typescript" | "javascript" | "python" | "hcl"`; `.tf` and `.tfvars` map to `hcl`.
- `CodeEntitySeed.kind`: `"class" | "function" | "resource" | "data" | "module" | "variable" | "output" | "provider" | "locals"`.
- `CodeEdgeSeed.kind`: `"imports" | "inherits" | "uses" | "depends_on" | "references"`.
- `HCL_BLOCK_KIND = Object.freeze({ resource: "resource", data: "data", module: "module", variable: "variable", output: "output", provider: "provider", locals: "locals" } as const)` in `pre-extract-hcl.ts`.
- `parseHcl(path: string, content: string, entities: CodeEntitySeed[], edges: CodeEdgeSeed[], variablesOnly: boolean): void` (`variablesOnly` true for `.tfvars`).

### Reach (lane D)

- `RenderActiveOptions.readable?: (rel: string) => boolean` (`src/core/brain/active.ts`).
- `readActiveForReader(vault: string, opts: { readonly readable?: (rel: string) => boolean; readonly agentScope?: string }): string` in `active.ts`: file bytes when nothing is withheld, a filtered render with the on-disk `generated_at` otherwise.
- `PreCompressOptions.readable?: (rel: string) => boolean` (`src/core/brain/pre-compress-pack.ts:75`).
- `ApplyRepairOptions.reach?: TransportReach` (`src/core/brain/diagnostics.ts:1239`; `TransportReach` from `src/core/graph/transport-reach.ts`) and `doctorIssueRefs(vault: string, issue: DoctorIssueNaming): ReadonlyArray<string | undefined>` exported from `diagnostics.ts`, where `DoctorIssueNaming = { readonly message: string; readonly path?: string; readonly target?: string; readonly sources?: ReadonlyArray<string> }` (the ref extraction hoisted from `visibleIssues`, `health-tools.ts:165-186`, unchanged in behaviour).
- Matrix labels removed: `"brain_context"`, `"brain_pre_compress_pack"`, `"brain_doctor #2"`.

## File ownership (every file this plan touches, exactly one owner)

| Lane | Files |
|---|---|
| A | `src/core/project-manifests.ts` (new), `src/core/partner/codegraph.ts`, `tests/core/project-manifests.test.ts` (new), `src/core/brain/architect/manifests.ts` (new), `tests/core/brain/architect-manifests.test.ts` (new), `tests/core/architecture/verdict-vocabulary-census.test.ts` |
| B | `src/core/brain/architect/scan.ts`, `src/core/brain/architect/generate.ts`, `src/cli/brain/verbs/architect.ts`, `src/cli/brain/help-text.ts`, `tests/core/brain/architect.test.ts`, `tests/core/brain/architect-dependencies.test.ts` (new), `tests/core/brain/architect-depends-on.test.ts` (new), `tests/core/brain/architect-module-map.test.ts`, `tests/core/brain/architect-codegraph-region.test.ts`, `tests/cli/brain-architect.test.ts`, `tests/core/version.test.ts` (docblock only) |
| C | `src/core/redactor.ts`, `src/core/brain/ingest/pre-extract.ts`, `src/core/brain/ingest/pre-extract-hcl.ts` (new), `tests/core/brain/ingest/pre-extract.test.ts`, `tests/core/brain/ingest/pre-extract-hcl.test.ts` (new), `src/mcp/brain/ingest-tools.ts`, `src/cli/brain/verbs/pre-extract.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-pre-extract.test.ts`, `tests/mcp/ingest-tool.test.ts` |
| D | `src/core/brain/active.ts`, `src/mcp/brain/context-tools.ts`, `src/mcp/resources.ts`, `src/core/brain/pre-compress-pack.ts`, `src/mcp/brain/pack-tools.ts`, `src/mcp/brain/health-tools.ts`, `src/core/brain/diagnostics.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/mcp/visibility-matrix.test.ts`, `tests/core/architecture/visibility-surface-census.test.ts` (docblock only), `tests/mcp/active-digest-reach.test.ts` (new), `tests/mcp/health-repair-reach.test.ts` (new), at most two files and one test named by D4's probe, `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md` |
| none | `CHANGELOG.md`, `package.json` and the version mirrors (PR preparation); `openclaw/index.js` (integrator) |

Expected size: about 43-46 changed files.

## Tasks

### Lane A - shared substrate (commits first)

### Task A1: shared manifest vocabulary, codegraph detection on it
- **Files**: `src/core/project-manifests.ts`, `src/core/partner/codegraph.ts`, `tests/core/project-manifests.test.ts`
- **Acceptance**: the new test pins the eight specs in precedence order, the nine detection files, `manifestSpecFor`, and that the module source contains no `Bun.` reference; `tests/core/partner/codegraph.test.ts` passes unchanged (detection identical).
- **Depends on**: none

### Task A2: status vocabulary, types, `package.json` and `pyproject.toml` readers
- **Files**: `src/core/brain/architect/manifests.ts`, `tests/core/brain/architect-manifests.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Acceptance**: tests cover `read` (runtime list, `otherGroups` counts for dev, optional, peer), `malformed` with detail for broken JSON and broken TOML, `unreadable` (guarded by `CHMOD_CANNOT_DENY`), PEP 503 names, PEP 508 prefix extraction, Poetry `python` dropped; the census suite passes with `MANIFEST_STATUS` registered.
- **Depends on**: A1

### Task A3: `Cargo.toml` and `go.mod` readers, unsupported manifests
- **Files**: `src/core/brain/architect/manifests.ts`, `tests/core/brain/architect-manifests.test.ts`
- **Acceptance**: tests cover Cargo `[dependencies]`, `[target.'cfg'.dependencies]`, dotted `[dependencies.x]`, `package =` renames, dev and build counts; go.mod single-line and block `require`, `// indirect` counted, `replace`/`exclude` ignored, quoted paths, module path as name; `pom.xml`, `build.gradle`, `Gemfile`, `composer.json` return `unsupported` with no fact; a non-manifest basename throws `TypeError`.
- **Depends on**: A2

### Lane B - architect scan and generate wiring

### Task B1: root and per-module manifests, inter-module edges in the scan
- **Files**: `src/core/brain/architect/scan.ts`, `tests/core/brain/architect.test.ts`, `tests/core/version.test.ts`
- **Acceptance**: tests show precedence (package.json name wins over pyproject), `manifest` stays `null` for the flat layout, a malformed root manifest is a `malformed` reading and the name falls back to the basename, module manifests are read from the walk's paths, an edge binds on exactly one matching module name and not on two, self-edges dropped, output byte-stable across two scans; "stdlib-only" wording in the header replaced.
- **Depends on**: A3

### Task B2: `dependencies` and `module-dependencies` regions
- **Files**: `src/core/brain/architect/generate.ts`, `tests/core/brain/architect-dependencies.test.ts`, `tests/core/brain/architect-module-map.test.ts`, `tests/core/brain/architect-codegraph-region.test.ts`
- **Acceptance**: the overview lists manifests with statuses, runtime dependencies per ecosystem (module names excluded), one "not listed" count line per ecosystem; `module-dependencies` renders one Mermaid edge per `ModuleDependency` with its claim sentence and a fixed sentence when there is none; `module-map` still has only `root -->` edges; module notes gain a `dependencies` region; a second run reports `unchanged`.
- **Depends on**: B1

### Task B3: generator-owned `depends_on` frontmatter key
- **Files**: `src/core/brain/architect/generate.ts`, `tests/core/brain/architect-depends-on.test.ts`
- **Acceptance**: the key is written on creation, rewritten when edges change, removed when they vanish, other frontmatter keys and operator prose byte-identical, unchanged project unchanged; indexing the vault yields a `links` row with `relation: depends_on` from `modules/web.md` to the `modules/core` note; the header lists the third exception.
- **Depends on**: B2

### Task B4: CLI envelope and help
- **Files**: `src/cli/brain/verbs/architect.ts`, `src/cli/brain/help-text.ts`, `tests/cli/brain-architect.test.ts`
- **Acceptance**: `--json` carries `manifests` (always, sorted), text mode prints the not-read line only when needed, the help wording says "built-in runtime only, no dependency" and the long-help usage includes `--progress`.
- **Depends on**: B3

### Lane C - Terraform family in the pre-extractor

### Task C1: URL credentials redacted in every import specifier
- **Files**: `src/core/redactor.ts`, `src/core/brain/ingest/pre-extract.ts`, `tests/core/brain/ingest/pre-extract.test.ts`
- **Acceptance**: a TS, a JS and a Python specifier carrying `user:<fakeCredential>@host` yield `***REDACTED***@host` in the `imports` seed; specifiers without credentials are byte-identical to today.
- **Depends on**: A3

### Task C2: `hcl` family, typed dispatch, block entities and module sources
- **Files**: `src/core/brain/ingest/pre-extract.ts`, `src/core/brain/ingest/pre-extract-hcl.ts`, `tests/core/brain/ingest/pre-extract-hcl.test.ts`
- **Acceptance**: `.tf` yields `extracted: true, language: "hcl"` with resource, data, module, variable, output, provider and locals seeds in address syntax; a module `source` with credentials becomes a redacted `imports` seed; a `.tf` file is never a TS relative-import target; `.hcl` and `.tf.json` stay unsupported; the dispatch switch is exhaustive.
- **Depends on**: C1

### Task C3: edges and the line scanner
- **Files**: `src/core/brain/ingest/pre-extract-hcl.ts`, `tests/core/brain/ingest/pre-extract-hcl.test.ts`
- **Acceptance**: single-line `depends_on` edges, `references` edges for `var.`, `local.`, `module.`, `data.` and same-file bare resource addresses; braces inside strings and heredocs ignored; comments skipped; a nested `provisioner` `source` is not a module source; `.tfvars` yields names, never values; output deterministic; the module comment names every out-of-scope construct.
- **Depends on**: C2

### Task C4: surfaces
- **Files**: `src/mcp/brain/ingest-tools.ts`, `src/cli/brain/verbs/pre-extract.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-pre-extract.test.ts`, `tests/mcp/ingest-tool.test.ts`
- **Acceptance**: `o2b brain pre-extract main.tf --json` and `brain_ingest_source {pre_extract: true}` on a `.tf` file return HCL seeds; the `pre_extract` description stays a single line and names the Terraform seeds; the manifest description names Terraform.
- **Depends on**: C3

### Lane D - reach left-overs and docs

### Task D1: active digest filtered at read time for `brain_context` and the resource
- **Files**: `src/core/brain/active.ts`, `src/mcp/brain/context-tools.ts`, `src/mcp/resources.ts`, `tests/mcp/active-digest-reach.test.ts`
- **Acceptance**: A/B: a vault with a confirmed private preference and one without give identical normalised remote answers (counts included) free of the principle; local still shows it; a remote call on a vault with nothing withheld returns the file bytes.
- **Depends on**: A3

### Task D2: `brain_pre_compress_pack` head and top-K, registry and matrix for the digest readers
- **Files**: `src/core/brain/pre-compress-pack.ts`, `src/mcp/brain/pack-tools.ts`, `tests/mcp/active-digest-reach.test.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/mcp/visibility-matrix.test.ts`
- **Acceptance**: the pack A/B passes; rows `brain_context`, `brain_pre_compress_pack`, `osb://preferences/active` are covered; labels `"brain_context"` and `"brain_pre_compress_pack"` removed; matrix and census suites pass.
- **Depends on**: D1

### Task D3: `brain_health` and `brain_doctor` repair at reach
- **Files**: `src/mcp/brain/health-tools.ts`, `src/core/brain/diagnostics.ts`, `tests/mcp/health-repair-reach.test.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/mcp/visibility-matrix.test.ts`, `tests/core/architecture/visibility-surface-census.test.ts`
- **Acceptance**: A/B for `brain_health` and for `brain_doctor {repair: true}` dry run and apply (a private preference with a dead `evidenced_by` is neither planned nor written at remote reach, no log event; local still fixes it); rows covered, label `"brain_doctor #2"` removed.
- **Depends on**: D2

### Task D4: derived-page probe
- **Files**: the probe test and, only if the fix is at most two files, those files (recorded in the commit body); otherwise a note appended to `design.md` risks by the integrator.
- **Acceptance**: a test that indexes a vault with a private confirmed preference and runs a remote `brain_search` for its principle either passes after the fix or documents the recorded finding.
- **Depends on**: D3

### Task D5: reference docs
- **Files**: `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md`
- **Acceptance**: the architect section describes manifests, statuses, regions and the `depends_on` key; "stdlib-only" replaced; `pre-extract` lists Terraform with its named limits; a "Since v1.68.0" note in `docs/mcp.md`; `docs/updating.md` extends the reach list in the v1.67.0 wording; no card ids, no exclamation marks.
- **Depends on**: B4 (and D4 within the lane)
