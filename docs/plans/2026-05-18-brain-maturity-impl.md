# v0.10.5 Brain maturity — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` (or
> `superpowers:subagent-driven-development` for fresh-context-per-task
> dispatch) to walk this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Ship §14 (local explorer), §12 (merge-suggestions plus
`o2b brain merge`), §15-tail (good-vs-bad SKILL section), and §4-tail
(per-runtime cadence for `hooks/lib/messages.ts`) from
`Projects/OpenSecondBrain/Features/_summary` in one PR.

**Architecture:** Four independent slices land in dependency order.
§12 lands first because lifting `tokenise`/`jaccard` out of
`doctor.ts` into `src/core/brain/similarity.ts` is a refactor that
should settle before any new consumer (the new
`merge-candidates.ts`) is wired up. §14 lands second — large slice,
isolated module, no cross-coupling with §12 beyond the digest staying
green. §4-tail lands third because the hook surface is small and
back-compat by construction. §15-tail lands last — text-only, no
test surface.

- **§12** lifts `tokenise`/`jaccard` into `src/core/brain/similarity.ts`,
  adds `src/core/brain/merge-candidates.ts` (read-only detector),
  `src/core/brain/merge.ts` (mutating writer), one CLI verb `merge`,
  a new `BRAIN_RETIRED_REASON.mergedInto` constant, a new
  `BRAIN_LOG_EVENT_KIND.merge` constant, and a new digest section.
- **§14** ships entirely under `src/core/brain/explorer.ts` plus
  `templates/brain-explorer.html` plus one CLI verb `explorer`. No
  cross-module dependency outside the existing `buildBacklinkIndex`
  and `parsePreference` / `parseRetired` readers.
- **§4-tail** is two-file change: `hooks/lib/detect.ts` gains
  `detectHookRuntime`, `hooks/lib/messages.ts` gains a `runtime`
  parameter and a `cadenceLine` helper, the two hook entry points
  thread the value.
- **§15-tail** is one inline edit in `skills/brain-memory/SKILL.md`.

**Tech Stack:** TypeScript on Bun. No new external dependencies.
Re-uses `fs-atomic.ts`, `proper-lockfile` (already in deps),
`bun:test`, `tsc --noEmit`, `Bun.serve` for the live explorer.

**Source of truth for behaviour:**
[`docs/plans/2026-05-18-brain-maturity-design.md`](./2026-05-18-brain-maturity-design.md).
Every task below implements a slice of that spec — on conflict the
spec wins and this plan is amended.

---

## Plan-wide conventions

These apply to every task; do not re-state per step.

- **Imports.** Production code uses `node:`-prefixed builtins
  (`node:fs`, `node:os`, `node:path`). Tests use
  `import { test, expect, describe, beforeEach, afterEach } from "bun:test"`.
  Always `.ts` extensions in cross-module imports.
- **Result shape.** New public-API return values are `Object.freeze`-d
  at the producing call site (project convention).
- **Errors.** Reuse existing typed errors when the failure mode
  matches. Create one new typed error `BrainMergeError` for §12
  because its failure shape (mismatched topic/scope, pin parity,
  same-id) is distinct enough to warrant a separate catch handler in
  the CLI verb.
- **No git from this plan.** Each task ends with **Pause for review
  (no commit).** Active git is reserved for the user — see vault
  memory `project_o2b_no_active_git`.
- **No misleading fallbacks.** New CLI flags exit 2 with an explicit
  message rather than silently fall through. The explorer detects
  unknown runtime in the hook by returning the literal `"unknown"`
  — that branch then renders no cadence line, which is
  byte-identical to the pre-change reminder.
- **Atomic writes** via `src/core/fs-atomic.ts:atomicWriteFileSync`.
  Single-file export (§14 `--export`) writes through the atomic
  helper.
- **Style preferences (Brain active):**
  - `pref-no-exclamation-marks-in-docs` — no exclamation marks in
    prose strings (rendered text, error messages, comments).
  - `pref-no-simply-word` — the word "simply" is forbidden in any
    written artifact (docs, comments, log strings, tests).
- **Verification.** Every task ends with a targeted `bun test
  tests/path/to/file.test.ts` and an expected pass count. End of
  every Phase: full `bun test` + `bun run typecheck` green.
- **CHANGELOG.** Touched exactly once, in Phase 5. Do not bump
  mid-PR — per vault memory `feedback_one_pr_one_version`.
- **`_summary.md` (vault).** Touched exactly once, in Phase 5, in
  the same step that bumps the CHANGELOG. Two deferred entries are
  retired (§4 per-runtime hook text, §15 good-vs-bad SKILL section)
  and three new entries are added (D14.1, D14.2, D14.3, D12.1,
  D12.2). The vault is at `/root/vault/` — this is a VAULT edit, not
  a repo edit, and lives outside the git tree.

---

## File map

New files (count: 12):

```
docs/plans/2026-05-18-brain-maturity-impl.md             # this file
src/core/brain/similarity.ts                             # §12 lift
src/core/brain/merge-candidates.ts                       # §12 detector
src/core/brain/merge.ts                                  # §12 writer
src/core/brain/explorer.ts                               # §14 module
templates/brain-explorer.html                            # §14 template
tests/core/brain/similarity.test.ts                      # §12
tests/core/brain/merge-candidates.test.ts                # §12
tests/core/brain/merge.test.ts                           # §12
tests/cli/brain-merge.test.ts                            # §12
tests/core/brain/explorer.test.ts                        # §14
tests/cli/brain-explorer.test.ts                         # §14
```

Modified files (count: 15):

```
src/core/brain/doctor.ts                                 # §12 import from similarity.ts
src/core/brain/digest.ts                                 # §12 merge_suggestions section
src/core/brain/types.ts                                  # §12 new reason + event kind
src/cli/brain.ts                                         # §12 + §14 wiring
hooks/lib/detect.ts                                      # §4-tail runtime detector
hooks/lib/messages.ts                                    # §4-tail cadence
hooks/post-write-reminder.ts                             # §4-tail call site
hooks/stop-log-guardrail.ts                              # §4-tail call site
skills/brain-memory/SKILL.md                             # §15-tail section
tests/hooks/detect.test.ts                               # §4-tail
tests/hooks/post-write-reminder.test.ts                  # §4-tail
tests/hooks/stop-log-guardrail.test.ts                   # §4-tail
tests/core/brain/digest.test.ts                          # §12 digest section
CHANGELOG.md                                             # Phase 5 only
package.json                                             # Phase 5 only (version bump)
```

Version-mirror files (touched once in Phase 5 via `bun run sync-version`):

```
.claude-plugin/plugin.json
.codex-plugin/plugin.json
plugins/codex/.codex-plugin/plugin.json
plugins/hermes/plugin.yaml
plugin.yaml
openclaw.plugin.json
__init__.py
```

`bun run sync-version` rewrites these from `package.json`; do not
hand-edit.

---

## Phase 1 — §12 Merge

Smallest blast radius first: lift the shared helpers, then write the
read-only detector, then the mutating writer, then the digest section,
then the CLI verb.

### Task 1.1: Lift `tokenise` and `jaccard` into `src/core/brain/similarity.ts`

**Objective:** Create the shared similarity module with the current
helpers, byte-identical behaviour. `doctor.ts` becomes the first
consumer.

**Files:**
- Create: `src/core/brain/similarity.ts`
- Modify: `src/core/brain/doctor.ts` (remove the two local functions, add import)
- Create: `tests/core/brain/similarity.test.ts`

**Step 1: Write failing test**

```ts
// tests/core/brain/similarity.test.ts
import { describe, expect, test } from "bun:test";
import { jaccard, tokenise } from "../../../src/core/brain/similarity.ts";

describe("tokenise", () => {
  test("lowercases and splits on punctuation", () => {
    const tokens = tokenise("Use imperative voice; describe what the commit DOES");
    expect(tokens.has("use")).toBe(true);
    expect(tokens.has("imperative")).toBe(true);
    expect(tokens.has("does")).toBe(true);
    expect(tokens.has(";")).toBe(false);
  });

  test("keeps multi-byte tokens", () => {
    const tokens = tokenise("Используй императив");
    expect(tokens.has("используй")).toBe(true);
    expect(tokens.has("императив")).toBe(true);
  });

  test("filters tokens of length 1", () => {
    const tokens = tokenise("a b cd");
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("cd")).toBe(true);
  });
});

describe("jaccard", () => {
  test("identical sets → 1", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  test("disjoint sets → 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  test("both empty → 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  test("partial overlap → intersection / union", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4, 5);
  });
});
```

