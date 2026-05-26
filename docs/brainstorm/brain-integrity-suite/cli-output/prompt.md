You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

The Open Second Brain ("OSB") codebase needs a **Brain Integrity Suite** that bundles five Brain-side improvements into one PR. All five live inside the same write path (`src/core/brain/preference.ts`, `src/core/brain/dream.ts`, `src/core/brain/policy.ts`, `src/mcp/brain-tools.ts`) and share three primitives that the brainstorm must shape:

1. A revision/hash field on preference frontmatter.
2. A pre-write check that compares expected-vs-actual revision/length/status.
3. A read-only "what would dream do" projection over the existing dream pipeline.

The five user-visible features:

## Feature 1: Content-hash drift detection on confirmed preferences

On promotion to `_status: confirmed`, write `_content_hash: sha256(principle + scope)` into frontmatter. On every read of a confirmed preference (`brain_query`, `brain_search`, `dream` rescan), recompute the hash and compare. Mismatch fires a `drift_detected` event into `Brain/log/<today>.md` (plus JSONL sidecar) and surfaces in `brain_doctor` as a warning. Hand-edits remain legal - the goal is **observability**, not enforcement.

## Feature 2: Structured write-collision detection on preference writes

`writePreference` currently goes through `writeFrontmatterAtomic` (no version check). Four collision modes need typed errors instead of silent last-writer-wins:
- `StaleUpdate` - writer holds an outdated read (compare `_revision` counter or `_last_evidence_at`).
- `UnsafeShrink` - new principle is < N% of existing principle's length (configurable).
- `SourceLock` - signal-lock conflict (a preference is currently being mutated by another in-flight call).
- `DuplicateWrite` - same payload arrives twice from different agents within a short window.

Build on the existing `proper-lockfile`-based `transitionRequest` pattern from `src/core/pay-memory/approval.ts:361` (lock acquire -> re-load inside lock -> verify expected state -> mutate -> writeFrontmatterAtomic -> release).

## Feature 3: Destructive-proof gate on confirmed preferences

Two sub-gates wrapping the dream pass's promotion/retirement logic:
- **Shrink-gate**: if `dream` is about to overwrite a `_status: confirmed` preference's `principle` with text < N% of the existing length, the write is held back and emits a `requires_explicit_replace` quarantine entry instead.
- **Retire-from-confirmed gate**: retiring a `_status: confirmed` preference requires either an explicit operator action (already exists via CLI verb), or an evidence count higher than the default retirement threshold (e.g. 3x). Single-signal retirement of a multi-evidence confirmed pref is rejected.

Both gates emit `brain_note` events when they fire (observable, not blocking-silent).

## Feature 4: Durable workrun checkpoints for dream pass

Today `dream(vault, opts)` runs synchronously, returns `DreamRunSummary`. If the process crashes mid-pass, there is no on-disk trace of progress. Add a JSONL workrun file per dream invocation:
- Path: `Brain/log/dream-runs/<YYYY-MM-DD>-<run-id>.jsonl`
- One line per phase transition. Phases: `started`, `cluster_complete`, `promote_complete`, `retire_complete`, `finalized | interrupted`.
- On dream startup, scan `dream-runs/` for incomplete files. If found, emit `recovered: <run_id>` event into the regular log and either resume (when safe) or skip (and add a `dangling_workrun` check to `brain_doctor`).

## Feature 5: `brain_review_candidates` - read-only dream-pass projection

A new MCP tool that surfaces what the next `brain_dream` invocation *would* do, without applying anything. Backed by the existing `dream(vault, { dryRun: true })` path (which already exists but is not exposed as a separate tool). Output shape:
```
{ would_promote: [...], would_retire: [...], would_supersede: [...], clusters_below_threshold: [...] }
```
Pure projection over current inbox + active preferences + retired/. No persistent state added.

## Cross-cutting constraints

