# Tier-A bundle Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` (or
> `superpowers:subagent-driven-development` for fresh-context-per-task
> dispatch) to walk this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Ship Tier-A items §5 (snapshot diff + rollback dry-run),
§10 (numeric confidence + derived band), §21 (cross-project pointer
+ primary agent), §27 (titled wikilinks for prefs) of
`Projects/OpenSecondBrain/Features/_summary` in one PR.

**Architecture:** Four mostly-independent slices land in dependency
order. §27 is the only one that touches every other slice: it adds
the `renderPrefLink` helper that §21, §10, §5 all consume in their
rendered output. The remaining three slices are orthogonal in code
terms — each owns a separate sub-tree under `src/core/brain/` and
`src/cli/`.

- **§27** lives in `wikilink.ts` (new helper) and sweeps every Brain
  writer that emits a preference / retired wikilink.
- **§21** adds one field to `Brain/_brain.yaml`, one CLI verb
  (`set-primary`), a non-fatal dream-warning channel, and one new
  documentation file.
- **§10** widens `BrainPreference` / `BrainRetired` with one numeric
  field, extends `_brain.yaml.confidence` with two new thresholds,
  reworks `computeConfidence` in `dream.ts`, and threads the new
  signal through digest + active + MCP.
- **§5** refactors the snapshot extraction step out of
  `restoreSnapshot`, adds a pure `diffBrainTrees` walker plus its
  markdown / JSON renderer, and exposes two new CLI surfaces
  (`o2b brain rollback --dry-run`, `o2b brain snapshot diff`).

**Tech Stack:** TypeScript on Bun. No new external dependencies.
Re-uses `proper-lockfile`, `fs-atomic.ts`, `snapshot.ts`,
`writeFrontmatterAtomic`, `appendLogEvent` from existing code.

**Source of truth for behaviour:**
[`docs/plans/2026-05-17-tier-a-snapshot-confidence-pointer-design.md`](./2026-05-17-tier-a-snapshot-confidence-pointer-design.md).
Every task below implements a slice of that spec — on conflict the
spec wins and the plan is amended.

---

## Plan-wide conventions

These apply to every task; do not re-state per step.

- **Imports.** Production code uses `node:`-prefixed builtins
  (`node:fs`, `node:crypto`, `node:path`). Tests use
  `import { test, expect, describe, beforeEach, afterEach } from "bun:test"`.
  Always `.ts` extensions in imports.
- **Result shape.** Public-API return values are `Object.freeze`-d at
  the producing call site (project convention, mirrors
  `src/core/brain/query.ts`).
- **Errors.** Reuse existing typed error classes
  (`BrainSnapshotError`, `BrainConfigError`, `CliError`). New typed
  errors only when a new failure shape needs distinct catch-handling
  (none expected for this bundle).
- **No git from this plan.** Each task ends with **Pause for review
  (no commit).** The user (Sergey) does all git work themselves —
  this project's `Brain/preferences/` has an active rule against
  active git from the agent.
- **No bait fallbacks.** New CLI flags exit 2 with an explicit message
  rather than silently fall through. Wilson formula at `n == 0` returns
  `value = 0.0` (honest, not derived).
- **Atomic writes** via `src/core/fs-atomic.ts:atomicWriteFileSync`.
  In-place YAML edits hold the same lock pattern as `migrate-frontmatter`
  (`proper-lockfile.lock(path, { retries: 3, factor: 2 })`).