**Step 2: Run test to verify failure**

```
bun test tests/core/brain/similarity.test.ts
```
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

Lift the two functions byte-for-byte from `src/core/brain/doctor.ts`
into the new module. Re-export.

```ts
// src/core/brain/similarity.ts
/**
 * Shared similarity helpers — `tokenise` + `jaccard`. Lifted out of
 * `doctor.ts` so both `duplicate-preferences` lint and the
 * `merge-candidates` detector use one implementation (DRY).
 *
 * No language-specific stopword list: Brain principles are routinely
 * multilingual and an English-only list would either under-filter or
 * skew similarity on non-English text.
 */

const TOKEN_STOPWORDS: ReadonlySet<string> = new Set();

export function tokenise(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((t) => t.length > 1 && !TOKEN_STOPWORDS.has(t)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}
```

**Step 4: Update `doctor.ts` to import from the new module**

- Remove the local `TOKEN_STOPWORDS`, `tokenise`, `jaccard`.
- Add `import { jaccard, tokenise } from "./similarity.ts";` near the
  top of `doctor.ts`.

**Step 5: Run tests to verify pass and no doctor regression**

```
bun test tests/core/brain/similarity.test.ts
bun test tests/core/brain/doctor.test.ts
```
Expected: both green; existing doctor tests unchanged.

**Step 6: Pause for review (no commit).**

---

### Task 1.2: Add `BRAIN_RETIRED_REASON.mergedInto` and `BRAIN_LOG_EVENT_KIND.merge`

**Objective:** New constants in `types.ts`, no other changes.

**Files:**
- Modify: `src/core/brain/types.ts`

**Step 1: Add to `BRAIN_RETIRED_REASON`**

In the existing const block (after `supersededByContext`):

```ts
  // Preference retired through `o2b brain merge` — counters and
  // evidence were folded into the retained pref pointed at by
  // `superseded_by`. Distinct from `rebutted` (signals) and
  // `superseded-by-context` (outdated evidence) because no
  // contradiction is implied — the rules said the same thing.
  mergedInto: "merged-into",
```

**Step 2: Add to `BRAIN_LOG_EVENT_KIND`**

In the existing const block (after `migrateFrontmatter`):

```ts
  /**
   * `merge` — operator ran `o2b brain merge <keep> <drop>`. Payload
   * carries both wikilinks, the union-size of `evidenced_by`, and
   * the summed counters as raw integers for audit grepping.
   */
  merge: "merge",
```

**Step 3: Typecheck**

```
bun run typecheck
```
Expected: PASS.

**Step 4: Pause for review (no commit).**

---

### Task 1.3: Implement `findMergeCandidates`

**Objective:** Read-only detector returning the pairs that the digest
will render.

**Files:**
- Create: `src/core/brain/merge-candidates.ts`
- Create: `tests/core/brain/merge-candidates.test.ts`

**Step 1: Write failing test**

```ts
// tests/core/brain/merge-candidates.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMergeCandidates } from "../../../src/core/brain/merge-candidates.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-merge-cand-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function writePref(slug: string, body: Record<string, string | number | boolean>): void {
  const fm = Object.entries(body)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    `---\n${fm}\n---\n\nPrinciple body.\n`,
  );
}

describe("findMergeCandidates", () => {
  test("pair in [0.6, 0.85) surfaces", () => {
    writePref("imperative-commits", {
      id: "pref-imperative-commits",
      topic: "commits",
      principle: "Use imperative voice in commit subjects",
      status: "confirmed",
      confidence: "high",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
    });
    writePref("imperative-subjects", {
      id: "pref-imperative-subjects",
      topic: "commits",
      principle: "Write commit subjects in imperative voice and keep them short",
      status: "confirmed",
      confidence: "high",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 2,
      violated_count: 0,
    });
    const out = findMergeCandidates(vault);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].topic).toBe("commits");
    expect(out[0].jaccard).toBeGreaterThanOrEqual(0.6);
  });

  test("pairs across different topic or scope do not surface", () => {
    writePref("a", {
      id: "pref-a", topic: "x", principle: "Same words here",
      status: "confirmed", confidence: "high",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 1, violated_count: 0,
    });
    writePref("b", {
      id: "pref-b", topic: "y", principle: "Same words here",
      status: "confirmed", confidence: "high",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 1, violated_count: 0,
    });
    expect(findMergeCandidates(vault).length).toBe(0);
  });

  test("stable ordering by (jaccard desc, a asc, b asc)", () => {
    // Three prefs forming three pairs with descending jaccard.
    // Verify deterministic order.
    writePref("a", { id: "pref-a", topic: "t", principle: "alpha beta gamma delta",
      status: "confirmed", confidence: "high",
      created_at: "2026-05-01T00:00:00Z", unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 1, violated_count: 0 });
    writePref("b", { id: "pref-b", topic: "t", principle: "alpha beta gamma epsilon",
      status: "confirmed", confidence: "high",
      created_at: "2026-05-01T00:00:00Z", unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 1, violated_count: 0 });
    writePref("c", { id: "pref-c", topic: "t", principle: "alpha beta zeta eta",
      status: "confirmed", confidence: "high",
      created_at: "2026-05-01T00:00:00Z", unconfirmed_until: "2026-05-08T00:00:00Z",
      applied_count: 1, violated_count: 0 });
    const out = findMergeCandidates(vault);
    // First pair should be (a, b) with highest jaccard.
    expect(out[0].a < out[0].b).toBe(true);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].jaccard).toBeLessThanOrEqual(out[i - 1].jaccard);
    }
  });
});
```

**Step 2: Run test to verify failure**

```
bun test tests/core/brain/merge-candidates.test.ts
```
Expected: FAIL — module not found.

**Step 3: Implement**

```ts
// src/core/brain/merge-candidates.ts
/**
 * `findMergeCandidates` — pure-read detector for the `## Merge
 * suggestions` digest section and the upcoming `o2b brain merge`
 * CLI. Pairs of confirmed/quarantine preferences in the same
 * `(topic, scope)` bucket whose `principle` tokens share jaccard
 * similarity at or above `JACCARD_MERGE_SUGGEST_THRESHOLD`.
 *
 * Pairs at or above `JACCARD_DUPLICATE_THRESHOLD` are also flagged
 * by `doctor` as `duplicate-preferences`; the digest surface is the
 * lighter signal, the doctor surface is the heavier one.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { jaccard, tokenise } from "./similarity.ts";
import { BRAIN_PREFERENCE_STATUS } from "./types.ts";

export const JACCARD_MERGE_SUGGEST_THRESHOLD = 0.6;
export const MERGE_SUGGESTION_LIMIT = 10;

export interface MergeCandidate {
  readonly a: string;
  readonly b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly jaccard: number;
}

export function findMergeCandidates(
  vault: string,
  opts: { threshold?: number; limit?: number } = {},
): ReadonlyArray<MergeCandidate> {
  const threshold = opts.threshold ?? JACCARD_MERGE_SUGGEST_THRESHOLD;
  const limit = opts.limit ?? MERGE_SUGGESTION_LIMIT;
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return Object.freeze([]);

  interface Entry {
    readonly id: string;
    readonly topic: string;
    readonly scope: string | null;
    readonly principle: string;
    readonly tokens: ReadonlySet<string>;
  }
  const entries: Entry[] = [];
  for (const f of readdirSync(dirs.preferences, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".md") || !f.name.startsWith("pref-")) continue;
    try {
      const p = parsePreference(join(dirs.preferences, f.name));
      if (
        p.status !== BRAIN_PREFERENCE_STATUS.confirmed
        && p.status !== BRAIN_PREFERENCE_STATUS.quarantine
      ) continue;
      entries.push({
        id: p.id,
        topic: p.topic,
        scope: p.scope ?? null,
        principle: p.principle,
        tokens: tokenise(p.principle),
      });
    } catch {
      // Doctor reports corruption; the detector skips silently.
    }
  }

  const buckets = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.topic}\x00${e.scope ?? ""}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(e);
    buckets.set(key, bucket);
  }

  const candidates: MergeCandidate[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const sim = jaccard(a.tokens, b.tokens);
        if (sim < threshold) continue;
        candidates.push({
          a: a.id,
          b: b.id,
          topic: a.topic,
          scope: a.scope,
          principle_a: a.principle,
          principle_b: b.principle,
          jaccard: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  candidates.sort((x, y) => {
    const diff = y.jaccard - x.jaccard;
    if (diff !== 0) return diff;
    const da = x.a.localeCompare(y.a);
    if (da !== 0) return da;
    return x.b.localeCompare(y.b);
  });

  return Object.freeze(candidates.slice(0, limit));
}
```

