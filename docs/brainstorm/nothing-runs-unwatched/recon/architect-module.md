# Recon — `architect` module (t_4b479851)

Subject: `feat/nothing-runs-unwatched`, based on v1.47.0 (`aa818084 feat: wiring what exists (v1.47.0) (#164)`).
Every claim below carries a `path:LINE` anchor that was read. Measurements were run on this repository as
subject; the exact commands are reproduced in section 2.

## 1. The full architect surface

The module is two files, 408 lines total.

| File | Role | Public entry points |
| --- | --- | --- |
| `src/core/brain/architect/scan.ts` (229 lines) | Stdlib-only structural scan of one project tree into frozen facts. No network, no LLM, no language parsing (`src/core/brain/architect/scan.ts:1-13`). | `scanProject(projectRoot): ProjectFacts` (`src/core/brain/architect/scan.ts:214`); types `ModuleFact` / `ManifestFact` / `ProjectFacts` (`:48`, `:58`, `:65`) |
| `src/core/brain/architect/generate.ts` (179 lines) | Renders those facts into vault notes under `Brain/projects/arch/<repo-key>/` through sentinel regions. | `generateArchDocs(vault, projectRoot): GenerateArchDocsResult` (`src/core/brain/architect/generate.ts:131`); result type at `:32` |

Nothing else lives in the directory (`ls src/core/brain/architect/` → `generate.ts`, `scan.ts`).

Internal helpers, for the cost analysis below: `walk` (`scan.ts:84`), `statsFor` (`scan.ts:115`), `listDirs`
(`scan.ts:121`), `readManifest` (`scan.ts:141`), `detectModules` (`scan.ts:161`), `detectEntryPoints`
(`scan.ts:193`); `languagesLine` (`generate.ts:42`), `overviewRegions` (`generate.ts:53`), `moduleRegions`
(`generate.ts:89`), `frontmatter` (`generate.ts:105`), `upsertNote` (`generate.ts:114`).

Dependencies out of the module: `atomicWriteFileSync` (`src/core/fs-atomic.ts:42`), `repoKey`
(`src/core/brain/git/identity.ts:25`), `buildRegionDocument` / `mergeRegions` (`src/core/brain/regions.ts:105`,
`:115`), `assertVaultIdentityForWrite` (`src/core/brain/vault-identity.ts:354`).

### Callers

**CLI only. There is no MCP tool.**

- CLI verb: `cmdBrainArchitect` (`src/cli/brain/verbs/architect.ts:12`), calling `generateArchDocs`
  at `src/cli/brain/verbs/architect.ts:23`.
- Dispatch: `case "architect"` in `src/cli/brain.ts:347-348`, re-exported at
  `src/cli/brain/verbs/index.ts:88`.
- Manifest + help: `src/cli/command-manifest.ts:292`, `src/cli/brain/help-text.ts:166` and `:1070-1073`.
- Docs: `docs/cli-reference.md:223`, `docs/how-it-works.md:1214`.
- Tests: `tests/core/brain/architect.test.ts:11-12`, `tests/cli/brain-architect.test.ts:31`,
  `tests/e2e/project-history.integration.test.ts:100`, `:122`, `:134`.

A repo-wide grep for `generateArchDocs|scanProject` outside the module returns exactly those sites; no
`src/mcp/**` file mentions `architect` or exposes an arch tool (checked by `grep -rln "architect" src/mcp/`
→ no matches).

### Argument shape

`cmdBrainArchitect` reads `positional[0]` only (`src/cli/brain/verbs/architect.ts:15`); extra positionals are
silently ignored. Flags are `--vault` and `--json` (`:14-17`). There is no `--repos`, no glob, no
concurrency flag, and no progress flag anywhere in the verb.

## 2. What is actually slow — measured

**Wall clock is the filesystem walk. Rendering and writing is 2% of a steady-state run on this repo.**

Command (run from any directory; timings are medians of 7):