- **No Python**. TypeScript with Bun runtime.
- **No new external dependencies** (proper-lockfile is already vendored). sqlite-vec is an optional dep; do not add anything else.
- **Backward compatibility** is NOT required - the codebase explicitly cleared every pre-1.0 shim in v0.11.0 (no public users yet). New frontmatter fields are additive but readers may treat absent-as-default.
- **Atomicity**: every write keeps going through `writeFrontmatterAtomic` from `src/core/vault.ts:151`. New collision detection wraps that, doesn't replace it.
- **All five features must commit on the same feature branch and ship in one PR** (multi-task epic pattern from the feature-release-playbook).
- **No hardcoded human-language strings** for user-facing text. Error names and event codes stay machine-friendly (`StaleUpdate`, `drift_detected`, etc.).
- **TDD-first**: every code change must have a failing-first test in `tests/core/brain/`.

# Project context

**Project:** Open Second Brain - second brain for AI agents using Obsidian-compatible Markdown vaults. TypeScript + Bun. v0.11.0.

**Top files in scope (verified via codegraph):**

| Symbol | Location | Shape |
|---|---|---|
| `dream` | `src/core/brain/dream.ts:191` | `(vault: string, opts: DreamOptions = {}): DreamRunSummary` (sync). Already has `dryRun?: boolean` field. |
| `DreamOptions` | `src/core/brain/dream.ts:134` | Interface; has `dryRun`, `agentName`, etc. |
| `DreamRunSummary` | `src/core/brain/dream.ts:96` | Final summary; has `confirmed`, `retired`, `new_unconfirmed` arrays. |
| `scanBrain` | `src/core/brain/dream.ts:574` | One-pass scan of all topics; no checkpoint emission today. |
| `writePreference` | `src/core/brain/preference.ts:200` | `(vault, input, options): WritePreferenceResult`, sync. Validates fields and calls `writeFrontmatterAtomic`. |
| `preferenceFrontmatter` | `src/core/brain/preference.ts:293` | Builds the FrontmatterMap. Uses `_`-prefix convention for derived fields. |
| `writeFrontmatterAtomic` | `src/core/vault.ts:151` | Atomic file write via temp+rename. The bottom primitive. |
| `transitionRequest` | `src/core/pay-memory/approval.ts:361` | Reference lockfile pattern - `lockfile.lock(target, {retries: {retries:30, factor:1.2, minTimeout:30, maxTimeout:500}, stale:10_000})`, re-load inside lock, mutate, release. |
| `toolBrain*` | `src/mcp/brain-tools.ts` | MCP tool handlers: `(ctx, args) => Promise<Record<string,unknown>>`. Patterns: `toolBrainDream:231`, `toolBrainQuery:479`, `toolBrainNote:340`, `toolBrainDoctor:570`. |
| `brain_note` writer | called via `noteAppend` into `Brain/log/<today>.md` + JSONL sidecar | Existing event-recording surface. |

**Preference frontmatter convention (verified):** Identity fields stay unprefixed (`kind`, `id`, `created_at`, `unconfirmed_until`, `topic`, `principle`, `scope`, `tags`, `aliases`, `supersedes`, `pinned`). Derived/dream-owned fields use `_` prefix (`_status`, `_confirmed_at`, `_evidenced_by`, `_applied_count`, `_violated_count`, `_last_evidence_at`, `_confidence`, `_confidence_value`, `_lifecycle`). New fields from this suite (`_content_hash`, `_revision`) follow the `_` convention.

**Test layout:** `tests/core/brain/<feature>.test.ts` - one file per feature; `bun test` is the harness.

**Conventions from CHANGELOG (v0.10.x - v0.11.0):**
- Pure functions where possible; the dream pipeline is heavy on `scan -> compute -> apply` separation.
- Numeric thresholds configurable via `Brain/_brain.yaml` and surfaced through `loadBrainConfig`.
- Every observable event goes through the log writer (Markdown + JSONL sidecar).
- `brain_doctor` is the operator's invariant check; new checks plug in there.

**Constraints from playbook:**
- One PR per CHANGELOG version (v0.12.0).
- Conventional commits, atomic per feature.
- Mermaid diagrams in PR description must render server-side.

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
