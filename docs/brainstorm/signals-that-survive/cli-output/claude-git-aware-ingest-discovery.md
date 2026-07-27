### Variant 1: Inline mirror inside `batch-plan.ts`

- **Approach**: Copy the hygiene scan's layering shape directly into the ingest planner: a private `buildGitScope(dirAbs)` that reads `.git/info/exclude` then the root `.gitignore`, and a per-directory `.gitignore` extension inside `collectIngestible`, stacked *under* the operator `--exclude` layer so `--exclude` always wins. Submodules are skipped by testing each candidate directory for a `.git` entry (gitlink file or directory) before recursing. Nothing outside `src/core/brain/ingest/` changes.
- **Trade-offs**:
  - Smallest blast radius: hygiene's `listScanTargets` and its golden tests are untouched, so the 910-test suite risk is confined to ingest.
  - Byte-identical no-git path falls out naturally — with no ignore files present every added layer is empty and `IgnoreScope.isEmpty` holds, so `planId` does not shift.
  - Resolves the vault-relative/root-relative base-dir mismatch locally: layers are based at `dirRel` (or the nested dir's vault-relative path), which is exactly what `IgnoreLayer.baseDir` already models.
  - Direct DRY violation against an explicit repo constraint: two near-identical `extendWithIgnoreFile` + walk implementations that must be kept in step forever, and the submodule rule then exists in only one of them.
  - Malformed-pattern warnings need a second, ingest-shaped disposition (`buildExcludeScope` throws for `--exclude`; a repo's own broken `.gitignore` line must not fail an ingest plan), so the warning policy gets invented twice.
  - Repo-root discovery is ad hoc: if `sourceDir` points at a subtree of a checked-out repo, an inline implementation either ignores the ancestor `.gitignore` files or grows its own upward walk.
- **Complexity**: small
- **Risk**: low

### Variant 2: Extract a shared git-aware discovery module under `src/core/fs/`

- **Approach**: Promote the layering logic out of `scan-repo.ts` into a sibling of `ignore.ts` — a module owning "given a repo root, produce the base `IgnoreScope`" and "given a directory, extend a scope with its `.gitignore`", plus a submodule/non-working-tree predicate, with malformed-pattern warnings returned as structured `IgnoreWarning[]` rather than printed. `scan-repo.ts` keeps its `hygiene:` stderr sink by consuming those warnings itself; `collectIngestible` consumes the same module and chooses its own disposition (structured field on the plan, or advisory-rail code). Submodule skipping lands once and both discovery paths inherit it.
- **Trade-offs**:
  - Satisfies the DRY/SOLID constraint the repo states outright, and puts the git-metadata reader next to the matcher engine it composes with, where the next consumer will look for it.
  - Submodule handling — the one net-new piece — is written, tested, and reviewed once instead of diverging between hygiene and ingest.
  - Warnings become data rather than a side effect, which fits "findings carry their data as structured fields" and lets the plan surface a broken repo `.gitignore` without printing from the kernel.
  - Touches a currently-green subsystem: hygiene's scan is behaviour-pinned by tests, so the refactor must be provably inert there before the ingest wiring is even visible.
  - Larger review surface for a change whose user-visible payoff is entirely in ingest; the hygiene diff is pure motion.
  - Forces an early decision on the base-dir contract (repo-root-relative vs. vault-relative) that both callers must agree on, rather than deferring it.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Delegate discovery to `git` itself

- **Approach**: When `isGitRepo(dirAbs)` holds, obtain the candidate file set from `git ls-files --cached --others --exclude-standard` through the existing `runGit` helper in `src/core/brain/git/reader.ts`, then filter by extension and apply the operator `--exclude` scope on top; otherwise walk as today. Git's own answer covers nested `.gitignore`, `.git/info/exclude`, `core.excludesFile`, and submodule boundaries with no reimplementation.
- **Trade-offs**:
  - Exact parity with git semantics, including the corners `ignore.ts` explicitly disclaims (it documents a subset, not `git check-ignore` parity) — no drift between what the operator sees in `git status` and what ingest picks up.
  - Submodules, sparse checkouts, and assume-unchanged entries come free; no new matcher code at all.
  - Makes a core deterministic planner depend on an external `git` binary and on user-global config (`core.excludesFile`, `~/.config/git/ignore`), so the same vault on two machines can produce different `planId`s — directly against the deterministic-kernel and no-hidden-runtime-dependency constraints.
  - A missing or failing `git` cannot silently fall back to the dot-entry walk (that is the forbidden silent-no-op), so it must surface as an explicit error, which makes ingest newly fragile on machines without git.
  - Sits awkwardly against the repo's stance that the replicated vault carries no git; a source dir under the vault that is a real checkout is an edge the current code does not otherwise assume.
  - Process-spawn cost per plan, and output parsing/quoting (`core.quotePath`) becomes a new correctness surface.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The task's own framing is that both halves already exist and the work is composition — which makes duplicating the hygiene walk (Variant 1) a self-inflicted maintenance seam right where the repo's DRY constraint is loudest, especially since submodule handling is net-new and would otherwise be implemented in only one of two twins. Variant 3 buys exact git parity at the price of an external binary and user-global config inside a planner whose `planId` must be reproducible, which the deterministic-kernel constraint rules out. Variant 2 keeps discovery pure, in-process, and byte-identical when a source carries no ignore files, and the hygiene refactor it requires is inert motion pinned by existing tests rather than new behaviour.