- **Brain log events.** Use the existing `appendLogEvent` writer; only
  add new `BrainLogEventKind` constants when the event has a
  payload-key set that warrants type narrowing (none in this bundle —
  §21's warning rides on the existing `dream` event payload).
- **Verification.** Every task ends with `bun test tests/path/to/file.test.ts`
  and an expected pass count. End of every Phase: full
  `bun test` + `bun run typecheck` green. CHANGELOG is touched
  exactly once, in Phase 5.
- **Style preferences.** Active Brain rules at the time of writing:
  no exclamation marks in technical prose
  ([[pref-no-exclamation-marks-in-docs]]), no use of `simply`
  ([[pref-no-simply-word]]). Both extend to test descriptions and
  CHANGELOG copy.

## File map

Create:

```
src/core/brain/snapshot-diff.ts             — pure diffBrainTrees(rootA, rootB)
src/core/brain/snapshot-diff-render.ts      — renderDiffMarkdown, renderDiffJson
src/core/brain/set-primary.ts               — setPrimaryAgent(vault, name|null)
docs/cross-project-pointer.md               — agent-facing pointer doc + snippet + primary-agent guidance
tests/core/brain.wikilink.test.ts           — renderPrefLink unit (extends existing wikilink coverage)
tests/core/brain.snapshot-diff.test.ts      — diffBrainTrees fixture-driven
tests/core/brain.snapshot-diff-render.test.ts — render snapshot tests
tests/core/brain.set-primary.test.ts        — setPrimaryAgent unit
tests/core/brain.dream.non-primary.test.ts  — dream-warning channel
tests/core/brain.confidence-value.test.ts   — Wilson + freshness + hard-floor interaction
tests/cli/brain.snapshot-diff.test.ts       — CLI snapshot diff + rollback --dry-run
tests/cli/brain.set-primary.test.ts         — CLI set-primary
tests/e2e/brain-tier-a-bundle.test.ts       — end-to-end chain through every new surface
```

Modify:

```
src/core/brain/wikilink.ts          — renderPrefLink + MAX_PREF_LINK_TITLE_LEN
src/core/brain/active.ts            — call sites: pref/retired link emission
src/core/brain/digest.ts            — call sites + new "## Confidence drops" section
src/core/brain/dream.ts             — log payload link emission; computeConfidence → {value, band}; refresh tracks previous band; non-primary warning channel
src/core/brain/apply-evidence.ts    — log entry uses renderPrefLink
src/core/brain/preference.ts        — moveToRetired retired-body links; writer emits _confidence_value; parser tolerates both shapes
src/core/brain/backlinks.ts         — output uses renderPrefLink (if it renders)
src/core/brain/snapshot.ts          — extract extractSnapshotToTemp helper; restoreSnapshot rewires to call it
src/core/brain/types.ts             — BrainConfig.primary_agent; BrainConfidenceConfig adds medium_min, high_min; BrainPreference/BrainRetired add confidence_value
src/core/brain/policy.ts            — parser+validator+DEFAULT_BRAIN_CONFIG_YAML for primary_agent + new confidence thresholds
src/core/brain/init.ts              — accept primaryAgent in scaffold
src/cli/brain.ts                    — flag wiring (`--primary-agent` on init), new verbs (`set-primary`, `snapshot diff`), `--dry-run` on rollback, VERB_HELP entries, dispatch
src/cli/main.ts                     — pass-through for `--primary-agent` on `o2b init` if it bootstraps Brain
src/mcp/brain-tools.ts              — brain_query JSON includes confidence_value; brain_dream surfaces warnings array
README.md                           — Cross-project setup subsection, CLI table extension
docs/how-it-works.md                — snapshot diff family, numeric confidence, primary_agent paragraph
install.md                          — Branch A (Hermes): --primary-agent recommendation
CHANGELOG.md                        — single new version section (added/changed/notes)
package.json                        — version bump via `bun run sync-version`
pyproject.toml                      — version bump via sync
```

---

## Phase 1 — §27 Titled wikilinks (foundation)

§27 must land first because every other phase emits new log payloads
or markdown using `renderPrefLink`. Implementing it later forces a
second sweep.

### Task 1: `renderPrefLink` helper

**Files:**
- Modify: `src/core/brain/wikilink.ts`
- Test: `tests/core/brain.wikilink.test.ts`

- [ ] **Step 1: Failing test for the unit table**

Add to `tests/core/brain.wikilink.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  MAX_PREF_LINK_TITLE_LEN,
  renderPrefLink,
} from "../../src/core/brain/wikilink.ts";

test("renderPrefLink renders bare id when principle missing", () => {
  expect(renderPrefLink({ id: "pref-foo" })).toBe("[[pref-foo]]");
});

test("renderPrefLink renders titled link for non-empty principle", () => {
  expect(
    renderPrefLink({ id: "pref-foo", principle: "Prefer the calm option" }),
  ).toBe("[[pref-foo|Prefer the calm option]]");
});

test("renderPrefLink strips wikilink-breaking characters", () => {
  expect(
    renderPrefLink({ id: "pref-foo", principle: "Use [brackets] | here" }),
  ).toBe("[[pref-foo|Use brackets here]]");
});

test("renderPrefLink collapses internal whitespace and trims", () => {
  expect(
    renderPrefLink({ id: "pref-foo", principle: "  a\n\tb   c  " }),
  ).toBe("[[pref-foo|a b c]]");
});

test("renderPrefLink falls back to bare id when sanitised title is empty", () => {
  expect(renderPrefLink({ id: "pref-foo", principle: "[]|" })).toBe(
    "[[pref-foo]]",
  );
});

test("renderPrefLink truncates at word boundary with ellipsis", () => {
  const long =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
  const link = renderPrefLink({ id: "pref-foo", principle: long });
  expect(link.startsWith("[[pref-foo|")).toBe(true);
  expect(link.endsWith("…]]")).toBe(true);
  const titleLen = link.slice("[[pref-foo|".length, -"]]".length).length;
  // ellipsis counts as one char; truncation cap is MAX_PREF_LINK_TITLE_LEN
  expect(titleLen).toBeLessThanOrEqual(MAX_PREF_LINK_TITLE_LEN + 1);
});

test("renderPrefLink hard-cuts when no word boundary fits", () => {
  const oneLongWord = "x".repeat(MAX_PREF_LINK_TITLE_LEN + 20);
  const link = renderPrefLink({ id: "pref-foo", principle: oneLongWord });
  expect(link).toBe(`[[pref-foo|${"x".repeat(MAX_PREF_LINK_TITLE_LEN)}…]]`);
});

test("renderPrefLink works for retired ids", () => {
  expect(
    renderPrefLink({ id: "ret-bar", principle: "Old rule" }),
  ).toBe("[[ret-bar|Old rule]]");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/core/brain.wikilink.test.ts`
Expected: FAIL with `Cannot find name 'renderPrefLink'`.

- [ ] **Step 3: Implement in `wikilink.ts`**

Append after `parseArtifactRef`:

```ts
/** Title length cap before truncation. Chosen for one-line Obsidian display. */
export const MAX_PREF_LINK_TITLE_LEN = 80;

/**
 * Render a wikilink to a Brain preference or retired artifact with a
 * human-readable title sourced from the `principle` field.
 *
 * The title is NFC-normalised, whitespace-collapsed, sanitised of
 * wikilink-breaking characters (`[`, `]`, `|`), and truncated to
 * MAX_PREF_LINK_TITLE_LEN at a word boundary (with an ellipsis suffix).
 * Empty input after sanitisation falls back to the bare `[[id]]` form
 * so the link stays resolvable.
 *
 * Used by every Brain writer that emits a pref/retired reference;
 * signal and external-artifact wikilinks stay bare-id since they have
 * no useful title source.
 */
export function renderPrefLink(input: {
  readonly id: string;
  readonly principle?: string;
}): string {
  const raw = input.principle ?? "";
  let title = raw.normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\[\]\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) return `[[${input.id}]]`;
  if (title.length <= MAX_PREF_LINK_TITLE_LEN) return `[[${input.id}|${title}]]`;
  // Truncate, then back off to the previous word boundary if any exists
  // within the cap window.
  let cut = title.slice(0, MAX_PREF_LINK_TITLE_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `[[${input.id}|${cut}…]]`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/brain.wikilink.test.ts`
Expected: all 8 tests pass.

**Pause for review (no commit).**

---

### Task 2: Sweep `active.ts` call sites

**Files:**
- Modify: `src/core/brain/active.ts`
- Test: `tests/core/brain.active.test.ts`

- [ ] **Step 1: Update tests first**

Find every existing assertion in `tests/core/brain.active.test.ts` that
matches `[[pref-...]]` or `[[ret-...]]` on a preference/retired line
inside the rendered `active.md`. Rewrite the expected substring to the
titled form `[[pref-slug|principle]]`. Keep the bare form for any
signal or external wikilink the test happens to cover.

- [ ] **Step 2: Run to verify expected failures**

Run: `bun test tests/core/brain.active.test.ts`
Expected: FAIL — assertions miss the new shape.

- [ ] **Step 3: Implement**

Locate the loop that builds the Active and Quarantine bullets. Replace
the existing `${id}` interpolation in the wikilink position:

```ts
import { renderPrefLink } from "./wikilink.ts";

// before: `- [[${pref.id}]] ...`
// after:  `- ${renderPrefLink({ id: pref.id, principle: pref.principle })} ...`
```

Apply the same change to the Recently-retired section if it renders
retired-pref links (`{ id: retired.id, principle: retired.principle }`).

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.active.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 3: Sweep `digest.ts` call sites

**Files:**
- Modify: `src/core/brain/digest.ts`
- Test: `tests/core/brain.digest.test.ts`

- [ ] **Step 1: Update digest tests for the titled form**

Same pattern as Task 2. Sections to touch: newly-confirmed prefs,
newly-retired prefs, hot prefs, quarantined prefs, suppressed-signal
listing (retired-pref wikilink). Verify with `grep -n '\[\[pref-' tests/core/brain.digest.test.ts`
and `grep -n '\[\[ret-' tests/core/brain.digest.test.ts` first.

- [ ] **Step 2: Verify failures**

Run: `bun test tests/core/brain.digest.test.ts`
Expected: FAIL on touched sections.

- [ ] **Step 3: Implement**

In each section's renderer, swap `[[${pref.id}]]` for
`renderPrefLink({ id: pref.id, principle: pref.principle })`. Same for
retired references (use the retired's snapshot `principle`).

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.digest.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 4: Sweep `dream.ts` log payloads

**Files:**
- Modify: `src/core/brain/dream.ts`
- Test: `tests/core/brain.dream.test.ts`

- [ ] **Step 1: Update dream tests**

Sections affected (assert on `Brain/log/<date>.md` body): promote /
retire / signal-suppressed events; refresh-with-superseded; pinned
retain. Each event currently writes `preference: [[pref-id]]` or
`retired: [[ret-id]]` in the bullet payload. Update assertions to
expect the titled form sourced from the in-memory pref/retired record
passed into the log writer.

- [ ] **Step 2: Verify failures**

Run: `bun test tests/core/brain.dream.test.ts`
Expected: FAIL on touched assertions.

- [ ] **Step 3: Implement**

`dream.ts` already builds `BrainLogEntry` objects via the `body`
record. Replace the inline `[[${id}]]` strings with the helper:

```ts
preference: renderPrefLink({ id: pref.id, principle: pref.principle }),
```

For retired references in the same payload, use the in-flight retired
record's principle. For `superseded_by` in retire events, source from
the newer preference being recorded.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.dream.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 5: Sweep `apply-evidence.ts` log payload

**Files:**
- Modify: `src/core/brain/apply-evidence.ts`
- Test: `tests/core/brain.apply-evidence.test.ts`

- [ ] **Step 1: Update tests**

`apply-evidence` writes one bullet per call: `preference: [[pref-id]]`.
Update the assertion to expect `[[pref-id|principle]]`.

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.apply-evidence.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`appendApplyEvidence` already reads the target preference via
`parsePreference` to validate it exists. Reuse the parsed object to
render the link:

```ts
preference: renderPrefLink({ id: target.id, principle: target.principle }),
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.apply-evidence.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 6: Sweep `preference.ts moveToRetired` body and superseded_by

**Files:**
- Modify: `src/core/brain/preference.ts`
- Test: `tests/core/brain.preference.test.ts` and any retired-body assertion in `tests/core/brain.body-hygiene.test.ts`

- [ ] **Step 1: Update tests**

Touch every assertion that expects bare `[[pref-...]]` or `[[ret-...]]`
inside the rendered retired body or the `superseded_by` frontmatter
line. The frontmatter writer for retired records the value via
`writeFrontmatterAtomic`; YAML rendering of `[[id|title]]` works
unquoted only if the title is wikilink-safe (no `:` immediately after
`[[`). The sanitiser already removes `[`, `]`, `|`; titles never
contain `:` adjacent to the opening bracket. Safe to emit unquoted.

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.preference.test.ts tests/core/brain.body-hygiene.test.ts`
Expected: FAIL on touched assertions.

- [ ] **Step 3: Implement**

In `moveToRetired`:
- Where `superseded_by` is set in the inherited frontmatter, replace
  bare `[[${supersededByPref.id}]]` with the titled form (when a
  superseding pref is provided).
- In `renderRetiredBody`, the Origin / Recent applications /
  Recent violations sections currently reference signals (bare-id is
  correct) and the artifact (external, bare-id is correct). The
  `## Retired` section may carry a `superseded_by` pointer — render
  it via `renderPrefLink` for consistency with the frontmatter.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.preference.test.ts tests/core/brain.body-hygiene.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 7: Sweep `backlinks.ts` + CLI human output

**Files:**
- Modify: `src/core/brain/backlinks.ts`, `src/cli/brain.ts`
- Test: `tests/core/brain.backlinks.test.ts`, `tests/cli/brain.test.ts` (existing)

- [ ] **Step 1: Update tests**

In `backlinks.test.ts`, every assertion of the form `[[pref-...]]` or
`[[ret-...]]` that came from the backlinks output (not from frontmatter
parse round-trip) gains the titled form. In `tests/cli/brain.test.ts`,
the `cmdBrainBacklinks` and `cmdBrainQuery` human-output assertions get
the same treatment.

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.backlinks.test.ts tests/cli/brain.test.ts`
Expected: FAIL on touched cases.

- [ ] **Step 3: Implement**

In `buildBacklinkIndex` (or its renderer wrapper): for every result row
that points at a pref/retired, switch to `renderPrefLink`.

In `src/cli/brain.ts`:
- `cmdBrainBacklinks` — when human (not `--json`) output prints a
  preference target line, emit titled link.
- `cmdBrainQuery` — same treatment when the query result row carries a
  pref/retired record.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.backlinks.test.ts tests/cli/brain.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 8: Phase 1 close

- [ ] **Step 1: Full Brain suite**

Run: `bun test tests/core/brain.*.test.ts`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: zero errors.

**Pause for review (no commit).**

---

## Phase 2 — §21 Cross-project pointer + primary agent

### Task 9: Extend `BrainConfig` type

**Files:**
- Modify: `src/core/brain/types.ts`
- Test: covered by Task 10 policy tests

- [ ] **Step 1: Add field**

In the `BrainConfig` interface (currently in `types.ts`):

```ts
export interface BrainConfig {
  readonly schema_version: number;
  readonly primary_agent: string | null;   // NEW
  readonly dream: BrainDreamConfig;
  readonly retire: BrainRetireConfig;
  readonly confidence: BrainConfidenceConfig;
  readonly snapshots: BrainSnapshotsConfig;
}
```

- [ ] **Step 2: Verify type errors surface**

Run: `bun run typecheck`
Expected: errors only in `policy.ts` (the validator still doesn't
populate the field). Resolved in Task 10.

**Pause for review (no commit).**

---

### Task 10: `policy.ts` parser + validator + default YAML

**Files:**
- Modify: `src/core/brain/policy.ts`
- Test: `tests/core/brain.policy.test.ts` (existing file in
  `tests/core/` if present; otherwise create alongside)

- [ ] **Step 1: Failing tests**

```ts
test("loadBrainConfig defaults primary_agent to null", () => {
  const cfg = validateBrainConfig({ schema_version: 1 });
  expect(cfg.primary_agent).toBeNull();
});

test("loadBrainConfig parses quoted primary_agent string", () => {
  const cfg = validateBrainConfig({ schema_version: 1, primary_agent: "hermes-vps" });
  expect(cfg.primary_agent).toBe("hermes-vps");
});

test("loadBrainConfig rejects empty string primary_agent", () => {
  expect(() =>
    validateBrainConfig({ schema_version: 1, primary_agent: "" }),
  ).toThrow(/primary_agent/);
});

test("loadBrainConfig rejects non-string non-null primary_agent", () => {
  expect(() =>
    validateBrainConfig({ schema_version: 1, primary_agent: 42 }),
  ).toThrow(/primary_agent/);
});
```

- [ ] **Step 2: Run to fail**

Run: `bun test tests/core/brain.policy.test.ts`
Expected: FAIL — primary_agent unknown to validator.

- [ ] **Step 3: Implement**

Update `DEFAULT_BRAIN_CONFIG`:

```ts
export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  schema_version: 1,
  primary_agent: null,
  dream: Object.freeze({ /* ... */ }),
  // ...
}) as BrainConfig;
```

Update `DEFAULT_BRAIN_CONFIG_YAML`:

```yaml
schema_version: 1

# Optional. When set, dream runs from a different agent emit a
# warning. The vault should have a single dream-running runtime even
# when it is shared across devices via Syncthing.
primary_agent: null

dream:
  candidate_threshold: 3
  # ...
```

In `validateBrainConfigDetailed`, after parsing `schema_version` and
before the dream block:

```ts
let primaryAgent: string | null = null;
if ("primary_agent" in obj) {
  const v = obj["primary_agent"];
  if (v === null) {
    primaryAgent = null;
  } else if (typeof v === "string" && v.trim().length > 0) {
    primaryAgent = v.trim();
  } else {
    throw new BrainConfigError(
      `must be either null or a non-empty string; got ${describe(v)}`,
      "primary_agent",
      source,
    );
  }
}
```

Then add `primaryAgent` to the assembled `config` object and to the
known-keys set used by the unknown-key warning loop.

Update `parseBrainYaml`'s scalar handler if needed so that
`primary_agent: hermes-vps-agent` (unquoted) parses as the literal
string `hermes-vps-agent` (current behaviour — verify with one
explicit test). Hyphens are already supported.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.policy.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 11: `init.ts` accepts `primaryAgent`

**Files:**
- Modify: `src/core/brain/init.ts`
- Test: `tests/core/brain.init.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("bootstrapBrain writes primary_agent into _brain.yaml when provided", () => {
  const result = bootstrapBrain(tmpVault, { primaryAgent: "hermes-vps" });
  const yaml = readFileSync(brainConfigPath(tmpVault), "utf8");
  expect(yaml).toMatch(/^primary_agent: hermes-vps$/m);
});

test("bootstrapBrain leaves primary_agent: null on fresh init by default", () => {
  bootstrapBrain(tmpVault, {});
  const yaml = readFileSync(brainConfigPath(tmpVault), "utf8");
  expect(yaml).toMatch(/^primary_agent: null$/m);
});

test("bootstrapBrain re-run preserves primary_agent already set", () => {
  bootstrapBrain(tmpVault, { primaryAgent: "hermes-vps" });
  bootstrapBrain(tmpVault, {});
  const yaml = readFileSync(brainConfigPath(tmpVault), "utf8");
  expect(yaml).toMatch(/^primary_agent: hermes-vps$/m);
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/core/brain.init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Widen `bootstrapBrain`'s options:

```ts
export interface BootstrapBrainOptions {
  readonly primaryAgent?: string;
  // ...existing options
}
```

On a fresh init, render the template with the supplied value (default
`null`). On re-run when `_brain.yaml` already exists, read it, replace
the `primary_agent:` line only when a new value is explicitly passed,
otherwise leave intact. The line-replace uses the same idempotent
single-line edit pattern as `setPrimaryAgent` (Task 12).

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.init.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 12: `setPrimaryAgent` module

**Files:**
- Create: `src/core/brain/set-primary.ts`
- Test: `tests/core/brain.set-primary.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { setPrimaryAgent } from "../../src/core/brain/set-primary.ts";

let vault: string;
beforeEach(() => {
  vault = createTempVault();
  bootstrapBrain(vault, {});
});

test("setPrimaryAgent writes a non-null value", () => {
  const r = setPrimaryAgent(vault, "hermes-vps");
  expect(r.previous).toBeNull();
  expect(r.next).toBe("hermes-vps");
  expect(r.changed).toBe(true);
});

test("setPrimaryAgent is idempotent on repeat", () => {
  setPrimaryAgent(vault, "hermes-vps");
  const r = setPrimaryAgent(vault, "hermes-vps");
  expect(r.previous).toBe("hermes-vps");
  expect(r.next).toBe("hermes-vps");
  expect(r.changed).toBe(false);
});

test("setPrimaryAgent --clear writes null", () => {
  setPrimaryAgent(vault, "hermes-vps");
  const r = setPrimaryAgent(vault, null);
  expect(r.next).toBeNull();
});

test("setPrimaryAgent throws on missing _brain.yaml", () => {
  rmSync(brainConfigPath(vault));
  expect(() => setPrimaryAgent(vault, "x")).toThrow(/config file/);
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/core/brain.set-primary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { existsSync, readFileSync } from "node:fs";
import { brainConfigPath } from "./paths.ts";
import { BrainConfigError, parseBrainYaml, validateBrainConfig } from "./policy.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";

export interface SetPrimaryResult {
  readonly previous: string | null;
  readonly next: string | null;
  readonly changed: boolean;
}

const LINE_RE = /^primary_agent:.*$/m;

export function setPrimaryAgent(
  vault: string,
  name: string | null,
): SetPrimaryResult {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainConfigError(
      "config file does not exist; run `o2b brain init` first",
      null,
      path,
    );
  }
  const text = readFileSync(path, "utf8");
  const parsed = parseBrainYaml(text);
  validateBrainConfig({ ...parsed, primary_agent: name ?? null }, path); // strict re-validate
  const cfg = validateBrainConfig(parsed, path);
  const previous = cfg.primary_agent;
  const nextValue = name ?? null;
  if (previous === nextValue) {
    return Object.freeze({ previous, next: nextValue, changed: false });
  }
  const line = nextValue === null
    ? "primary_agent: null"
    : `primary_agent: ${nextValue}`;
  let updated: string;
  if (LINE_RE.test(text)) {
    updated = text.replace(LINE_RE, line);
  } else {
    // Insert after schema_version line, or prepend if absent.
    const sv = /^schema_version:.*$/m;
    updated = sv.test(text)
      ? text.replace(sv, (m) => `${m}\n\n${line}`)
      : `${line}\n\n${text}`;
  }
  atomicWriteFileSync(path, updated);
  return Object.freeze({ previous, next: nextValue, changed: true });
}
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.set-primary.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 13: CLI `cmdBrainSetPrimary` + `--primary-agent` on init

**Files:**
- Modify: `src/cli/brain.ts`
- Test: `tests/cli/brain.set-primary.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("o2b brain set-primary writes the agent name", async () => {
  const exit = await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault]);
  expect(exit).toBe(0);
  expect(readBrainYaml(vault)).toMatch(/^primary_agent: hermes-vps$/m);
});

test("o2b brain set-primary --clear writes null", async () => {
  await runCli(["brain", "set-primary", "hermes-vps", "--vault", vault]);
  const exit = await runCli(["brain", "set-primary", "--clear", "--vault", vault]);
  expect(exit).toBe(0);
  expect(readBrainYaml(vault)).toMatch(/^primary_agent: null$/m);
});

test("o2b brain set-primary requires <name> or --clear", async () => {
  const exit = await runCli(["brain", "set-primary", "--vault", vault]);
  expect(exit).toBe(1);
});

test("o2b brain init --primary-agent threads value", async () => {
  const exit = await runCli(["brain", "init", "--vault", vault, "--primary-agent", "hermes-vps"]);
  expect(exit).toBe(0);
  expect(readBrainYaml(vault)).toMatch(/^primary_agent: hermes-vps$/m);
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/cli/brain.set-primary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/cli/brain.ts`, add a new dispatcher case:

```ts
case "set-primary":
  return cmdBrainSetPrimary(rest);
```

```ts
async function cmdBrainSetPrimary(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    clear: { type: "boolean" },
    json:  { type: "boolean" },
  });
  const cfg = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, cfg);
  let name: string | null;
  if (flags["clear"]) {
    if (positional.length > 0) {
      return fail("brain set-primary --clear takes no positional arg");
    }
    name = null;
  } else {
    if (positional.length < 1) {
      return fail("brain set-primary requires <name> or --clear");
    }
    name = positional[0]!.trim();
    if (name.length === 0) {
      return fail("brain set-primary <name> must be non-empty");
    }
  }
  let r;
  try {
    r = setPrimaryAgent(vault, name);
  } catch (exc) {
    return fail(`set-primary failed: ${(exc as Error).message ?? exc}`);
  }
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  if (!r.changed) {
    ok(`primary_agent already set to ${r.next ?? "null"}`);
  } else {
    ok(`primary_agent: ${r.previous ?? "null"} → ${r.next ?? "null"}`);
  }
  return 0;
}
```

Extend `cmdBrainInit` to accept `--primary-agent <name>` and thread it
into `bootstrapBrain({ primaryAgent: flags["primary-agent"] as string | undefined })`.

Add VERB_HELP entry:

```ts
"set-primary":
  "usage: o2b brain set-primary <name> [--vault <path>] [--json]\n" +
  "       o2b brain set-primary --clear [--vault <path>] [--json]\n" +
  "Set or clear the vault's primary dream-running agent.\n",
```

- [ ] **Step 4: Verify**

Run: `bun test tests/cli/brain.set-primary.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 14: Non-primary dream warning

**Files:**
- Modify: `src/core/brain/dream.ts`
- Test: `tests/core/brain.dream.non-primary.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("dream emits a non-primary warning when agent differs", async () => {
  bootstrapBrain(vault, {});
  setPrimaryAgent(vault, "hermes-vps");
  const r = await dream(vault, { agentName: "claude-vps-agent", now });
  expect(r.warnings.map(w => w.code)).toContain("non-primary-dream-run");
  expect(r.warnings.find(w => w.code === "non-primary-dream-run")!.message).toMatch(/claude-vps-agent.*hermes-vps/);
});

test("dream does not warn when primary_agent matches", async () => {
  bootstrapBrain(vault, {});
  setPrimaryAgent(vault, "hermes-vps");
  const r = await dream(vault, { agentName: "hermes-vps", now });
  expect(r.warnings.map(w => w.code)).not.toContain("non-primary-dream-run");
});

test("dream does not warn when primary_agent is null (default)", async () => {
  bootstrapBrain(vault, {});
  const r = await dream(vault, { agentName: "anyone", now });
  expect(r.warnings.map(w => w.code)).not.toContain("non-primary-dream-run");
});

test("dream log event carries non_primary_agent payload when warning fires", async () => {
  bootstrapBrain(vault, {});
  setPrimaryAgent(vault, "hermes-vps");
  await dream(vault, { agentName: "claude-vps-agent", now });
  const logText = readTodayLog(vault);
  expect(logText).toMatch(/^- non_primary_agent: claude-vps-agent$/m);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.dream.non-primary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`DreamResult` already exposes a `warnings: ReadonlyArray<…>` slot
(used by snapshot-tooling missing-binary warnings). Add a new code
constant if needed; otherwise use a free-form `{ code, message }`
pair consistent with existing warning shape.

After `loadBrainConfig` and before any state mutation:

```ts
if (cfg.primary_agent !== null && cfg.primary_agent !== agentName) {
  warnings.push({
    code: "non-primary-dream-run",
    message:
      `dream run from agent '${agentName}', but primary is ` +
      `'${cfg.primary_agent}'. Convention violation, run proceeds.`,
  });
}
```

When composing the `dream` summary log body, conditionally add the
`non_primary_agent` key:

```ts
const body: Record<string, string> = {
  run_id: runId,
  /* existing keys */,
};
if (cfg.primary_agent !== null && cfg.primary_agent !== agentName) {
  body["non_primary_agent"] = agentName;
}
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.dream.non-primary.test.ts tests/core/brain.dream.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 15: CLI surfaces the warning

**Files:**
- Modify: `src/cli/brain.ts` (cmdBrainDream)
- Test: `tests/cli/brain.test.ts` (existing dream coverage)

- [ ] **Step 1: Failing test**

```ts
test("o2b brain dream prints non-primary warning to stderr", async () => {
  bootstrapBrain(vault, {});
  setPrimaryAgent(vault, "hermes-vps");
  const { exit, stderr } = await runCli(
    ["brain", "dream", "--vault", vault, "--agent", "claude-vps-agent"],
    { captureStderr: true },
  );
  expect(exit).toBe(0);
  expect(stderr).toMatch(/non-primary-dream-run/);
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/cli/brain.test.ts -t "non-primary"`
Expected: FAIL.

- [ ] **Step 3: Implement**

After `dream(...)` returns, iterate `result.warnings` and write each
to stderr in the existing warning format used by `cmdBrainRollback`'s
log-failure warning. Do not change the exit code.

- [ ] **Step 4: Verify**

Run: `bun test tests/cli/brain.test.ts -t "non-primary"`
Expected: green.

**Pause for review (no commit).**

---

### Task 16: MCP `brain_dream` exposes warnings

**Files:**
- Modify: `src/mcp/brain-tools.ts`
- Test: `tests/mcp/brain-tools.test.ts` (existing)

- [ ] **Step 1: Failing test**

```ts
test("brain_dream JSON response includes warnings array", async () => {
  bootstrapBrain(vault, {});
  setPrimaryAgent(vault, "hermes-vps");
  const r = await callMcpTool("brain_dream", { vault, agent: "claude-vps-agent" });
  expect(r.warnings).toContainEqual(
    expect.objectContaining({ code: "non-primary-dream-run" }),
  );
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/mcp/brain-tools.test.ts -t "warnings"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the `brain_dream` tool handler, return
`{ warnings: result.warnings, ...existing }` instead of dropping the
warnings on the floor.

- [ ] **Step 4: Verify**

Run: `bun test tests/mcp/brain-tools.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 17: `docs/cross-project-pointer.md`

**Files:**
- Create: `docs/cross-project-pointer.md`

- [ ] **Step 1: Write the doc**

Three sections:

```markdown
# Cross-project setup

This page tells coding-runtimes (Claude Code, Codex, Cursor, Aider, …)
how to find an Open Second Brain vault when they are launched from a
project directory that is not the vault itself.

## 1. Add the pointer snippet to your project

Append the block below to one of the agent-prompt files your runtime
reads on startup. Common targets:

- `CLAUDE.md` — Claude Code.
- `AGENTS.md` — Codex, Cursor, Aider, and other tools that follow the
  agents.md convention.

Pick **one** location per project. The managed-block fences let a
future `o2b brain bootstrap` command rewrite the snippet idempotently;
manual edits inside the fences are preserved on subsequent runs.

> NOTE: replace `<absolute-vault-path>` with the absolute path of
> your Obsidian-compatible vault.

```text
# >>> open-second-brain managed >>>
## Open Second Brain

This project shares an Obsidian-compatible vault with an active
observing-memory layer. At session start, read the current
preferences:

    <absolute-vault-path>/Brain/active.md

Record taste signals via `brain_feedback` (MCP) or
`o2b brain feedback` (CLI). After producing a durable artifact, call
`brain_apply_evidence` with `result: applied | violated | outdated`
for any preference whose `scope` matches.

Do not run `o2b brain dream` from this runtime. The vault has a
primary dream-running agent; see `<vault>/Brain/_brain.yaml`
(key `primary_agent`).
# <<< open-second-brain managed <<<
```

## 2. Primary agent and dream cron

A shared vault has one runtime responsible for running the
deterministic `dream` consolidation pass. Declare that runtime in
`Brain/_brain.yaml`:

    o2b brain set-primary <agent-name> --vault <vault-path>

The agent name is the value of `agent_name` in
`~/.config/open-second-brain/config.yaml` on the host that runs the
dream cron. When dream runs from a different agent, you get a stderr
warning and a `non_primary_agent` payload row in the dream log
entry; the run still proceeds (no hard block — the data is safe).

Pin / unpin / reject / pin-toggle are unrestricted: any agent on any
device can mutate the protected set.

To clear the primary declaration (vault is single-host again):

    o2b brain set-primary --clear --vault <vault-path>

## 3. Multi-device through Syncthing

The vault is designed to be Syncthing-shared. Signals can be captured
on any device — `brain_feedback` from a coding session on the laptop,
`@osb` markers added by hand on the phone — and they all land in
`Brain/inbox/` on every peer. The primary host's dream cron picks
them up next pass, regardless of which peer wrote them.
```

- [ ] **Step 2: Verify the doc renders cleanly**

Run: `grep -n '<vault-path>' docs/cross-project-pointer.md | head`
Expected: every placeholder is intentional and bracketed.

**Pause for review (no commit).**

---

### Task 18: README cross-project section + CLI table

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the CLI line**

In the Brain CLI table (current block lists 14 verbs), add a row for
`set-primary` between `unpin` and `rollback`:

```text
o2b brain set-primary           Declare or clear primary_agent in _brain.yaml
```

- [ ] **Step 2: Add cross-project subsection**

After the "Brain (observing memory)" section, insert:

```markdown
### Cross-project setup

When your coding work happens in a project directory that is not the
vault itself, add a pointer snippet to your project's `CLAUDE.md` /
`AGENTS.md` so the agent knows where to read preferences from. The
canonical snippet, the rules for multi-device Syncthing setups, and
the `o2b brain set-primary` invocation are in
[`docs/cross-project-pointer.md`](docs/cross-project-pointer.md).
```

- [ ] **Step 3: Verify**

Run: `grep -n 'set-primary' README.md`
Expected: one CLI-table line, one section link.

**Pause for review (no commit).**

---

### Task 19: install.md branch A recommends `--primary-agent`

**Files:**
- Modify: `install.md`

- [ ] **Step 1: Add the recommendation**

In Branch A — Hermes, step 4 (`o2b init` invocation), append a note:

```markdown
**Set this Hermes install as the vault's primary dream-running agent.**
If this is the runtime that will run `hermes cron` for `o2b brain
dream`, pass `--primary-agent <agent-name>` (use the same value as
`--agent-name`). Doing so writes `primary_agent` into
`Brain/_brain.yaml` and any subsequent dream run from a different
runtime emits a warning. You can change or clear the primary later
with `o2b brain set-primary <name>` / `o2b brain set-primary --clear`.
```

- [ ] **Step 2: Verify**

Run: `grep -n '--primary-agent' install.md`
Expected: one or two occurrences in Branch A.

**Pause for review (no commit).**

---

### Task 20: Phase 2 close

- [ ] **Step 1: Full Brain suite + CLI**

Run: `bun test tests/core/brain.*.test.ts tests/cli/brain.*.test.ts tests/mcp/brain-tools.test.ts`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: zero errors.

**Pause for review (no commit).**

---

## Phase 3 — §10 Numeric confidence

### Task 21: Extend `BrainConfidenceConfig` + frontmatter types

**Files:**
- Modify: `src/core/brain/types.ts`

- [ ] **Step 1: Add fields**

```ts
export interface BrainConfidenceConfig {
  readonly low_max_applied: number;
  readonly high_min_applied: number;
  readonly high_freshness_factor: number;
  readonly medium_min: number;     // NEW
  readonly high_min: number;       // NEW
}

export interface BrainPreference {
  // existing fields...
  readonly confidence: BrainConfidence;
  readonly confidence_value: number | null;  // NEW
  // existing fields...
}

export interface BrainRetired {
  // existing fields...
  readonly confidence: BrainConfidence;
  readonly confidence_value: number | null;  // NEW
  // existing fields...
}
```

- [ ] **Step 2: Verify type errors surface**

Run: `bun run typecheck`
Expected: errors at policy / preference / digest / dream / mcp sites
that build these objects. Resolved in following tasks.

**Pause for review (no commit).**

---

### Task 22: `policy.ts` accepts new thresholds

**Files:**
- Modify: `src/core/brain/policy.ts`
- Test: `tests/core/brain.policy.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("validateBrainConfig defaults medium_min and high_min", () => {
  const cfg = validateBrainConfig({ schema_version: 1 });
  expect(cfg.confidence.medium_min).toBeCloseTo(0.40);
  expect(cfg.confidence.high_min).toBeCloseTo(0.75);
});

test("validateBrainConfig rejects medium_min outside [0, 1]", () => {
  expect(() =>
    validateBrainConfig({
      schema_version: 1,
      confidence: { medium_min: -0.1 },
    }),
  ).toThrow(/medium_min/);
});

test("validateBrainConfig rejects medium_min >= high_min", () => {
  expect(() =>
    validateBrainConfig({
      schema_version: 1,
      confidence: { medium_min: 0.8, high_min: 0.6 },
    }),
  ).toThrow(/medium_min.*high_min/);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.policy.test.ts -t "medium_min"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `DEFAULT_BRAIN_CONFIG.confidence`:

```ts
confidence: Object.freeze({
  low_max_applied: 2,
  high_min_applied: 10,
  high_freshness_factor: 0.8,
  medium_min: 0.40,
  high_min:   0.75,
}),
```

Extend `DEFAULT_BRAIN_CONFIG_YAML`:

```yaml
confidence:
  low_max_applied: 2
  high_min_applied: 10
  high_freshness_factor: 0.8
  medium_min: 0.40
  high_min:   0.75
```

In `validateBrainConfigDetailed`, after existing confidence-block
checks:

```ts
function requireUnitInterval(field: string, v: unknown, source: string | null): void {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < 0 || v > 1
  ) {
    throw new BrainConfigError(
      `must be a number in [0, 1]; got ${describe(v)}`,
      field, source,
    );
  }
}