```
bun -e '
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { scanProject } from "/srv/projects/open-second-brain/src/core/brain/architect/scan.ts";
import { generateArchDocs } from "/srv/projects/open-second-brain/src/core/brain/architect/generate.ts";
const repo = "/srv/projects/open-second-brain";
const med = (a) => a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)];
const time = (fn,n) => { const t=[]; for (let i=0;i<n;i++){const s=Bun.nanoseconds(); fn(); t.push((Bun.nanoseconds()-s)/1e6);} return med(t); };
const tScan = time(()=>scanProject(repo),7);
const tmp = mkdtempSync(join(tmpdir(),"o2b-arch-bench-")); const vault = join(tmp,"vault");
mkdirSync(join(vault,"Brain"),{recursive:true});
let s=Bun.nanoseconds(); const first=generateArchDocs(vault,repo); const tFirst=(Bun.nanoseconds()-s)/1e6;
const tSteady = time(()=>generateArchDocs(vault,repo),7);
console.log({tScan,tFirst,tSteady,notes:1+first.modulePaths.length}); rmSync(tmp,{recursive:true,force:true});'
```

Result on this repository (`totalFiles: 24094`, 4 modules → 5 notes):

| Phase | ms |
| --- | --- |
| `scanProject` alone | **388.0** |
| `generateArchDocs` cold (5 notes created) | 451.4 → render+write ≈ **63.4** |
| `generateArchDocs` steady (5 notes unchanged) | 395.9 → render+read ≈ **7.9** |

Syscall census of one `scanProject` on this repo
(`strace -f -c -e trace=getdents64,newfstatat,lstat,openat,statx,write,rename,fsync bun -e 'import {scanProject} from "…/scan.ts"; scanProject("/srv/projects/open-second-brain")'`):

```
statx      28356   (68.7% of syscall time)
getdents64  6648   (20.8%)
openat      3350   (10.6%)
write           1
```

That is one `lstat` per directory entry (`scan.ts:99`) and ~2 `getdents64` per directory
(`readdirSync`, `scan.ts:87` and `scan.ts:123`). Writes do not appear because a scan writes nothing.

**Why the walk is that large, and where the redundancy is.** `scanProject` walks the tree at least twice
over parts of it:

1. `statsFor(root)` (`scan.ts:217`) walks the *entire* tree to compute `totalFiles`/`languages`.
2. `detectModules` (`scan.ts:161-179`) walks `src/<dir>` (or `packages/<dir>`) again, once per module
   (`scan.ts:169`) — so the `src` subtree is walked twice in total.
3. On a **flat layout** the whole tree is walked a second time in full (`scan.ts:181`), because the root
   becomes the single module.
4. `package.json` is read and JSON-parsed twice: `readManifest` (`scan.ts:145`) and again in
   `detectEntryPoints` (`scan.ts:196`).