**Step 4: Run tests to verify pass**

```
bun test tests/core/brain/merge-candidates.test.ts
```
Expected: 3 passed.

**Step 5: Pause for review (no commit).**

---

### Task 1.4: Wire merge-candidates into `brain_digest`

**Objective:** Render the `## Merge suggestions` Markdown section and
the `merge_suggestions` JSON array. Existing fixtures without any
candidates → section absent, JSON empty array.

**Files:**
- Modify: `src/core/brain/digest.ts`
- Modify: `tests/core/brain/digest.test.ts`

**Step 1: Add JSON type and update `DigestJson`**

In `src/core/brain/digest.ts`, after `DigestJsonTopReferenced`:

```ts
export interface DigestJsonMergeSuggestion {
  readonly a: string;
  readonly b: string;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly jaccard: number;
}
```

Add `readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;`
to `DigestJson`.

**Step 2: Add to `DigestData` and `collectDigestData`**

```ts
interface DigestData {
  // ... existing fields ...
  readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;
}
```

In `collectDigestData`, before the `return`:

```ts
const merge_suggestions = findMergeCandidates(vault).map((c) => ({
  a: c.a,
  b: c.b,
  principle_a: c.principle_a,
  principle_b: c.principle_b,
  topic: c.topic,
  scope: c.scope,
  jaccard: c.jaccard,
}));
```

Add `merge_suggestions` to the returned object.

**Import:** add at top of file:

```ts
import { findMergeCandidates } from "./merge-candidates.ts";
```

**Step 3: Render in JSON and Markdown**

JSON path: add `merge_suggestions: data.merge_suggestions` to the
`payload` object inside the `format === "json"` branch.

Markdown path: in `renderMarkdown`, after the `top_referenced` block
and before the `confidence_shifts` block:

```ts
if (data.merge_suggestions.length > 0) {
  lines.push(`## Merge suggestions (${data.merge_suggestions.length})`, "");
  for (const item of data.merge_suggestions) {
    const scope = item.scope ?? "—";
    lines.push(
      `- ${renderPrefLink({ id: item.a, principle: item.principle_a })}`
      + ` ≈ ${renderPrefLink({ id: item.b, principle: item.principle_b })}`
      + ` — topic '${item.topic}', scope ${scope}, jaccard ${item.jaccard.toFixed(2)}`,
    );
  }
  lines.push("");
}
```

**Step 4: `isEmpty` predicate**

Do **NOT** add `merge_suggestions` to `isEmpty`. The predicate gates
the silent-if-no-changes behaviour; suggestions reflect current
state, not windowed change. Existing tests assert empty-window
collapses to one line — keep that contract.

**Step 5: Add digest tests**

Append two test cases in `tests/core/brain/digest.test.ts`:

- One fixture with two near-duplicate confirmed prefs → assert
  Markdown contains `## Merge suggestions` and JSON
  `merge_suggestions.length >= 1`.
- One fixture with zero candidates (existing fixtures) → assert
  Markdown does NOT contain `## Merge suggestions` and JSON
  `merge_suggestions === []`.

**Step 6: Run tests**

```
bun test tests/core/brain/digest.test.ts
```
Expected: all previous tests still green plus the two new ones.

**Step 7: Pause for review (no commit).**

---

### Task 1.5: Implement `merge` writer module

**Objective:** Pure mutating writer that the CLI verb wraps. All
guards in one place, all writes via existing atomic helpers.

**Files:**
- Create: `src/core/brain/merge.ts`
- Create: `tests/core/brain/merge.test.ts`

**Step 1: Define the surface**

```ts
// src/core/brain/merge.ts
import type { BrainPreference } from "./types.ts";

export class BrainMergeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrainMergeError";
  }
}

export interface MergeOptions {
  readonly now?: Date;
  readonly agentName?: string;
  readonly dryRun?: boolean;
}

export interface MergePlan {
  readonly keep_id: string;
  readonly drop_id: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly merged_evidenced_by: ReadonlyArray<string>;
  readonly applied_sum: number;
  readonly violated_sum: number;
  readonly last_evidence_at: string | null;
  readonly retired_path: string;
}

/**
 * Build the merge plan and (unless dryRun) execute it. Throws
 * `BrainMergeError` on any guard failure.
 */
export function mergePreferences(
  vault: string,
  keepId: string,
  dropId: string,
  opts?: MergeOptions,
): MergePlan;
```

**Step 2: Write failing tests**