requireUnitInterval("confidence.medium_min", confidence.medium_min, source);
requireUnitInterval("confidence.high_min",   confidence.high_min,   source);
if ((confidence.medium_min as number) >= (confidence.high_min as number)) {
  throw new BrainConfigError(
    `medium_min must be strictly less than high_min; got ` +
      `medium_min=${confidence.medium_min}, high_min=${confidence.high_min}`,
    "confidence.medium_min",
    source,
  );
}
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.policy.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 23: `preference.ts` writer + parser

**Files:**
- Modify: `src/core/brain/preference.ts`
- Test: `tests/core/brain.preference.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("writePreference emits _confidence_value", () => {
  writePreference(vault, { /* minimal valid input */, confidence_value: 0.5413 });
  const raw = readFileSync(path, "utf8");
  expect(raw).toMatch(/^_confidence_value: 0\.5413$/m);
});

test("parsePreference reads _confidence_value as a number", () => {
  const p = writePref({ _confidence_value: 0.74 });
  expect(parsePreference(p).confidence_value).toBeCloseTo(0.74);
});

test("parsePreference falls back to null when _confidence_value absent (legacy file)", () => {
  const p = writeLegacyPref();  // no _confidence_value line
  expect(parsePreference(p).confidence_value).toBeNull();
});

test("moveToRetired propagates confidence_value into retired frontmatter", () => {
  const ret = moveToRetired(vault, "pref-foo", { now, retired_by: "[[dream-x]]", confidence_value: 0.61 });
  const raw = readFileSync(ret.path, "utf8");
  expect(raw).toMatch(/^_confidence_value: 0\.61$/m);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.preference.test.ts -t "_confidence_value"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `WritePreferenceInput`:

```ts
readonly confidence_value?: number;
```

In `preferenceFrontmatter` add:

```ts
const confidenceValue = input.confidence_value;
// inside metadata:
_confidence_value: confidenceValue === undefined ? "null" : Number(confidenceValue.toFixed(4)),
```

Round to 4 decimals at write time so YAML stays stable across no-op
refreshes.

In `parsePreference`, read `_confidence_value` through the existing
derived-field path; coerce the parsed value to `number | null`. Same
in `parseRetired`. Propagate through `moveToRetired` (it currently
inherits the originating pref's `_confidence_value` already once the
field flows through the inherited frontmatter — verify and add to
the test list above if not).

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.preference.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 24: `dream.ts` `computeConfidence` returns `{ value, band }`

**Files:**
- Modify: `src/core/brain/dream.ts`
- Test: `tests/core/brain.confidence-value.test.ts`

- [ ] **Step 1: Failing test for the formula**

```ts
import { test, expect } from "bun:test";
import {
  computeConfidence,
  type ConfidenceComputeResult,
} from "../../src/core/brain/dream.ts";