`SKIP_DIRS` (`scan.ts:18-32`) skips `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `vendor`,
`target`, `.venv`, `venv`, `__pycache__`, `.next`, `.cache` — and *nothing else*. No `.gitignore`, no
ignore-file support, no dot-directory rule. On this checkout that means the dominant cost is a directory
nobody wants in architecture notes: of the 24094 counted files, **21113 are under `.claude/`**
(`find .claude -type f | wc -l` → 21121; `scanProject("…/.claude").totalFiles` → 21113), 940 under `src/`,
1120 under `tests/`, 522 under `docs/`.

Per-subtree timings (same harness, medians of 5): `src` 940 files → 59.4 ms; `docs` 522 files → 45.1 ms;
`.claude` 21113 files → 1059.4 ms (flat layout, hence the double walk of point 3).

**The render half, isolated.** A synthetic project with 100 modules × 5 files (501 files) built in
`mkdtemp`, scanned and generated:

| Phase | ms |
| --- | --- |
| `scanProject` (501 files) | 15.9 |
| `generateArchDocs` cold, 101 notes written | 282.7 → render+write ≈ **266.9** (≈ 2.6 ms/note) |
| `generateArchDocs` steady, 101 notes unchanged | 20.5 → render+read ≈ **4.7** (≈ 0.05 ms/note) |

So the render half is fsync-bound on *first* generation only (`fsyncSync` of the temp file plus a parent
directory fsync per note — `src/core/fs-atomic.ts:291` and `:297-305`), and effectively free once the notes
exist, because an unchanged note short-circuits before any write (`generate.ts:125`).

**Conclusion, stated plainly.** Parallelising "rendering across notes" parallelises 8 ms out of 396 ms on
this repo (2%). The only case where note-level concurrency has anything to bite on is the *cold* generation
of a module-rich project (≈ 2.6 ms/note, fsync-dominated) — and `atomicWriteFileSync` is fully synchronous
(`src/core/fs-atomic.ts:42-54`, `:264-328`), so concurrency there requires either an async twin of the
shared writer or worker threads, both of which are census-relevant changes (section 4). The wall clock lives
in `walk` (`scan.ts:84-113`), which is a synchronous recursive `readdirSync`/`lstatSync` loop.

*What I did not establish:* whether the scan is CPU-bound or IO-wait-bound on cold page cache. All numbers
above are warm-cache. On a cold cache the ratio between walking and writing may shift, and I did not drop
caches (that needs root).

## 3. Determinism mechanics

Sentinels are paired HTML comments with explicit ids, not a single `@generated` marker:

```
<!-- o2b:begin <region-id> -->
…generated body…
<!-- o2b:end <region-id> -->
```

`src/core/brain/regions.ts:32-33` (the two regexes, tolerating a trailing `\r`), rendered at
`src/core/brain/regions.ts:101`. Everything outside a region is operator-owned and survives byte-for-byte
(`regions.ts:1-27`). Parsing is fail-closed: unbalanced / duplicate / nested / mismatched sentinels throw
`RegionError` *before* any write (`regions.ts:55-97`, re-validated first thing in `mergeRegions` at
`regions.ts:116`), and the CLI turns that into a repair message (`src/cli/brain/verbs/architect.ts:44-48`).

Region ids emitted today: `summary`, `modules`, `entry-points`, `dependencies` on the overview
(`generate.ts:81-86`); `facts`, `files` on each module note (`generate.ts:99-102`).

### Every place ordering can change bytes

Exhaustive list of the ordering-sensitive properties of the output, each anchored:

1. **Note set / note paths.** `overview.md` plus one `modules/<name>.md` per detected module
   (`generate.ts:148`, `:158-168`). Names come from distinct entries of one directory listing
   (`scan.ts:121-139`), so two notes can never target the same path in one run — *except* that the
   flat-layout branch always emits exactly one module named `root` (`scan.ts:182-190`).
2. **Module list inside the overview** — the `modules` region body is built by mapping `facts.modules`
   in array order (`generate.ts:63-69`). That order is `readdirSync(...).toSorted()` (`scan.ts:129`), i.e.
   fixed by the scan, not by write order. A concurrent renderer must not build this list from completion
   order.
3. **Language lists** (`generate.ts:42-51`), used by both the overview summary (`generate.ts:59`) and each
   module note (`generate.ts:93`). Sorted by count desc, ties broken by **`localeCompare`**
   (`generate.ts:44`) — see Divergence D5.
4. **Top-file lists** in module notes: `stats.paths.toSorted().slice(0, 20)` (`scan.ts:175`, `:188`, cap at
   `scan.ts:76`). Walk order is itself sorted (`scan.ts:91`), and the result is re-sorted, so the list is
   walk-order-independent.
5. **Entry points**: `Set` insertion order collapsed by `toSorted()` (`scan.ts:210`).
6. **Dependencies**: `Object.keys(...).toSorted()` (`scan.ts:148`).
7. **Region order within a note.** For a *new* file, `buildRegionDocument` emits regions in array order
   (`regions.ts:105-107`). For an existing file, region bodies are replaced in place and only ids *new to
   the update* are appended, in the update array's order (`regions.ts:144-147`). Both orders come from the
   fixed literal arrays at `generate.ts:81-86` and `:99-102`, not from scheduling.
8. **Cross-note references.** The overview links each module note by wikilink
   (`generate.ts:66`). This is computed from `facts` and `key`, *not* by reading the module notes, so there
   is no read-after-write dependency between notes in a run. Module notes contain no back-links.
9. **Frontmatter.** Written once at creation and never rewritten (`generate.ts:105-107`, `:120`, and the
   contract at `generate.ts:12-14`). Under concurrency the create/merge decision is per-note
   (`generate.ts:115-127`), so this stays per-file.
10. **Shared mutable state inside one run** — the three real hazards:
    - the `created` / `updated` / `unchanged` counters and the `tally` closure (`generate.ts:139-146`);
    - the `modulePaths` array, pushed in loop order (`generate.ts:157`, `:160`) and surfaced verbatim as
      `module_paths` in the CLI JSON (`src/cli/brain/verbs/architect.ts:30`) — completion-order pushes
      would make that array non-deterministic even though the note *bytes* stay stable;
    - `mkdirSync(join(dir, "modules"), {recursive:true})` runs once before the loop (`generate.ts:137`);
      a design that moves it per-note gains a concurrent-mkdir race that `recursive: true` tolerates but
      that no longer happens exactly once.
11. **Partial-failure surface.** A `RegionError` on note *k* leaves notes `0..k-1` already written
    (`generate.ts:149-168`); the process exits through `fail()` (`architect.ts:44`). Which prefix is on disk
    is currently a deterministic function of module order; under concurrency it becomes a function of
    scheduling.
12. **The unchanged short-circuit** (`generate.ts:125`) compares merged text against the bytes just read at
    `generate.ts:123`. Read and write are two separate syscalls with no lock between them (section 4), so
    the "unchanged" verdict is only as true as the absence of a concurrent writer to that path.

Byte-stability is pinned by tests: `tests/core/brain/architect.test.ts:117-124` ("unchanged project
regenerates byte-identically"), `:104-115` (operator prose outside regions survives), and the CLI-level
idempotency check at `tests/cli/brain-architect.test.ts:31-48`.

## 4. Write conflicts

- **Shared writer: yes.** Both writes go through `atomicWriteFileSync` (`generate.ts:120` for create,
  `generate.ts:126` for update), imported at `generate.ts:24`. That is temp-file + fsync + `rename(2)` +
  best-effort parent-dir fsync (`src/core/fs-atomic.ts:42-54`, `:264-328`). Temp names carry pid + ms +
  random suffix precisely so concurrent writers to the same target cannot collide on the temp inode
  (`src/core/fs-atomic.ts:276-280`).
- **Lock: no.** `generateArchDocs` acquires nothing. It does not import `sync-lockfile.ts`
  (`acquireLockSync` at `src/core/brain/sync-lockfile.ts:65`), which other Brain writers do use
  (`preference-txn.ts`, `idempotency-ledger.ts`, `lineage/ledger.ts`, `continuity/store.ts`, …). The
  read-modify-write in `upsertNote` (`generate.ts:123` read → `:126` write) is therefore a TOCTOU window:
  an operator edit landing between the two is silently overwritten, and two concurrent architect runs on the
  same repo are last-writer-wins. This is the *pre-existing* state; concurrency inside one run widens the
  window but does not create it.
- **Write-site census.** The census is `tests/core/architecture/write-site-census.test.ts`. Its population
  rule pulls in everything under `src/core/brain/` (`VAULT_WRITE_ROOTS`, `:77-82`). `CONTENT_WRITE_CALLS`
  (`:97-132`) deliberately excludes `mkdirSync` (`:93-96`), and `SHARED_WRITE_CALLS` (`:143-149`) names
  `atomicWriteFileSync`. `generate.ts` imports only `existsSync, mkdirSync, readFileSync` from `node:fs`
  (`generate.ts:21`), so it has **zero** direct-fs content writes: it is classified into the *shared-writer*
  class (`classify`, `:803-809`) and correctly carries **no entry** in `DIRECT_WRITE_EXCLUSIONS` (`:243-706`).
  `scan.ts` writes nothing and is out of the census entirely. **The rule architect is registered under is
  "routes through a shared writer" — i.e. it is in the clean half, not in the excused half.** Any change
  that reaches `node:fs` directly (a worker writing bytes, an async `writeFile`, a `Bun.write`) fails
  `:825-831` by name and would need a new written exclusion; note `writeFile`/`rename`/`rm` from
  `node:fs/promises` are already in the detected set (`:119-131`) and `Bun.write` is matched without any
  import (`:140`, `:796-798`).
- **Vault-identity guard.** `generateArchDocs` calls `assertVaultIdentityForWrite(vault)` as its first
  statement (`generate.ts:133`, guard at `src/core/brain/vault-identity.ts:354`). The guard census
  (`tests/core/brain/vault-guard-census.test.ts:57`) matches on the literal call, so a refactor that moves
  the assertion into a per-note worker must keep the identifier visible in the module.
- **Path construction.** The arch directory is assembled by raw `join` (`generate.ts:136`) — it is *not* in
  the `paths.ts` vocabulary and `ensureInsideVault` is never applied here (grep for `projects/` in
  `src/core/brain/paths.ts` → no match). The repo key that keys the directory is a pure function of the
  absolute path (`src/core/brain/git/identity.ts:25-29`), so two distinct repos can never share a directory,
  and the same repo scanned twice always lands in the same one.

## 5. Overlap with t_041c571f

**The claim that Open Second Brain has no architecture-notes generator is false.** `src/core/brain/architect/`
ships one, wired to `o2b brain architect` (`src/cli/brain.ts:347`), documented (`docs/cli-reference.md:223`),
and covered by unit, CLI, and e2e tests. Item by item:

| t_041c571f item | Status | Evidence |
| --- | --- | --- |
| Overview note | **Shipped** | `overview.md` with `kind: arch-overview`, summary / modules / entry-points / dependencies regions — `generate.ts:148-155`, `:53-87` |
| …with a Mermaid diagram | **Not shipped** | `grep -rln mermaid src/` → no matches anywhere in `src/` |
| …with inferred personas | **Not shipped** | No persona inference in either architect file; the only `personas` module is `src/core/brain/write-session/personas.ts:24`, an unrelated write-session review-lens list |
| One note per core module | **Shipped** | `generate.ts:158-168`, module detection at `scan.ts:161-191`; per-module regions at `generate.ts:89-103` |
| Key-decisions note | **Not shipped in architect**; an adjacent generator exists | Architect emits no decisions region. `mineCommitDecisions` (`src/core/brain/git/decisions.ts:111`) writes ADR *candidates* to `Brain/decisions/candidates/adr-<shortsha>-<slug>.md` (`decisions.ts:10-11`, `:115`) from conventional-commit signals (`decisions.ts:38`) — commit-derived, not architecture-derived, and in a different tree |
| Sentinel-marker refresh preserving hand edits | **Shipped** | `src/core/brain/regions.ts` in full; `upsertNote` (`generate.ts:114-128`); proven at `tests/core/brain/architect.test.ts:104-115` and end-to-end at `tests/e2e/project-history.integration.test.ts:108-127` |
| LLM-synthesised prose | **Not shipped, and deliberately excluded** | "no network, no LLM, no per-language parsing … the same tree always produces the same facts (the generator's idempotency rests on this)" — `scan.ts:1-13`; the docblock also puts import-graph analysis explicitly out of scope (`scan.ts:7-8`) |

Facts only; the scope call belongs to whoever owns t_041c571f. Worth flagging for that decision: the three
missing items (Mermaid, personas, LLM prose) are the three that would introduce non-determinism or a network
call into a module whose byte-identical-regeneration test (`tests/core/brain/architect.test.ts:117`) currently
depends on their absence.

## 6. Progress subject — is the unit count known up front?

- **Notes: known only *after* the expensive part.** `notes = 1 + facts.modules.length`, and `facts` comes
  from `scanProject` at `generate.ts:135` — i.e. after the whole tree has already been walked. Everything
  after that point (`generate.ts:137-168`) is the cheap 2%.
- **During the scan: not known at all.** `walk` (`scan.ts:84-113`) is a depth-first recursive discovery with
  no pre-pass and no counter; `statsFor` returns totals only when finished (`scan.ts:115-119`). There is no
  file-count total available before the walk ends, so a percentage-complete over the scan is impossible
  without adding a pre-pass (which doubles the very syscalls that dominate). A *monotone* counter —
  directories entered, files seen, current relative path — is available with no extra I/O, since both values
  are already accumulated in `WalkStats` (`scan.ts:78-82`, `:108-109`).
- **Repos: there is no multi-repo unit.** `generateArchDocs` takes one `projectRoot` (`generate.ts:131`) and
  the CLI reads one positional (`src/cli/brain/verbs/architect.ts:15`). No registry of arch repos exists; the
  only repo enumerator in the codebase is `listGitRepos` (`src/core/brain/git/store.ts:338-353`), which lists
  `Brain/projects/git/*` — the *git-history* store, not `Brain/projects/arch/`, and it is consumed only by
  `src/cli/brain/verbs/git.ts:50`, `:146`, `:218`.
- **No progress facility exists to reuse.** `grep -rn "onProgress\|progress(" --include=*.ts src/` returns
  nothing outside tests. Concurrency precedents that *do* exist: the embedding batch pipeline
  (`src/core/search/embeddings/http-util.ts:5`, `:13`, `:54-74`, with retry/backoff/jitter) and the
  `embedding_concurrency` semaphore reasoning at `src/core/search/indexer.ts:870-877`; the serialisation
  precedent is `src/core/search/store/writer-lock.ts:1-40`.

## Divergences

Where t_4b479851's framing does not survive contact with the source.

- **D1 — "concurrent rendering across notes" targets 2% of the runtime.** Measured: steady-state render+write
  is 7.9 ms of a 395.9 ms run on this repo, and 4.7 ms for 101 notes on the synthetic project (section 2).
  The wall clock is in `walk` (`scan.ts:84-113`). The one case with real cost is *cold* generation
  (≈ 2.6 ms/note, fsync-bound at `src/core/fs-atomic.ts:291`, `:297-305`), which happens once per project.
- **D2 — "multi-repo scans" do not exist in this module.** One call, one root (`generate.ts:131`;
  `src/cli/brain/verbs/architect.ts:15`). Any multi-repo pass — and therefore any repo-level progress —
  has to be *built*, not instrumented. Extra positionals are currently ignored without a word.
- **D3 — the task's own premise ("retry has little to bite on") is confirmed, but for a sharper reason than
  stated.** There is no network and no LLM anywhere in the module (`scan.ts:1-13`), and every I/O failure in
  the scan is already swallowed on purpose: `readdirSync` failures return/skip (`scan.ts:87-90`,
  `:122-126`), `lstatSync` failures `continue` (`scan.ts:99-102`, `:132-137`), a malformed `package.json`
  yields `null` (`scan.ts:156-158`). The one *unswallowed* failure class is on the write side —
  `RegionError` (fail-closed by design, `regions.ts:35-43`) and raw errno from `atomicWriteFileSync`
  (ENOSPC, EROFS, EACCES). Neither is retry-shaped: the first is a repair request, the second is
  correctly propagated (`src/core/fs-atomic.ts:240-247` propagates every non-EEXIST errno untouched).
- **D4 — the real performance lever is not concurrency at all.** It is (a) not re-walking the same subtree
  (`scan.ts:217` + `scan.ts:169`; full double-walk on flat layouts, `scan.ts:181`) and (b) the skip list
  (`scan.ts:18-32`), which honours no `.gitignore` and no dot-directory rule: 21113 of the 24094 files this
  repo's scan visits are under `.claude/`. Fixing either shrinks the dominant term by more than any
  parallelism applied to the current shape.
- **D5 — "output stays deterministic" is not unconditionally true today, independent of concurrency.**
  `languagesLine` breaks count ties with `a[0].localeCompare(b[0])` (`generate.ts:44`), which is
  ICU/locale-dependent; every other ordering in the module uses plain `toSorted()` (`scan.ts:91`, `:129`,
  `:148`, `:175`, `:210`). Two machines with different collation can therefore render different bytes for
  the same tree. Worth fixing in the same wave, since the concurrency work will lean on the byte-identity
  test at `tests/core/brain/architect.test.ts:117`.
- **D6 — "sentinel-region-stable regardless of concurrency" is currently unenforced *across processes*.**
  No lock (section 4), and `upsertNote`'s read-then-write (`generate.ts:123` → `:126`) has an open TOCTOU
  window against both a concurrent architect run and a live operator edit.
- **D7 — one ordering artefact *does* leak into an output today, just not into note bytes.**
  `module_paths` in the CLI JSON (`src/cli/brain/verbs/architect.ts:30`) is `modulePaths` in loop-push order
  (`generate.ts:157`, `:160`). Concurrent rendering scrambles it unless it is re-derived from `facts.modules`.

## What a design must not assume

- **Do not assume note-level concurrency buys anything measurable on a normal re-run.** It does not
  (D1). If concurrency is worth having, the subject is the *walk*, and the walk is synchronous
  `readdirSync`/`lstatSync` (`scan.ts:87`, `:99`) — parallelising it means either `node:fs/promises` or
  workers, both of which change the module's classification in the write-site census
  (`tests/core/architecture/write-site-census.test.ts:119-131`, `:140`) if any write moves with them.
- **Do not assume `atomicWriteFileSync` can be called concurrently "for free".** It is fully synchronous
  (`src/core/fs-atomic.ts:42-54`), so within one JS thread it serialises regardless of how the callers are
  scheduled; overlapping it needs an async twin (a new shared writer, hence a census decision) or worker
  threads (which cannot share the counters at `generate.ts:139-146`).
- **Do not assume the number of units is known before the pass starts.** Note count is known only after the
  scan (`generate.ts:135`); file count is never known before the walk finishes (`scan.ts:84-113`). A
  percentage-complete requires a pre-pass that doubles the dominant syscall cost. A monotone
  "files seen / current path" counter is free.
- **Do not assume there is a repo list to iterate.** There is none for arch (section 6);
  `listGitRepos` (`src/core/brain/git/store.ts:338`) enumerates `Brain/projects/git/`, a different store.
- **Do not assume ordering only affects note bytes.** It also affects `module_paths` in the JSON envelope
  (D7), the created/updated/unchanged tally (`generate.ts:139-146`), and *which prefix of notes exists* when
  a `RegionError` aborts mid-run (`generate.ts:149-168`).
- **Do not assume a progress channel can print freely.** `--json` emits a single JSON object via `okJson`
  (`src/cli/brain/verbs/architect.ts:25-34`); any progress line on stdout in that mode breaks the envelope.
- **Do not assume the identity guard can move.** `assertVaultIdentityForWrite` must stay textually present
  in the writing module — the guard census matches the identifier
  (`tests/core/brain/vault-guard-census.test.ts:57`) — and it must stay *before* the first byte
  (`src/core/brain/vault-identity.ts:344-352`).
- **Do not assume retry belongs anywhere here** without first naming the concrete errno it would retry.
  Scan-side I/O failures are already absorbed by design (D3); write-side failures are either fail-closed
  corruption reports or errnos that must propagate.