```ts
// tests/core/brain/merge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrainMergeError, mergePreferences } from "../../../src/core/brain/merge.ts";

let vault: string;
const NOW = new Date("2026-05-18T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-merge-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

// Helpers: writePref, writeRetired — copy from explorer test once written.

describe("mergePreferences — guards", () => {
  test("rejects mismatched topic", () => {
    // ... writePref keep with topic=x, drop with topic=y ...
    expect(() => mergePreferences(vault, "pref-keep", "pref-drop", { now: NOW }))
      .toThrow(BrainMergeError);
  });

  test("rejects mismatched scope (string vs null)", () => { /* ... */ });
  test("rejects keep_id === drop_id", () => { /* ... */ });
  test("rejects drop already in retired/", () => { /* ... */ });
  test("rejects keep=unpinned, drop=pinned", () => { /* ... */ });
  test("accepts both pinned", () => { /* ... */ });
});

describe("mergePreferences — happy path", () => {
  test("merges counters, evidenced_by, last_evidence_at; retires drop with merged-into", () => {
    // ... writePref keep + drop ...
    const plan = mergePreferences(vault, "pref-keep", "pref-drop", { now: NOW, agentName: "test" });
    expect(plan.applied_sum).toBe(/* k.applied + d.applied */);
    // Read keep file, assert applied_count, violated_count, last_evidence_at, evidenced_by union.
    // Read retired file, assert retired_reason: merged-into, superseded_by: [[pref-keep|...]].
    // Read log/today, assert one `## ... merge` block.
    // Assert active.md regenerated (does not contain drop, does contain keep with new counters).
  });

  test("dryRun returns plan but writes nothing", () => { /* ... */ });
});
```

Fill in the `writePref` / `writeRetired` helpers using the same
frontmatter shapes as in `merge-candidates.test.ts` plus the fields
required for `BrainPreference` parsing (`evidenced_by` array,
`applied_count`, `violated_count`, `last_evidence_at`, `pinned`,
`confidence_value`).

**Step 3: Verify failure**

```
bun test tests/core/brain/merge.test.ts
```
Expected: FAIL — module not found.

**Step 4: Implement**

Implementation outline (translate to TS, ~180 lines):

1. Resolve paths via `preferencePath(vault, slug)` / `retiredPath`.
2. Parse both prefs via `parsePreference`. Throw `BrainMergeError`
   with codes `keep-not-found`, `drop-not-found` if missing.
3. Guards (each throws with a distinct code):
   - `same-id` if `keepId === dropId`.
   - `drop-already-retired` if `dropId` resolves under `retired/`.
   - `topic-mismatch` if `keep.topic !== drop.topic`.
   - `scope-mismatch` if `keep.scope !== drop.scope` (treating
     undefined as `null` consistently).
   - `pin-parity` if exactly one of the two is pinned and the
     pinned one is `drop`.
4. Compute `mergedKeep`:
   - `evidenced_by`: sorted dedup union.
   - `applied_count`: sum.
   - `violated_count`: sum.
   - `last_evidence_at`: max by ISO-8601 lexical compare; null when
     both null.
   - All other fields = `keep` as-is.
5. Compute the `MergePlan` object. Return early if `dryRun`.
6. Write: `writePreference(mergedKeep, { overwrite: true })`.
7. Move drop: `moveToRetired(vault, dropPath, "merged-into", { now,
   retired_by: "[[Brain/log/<today>]]", superseded_by: renderPrefLink({
   id: keep.id, principle: keep.principle }) })`.
8. Append log event of kind `merge` via `appendLogEvent` with body:
   - `keep`, `drop` (titled wikilinks)
   - `signal_union: <N> (was <K>, <D>)`
   - `applied_sum: <N> (was <K>, <D>)`
   - `violated_sum: <N> (was <K>, <D>)`
   - `agent: <agentName ?? "unknown">`
9. `regenerateActiveQuiet(vault, { now })`.

**Step 5: Run tests**

```
bun test tests/core/brain/merge.test.ts
```
Expected: 8 passed (6 guards + 2 happy-path).

**Step 6: Pause for review (no commit).**

---

### Task 1.6: Add `o2b brain merge` CLI verb

**Objective:** CLI wrapper around `mergePreferences` with interactive
confirmation and `--dry-run` / `--force`.

**Files:**
- Modify: `src/cli/brain.ts`
- Create: `tests/cli/brain-merge.test.ts`

**Step 1: Add verb dispatch**

In `src/cli/brain.ts`:

- Add `case "merge": return await cmdBrainMerge(rest);` to the
  switch in `handleBrainSubcommand`.
- Add `merge` entry to `BRAIN_HELP` and a `VERB_HELP["merge"]` block.

**Step 2: Implement `cmdBrainMerge`**

Reuse `parse` (CLI flag parser), `resolveBrainVault`, `readSingleLine`
(for interactive y/N — same pattern as rollback).

Behaviour:
- Args: two positional ids (keep, drop). `parse` rejects fewer/more
  than 2.
- Flags: `--dry-run`, `--force`, `--vault <path>`.
- Compute plan via `mergePreferences(vault, keep, drop, { dryRun:
  true, now, agentName })`.
- Print plan summary on stdout: 4 lines (keep / drop / counters /
  retired_path).
- If `--dry-run`: print "dry-run; no changes" and return 0.
- If `--force`: skip prompt.
- Else: prompt `Proceed? [y/N] ` via `readSingleLine`. Anything not
  `y`/`Y` → return 0 with "merge cancelled".
- Call `mergePreferences` again with `dryRun: false` to commit.
- Print one-line confirmation and return 0.

**Step 3: Tests**

```ts
// tests/cli/brain-merge.test.ts
describe("o2b brain merge", () => {
  test("dry-run prints plan and writes nothing", async () => { /* ... */ });
  test("--force commits without prompt", async () => { /* ... */ });
  test("interactive 'y' commits", async () => { /* ... */ });
  test("interactive 'N' (default) does not commit", async () => { /* ... */ });
  test("topic mismatch exits 1 with documented message", async () => { /* ... */ });
  test("missing keep exits 1", async () => { /* ... */ });
  test("same id exits 1", async () => { /* ... */ });
});
```

Each test spawns `bun run src/cli/main.ts brain merge <args>` against a
fixture vault, asserts exit code, stdout/stderr, and on-disk effect
(or non-effect).

**Step 4: Verify**

```
bun test tests/cli/brain-merge.test.ts
```
Expected: 7 passed.

**Step 5: Phase 1 typecheck and full test**

```
bun run typecheck
bun test
```
Expected: both green. Existing `digest.test.ts` and `doctor.test.ts`
included.

**Step 6: Pause for review (no commit).**

---

## Phase 2 — §14 Local explorer

### Task 2.1: Implement `collectExplorerData`

**Objective:** Pure-read data collector returning the
`ExplorerGraph` shape from the design doc.

**Files:**
- Create: `src/core/brain/explorer.ts` (data side only — rendering in 2.2)
- Create: `tests/core/brain/explorer.test.ts`

**Step 1: Write failing test**

```ts
// tests/core/brain/explorer.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// ... usual mkdtemp boilerplate ...
import { collectExplorerData } from "../../../src/core/brain/explorer.ts";

describe("collectExplorerData", () => {
  test("empty Brain → 0 nodes, 0 edges", () => {
    const g = collectExplorerData(vault);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.schema_version).toBe(1);
  });

  test("includes confirmed, unconfirmed, quarantine, retired", () => { /* ... */ });

  test("supersedes edge from retired.superseded_by", () => { /* ... */ });

  test("wikilink edge from principle body, deduped", () => { /* ... */ });

  test("excludes edges to signals or log files", () => { /* ... */ });

  test("byte-identical output across runs on the same vault", () => {
    const g1 = JSON.stringify(collectExplorerData(vault));
    const g2 = JSON.stringify(collectExplorerData(vault));
    expect(g1).toBe(g2);
  });

  test("legacy pref with confidence_value=null surfaces as null", () => { /* ... */ });

  test("backlink_count matches buildBacklinkIndex", () => { /* ... */ });
});
```

**Step 2: Verify failure**

```
bun test tests/core/brain/explorer.test.ts
```
Expected: FAIL.

**Step 3: Implement `collectExplorerData`**

Source code outline:

```ts
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildBacklinkIndex } from "./backlinks.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import { extractWikilinks } from "../vault.ts";

export interface ExplorerNode { /* per spec */ }
export interface ExplorerEdge { /* per spec */ }
export interface ExplorerGraph { /* per spec */ }