const cfg = /* DEFAULT_BRAIN_CONFIG */;
const now = new Date("2026-05-17T00:00:00Z");

test("computeConfidence value=0 when no evidence", () => {
  const r = computeConfidence(0, 0, null, cfg, now);
  expect(r.value).toBe(0);
  expect(r.band).toBe("low");
});

test("computeConfidence Wilson lower bound for 8 applied 0 violated, fresh", () => {
  const last = "2026-05-15T00:00:00Z"; // 2 days old
  const r = computeConfidence(8, 0, last, cfg, now);
  // Wilson 95% lower bound for 8/8 ≈ 0.6764; freshness ≈ 1 - 2/90 = 0.9778
  // value ≈ 0.6764 * 0.9778 ≈ 0.6614
  expect(r.value).toBeGreaterThan(0.60);
  expect(r.value).toBeLessThan(0.70);
});

test("computeConfidence violated >= applied → band low (hard floor)", () => {
  const r = computeConfidence(5, 5, "2026-05-15T00:00:00Z", cfg, now);
  expect(r.band).toBe("low");
});

test("computeConfidence applied <= low_max_applied → band low (hard floor)", () => {
  const r = computeConfidence(2, 0, "2026-05-15T00:00:00Z", cfg, now);
  expect(r.band).toBe("low");
});