export function collectExplorerData(vault: string): ExplorerGraph {
  const dirs = brainDirs(vault);
  const nodes: ExplorerNode[] = [];
  const knownIds = new Set<string>();

  // 1. Walk preferences/.
  // 2. Walk retired/.
  // 3. Build backlink index, copy `backlink_count` per node.

  // 4. Build edges:
  //    - frontmatter `supersedes` / `superseded_by` (one edge per ref).
  //    - inline wikilinks in principle body AND retired body, filtered
  //      to refs that land in `knownIds`.
  //    - dedup keyed by (source, target, kind).

  // 5. Sort nodes by (kind, id). Sort edges by (source, target, kind).

  return Object.freeze({
    generated_at: new Date().toISOString(),
    schema_version: 1,
    vault_basename: basename(vault),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}
```

Use the existing `buildBacklinkIndex` for `backlink_count` (the
function returns `Map<targetId, refs[]>` — count = `refs.length`).

**Step 4: Verify**

```
bun test tests/core/brain/explorer.test.ts
```
Expected: 8 passed.

**Step 5: Pause for review (no commit).**

---

### Task 2.2: Implement `renderExportedHtml` plus the HTML template

**Objective:** Substitute the JSON placeholder, write the template to
disk with mini physics engine + canvas renderer.

**Files:**
- Create: `templates/brain-explorer.html`
- Modify: `src/core/brain/explorer.ts` (add `renderExportedHtml`)
- Modify: `tests/core/brain/explorer.test.ts` (template tests)

**Step 1: Skeleton template**

Create `templates/brain-explorer.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Open Second Brain — Explorer</title>
  <style>/* ~80 lines, system-ui font, light/dark via prefers-color-scheme */</style>
</head>
<body>
  <header>...</header>
  <aside id="filters">
    <input id="search" type="search" placeholder="Search principle or topic" />
    <fieldset id="status-filters">...</fieldset>
    <fieldset id="kind-filters">...</fieldset>
  </aside>
  <main>
    <canvas id="canvas"></canvas>
  </main>
  <aside id="details">
    <p class="empty">Select a node to inspect.</p>
  </aside>

  <script type="application/json" id="brain-data">__GRAPH_JSON__</script>
  <script>
    // ~250 lines:
    // 1. Parse JSON.
    // 2. Build internal state (id → node, edges as adj list).
    // 3. miniForceLayout: Verlet with topic-center attraction,
    //    global charge repulsion, edge spring, damping. Tick on rAF.
    // 4. canvasRender: clear, draw edges, draw nodes (colour by status,
    //    size by sqrt(applied_count), gold stroke if pinned).
    // 5. hitTest: nearest node within radius on mousemove / click.
    // 6. filterAndSearch: hide non-matching nodes; their edges hide too.
    // 7. renderRightPanel: id, principle, topic, scope, status,
    //    confidence band/value, applied/violated, pinned, last_evidence_at,
    //    backlink_count, retired_reason if retired, edges list.
  </script>
</body>
</html>
```

Tune constants: `K_TOPIC = 0.005`, `K_CHARGE = 600`, `K_SPRING =
0.05`, damping `0.85`, max-velocity clamp.

**Step 2: `renderExportedHtml` in `explorer.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "brain-explorer.html",
);

const PLACEHOLDER = "__GRAPH_JSON__";

let templateCache: string | undefined;

function loadTemplate(): string {
  if (templateCache !== undefined) return templateCache;
  templateCache = readFileSync(TEMPLATE_PATH, "utf8");
  if (!templateCache.includes(PLACEHOLDER)) {
    throw new Error(
      `brain-explorer.html template missing the ${PLACEHOLDER} marker`,
    );
  }
  return templateCache;
}

export function renderExportedHtml(graph: ExplorerGraph): string {
  // JSON.stringify with `2` would bloat the file — single-line.
  const json = JSON.stringify(graph);
  return loadTemplate().replace(PLACEHOLDER, () => json);
}
```

`String.replace(_, fn)` form avoids `$&`/`$1` injection if the JSON
ever contains the `$` sigil (it might — `principle` is free text).

**Step 3: Add template tests**

```ts
test("renderExportedHtml replaces the placeholder exactly once", () => {
  const html = renderExportedHtml(collectExplorerData(vault));
  expect(html.includes("__GRAPH_JSON__")).toBe(false);
  const match = html.match(/<script type="application\/json" id="brain-data">([\s\S]+?)<\/script>/);
  expect(match).not.toBeNull();
  const parsed = JSON.parse(match![1]!);
  expect(parsed.schema_version).toBe(1);
});

test("template carries the placeholder before substitution", () => {
  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  expect(raw.includes("__GRAPH_JSON__")).toBe(true);
});
```

**Step 4: Verify**

```
bun test tests/core/brain/explorer.test.ts
```
Expected: all previous tests still green plus the two new ones.

**Step 5: Manual smoke (optional, no test)**

Render against the local vault, open the file in a browser, verify:
- Nodes render and settle.
- Hover shows tooltip.
- Click populates the right panel.
- Search box filters live.
- Status filter checkboxes work.

Document in the PR description; this is not gated in CI.

**Step 6: Pause for review (no commit).**

---

### Task 2.3: Implement `buildLiveServer`

**Objective:** Tiny HTTP server on loopback that re-reads vault per
request and serves the same template + JSON.

**Files:**
- Modify: `src/core/brain/explorer.ts`

**Step 1: Write the function**

```ts
import { Server } from "bun";

export interface LiveServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

export function buildLiveServer(
  vault: string,
  port: number,
): LiveServerHandle {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const graph = collectExplorerData(vault);
        const html = renderExportedHtml(graph);
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/data.json") {
        const graph = collectExplorerData(vault);
        return new Response(JSON.stringify(graph), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    close: async () => { server.stop(); },
  };
}
```

**Step 2: Test**

In `tests/cli/brain-explorer.test.ts` (created next task), add the
live-server smoke. Server-only tests live there because they spawn a
subprocess via the CLI.

**Step 3: Pause for review (no commit).**

---

### Task 2.4: Add `o2b brain explorer` CLI verb

**Objective:** Thread CLI flags into the explorer module and ship the
binary entry.

**Files:**
- Modify: `src/cli/brain.ts`
- Create: `tests/cli/brain-explorer.test.ts`

**Step 1: Verb dispatch**

```ts
case "explorer":
  return await cmdBrainExplorer(rest);
```

Add `explorer` to `BRAIN_HELP` and a `VERB_HELP["explorer"]` block.

**Step 2: Implement `cmdBrainExplorer`**

```ts
async function cmdBrainExplorer(argv: ReadonlyArray<string>): Promise<number> {
  const args = parse(argv, {
    flags: { force: false },
    options: { port: "7777", export: null, vault: null },
  });
  const vault = resolveBrainVault(args.options.vault);
  const exportPath = args.options.export;

  if (exportPath !== null) {
    if (existsSync(exportPath) && !args.flags.force) {
      fail(`${exportPath} exists; pass --force to overwrite`);
      return 1;
    }
    const graph = collectExplorerData(vault);
    const html = renderExportedHtml(graph);
    atomicWriteFileSync(exportPath, html);
    ok(`Exported ${graph.nodes.length} nodes to ${exportPath}`);
    return 0;
  }

  const port = parseInt(args.options.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    fail(`invalid --port value: ${args.options.port}`);
    return 1;
  }
  let server: LiveServerHandle;
  try {
    server = buildLiveServer(vault, port);
  } catch (err) {
    const msg = (err as Error).message;
    if (/EADDRINUSE/.test(msg)) {
      fail(`port ${port} already in use; try --port <other>`);
      return 1;
    }
    throw err;
  }
  ok(`Live explorer at ${server.url}`);
  info("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const onSignal = (): void => { server.close().then(() => resolve()); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  return 0;
}
```

**Step 3: Tests**

```ts
// tests/cli/brain-explorer.test.ts
describe("o2b brain explorer --export", () => {
  test("creates the file, exit 0", async () => { /* ... */ });
  test("refuses overwrite without --force", async () => { /* ... */ });
  test("overwrites with --force", async () => { /* ... */ });
  test("contains parseable JSON in the data script tag", async () => { /* ... */ });
});

describe("o2b brain explorer (live)", () => {
  test("binds to 127.0.0.1 and serves / + /data.json", async () => {
    // Bun.spawn the CLI, poll http://127.0.0.1:<port>/, parse the
    // <script type=application/json>, assert schema_version. SIGINT.
  });
  test("port in use exits 1 with documented message", async () => { /* ... */ });
});
```

For the live test, use a high random port (e.g. `30000 + Math.floor(Math.random() * 30000)`) to avoid collisions on the build host. The single-user VPS does not multiplex tests but CI might.

**Step 4: Verify**

```
bun test tests/cli/brain-explorer.test.ts
```
Expected: 6 passed.

**Step 5: Phase 2 typecheck and full test**

```
bun run typecheck
bun test
```
Expected: green.

**Step 6: Pause for review (no commit).**

---

## Phase 3 — §4-tail Per-runtime hook cadence

### Task 3.1: Add `detectHookRuntime` and `HookRuntime`

**Objective:** Extend `hooks/lib/detect.ts` with the runtime detector.

**Files:**
- Modify: `hooks/lib/detect.ts`
- Modify: `tests/hooks/detect.test.ts`

**Step 1: Write failing tests**

```ts
// in tests/hooks/detect.test.ts — append to existing describe
import { detectHookRuntime } from "../../hooks/lib/detect.ts";

describe("detectHookRuntime", () => {
  test("Claude Code transcript path → claudecode", () => {
    expect(detectHookRuntime({
      transcript_path: "/Users/x/.claude/projects/-srv/projects/foo/abc.jsonl",
    })).toBe("claudecode");
  });
  test("Codex transcript path → codex", () => {
    expect(detectHookRuntime({
      transcript_path: "/root/.codex/sessions/2026-05-18T10-00-00Z.json",
    })).toBe("codex");
  });
  test("Claude Code triple → claudecode (no transcript_path)", () => {
    expect(detectHookRuntime({
      session_id: "x", cwd: "/srv", tool_use_id: "y",
    })).toBe("claudecode");
  });
  test("Codex apply_patch shape → codex", () => {
    expect(detectHookRuntime({
      tool_name: "apply_patch",
      tool_input: { input: "*** Begin Patch\n...\n*** End Patch" },
    })).toBe("codex");
  });
  test("malformed payload → unknown without throw", () => {
    expect(detectHookRuntime(null)).toBe("unknown");
    expect(detectHookRuntime(undefined)).toBe("unknown");
    expect(detectHookRuntime("string")).toBe("unknown");
    expect(detectHookRuntime({})).toBe("unknown");
  });
});
```

**Step 2: Implement**

```ts
// hooks/lib/detect.ts (add at end)
export type HookRuntime = "claudecode" | "codex" | "unknown";

const CLAUDE_TRANSCRIPT_NEEDLES = ["/.claude/projects/", "/.claude/sessions/"];
const CODEX_TRANSCRIPT_NEEDLE = "/.codex/sessions/";

export function detectHookRuntime(payload: unknown): HookRuntime {
  if (payload === null || typeof payload !== "object") return "unknown";
  const p = payload as Record<string, unknown>;

  const tp = p["transcript_path"];
  if (typeof tp === "string") {
    if (CLAUDE_TRANSCRIPT_NEEDLES.some((n) => tp.includes(n))) return "claudecode";
    if (tp.includes(CODEX_TRANSCRIPT_NEEDLE)) return "codex";
  }

  // Claude Code's hook payload distinctively carries all three.
  if (
    typeof p["session_id"] === "string"
    && typeof p["cwd"] === "string"
    && typeof p["tool_use_id"] === "string"
  ) {
    return "claudecode";
  }

  // Codex's PostToolUse payload for apply_patch carries the patch
  // body in `tool_input.input` as a string.
  if (p["tool_name"] === "apply_patch") {
    const ti = p["tool_input"];
    if (ti !== null && typeof ti === "object") {
      const input = (ti as Record<string, unknown>)["input"];
      if (typeof input === "string" && input.includes("*** Begin Patch")) {
        return "codex";
      }
    }
  }

  return "unknown";
}
```

**Step 3: Verify**

```
bun test tests/hooks/detect.test.ts
```
Expected: existing tests still green plus 5 new.

**Step 4: Pause for review (no commit).**

---

### Task 3.2: Thread `runtime` through `postWriteReminder` and `stopGuardrailReason`

**Objective:** Add the parameter, render the cadence line, keep
`unknown` byte-identical to current output.

**Files:**
- Modify: `hooks/lib/messages.ts`
- Modify: `hooks/post-write-reminder.ts`
- Modify: `hooks/stop-log-guardrail.ts`
- Modify: `tests/hooks/post-write-reminder.test.ts`
- Modify: `tests/hooks/stop-log-guardrail.test.ts`

**Step 1: Update `hooks/lib/messages.ts`**

```ts
import type { HookRuntime } from "./detect.ts";

export interface PostWriteReminderInput {
  readonly toolName: string;
  readonly filePath: string | null;
  readonly runtime: HookRuntime;
}

function postWriteCadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return [
        "_Claude Code session: many turns ahead — capture the signal_",
        "_or evidence now rather than batching to end-of-session; long_",
        "_sessions risk forgetting the context that distinguishes one_",
        "_artifact from the next._",
      ].join("\n");
    case "codex":
      return [
        "_Codex `codex exec` is a one-shot run — call `brain_feedback`_",
        "_or `brain_apply_evidence` before this exec returns; there_",
        "_is no second turn._",
      ].join("\n");
    case "unknown":
      return "";
  }
}

export function postWriteReminder({
  toolName, filePath, runtime,
}: PostWriteReminderInput): string {
  const target = filePath ? `\`${filePath}\`` : "a file";
  const cadence = postWriteCadenceLine(runtime);
  const parts: string[] = [
    `Open Second Brain hook: you just ran \`${toolName}\` against ${target}.`,
    "",
  ];
  if (cadence) {
    parts.push(cadence, "");
  }
  parts.push(
    "If this turn contained a user preference, correction, or rule that",
    "should outlast the current task (\"don't do X\", \"prefer Y\", \"use",
    "A instead of B\"), call `brain_feedback` once per signal to record",
    "it into `Brain/inbox/`.",
    "",
    "If a confirmed or unconfirmed preference in `Brain/preferences/`",
    "scopes to the artifact you just produced, call",
    "`brain_apply_evidence` with `result: applied | violated` so the",
    "dream pass can update confidence and retire stale rules.",
    "",
    "Trivial edits (typo fix, pure formatting) don't need either call.",
    "A misrecorded signal is worse than a missed one — skip when not",
    "confident; the dream pass will pick up patterns from repeats.",
  );
  return parts.join("\n");
}

function stopGuardrailCadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return "_This guardrail fires at most once per turn — send another reply (with or without `event_log_append`) to clear it._";
    case "codex":
      return "_This `codex exec` is about to end — call `event_log_append` now or finish silently; no further guardrail will fire._";
    case "unknown":
      return "";
  }
}

export function stopGuardrailReason(runtime: HookRuntime = "unknown"): string {
  const cadence = stopGuardrailCadenceLine(runtime);
  const parts: string[] = [
    "Open Second Brain hook: this turn touched files",
    "(Write / Edit / MultiEdit / apply_patch) but did not call",
    "`event_log_append`.",
    "",
  ];
  if (cadence) {
    parts.push(cadence, "");
  }
  parts.push(
    "If the change is a durable artifact you want future sessions to",
    "be able to search for, call `event_log_append` with a one-line",
    "message describing what landed, then finish.",
    "",
    "If the change is trivial and not worth logging, just send your",
    "reply again — this guardrail fires at most once per turn and",
    "will let the second Stop through.",
  );
  return parts.join("\n");
}
```

`stopGuardrailReason` has a default `runtime = "unknown"` so callers
that haven't been updated yet keep working — back-compat for any
third-party hook or test that calls the function with no argument.

**Step 2: Update call sites**

`hooks/post-write-reminder.ts` — between `const toolName` and the call
to `postWriteReminder`:

```ts
import { detectHookRuntime } from "./lib/detect.ts";
// ...
const runtime = detectHookRuntime(payload);
const text = postWriteReminder({ toolName, filePath, runtime });
```

`hooks/stop-log-guardrail.ts` — analogous:

```ts
import { detectHookRuntime } from "./lib/detect.ts";
// ...
const runtime = detectHookRuntime(payload);
const out = {
  decision: "block",
  reason: stopGuardrailReason(runtime),
};
```

**Step 3: Update tests**

In `tests/hooks/post-write-reminder.test.ts`:

```ts
test("Claude Code payload includes the claudecode cadence line", async () => {
  const r = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/foo.md", content: "hello" },
    session_id: "abc", cwd: "/srv", tool_use_id: "xyz",
  });
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.additionalContext).toContain("Claude Code session");
});

test("Codex payload includes the codex cadence line", async () => {
  const r = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { input: "*** Begin Patch\n*** Update File: /tmp/foo.md\n*** End Patch" },
  });
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.additionalContext).toContain("codex exec");
});