test("computeConfidence high band requires high_min_applied + no violated + fresh + numeric high", () => {
  const last = "2026-05-15T00:00:00Z";
  // n=20, applied=20, violated=0; Wilson lower bound 0.832 * freshness ≈ 0.813
  const r = computeConfidence(20, 0, last, cfg, now);
  expect(r.band).toBe("high");
  expect(r.value).toBeGreaterThan(0.78);
});

test("computeConfidence stale evidence → freshness 0 → value 0", () => {
  const last = "2025-01-01T00:00:00Z";  // > stale_evidence_days old
  const r = computeConfidence(20, 0, last, cfg, now);
  expect(r.value).toBe(0);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.confidence-value.test.ts`
Expected: FAIL on the value-based assertions (existing
`computeConfidence` only returns a band).

- [ ] **Step 3: Implement**

Replace the body of `computeConfidence` in `dream.ts`:

```ts
export interface ConfidenceComputeResult {
  readonly value: number;
  readonly band: BrainConfidence;
}

export function computeConfidence(
  applied: number,
  violated: number,
  lastEvidenceAt: string | null,
  cfg: BrainConfig,
  now: Date,
): ConfidenceComputeResult {
  const n = applied + violated;
  let wilsonLow = 0;
  if (n > 0) {
    const z = 1.96;
    const z2 = z * z;
    const pHat = applied / n;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin = z * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n)) / denom;
    wilsonLow = Math.max(0, centre - margin);
  }
  let freshness = 0;
  if (lastEvidenceAt) {
    const ageMs = now.getTime() - Date.parse(lastEvidenceAt);
    if (Number.isFinite(ageMs)) {
      const limitMs = cfg.retire.stale_evidence_days * 24 * 3600 * 1000;
      freshness = Math.max(0, Math.min(1, 1 - ageMs / limitMs));
    }
  }
  const value = Math.round(wilsonLow * freshness * 10_000) / 10_000;

  // Derive band: hard floors first, then numeric thresholds.
  let band: BrainConfidence = BRAIN_CONFIDENCE.medium;
  if (applied <= cfg.confidence.low_max_applied) band = BRAIN_CONFIDENCE.low;
  else if (applied > 0 && violated >= applied) band = BRAIN_CONFIDENCE.low;
  else {
    const fresh = freshness >= (1 - cfg.confidence.high_freshness_factor);
    const allowHigh =
      applied >= cfg.confidence.high_min_applied
      && violated === 0
      && fresh;
    if (value >= cfg.confidence.high_min && allowHigh) {
      band = BRAIN_CONFIDENCE.high;
    } else if (value >= cfg.confidence.medium_min) {
      band = BRAIN_CONFIDENCE.medium;
    } else {
      band = BRAIN_CONFIDENCE.low;
    }
  }
  return Object.freeze({ value, band });
}
```

Update the refresh loop call site to consume `{ value, band }`:

```ts
const conf = computeConfidence(applied, violated, lastEvidence, cfg, now);
const prospective: WritePreferenceInput = {
  // ...
  confidence: conf.band,
  confidence_value: conf.value,
};
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.confidence-value.test.ts tests/core/brain.dream.test.ts`
Expected: green. Existing dream tests may need band-expectation
updates if their fixture's evidence count crosses one of the new
numeric thresholds — adjust as the suite tells you.

**Pause for review (no commit).**

---

### Task 25: Refresh-time band-drop tracking

**Files:**
- Modify: `src/core/brain/dream.ts`
- Test: `tests/core/brain.dream.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("dream RefreshResult records previous_band → next_band on band change", async () => {
  // Build fixture where a confirmed pref currently has confidence high
  // and the refresh recomputes to medium.
  const r = await dream(vault, { /* fixture */ now });
  expect(r.refresh.bandDrops).toContainEqual(
    expect.objectContaining({ slug: "pref-foo", previous: "high", next: "medium" }),
  );
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.dream.test.ts -t "bandDrops"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `RefreshResult`:

```ts
readonly bandDrops: ReadonlyArray<{
  readonly slug: string;
  readonly principle: string;
  readonly previous: BrainConfidence;
  readonly next: BrainConfidence;
  readonly applied: number;
  readonly violated: number;
}>;
```

In the refresh loop, after computing `prospective`:

```ts
const oldBand = rec.pref.confidence;
const newBand = prospective.confidence;
const rank = { low: 0, medium: 1, high: 2 } as const;
if (rank[newBand] < rank[oldBand]) {
  drops.push({
    slug, principle: rec.pref.principle,
    previous: oldBand, next: newBand,
    applied, violated,
  });
}
```

Pass `bandDrops` up to `DreamResult` so digest can read it.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.dream.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 26: Digest `## Confidence drops` section

**Files:**
- Modify: `src/core/brain/digest.ts`
- Test: `tests/core/brain.digest.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("digest emits Confidence drops section when refresh.bandDrops non-empty", async () => {
  const md = renderDigest(/* fixture with one drop */);
  expect(md).toMatch(/^## Confidence drops$/m);
  expect(md).toMatch(/\[\[pref-foo\|.*\]\]: high → medium \(applied=11, violated=2\)/);
});

test("digest omits the section when bandDrops is empty", async () => {
  const md = renderDigest(/* fixture with no drops */);
  expect(md).not.toMatch(/^## Confidence drops$/m);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.digest.test.ts -t "Confidence drops"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `renderDigest`, after the existing sections (newly-confirmed,
retired, quarantined, hot, …):

```ts
if (drops.length > 0) {
  out.push("## Confidence drops", "");
  for (const d of drops) {
    out.push(
      `- ${renderPrefLink({ id: \`pref-\${d.slug}\`, principle: d.principle })}: ` +
      `${d.previous} → ${d.next} ` +
      `(applied=${d.applied}, violated=${d.violated})`,
    );
  }
  out.push("");
}
```

The digest already accepts a `RefreshResult` (or its summary) in its
input pipeline; thread `bandDrops` through that channel.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.digest.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 27: `active.ts` numeric tail

**Files:**
- Modify: `src/core/brain/active.ts`
- Test: `tests/core/brain.active.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("active.md renders numeric confidence tail when available", async () => {
  const md = renderActive([
    { id: "pref-foo", principle: "Use spaces", status: "confirmed",
      confidence: "medium", confidence_value: 0.62, pinned: false, scope: "code" },
  ]);
  expect(md).toMatch(/\[\[pref-foo\|Use spaces\]\].*\(conf: 0\.62\)/);
});

test("active.md omits tail when confidence_value is null (legacy)", async () => {
  const md = renderActive([
    { id: "pref-bar", principle: "Old rule", status: "confirmed",
      confidence: "medium", confidence_value: null, pinned: false, scope: "code" },
  ]);
  expect(md).not.toMatch(/\(conf:/);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.active.test.ts -t "numeric"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `renderActive`, where each Active / Quarantine bullet is composed:

```ts
const tail = pref.confidence_value !== null
  ? ` (conf: ${pref.confidence_value.toFixed(2)})`
  : "";
out.push(
  `- ${renderPrefLink({ id: pref.id, principle: pref.principle })} ` +
  `${meta}${tail}`,
);
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.active.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 28: MCP `brain_query` JSON includes `confidence_value`

**Files:**
- Modify: `src/mcp/brain-tools.ts`
- Test: `tests/mcp/brain-tools.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("brain_query result row carries confidence_value", async () => {
  // Fixture: one pref with _confidence_value 0.74
  const r = await callMcpTool("brain_query", { preference: "pref-foo" });
  expect(r.row.confidence).toBe("medium");
  expect(r.row.confidence_value).toBeCloseTo(0.74);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/mcp/brain-tools.test.ts -t "confidence_value"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Locate the `brain_query` result serialiser. Add
`confidence_value: row.confidence_value` to the emitted object —
typically a one-line addition in the `toJSON` / `toResultRow` mapper.

- [ ] **Step 4: Verify**

Run: `bun test tests/mcp/brain-tools.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 29: Phase 3 close

- [ ] **Step 1: Full Brain + CLI + MCP suite**

Run: `bun test tests/core/brain.*.test.ts tests/cli/brain.*.test.ts tests/mcp/brain-tools.test.ts`
Expected: green.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: zero errors.

**Pause for review (no commit).**

---

## Phase 4 — §5 Snapshot diff + rollback dry-run

### Task 30: Extract `extractSnapshotToTemp`

**Files:**
- Modify: `src/core/brain/snapshot.ts`
- Test: `tests/core/brain.snapshot.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { extractSnapshotToTemp } from "../../src/core/brain/snapshot.ts";

test("extractSnapshotToTemp materialises a Brain/ tree in a sibling tmp dir", () => {
  createSnapshot(vault, "run-x");
  const r = extractSnapshotToTemp(vault, "run-x");
  try {
    expect(existsSync(r.brainRoot)).toBe(true);
    expect(r.brainRoot).toMatch(/Brain$/);
    expect(existsSync(join(r.brainRoot, "preferences"))).toBe(true);
  } finally {
    r.cleanup();
  }
  expect(existsSync(r.tmpRoot)).toBe(false);
});

test("extractSnapshotToTemp throws on missing archive", () => {
  expect(() => extractSnapshotToTemp(vault, "missing-run")).toThrow(/archive does not exist/);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.snapshot.test.ts -t "extractSnapshotToTemp"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Pull the extract step out of `restoreSnapshot` (lines ~452–520 today).
Signature:

```ts
export interface ExtractSnapshotResult {
  readonly tmpRoot: string;
  readonly brainRoot: string;
  readonly cleanup: () => void;
}

export function extractSnapshotToTemp(
  vault: string,
  runId: string,
): ExtractSnapshotResult;
```

Body: existing archive-existence probe, tooling detection, magic-byte
based decompressor pick, `tar -x` into `mkdtempSync(...)`,
`existsSync(extractedBrain)` sanity-check. `cleanup` is the same
`rmSync(tmp, { recursive: true, force: true })` that `restoreSnapshot`
currently runs in its `finally` block.

Rewire `restoreSnapshot` to:

```ts
const ext = extractSnapshotToTemp(vault, runId);
try {
  // existing live-tree wipe + cpSync loop, sourced from ext.brainRoot
} finally {
  ext.cleanup();
}
```

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.snapshot.test.ts`
Expected: all existing tests stay green; new ones pass.

**Pause for review (no commit).**

---

### Task 31: `BrainTreeDiff` types + `diffBrainTrees`

**Files:**
- Create: `src/core/brain/snapshot-diff.ts`
- Test: `tests/core/brain.snapshot-diff.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { diffBrainTrees } from "../../src/core/brain/snapshot-diff.ts";

test("diffBrainTrees reports added preference", () => {
  // a/ Brain/preferences/pref-a.md (parsed)
  // b/ Brain/preferences/pref-a.md (same) + Brain/preferences/pref-b.md
  const d = diffBrainTrees(rootA, rootB);
  expect(d.added).toContainEqual(
    expect.objectContaining({ kind: "preference", id: "pref-b" }),
  );
  expect(d.removed).toEqual([]);
  expect(d.modified).toEqual([]);
});

test("diffBrainTrees reports removed retired", () => { /* mirror */ });

test("diffBrainTrees reports modified preference with field deltas", () => {
  // pref-a status confirmed → quarantine, applied 4 → 7
  const d = diffBrainTrees(rootA, rootB);
  const chg = d.modified.find(c => c.entry.id === "pref-a")!;
  expect(chg.fields).toContainEqual({ field: "_status", before: "confirmed", after: "quarantine" });
  expect(chg.fields).toContainEqual({ field: "_applied_count", before: 4, after: 7 });
  expect(chg.bodyChanged).toBe(false);
});

test("diffBrainTrees marks body-only change with empty fields and bodyChanged true", () => {
  // pref-a frontmatter identical, body differs
  const d = diffBrainTrees(rootA, rootB);
  const chg = d.modified.find(c => c.entry.id === "pref-a")!;
  expect(chg.fields).toEqual([]);
  expect(chg.bodyChanged).toBe(true);
});

test("diffBrainTrees treats signals as immutable (added/removed only)", () => {
  // sig-a present in A absent in B
  const d = diffBrainTrees(rootA, rootB);
  expect(d.removed).toContainEqual(expect.objectContaining({ kind: "signal", id: "sig-a" }));
  expect(d.modified.find(c => c.entry.kind === "signal")).toBeUndefined();
});

test("diffBrainTrees compares logs byte-equal (bodyChanged only)", () => {
  // Brain/log/2026-05-17.md differs in B
  const d = diffBrainTrees(rootA, rootB);
  expect(d.modified).toContainEqual(
    expect.objectContaining({ entry: expect.objectContaining({ kind: "log" }), bodyChanged: true }),
  );
});

test("diffBrainTrees ignores .snapshots/", () => {
  // .snapshots dir differs
  const d = diffBrainTrees(rootA, rootB);
  expect(d.added.find(e => e.path.startsWith(".snapshots"))).toBeUndefined();
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.snapshot-diff.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parsePreference, parseRetired } from "./preference.ts";

const TRACKED_FIELDS = [
  "_status",
  "_applied_count",
  "_violated_count",
  "_confidence",
  "_confidence_value",
  "pinned",
] as const;

export interface BrainTreeEntry {
  readonly kind: "preference" | "retired" | "signal" | "log" | "config" | "other";
  readonly path: string;
  readonly id?: string;
}
// (other types from spec §3.3)

export function diffBrainTrees(
  rootA: string,
  rootB: string,
): BrainTreeDiff {
  // 1. Walk both roots, classify entries (excluding .snapshots/).
  // 2. Map by relative path.
  // 3. paths in A only → removed; in B only → added; in both →
  //    compare; if preferences/retired → frontmatter field diff;
  //    other kinds → byte equality, marked bodyChanged.
  // 4. Sort outputs deterministically (by kind, then id, then path).
}
```

Provide a `classify(relativePath)` helper that maps
`preferences/pref-*.md` → preference, `retired/ret-*.md` → retired,
`inbox/sig-*.md` and `inbox/processed/sig-*.md` → signal,
`log/*.md` → log, `_brain.yaml` / `_BRAIN.md` / `active.md` → config,
everything else under `Brain/` → other.

Frontmatter diff: parse both files; emit one `BrainFieldChange` per
tracked field whose value differs.

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.snapshot-diff.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 32: Diff renderers

**Files:**
- Create: `src/core/brain/snapshot-diff-render.ts`
- Test: `tests/core/brain.snapshot-diff-render.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("renderDiffMarkdown groups by kind and uses titled wikilinks", () => {
  const md = renderDiffMarkdown(/* sample diff */, { aLabel: "run-x", bLabel: "live" });
  expect(md).toMatch(/^# Brain snapshot diff$/m);
  expect(md).toMatch(/^- A: run-x$/m);
  expect(md).toMatch(/^- B: live$/m);
  expect(md).toMatch(/^## Preferences$/m);
  expect(md).toMatch(/^- \+ \[\[pref-foo\|Use spaces\]\] \(added\)$/m);
  expect(md).toMatch(/^- ~ \[\[pref-bar\|.*\]\]:$/m);
  expect(md).toMatch(/^  - _status: confirmed → quarantine$/m);
});

test("renderDiffJson returns the BrainTreeDiff verbatim", () => {
  const d = /* sample */;
  expect(renderDiffJson(d)).toEqual(d);
});

test("renderDiffMarkdown shows '(no changes)' under each section if empty", () => {
  const md = renderDiffMarkdown(emptyDiff, {});
  expect(md).toMatch(/^## Preferences\s+\(no changes\)$/m);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/core/brain.snapshot-diff-render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Pure rendering of `BrainTreeDiff` into Markdown. Use `renderPrefLink`
when the entry is a preference or retired (look up `principle` from
the diff's stored frontmatter snapshot — Task 31 stores enough on the
entry for the renderer to source the title).

- [ ] **Step 4: Verify**

Run: `bun test tests/core/brain.snapshot-diff-render.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 33: `cmdBrainRollback --dry-run`

**Files:**
- Modify: `src/cli/brain.ts`
- Test: `tests/cli/brain.snapshot-diff.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("rollback --dry-run prints would-be restore plan and does not modify Brain/", async () => {
  createSnapshot(vault, "run-x");
  writeFileSync(join(vault, "Brain/preferences/pref-new.md"), "...");
  const { exit, stdout } = await runCli(["brain", "rollback", "run-x", "--dry-run", "--vault", vault]);
  expect(exit).toBe(0);
  expect(stdout).toMatch(/^# Brain snapshot diff$/m);
  expect(stdout).toMatch(/^- A: run-x$/m);
  expect(stdout).toMatch(/^- B: live$/m);
  expect(existsSync(join(vault, "Brain/preferences/pref-new.md"))).toBe(true);
});

test("rollback --dry-run + --yes is an error", async () => {
  const { exit, stderr } = await runCli(["brain", "rollback", "run-x", "--dry-run", "--yes", "--vault", vault]);
  expect(exit).toBe(1);
  expect(stderr).toMatch(/mutually exclusive/);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/cli/brain.snapshot-diff.test.ts -t "rollback --dry-run"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `cmdBrainRollback`, extend the flag schema:

```ts
"dry-run": { type: "boolean" },
```

After resolving `runId` and verifying the snapshot exists:

```ts
if (flags["dry-run"]) {
  if (flags["yes"]) return fail("rollback: --dry-run and --yes are mutually exclusive");
  const ext = extractSnapshotToTemp(vault, runId);
  try {
    const diff = diffBrainTrees(ext.brainRoot, join(vault, "Brain"));
    const out = flags["json"]
      ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
      : renderDiffMarkdown(diff, { aLabel: runId, bLabel: "live" }) + "\n";
    process.stdout.write(out);
    return 0;
  } finally {
    ext.cleanup();
  }
}
```

- [ ] **Step 4: Verify**

Run: `bun test tests/cli/brain.snapshot-diff.test.ts -t "rollback --dry-run"`
Expected: green.

**Pause for review (no commit).**

---

### Task 34: `cmdBrainSnapshotDiff`

**Files:**
- Modify: `src/cli/brain.ts`
- Test: `tests/cli/brain.snapshot-diff.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("snapshot diff <run_id> against live", async () => {
  createSnapshot(vault, "run-x");
  writeFileSync(join(vault, "Brain/preferences/pref-new.md"), "...");
  const { exit, stdout } = await runCli(["brain", "snapshot", "diff", "run-x", "--vault", vault]);
  expect(exit).toBe(0);
  expect(stdout).toMatch(/^- A: run-x$/m);
  expect(stdout).toMatch(/^- B: live$/m);
  expect(stdout).toMatch(/\+ \[\[pref-new/);
});

test("snapshot diff <run_a> <run_b>", async () => {
  createSnapshot(vault, "run-x");
  writeFileSync(join(vault, "Brain/preferences/pref-new.md"), "...");
  createSnapshot(vault, "run-y");
  const { exit, stdout } = await runCli(["brain", "snapshot", "diff", "run-x", "run-y", "--vault", vault]);
  expect(exit).toBe(0);
  expect(stdout).toMatch(/- A: run-x.*- B: run-y/s);
});

test("snapshot diff --json yields parseable JSON", async () => {
  createSnapshot(vault, "run-x");
  const { exit, stdout } = await runCli(["brain", "snapshot", "diff", "run-x", "--vault", vault, "--json"]);
  expect(exit).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed).toHaveProperty("added");
  expect(parsed).toHaveProperty("removed");
  expect(parsed).toHaveProperty("modified");
});

test("snapshot diff with unknown run_id exits 2", async () => {
  const { exit } = await runCli(["brain", "snapshot", "diff", "missing", "--vault", vault]);
  expect(exit).toBe(2);
});
```

- [ ] **Step 2: Failing run**

Run: `bun test tests/cli/brain.snapshot-diff.test.ts -t "snapshot diff"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `handleBrainSubcommand`, add a `snapshot` sub-namespace dispatcher:

```ts
case "snapshot":
  return handleBrainSnapshotSubcommand(rest);
```

```ts
function handleBrainSnapshotSubcommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "diff": return cmdBrainSnapshotDiff(rest);
    default:
      process.stderr.write(
        "usage: o2b brain snapshot diff <run_id_a> [<run_id_b>] " +
        "[--vault <path>] [--json]\n",
      );
      return Promise.resolve(1);
  }
}
```

`cmdBrainSnapshotDiff`:

```ts
async function cmdBrainSnapshotDiff(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json:  { type: "boolean" },
  });
  const cfg = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, cfg);
  if (positional.length < 1 || positional.length > 2) {
    return fail("snapshot diff requires <run_id_a> [<run_id_b>]");
  }
  const [a, b] = positional;
  const snaps = listSnapshots(vault);
  if (!snaps.some(s => s.run_id === a)) return notFound(`snapshot not found: ${a}`);
  if (b && !snaps.some(s => s.run_id === b)) return notFound(`snapshot not found: ${b}`);

  const extA = extractSnapshotToTemp(vault, a);
  let extB: ExtractSnapshotResult | null = null;
  try {
    const bRoot = b
      ? (extB = extractSnapshotToTemp(vault, b)).brainRoot
      : join(vault, "Brain");
    const diff = diffBrainTrees(extA.brainRoot, bRoot);
    const out = flags["json"]
      ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
      : renderDiffMarkdown(diff, { aLabel: a!, bLabel: b ?? "live" }) + "\n";
    process.stdout.write(out);
    return 0;
  } finally {
    extA.cleanup();
    extB?.cleanup();
  }
}
```

Add VERB_HELP entry for `snapshot` and update the top-level
help-string in `cmdBrainHelp` to mention `o2b brain snapshot diff`.

- [ ] **Step 4: Verify**

Run: `bun test tests/cli/brain.snapshot-diff.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 35: Phase 4 close

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: zero errors.

**Pause for review (no commit).**

---

## Phase 5 — Release wrap

### Task 36: E2E test through the bundle

**Files:**
- Create: `tests/e2e/brain-tier-a-bundle.test.ts`

- [ ] **Step 1: Build the scenario**

```ts
test("Tier-A bundle: init → set-primary → dream → snapshot diff → rollback dry-run", async () => {
  // 1. o2b brain init --vault <tmp> --primary-agent hermes
  // 2. o2b brain feedback (positive, topic X) × 3 from agent=other
  // 3. o2b brain dream (agent=other) → warns non-primary
  // 4. o2b brain feedback (positive, topic X) × 2 more
  // 5. o2b brain dream (agent=hermes) → no warning
  // 6. listSnapshots → at least 2 entries
  // 7. o2b brain snapshot diff <run_a> <run_b> → JSON contains a pref-X with status quarantine|confirmed change
  // 8. o2b brain rollback <run_a> --dry-run → markdown shows the delta vs live
  // 9. Live Brain/ unchanged after dry-run
});
```

- [ ] **Step 2: Run, expecting full pass**

Run: `bun test tests/e2e/brain-tier-a-bundle.test.ts`
Expected: green.

**Pause for review (no commit).**

---

### Task 37: README CLI table updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Extend the CLI table**

Two new rows under "Brain":

```text
o2b brain set-primary           Declare or clear primary_agent in _brain.yaml
o2b brain snapshot diff         Diff between two snapshots (or snapshot vs live)
```

Add `--dry-run` mention under the existing `rollback` row.

- [ ] **Step 2: Add Cross-project setup subsection**

Already covered in Task 18 — verify the section is present.

- [ ] **Step 3: Verify**

Run: `grep -nE 'set-primary|snapshot diff|dry-run' README.md | head`
Expected: every row matches one CLI line.

**Pause for review (no commit).**

---

### Task 38: `docs/how-it-works.md` extension

**Files:**
- Modify: `docs/how-it-works.md`

- [ ] **Step 1: Three paragraph additions**

Add under the relevant existing sections (do not create new top-level
sections — work within the file's current outline):

- **Snapshot diff** — short paragraph in the "Snapshot model" section
  describing `o2b brain snapshot diff <a> [<b>]` and
  `rollback --dry-run` as the two read-only inspectors over the
  snapshot family.
- **Numeric confidence** — short paragraph in the "Confidence" section
  documenting `_confidence_value`, the Wilson + freshness formula at a
  high level, and the new band thresholds in `_brain.yaml.confidence`.
- **Primary agent** — short paragraph in the "Configuration" /
  `_brain.yaml` section listing `primary_agent: <name> | null` and the
  non-primary warning behaviour.

- [ ] **Step 2: Verify**

Run: `grep -nE 'snapshot diff|confidence_value|primary_agent' docs/how-it-works.md | head`
Expected: at least one hit each.

**Pause for review (no commit).**

---

### Task 39: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Compose the section**

One new release block (no `[Unreleased]` placeholder — project rule).
Date stamped at release time, version chosen by the release step
(this plan does not encode a specific number to avoid drift):

```markdown
## [<next version>] - <release date>

Brings four Tier-A items from `Projects/OpenSecondBrain/Features/_summary`:
§5 snapshot diff and dry-run rollback, §10 numeric confidence with
derived band, §21 cross-project pointer plus primary-agent
declaration, §27 titled wikilinks for preferences.

### Added
- `o2b brain snapshot diff <run_a> [<run_b>]` — read-only artifact
  diff between two snapshots, or between a snapshot and live Brain/.
  Groups output by artifact kind; `--json` for structured callers.
- `o2b brain rollback --dry-run <run_id>` — preview the restore plan
  via the same diff renderer, with the live tree untouched.
- `_confidence_value` numeric field on every preference and retired
  file, computed from a Wilson 95% lower bound on
  applied vs (applied + violated), modulated by linear freshness
  decay over `retire.stale_evidence_days`. The existing
  `_confidence` band stays on disk as a derived view.
- `_brain.yaml.confidence.medium_min`, `_brain.yaml.confidence.high_min`
  — derived-band thresholds on the numeric value.
- `_brain.yaml.primary_agent` — declarative owner of the
  dream-cron for a vault.
- `o2b brain set-primary <name> | --clear` — idempotent edit of
  `primary_agent`.
- `o2b brain init --primary-agent <name>` — set the primary at
  bootstrap time.
- `renderPrefLink({ id, principle })` — internal helper plus a
  sweep of every Brain writer that emits a pref / retired wikilink.
  Output shifts from `[[pref-id]]` to
  `[[pref-id|short principle]]` in `active.md`, digests, log
  payloads, retired bodies, and CLI human output.
- `docs/cross-project-pointer.md` — agent-facing setup guide for
  projects whose work happens outside the vault root.

### Changed
- `dream` refresh writes `_confidence_value` alongside the band on
  every touched preference. Legacy files migrate lazily on the next
  refresh pass.
- `dream` emits a non-fatal `non-primary-dream-run` warning (stderr
  + MCP `warnings` array) when run from an agent other than
  `primary_agent`. The dream pass still completes; the warning is
  visibility, not enforcement.
- `digest` adds a `## Confidence drops` section listing preferences
  whose band fell during the current dream pass.
- `active.md` bullets now append `(conf: 0.NN)` when a numeric value
  is on disk.
- `brain_query` MCP response carries `confidence_value` alongside
  the band on every result row.
- README adds a Cross-project setup subsection.
- install.md Branch A recommends `--primary-agent` during the
  Hermes-side `o2b init`.

### Notes
- No vault migration required. The first post-upgrade dream pass
  writes `_confidence_value` into every touched preference, and the
  bundled `o2b brain doctor` is unchanged.
- The four new CLI surfaces (`snapshot diff`, `rollback --dry-run`,
  `set-primary`, `init --primary-agent`) are CLI-only on the
  operator side; the MCP surface gains only an additive field on
  `brain_query` and an additive `warnings` channel on `brain_dream`.
```

- [ ] **Step 2: Verify the entry conforms to project rules**

Run: `grep -in 'unreleased' CHANGELOG.md | head`
Expected: zero occurrences (project rule "No `[Unreleased]` section").

Run: `grep -E '!{1}' CHANGELOG.md | head` to spot-check that the new
section follows the `pref-no-exclamation-marks-in-docs` rule. Expected:
no `!` in the new prose.

**Pause for review (no commit).**

---

### Task 40: Version bump via `sync-version`

**Files:**
- Modify: `package.json`, `pyproject.toml`

- [ ] **Step 1: Pick the next version**

Open `package.json`, read the current version (the previous release
on this lineage). Bump the patch (or minor — defer to release-call
judgement) to the next number consistent with semver and the
"one PR = one CHANGELOG version" rule.

- [ ] **Step 2: Run the sync script**

Run: `bun run sync-version <new version>`
Expected: both files updated; the script is the canonical writer.

- [ ] **Step 3: Verify**

Run: `grep version package.json pyproject.toml | head`
Expected: both report the same new value.

**Pause for review (no commit).**

---

### Task 41: Release-pass close

- [ ] **Step 1: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: green.

- [ ] **Step 2: Read CHANGELOG once more**

Skim the new section. Confirm: no `[Unreleased]`, no `simply`, no `!`
in prose, all four feature numbers referenced. Section header dates
**not** baked in from the planning phase (project rule).

**Pause for review (no commit).** Bundle ready for the user to
review, run any cloud reviews (CodeRabbit only if Sergey asks —
project rule against unsolicited runs), and stage / commit / push.