test("unknown runtime renders byte-identical to v0.10.4 baseline", async () => {
  const r = await runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/foo.md", content: "hello" },
    // No transcript_path, no triple, no apply_patch shape.
  });
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.additionalContext).not.toContain("Claude Code session");
  expect(out.hookSpecificOutput.additionalContext).not.toContain("codex exec");
  // Spot-check the original lines are present in order.
  expect(out.hookSpecificOutput.additionalContext).toContain("brain_feedback");
  expect(out.hookSpecificOutput.additionalContext).toContain("brain_apply_evidence");
});
```

Symmetric three tests in `tests/hooks/stop-log-guardrail.test.ts`.

**Step 4: Verify**

```
bun test tests/hooks/
bun run typecheck
```
Expected: green.

**Step 5: Pause for review (no commit).**

---

## Phase 6 — §E Embeddings activation

Folded in mid-PR after the Hermes onboarding report
`/root/vault/Projects/OpenSecondBrain/Features/embedding-provider-activation.md`.
Three independent slices plus one SKILL; design lives under
`§E.1–§E.4` in the design doc.

### Task 6.1: macOS sqlite shim — `scripts/_macos-sqlite.sh`

**Objective:** A sourced bash file that exports
`DYLD_LIBRARY_PATH` to Homebrew sqlite on Darwin, no-op
elsewhere; `scripts/o2b` sources it after the Bun precheck.

**Files:**
- Create: `scripts/_macos-sqlite.sh`
- Modify: `scripts/o2b`
- Create: `tests/scripts/macos-sqlite-shim.test.ts`

**Step 1: Write failing test** — see design §E.1 / Tests row.
The test spawns the shim under `bash -c '...'` with a stub
`uname` shadowing the real one through a tmp `PATH` entry, then
asserts the exported env. Three cases:
- `uname` says `Linux` → `DYLD_LIBRARY_PATH` unset on exit.
- `uname` says `Darwin`, brew prefix `/opt/homebrew/opt/sqlite/lib`
  exists (mkdir under tmp + alias prefix into the shim via env
  override) → `DYLD_LIBRARY_PATH` set to that path.
- `uname` says `Darwin`, `DYLD_LIBRARY_PATH=/preset` → preserved
  verbatim (shim must not clobber).

To stay portable, expose two env overrides in the shim:
`O2B_MACOS_SQLITE_PREFIXES_OVERRIDE` (colon-separated test
inputs) and `O2B_MACOS_FORCE_PLATFORM` (`Darwin` / `Linux`).
Both undocumented in user-facing help; comment in the script
explains they exist for the test harness.

**Step 2: Implement.** See design §E.1 contract. The full body
fits in ~25 lines. Comment header describes WHY (Apple's
`OMIT_LOAD_EXTENSION`).

**Step 3: Wire into `scripts/o2b`.** Add one source line after
`_bun-precheck.sh`. `shellcheck source=` directive ditto.

**Step 4: Run tests.**

```
bun test tests/scripts/macos-sqlite-shim.test.ts
```

Expected: 3 passed.

**Step 5: Pause for review (no commit).**

### Task 6.2: `recommendations` field on `IndexCheckReport`

**Objective:** Add an optional `recommendations: string[]` to
`IndexCheckReport`; populate it from rule table in design §E.2;
render in human + JSON.

**Files:**
- Modify: `src/core/search/types.ts` (extend report shape)
- Modify: `src/core/search/indexer.ts` (build the list)
- Modify: `src/cli/search.ts` (render in JSON + human)
- Create: `tests/core/search/check-recommendations.test.ts`

**Step 1: Write failing tests.** Drive `indexCheck` via the
public API with custom config; for the Darwin branch, monkey-
patch `process.platform` for the duration of the test (using
`Object.defineProperty(process, "platform", { value: "darwin" })`
and restore in `afterEach`). Coverage as listed in design.

**Step 2: Type change.**

```ts
// src/core/search/types.ts
export interface IndexCheckReport {
  // existing fields
  readonly recommendations: ReadonlyArray<string>;
}
```

**Step 3: Builder.** Inside `indexCheck` (`src/core/search/indexer.ts`),
after the existing warning aggregation:

```ts
const recommendations: string[] = [];
if (!embeddingKeyResolved) {
  recommendations.push(
    "Set OPEN_SECOND_BRAIN_EMBEDDING_KEY in ~/.hermes/.env (or the configured env file).",
  );
  recommendations.push(
    "Provider: OpenAI `text-embedding-3-small` is the default; any OpenAI-compatible endpoint works via OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL.",
  );
}
if (vecExtension === "unavailable") {
  if (process.platform === "darwin") {
    recommendations.push(
      "Install Homebrew SQLite: `brew install sqlite`. The o2b wrapper picks it up on the next invocation via DYLD_LIBRARY_PATH.",
    );
  } else {
    recommendations.push(
      "sqlite-vec did not load. Confirm the optional dependency with `bun pm ls`, or rebuild with `bun install --force`.",
    );
  }
}
if (embeddingKeyResolved && vecExtension === "loaded" /* and no embeddings yet */) {
  recommendations.push(
    "Run `o2b search reindex --embeddings` to compute the first vectors, then optionally `o2b search reindex --cron-template` for periodic refresh.",
  );
}
return Object.freeze({
  ...,
  recommendations: Object.freeze(recommendations),
});
```

The "no embeddings yet" branch needs a fact from the status
side; the simplest path is to consult `embeddings === 0` via
the same store, which the function already has open. Detail
in the impl.

**Step 4: Render.** In `src/cli/search.ts`:

```ts
function jsonForCheck(r: IndexCheckReport): unknown {
  return {
    // existing fields ...
    recommendations: r.recommendations,
  };
}
function renderCheckHuman(r: IndexCheckReport): string {
  // existing block ...
  if (r.recommendations.length > 0) {
    lines.push("");
    lines.push("recommendations:");
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  return lines.join("\n") + "\n";
}
```

**Step 5: Verify.**

```
bun test tests/core/search/check-recommendations.test.ts
bun test tests/cli/search.test.ts  # may surface a renderer regression
```

**Step 6: Pause for review (no commit).**

### Task 6.3: `o2b search reindex --cron-template`

**Objective:** Pure stdout template printer; writes nothing.

**Files:**
- Modify: `src/cli/search.ts` (extend `cmdSearchReindex`)
- Create: `src/cli/search-cron-template.ts` (template body)
- Create: `tests/cli/search-cron-template.test.ts`

**Step 1: Tests.** See design §E.3 / Tests row.

**Step 2: Implement `renderCronTemplate(interval: string)`.**
Returns a single string. Substitutions:
- `__O2B_BIN__` resolves to `process.argv0`-style absolute path
  (use the same resolution as `install-cli`).
- `__INTERVAL_CRON__` is the cron expression (e.g. `*/30 * * *
  *` for 30 minutes).
- `__INTERVAL_HUMAN__` is the human form (`30 minutes`).

Duration parser accepts `s`/`m`/`h`/`d` suffixes; rejects
zero / negative; rejects unrecognised units with a clear
message.

**Step 3: Wire into the verb.**

```ts
async function cmdSearchReindex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    // existing flags ...
    "cron-template": { type: "boolean" },
    interval: { type: "string" },
  });
  if (flags["cron-template"] === true) {
    const intervalRaw = (flags["interval"] as string | undefined) ?? "30m";
    let body: string;
    try {
      body = renderCronTemplate(intervalRaw);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }
    process.stdout.write(body);
    return 0;
  }
  // existing reindex flow ...
}
```

**Step 4: Verify.**

```
bun test tests/cli/search-cron-template.test.ts
```

**Step 5: Pause for review (no commit).**

### Task 6.4: `embeddings-setup` SKILL

**Objective:** New SKILL file under `skills/embeddings-setup/SKILL.md`.

**Files:**
- Create: `skills/embeddings-setup/SKILL.md`

**Step 1: Author the file.** See design §E.4 for the content
outline. Front matter `name: embeddings-setup`, description
with explicit triggers (verbatim phrases the agent watches for).

**Step 2: No test surface** — prose only.

**Step 3: Pause for review (no commit).**

### Phase 6 close-out

After Tasks 6.1–6.4:

```
bun run typecheck
bun test
```

Expected: both green; new test counts:
- `tests/scripts/macos-sqlite-shim.test.ts` — 3
- `tests/core/search/check-recommendations.test.ts` — ~4
- `tests/cli/search-cron-template.test.ts` — ~4

CHANGELOG and `_summary.md` deferred-block updates land in
Phase 5 (Task 5.1 and Task 5.3) — expand those entries with
`§E` lines covering the activation slices and the new D-E.x
deferred items.

---

## Phase 4 — §15-tail Good vs bad SKILL section

### Task 4.1: Insert the examples section

**Objective:** One inline edit in `skills/brain-memory/SKILL.md`.

**Files:**
- Modify: `skills/brain-memory/SKILL.md`

**Step 1: Locate insertion point**

After the `## Rules` block, before the `## Fallback capture surfaces`
heading.

**Step 2: Insert content**

```markdown
## Examples — good vs bad

**Bad:** `principle: "Write good commits"`
**Good:** `principle: "Use imperative voice in commit subjects; describe what the commit does, not what was done"`
*Why:* the bad form is unenforceable — no future signal can reasonably mark an artifact as "applied" or "violated" against it. The good form names a checkable behaviour.

**Bad:** `principle: "Be careful with secrets"`
**Good:** `principle: "Do not commit \`.env\`, credentials, or API keys; route them through environment variables"`
*Why:* the bad form is a vibe. The good form gives the agent a concrete list of patterns to spot in a diff.

**Bad:** `topic: "stuff"`
**Good:** `topic: "no-internal-abbrev"`
*Why:* topic is the stable bucket future signals join. A generic slug collects unrelated rules; a precise one keeps the cluster meaningful and lets `brain_query --topic <slug>` return a focused slice.

**Bad:** `note: "fixed it"`
**Good:** `note: "expanded 'OSB' to 'Open Second Brain' on first use — README diff still carried the abbreviation, would have confused a new reader"`
*Why:* notes survive the artifact. Without the "why" line you cannot tell in three months whether a violation was a regression or a deliberate change.
```

**Step 3: Verify there is no SKILL parser to satisfy**

`grep -rn "Examples — good vs bad" src/ tests/` returns zero — the
section is documentation only. The skill scanner already accepts
arbitrary headings.

**Step 4: Pause for review (no commit).**

---

## Phase 5 — Wrap-up

### Task 5.1: CHANGELOG entry

**Objective:** One `## [0.10.5]` block.

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Insert at the top of the file, under the front-matter intro**

```markdown
## [0.10.5]

Brings the v0.10.5 "Brain maturity" cluster from
`Projects/OpenSecondBrain/Features/_summary`: §14 local
HTML/web explorer, §12 merge-suggestions plus `o2b brain merge`,
§4 (partial — completes the deferred D5 from v0.10.4) per-runtime
cadence in `hooks/lib/messages.ts`, and §15-tail "good vs bad"
examples in the brain-memory SKILL.

No vault migration is required.

### Added

- §14 — `o2b brain explorer` launches a loopback HTTP server
  rendering preferences and retired entries as a force-directed
  graph; `o2b brain explorer --export <path>` writes the same view
  as a single offline HTML file with inlined data. Both modes share
  one template under `templates/brain-explorer.html`. Bun.serve
  handles the live mode; no backend, no LLM, no network. Markdown is
  parsed in the browser.
- §12 — `o2b brain digest` gains a `## Merge suggestions` section
  surfacing confirmed/quarantine pairs in the same `(topic, scope)`
  whose `principle` tokens jaccard ≥ 0.6. Pairs ≥ 0.85 continue to
  trip the `duplicate-preferences` doctor lint. `o2b brain merge
  <keep> <drop>` is the explicit slice for resolving them: `keep`
  retains its frontmatter, picks up the deduped union of
  `evidenced_by`, the summed `applied_count` and `violated_count`,
  and `max(last_evidence_at)`; `drop` lands in `retired/` with
  reason `merged-into` and a `superseded_by` wikilink to `keep`. The
  CLI prompts interactively unless `--force` is passed; `--dry-run`
  reports the plan and writes nothing.
- §4 (completes deferred D5 from v0.10.4) — `hooks/lib/messages.ts`
  emits a per-runtime cadence line above the
  `brain_feedback`/`brain_apply_evidence` block. Claude Code gets a
  "many turns ahead, capture now" hint; Codex gets a "one-shot exec,
  call before return" hint. Unknown runtime renders byte-identical
  to the v0.10.4 baseline. Detection lives in
  `hooks/lib/detect.ts:detectHookRuntime`, driven by hook-payload
  shape (`transcript_path` substring or Claude's
  `session_id`/`cwd`/`tool_use_id` triple). `stopGuardrailReason`
  follows the same pattern.
- §15 (completes deferred D4 from v0.10.4) — `skills/brain-memory/
  SKILL.md` gains an `## Examples — good vs bad` section: four
  contrastive pairs for weak/strong `principle`, too-general/
  precise `topic`, and `note` with/without the "why" line.

### Changed

- `tokenise` and `jaccard` lifted from `src/core/brain/doctor.ts`
  into `src/core/brain/similarity.ts`. No behavioural change. The
  doctor lint `duplicate-preferences` and the new merge-candidate
  detector now share one implementation.

### Internal

- New constant `BRAIN_RETIRED_REASON.mergedInto = "merged-into"`.
- New log event kind `BRAIN_LOG_EVENT_KIND.merge = "merge"`.
- New typed error `BrainMergeError`.
```

`[Unreleased]` is never added — per vault memory
`feedback_no_unreleased_section`.

**Step 2: Pause for review (no commit).**

---

### Task 5.2: Bump version

**Objective:** `package.json` from `0.10.4` to `0.10.5`. Mirror via
the existing script.

**Files:**
- Modify: `package.json`
- Auto-modified by `bun run sync-version`: the seven mirror files.

**Step 1: Edit `package.json`**

```diff
- "version": "0.10.4",
+ "version": "0.10.5",
```

**Step 2: Run sync**

```
bun run sync-version
```

**Step 3: Verify drift gone**

```
bun run sync-version:check
```
Expected: exit 0.

**Step 4: Pause for review (no commit).**

---

### Task 5.3: Vault edit — retire deferred items, add new ones

**Objective:** Update `_summary.md` deferred-work block. This is a
**vault edit** (`/root/vault/`), not a repo edit.

**Files:**
- Modify: `/root/vault/Projects/OpenSecondBrain/Features/_summary.md`

**Step 1: Replace the two deferred entries that this PR retires**

Find the deferred-work section, locate the two entries:
- `§4 — per-runtime steering text для Claude Code и Codex.`
- `§15 «good vs bad» SKILL-секция.`

Replace them with one consolidated line:

```markdown
- **§4 per-runtime hook cadence + §15 good-vs-bad SKILL section — shipped in v0.10.5.**
```

(Project memory `feedback_no_legacy_framing` says retired-deferred
entries should disappear from `_summary` for new readers; keeping a
one-line "shipped in" pointer is acceptable for cross-reference.)

**Step 2: Add new deferred entries (§14, §12 sub-features)**

Append, in the same deferred-work block:

```markdown
- **§14 Obsidian deep-link from explorer.** Live mode could open
  `obsidian://` URIs; export mode cannot. We keep both surfaces
  identical. Trigger to revisit: explicit operator request.
- **§14 Live-refresh in explorer (SSE / WebSocket).** Manual F5 is
  enough for the first iteration; push channel would break the
  zero-backend invariant. Trigger: explicit operator request.
- **§14 Layout-state persistence across runs.** Nodes resettle every
  load. `localStorage` keyed by id is cheap, not critical. Trigger:
  complaint about position jumps.
- **§12 MCP `brain_merge` tool.** Merge is rare, mutating, and
  operator-initiated after digest review. Not suitable for agent
  autonomy. Trigger: a concrete agent use-case.
- **§12 Bulk / interactive merge walkthrough.** Today the CLI takes
  one `(keep, drop)` pair per invocation. Trigger: ≥10 stable
  suggestions surface for at least one operator.
```

**Step 3: Pause for review (no commit).**

The vault is synced via Syncthing and backed up nightly; the user
notices changes through Obsidian or the daily backup. No git for the
vault.

---

### Task 5.4: Final full test pass

**Objective:** Repo green end-to-end before handoff.

**Step 1: Typecheck**

```
bun run typecheck
```
Expected: PASS.

**Step 2: Test**

```
bun test
```
Expected: all green. Note the new test counts:
- `tests/core/brain/similarity.test.ts` — 7 cases
- `tests/core/brain/merge-candidates.test.ts` — 3 cases
- `tests/core/brain/merge.test.ts` — 8 cases (6 guards + 2 happy-path)
- `tests/cli/brain-merge.test.ts` — 7 cases
- `tests/core/brain/explorer.test.ts` — 10 cases
- `tests/cli/brain-explorer.test.ts` — 6 cases
- `tests/hooks/detect.test.ts` (extended) — +5 cases
- `tests/hooks/post-write-reminder.test.ts` (extended) — +3 cases
- `tests/hooks/stop-log-guardrail.test.ts` (extended) — +3 cases
- `tests/core/brain/digest.test.ts` (extended) — +2 cases

**Step 3: Lint / format if the project has hooks**

`bun run lint` if defined. Otherwise skip.

**Step 4: Manual sanity**

- `bun run src/cli/main.ts brain explorer --export /tmp/brain-test.html --vault /root/vault`
- Open the file in a browser, sanity-check the graph.
- `bun run src/cli/main.ts brain digest --vault /root/vault`
- Verify either an empty `## Merge suggestions` (clean vault) or the
  section appears (vault with at least one near-duplicate pair).
- `bun run src/cli/main.ts brain merge --help`
- Verify the help output is clean.

**Step 5: Pause for review (no commit).**

End of plan. Hand back to the user — they decide commits, PR, and
release.

---

## Risks and known-unknowns (cross-reference design doc)

The design doc has the canonical list. Quick pointer:
- Explorer layout quality on large vaults (mitigation: hint past a
  node-count threshold).
- Force-merge error wording — the impl tests assert exact strings.
- Hook runtime detection on future runtime releases — unknown branch
  preserves the v0.10.4 reminder verbatim, so the failure mode is
  "cadence hint disappears", not a crash.
- Static export size — grows with vault size; acceptable up to ~1 MB
  for the typical 100-200 preference vault.

## Out-of-scope

Listed in the design doc under *Non-goals (explicitly deferred)* and
mirrored into `_summary.md → ## Deferred work` in Task 5.3.
