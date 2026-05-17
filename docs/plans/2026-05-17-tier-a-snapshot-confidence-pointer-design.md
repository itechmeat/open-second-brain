# Tier-A bundle: snapshot diff, numeric confidence, cross-project pointer, titled wikilinks

> Status: design draft for review.
> Bundle covers items §5, §10, §21, §27 of
> `Projects/OpenSecondBrain/Features/_summary` (vault knowledge base).
> Target: one release (`v0.10.3-draft`), one CHANGELOG version, ordered
> rollout per the dependency notes at the end of this document.

## 1. Summary

This bundle ships four mostly-orthogonal Brain layer increments:

| § | Title | Scope this iteration |
|---|---|---|
| 5 | Snapshot diff + rollback dry-run | `o2b brain snapshot diff` (read-only inspector) and `o2b brain rollback --dry-run` (preview restore). No sha256 manifest, no drift abort, no archive-format change. |
| 10 | Numeric confidence | `_confidence_value: 0.0–1.0` as new primary field; existing `_confidence: low\|medium\|high` becomes derived (and is still emitted on disk for reader backwards compatibility). Wilson lower bound formula, freshness decay, new band thresholds in `_brain.yaml`. Lazy migration through the next dream refresh. |
| 21 | Cross-project pointer + primary agent | `Brain/_brain.yaml.primary_agent` declarative field; `o2b brain set-primary` CLI; soft warning in dream when non-primary; `docs/cross-project-pointer.md` with the canonical CLAUDE.md / AGENTS.md snippet; install.md branch A recommendation. No managed-block CLI bootstrap (deferred until §4 installer ships together). |
| 27 | Titled wikilinks for preferences | New `renderPrefLink({id, principle})` helper in `wikilink.ts`. All Brain writers that reference a preference or retired artifact emit `[[pref-slug|short-title]]`. Parsers already strip `|alias`; reading path unchanged. |

Out of scope (called out explicitly so writing-plans does not re-open them):

- sha256 manifest, `--force-rollback`, drift abort (§5 partial — see _summary).
- Post-dream integrity drill hook (§5 partial — backed by rclone-crypt
  off-host backups, not worth the moving part).
- Hard refusal of non-primary dream runs (§21 — soft warning only).
- MCP `brain_set_primary` tool (§21 — CLI-only, joins
  `rollback` / `reject` / `migrate-frontmatter` in the operator-only band).
- `o2b brain bootstrap` (§21 — defers to §4 installer epic).
- `aliases` first-class rename safety (§27 — no real renames yet).
- Loosening the `BrainPreference.confidence` agent API (§10 — band stays
  on the public MCP shape).

## 2. Goals & non-goals

### Goals

1. Give the operator a read-only inspector for the snapshot family (diff
   between two runs, or between a run and live) without touching the live
   tree.
2. Promote confidence from a step-function (low/medium/high) to a continuous
   signal that the digest, doctor, and future tuners can reason about,
   without breaking the published agent shape.
3. Declare which runtime owns `dream` for a given vault, in a place that
   syncs across devices (Syncthing).
4. Make Brain wikilinks self-describing in Obsidian without changing how
   parsers resolve them.

### Non-goals

1. Re-deriving snapshots themselves. Existing tar+zstd format, retention,
   and `restoreSnapshot` semantics are untouched.
2. Changing how `dream` clusters signals or decides retire reasons. Only
   the **value** of confidence and the **payload** of log events shift.
3. Adding hard enforcement around primary agent. The whole point is
   visibility, not access control — pinning, rejecting, and pin-toggling
   from a non-primary host remain valid.

## 3. §5 — Snapshot diff + rollback dry-run

### 3.1 CLI surface

```text
o2b brain rollback <run_id> --dry-run [--vault <path>] [--json]
    # Mutually exclusive with --yes. Extracts the archive into a sibling
    # tmp directory, computes the would-be restore plan, prints it, and
    # removes tmp. Does NOT modify Brain/. Exit code 0.

o2b brain snapshot diff <run_id_a> [<run_id_b>] [--vault <path>] [--json]
    # With one positional: diff snapshot ↔ live Brain/.
    # With two positionals: diff <a> ↔ <b>.
    # Order semantics: <a> is "before", <b> (or live) is "after".
    # Output groups changes by artifact kind (preference, retired,
    # signal, log, config, other) and by mode (added, removed, modified).
    # Exit code 0 even when the diff is empty.
```

`snapshot` becomes a new sub-namespace under `brain`. Today it carries
only `diff`; future `snapshot list / show / verify` slots in here. The
flat alternative (`o2b brain snapshot-diff`) is consciously rejected.

### 3.2 Module layout

| file | role |
|---|---|
| `src/core/brain/snapshot.ts` (existing) | + `extractSnapshotToTemp(vault, runId): { tmpRoot, brainRoot, cleanup }`. Pure extraction step pulled out of `restoreSnapshot` (lines 452–520 today). `restoreSnapshot` rewires to call it. No behaviour change to existing callers — verified by snapshotting the rollback test fixtures. |
| `src/core/brain/snapshot-diff.ts` (new) | `diffBrainTrees(rootA: string, rootB: string): BrainTreeDiff`. Walks the two roots, classifies each top-level entry under `Brain/` (except `.snapshots/`), reads frontmatter for `preferences/*.md` and `retired/*.md` and computes a typed field diff for the canonical set (`_status`, `_applied_count`, `_violated_count`, `_confidence`, `_confidence_value`, `pinned`). Signals, logs, config, and other files compare by byte equality (no semantic diff). No I/O beyond `readFileSync` + `readdirSync`. |
| `src/core/brain/snapshot-diff-render.ts` (new) | Two pure renderers: `renderDiffMarkdown(diff): string`, `renderDiffJson(diff): unknown`. Markdown rendering uses `renderPrefLink` from §27 once that lands. |
| `src/cli/brain.ts` | + `cmdBrainSnapshotDiff`, `--dry-run` in `cmdBrainRollback`. Helptext, usage matrix. |

### 3.3 Types

```ts
export interface BrainTreeDiff {
  readonly added:    ReadonlyArray<BrainTreeEntry>;
  readonly removed:  ReadonlyArray<BrainTreeEntry>;
  readonly modified: ReadonlyArray<BrainTreeChange>;
}

export interface BrainTreeEntry {
  readonly kind: "preference" | "retired" | "signal" | "log" | "config" | "other";
  readonly path: string;        // vault-relative
  readonly id?:  string;        // pref-/ret-/sig- when applicable
}

export interface BrainTreeChange {
  readonly entry: BrainTreeEntry;
  readonly fields: ReadonlyArray<BrainFieldChange>;  // empty when only body changed
  readonly bodyChanged: boolean;
}

export interface BrainFieldChange {
  readonly field: string;       // e.g. "_status", "_applied_count"
  readonly before: string | number | boolean | null;
  readonly after:  string | number | boolean | null;
}
```

### 3.4 Output format

Markdown shape (stable, doctor-style; safe to grep):

```markdown
# Brain snapshot diff

- A: 2026-05-17T03-00-00Z (run-2026-05-17-03)
- B: live  (or 2026-05-18T03-00-00Z)

## Preferences
- + pref-no-internal-abbrev (added)
- - pref-stale-rule (removed)
- ~ pref-no-trailing-comma:
  - _status: confirmed → quarantine
  - _applied_count: 4 → 7
  - _violated_count: 0 → 3

## Retired
- + ret-stale-rule (removed; reason: stale-no-evidence)

## Signals
- + sig-2026-05-18-foo (added)

## Logs
- ~ Brain/log/2026-05-18.md (body changed)

## Config / Other
- (no changes)
```

JSON shape is the literal `BrainTreeDiff` serialisation.

### 3.5 Logging

`rollback --dry-run` and `snapshot diff` are read-only and **do not**
append to `Brain/log/`. This matches `digest` and `query`.

### 3.6 Tests

- `tests/core/brain.snapshot-diff.test.ts` — fixture-driven: two pre-built
  Brain trees on disk, expected `BrainTreeDiff`. Covers add/remove/modify
  for each artifact kind, ordering stability, byte-equal short-circuit.
- `tests/cli/brain.snapshot-diff.test.ts` — CLI invocation, markdown vs
  `--json`, mutual-exclusion `--dry-run` × `--yes`, missing run_id exit 2.
- Existing `tests/core/brain.snapshot.test.ts` — assert
  `extractSnapshotToTemp` extraction matches the previous inline path
  byte-for-byte (regression net).

## 4. §10 — Numeric confidence

### 4.1 Frontmatter shape

Preferences and retired files gain one new field:

```yaml
_confidence_value: 0.7413        # NEW — primary, written by dream
_confidence:       medium        # DERIVED — kept for backwards-compat readers
```

Both are stored. Writer emits both. Parser tolerates either being absent
on legacy files (lazy migration via the next refresh).

### 4.2 Formula

```text
n = applied + violated

if n == 0:
    value = 0.0
else:
    p_hat = applied / n
    z = 1.96                            # 95 % one-sided lower confidence bound
    denom  = 1 + z² / n
    centre = (p_hat + z²/(2n)) / denom
    margin = z * sqrt(p_hat*(1 - p_hat)/n + z²/(4n²)) / denom
    wilson_low = max(0, centre - margin)

    if last_evidence_at is null:
        freshness = 0.0
    else:
        age_days  = (now - last_evidence_at) / 1 day
        freshness = clamp(1 - age_days / cfg.retire.stale_evidence_days, 0, 1)

    value = round(wilson_low * freshness, 4)   # 4 decimals — stable in YAML
```

### 4.3 Band derivation

```text
band(value) =
  cfg.confidence.high_min   ≤ value           → high
  cfg.confidence.medium_min ≤ value < high_min → medium
                              value < medium_min → low
```

Then the existing count-based hard floors override the numeric band:

```text
if applied ≤ cfg.confidence.low_max_applied                  → low
if applied > 0 ∧ violated ≥ applied                          → low
if applied < cfg.confidence.high_min_applied
   ∨ violated > 0
   ∨ ¬fresh                                                  → at most medium
```

The numeric value is **always** the Wilson * freshness product (it does
not get clamped by the hard floors); only the **derived band** is
adjusted by them. This preserves the contract that agents (reading
band) keep their existing semantics, while the value remains a clean
continuous signal for the digest and future tuning work.

### 4.4 `_brain.yaml` configuration

```yaml
confidence:
  # Existing — keep, they drive hard-floor band rules and the legacy
  # freshness window used inside computeConfidence.
  low_max_applied:        2
  high_min_applied:       10
  high_freshness_factor:  0.8
  # NEW — derived band thresholds on the numeric value.
  medium_min:             0.40
  high_min:               0.75
```

Constraints validated by `policy.ts`:

```text
0 ≤ medium_min < high_min ≤ 1
```

Defaults (`DEFAULT_BRAIN_CONFIG`, `DEFAULT_BRAIN_CONFIG_YAML`) populate
the two new keys. Unknown keys remain forward-compat (warning, not
error).

### 4.5 Migration

- Parser accepts both shapes: legacy (no `_confidence_value`), new
  (both present). On `_confidence_value` absent → `confidence_value:
  null` on the parsed object. Public type widens
  (`confidence_value: number | null`).
- Writer always emits both fields, computed via the formula. Dream's
  refresh pass touches every pref every run; `wouldRewritePreference`
  already short-circuits on byte equality, so legacy files get the new
  field on the next refresh.
- No explicit `migrate-frontmatter` extension. The mechanism that lands
  `_confidence_value` is the same one that lands the band shift today.

### 4.6 Digest: confidence drops

Within a single dream run, the refresh phase already builds a
`RefreshResult` containing the old + new pref records. Capture the
band transition and surface in the digest:

```markdown
## Confidence drops

- pref-no-internal-abbrev: high → medium (applied=11, violated=2)
- pref-old-rule:          medium → low  (applied=3,  violated=4)
```

Rendered only when the list is non-empty.

### 4.7 Code touchpoints

| file | change |
|---|---|
| `src/core/brain/types.ts` | `BrainPreference.confidence_value: number \| null`; `BrainRetired.confidence_value: number \| null`; `BrainConfidenceConfig.medium_min: number`, `high_min: number`. |
| `src/core/brain/policy.ts` | `DEFAULT_BRAIN_CONFIG.confidence` adds new keys; `DEFAULT_BRAIN_CONFIG_YAML` adds two lines; validator checks the `[0, 1]` bounds and ordering. |
| `src/core/brain/preference.ts` | `WritePreferenceInput.confidence_value?: number`; writer emits `_confidence_value`; parser reads both. `moveToRetired` propagates the field into retired frontmatter. |
| `src/core/brain/dream.ts` | `computeConfidence` returns `{ value: number, band: BrainConfidence }`; refresh writes both; drop-tracking added to `RefreshResult`. |
| `src/core/brain/digest.ts` | New `## Confidence drops` section; reads the band transitions list passed from `dream`. |
| `src/mcp/brain-tools.ts` | `brain_query` JSON output includes `confidence_value` alongside `confidence`. |
| `src/core/brain/active.ts` | Active list and Quarantine list — append a numeric tail to each pref bullet, format `(conf: 0.74)`. In scope for this PR. |
| Tests | `tests/core/brain.dream.test.ts` (Wilson outputs, freshness decay edge cases, hard-floor interaction), `tests/core/brain.digest.test.ts` (drops section), parser tolerance test, policy validation test. |

### 4.8 MCP shape

`brain_query` adds `confidence_value: number | null` next to the
existing `confidence: 'low' | 'medium' | 'high'`. Older agents that
read only `confidence` are unaffected. The change is additive on the
JSON contract.

## 5. §21 — Cross-project pointer + primary agent

### 5.1 `_brain.yaml` field

```yaml
primary_agent: hermes-vps-agent     # OR ~ / null when unset
```

Validation: either `null` or a non-empty string matching the same
charset as `agent_name` elsewhere in the codebase (reuse the existing
validator).

### 5.2 CLI surface

```text
o2b brain init [--primary-agent <name>] [...existing flags]
    # Writes primary_agent into the fresh _brain.yaml. On already-
    # initialised vault → no-op (matches existing brain init contract).

o2b brain set-primary <name> [--vault <path>] [--json]
    # Idempotent edit of Brain/_brain.yaml: replaces the primary_agent
    # line. Re-run with same value → exits 0 with "primary already
    # set to <name>". Re-run with new value → overwrites, prints
    # "primary changed: <prev> → <next>".

o2b brain set-primary --clear [--vault <path>] [--json]
    # Sets primary_agent: null. For vaults that want to back out.
```

No MCP equivalent.

### 5.3 Dream soft warning

After `loadBrainConfig` and before any writes in `dream.ts`:

```ts
if (cfg.primary_agent != null && cfg.primary_agent !== agentName) {
  warnings.push({
    code: "non-primary-dream-run",
    message:
      `dream run from agent '${agentName}', but primary is ` +
      `'${cfg.primary_agent}'. Convention violation — the run will ` +
      `proceed.`,
  });
}
```

CLI prints warnings to `stderr`. MCP includes them in the
`warnings: string[]` array of the `brain_dream` response (already
exists for snapshot-tooling warnings — same channel).

Log event for the dream run gains an optional `non_primary_agent: <name>`
payload key whenever the warning fires. Read path of existing
`BrainDreamLogEvent` accepts this key in the payload union without a
schema bump (payload is already `Record<string, string | string[]>`).

### 5.4 Documentation

- `docs/cross-project-pointer.md` (new). Three sections:
  1. **Where to put the snippet** — CLAUDE.md, AGENTS.md, Cursor rules,
     Aider conventions. One canonical snippet (managed-block-style fences
     so a future `o2b brain bootstrap` can patch them):

     ```text
     # >>> open-second-brain managed >>>
     ## Open Second Brain

     This project shares an Obsidian-compatible vault with an active
     observing-memory layer. At session start, read the current
     preferences:

         <absolute-vault-path>/Brain/active.md

     Record taste signals via `brain_feedback` (MCP) or
     `o2b brain feedback` (CLI). After producing a durable artifact,
     call `brain_apply_evidence` with `result: applied | violated |
     outdated` for any preference whose `scope` matches.

     Do not run `o2b brain dream` from this runtime. The vault has a
     primary dream-running agent; see `<vault>/Brain/_brain.yaml`
     (key `primary_agent`).
     # <<< open-second-brain managed <<<
     ```
  2. **Primary agent and dream-cron** — what `primary_agent` is, the
     `o2b brain set-primary` invocation, what the non-primary warning
     looks like, what is *not* restricted (signal capture, pin/unpin,
     reject — all stay multi-host).
  3. **Multi-device through Syncthing** — note that the vault is
     designed to be Syncthing-shared, signals come from any host,
     dream consolidates them on the primary host's cron.
- README — add **Cross-project setup** subsection that points to the
  new doc. No content duplication.
- `install.md` Branch A (Hermes) — add a recommendation in the `o2b init`
  step: `--primary-agent <agent-name>` when this Hermes install is
  intended to own dream.

### 5.5 Code touchpoints

| file | change |
|---|---|
| `src/core/brain/types.ts` | `BrainConfig.primary_agent: string \| null`. |
| `src/core/brain/policy.ts` | Parser accepts quoted/unquoted strings + `null`; validator enforces non-empty string or `null`; `DEFAULT_BRAIN_CONFIG.primary_agent = null`; default YAML adds the line as `primary_agent: null`. |
| `src/core/brain/init.ts` | Accepts `primaryAgent: string \| null`; writes into the scaffolded YAML. |
| `src/core/brain/set-primary.ts` (new) | `setPrimaryAgent(vault, name \| null): { previous, next, changed }`. Reads YAML, replaces the line via the same atomic writer as `migrate-frontmatter`. |
| `src/core/brain/dream.ts` | Emits the non-primary warning and the log-event payload key. |
| `src/cli/brain.ts` | `cmdBrainSetPrimary`; `cmdBrainInit` honours `--primary-agent`; helptext, usage. |
| `src/cli/main.ts` | Pass-through if `o2b init` (vault-level) is responsible for bootstrapping Brain. |
| Tests | `tests/core/brain.set-primary.test.ts`, `tests/core/brain.dream.non-primary.test.ts`, parser/validator unit tests, CLI integration. |

## 6. §27 — Titled wikilinks for preferences

### 6.1 Helper

In `src/core/brain/wikilink.ts`:

```ts
export const MAX_PREF_LINK_TITLE_LEN = 80;

export function renderPrefLink(input: {
  id: string;
  principle?: string;
}): string;
```

Algorithm:

1. NFC-normalise principle; replace `\r\n?` with `\n`; collapse all
   whitespace runs to a single space; trim.
2. Replace each of `[`, `]`, `|` with a single space; re-collapse +
   trim.
3. If empty → return `[[${id}]]`.
4. If length > `MAX_PREF_LINK_TITLE_LEN`: truncate to the limit; back
   off to the previous word boundary if the cut lands inside a word;
   append `…` (U+2026, single character).
5. Return `[[${id}|${title}]]`.

### 6.2 Call-site rewrite

Every Brain writer that emits a preference or retired wikilink calls
`renderPrefLink`. Bare `[[pref-id]]` strings are not allowed in new
code (lint rule deferred — manual review during this PR).

| site | current | becomes |
|---|---|---|
| `active.ts` — Active / Quarantine sections | `[[pref-id]]` | `[[pref-id\|principle]]` |
| `digest.ts` — newly-confirmed, retired, hot, drops, quarantine | `[[pref-id]]` / `[[ret-id]]` | titled |
| `dream.ts` — log payload `preference: ...`, `retired: ...`, `superseded_by: ...` | bare | titled |
| `apply-evidence.ts` — `preference: [[pref-id]]` log entry | bare | titled |
| `preference.ts moveToRetired` — `superseded_by` frontmatter, `## Origin` references to a pref | bare | titled |
| `backlinks.ts` — inbound reference output (CLI + render layer) | bare | titled |
| `cli/brain.ts cmdBrainBacklinks`, `cmdBrainQuery` human output | bare | titled |

Not touched (signals + external artifacts have no useful title source):

- `evidenced_by` (lists signals).
- `apply-evidence.artifact` (external vault files).
- `BrainSignal.source` (external links).

### 6.3 Parsers + readers

No changes. `normaliseWikilinkTarget` and `parseWikilink` already strip
`|alias` (`wikilink.ts:60-67`). Brain doctor's wikilink resolution and
`brain_query`'s pref-id matching keep working byte-for-byte.

### 6.4 MCP shape

JSON output remains structured (`{ id, principle, ... }`). MCP clients
that render their own markdown can call the equivalent of
`renderPrefLink` themselves; the server stays format-neutral.

### 6.5 Tests

- `tests/core/brain.wikilink.test.ts` — unit table for `renderPrefLink`:
  empty principle, characters needing sanitisation, exactly-at-limit,
  past-limit-with-word-boundary, past-limit-no-space (hard cut), unicode
  in title.
- Update existing snapshot assertions in `tests/core/brain.active.test.ts`,
  `tests/core/brain.digest.test.ts`, `tests/core/brain.dream.test.ts`,
  `tests/core/brain.apply-evidence.test.ts`, `tests/core/brain.backlinks.test.ts`
  to expect the titled form.

## 7. CHANGELOG outline (one PR, one version)

Target version: next minor or patch after `v0.10.2` — picked by the
release step, **not** baked into this design. CHANGELOG section
structure:

```markdown
## [<next version>] - <date stamped at release time>

Brings Tier-A items §5, §10, §21, §27 of
`Projects/OpenSecondBrain/Features/_summary` …

### Added
- `o2b brain snapshot diff`, `o2b brain rollback --dry-run`
- `_confidence_value` on every preference / retired file …
- `Brain/_brain.yaml.primary_agent`, `o2b brain set-primary`,
  non-primary dream-run warning
- `renderPrefLink` and titled wikilink emission across every Brain
  writer
- `docs/cross-project-pointer.md`

### Changed
- `_brain.yaml.confidence` adds `medium_min`, `high_min` keys
- `dream` refresh writes `_confidence_value`; legacy files migrate
  lazily on the next refresh
- README — Cross-project setup subsection
- install.md branch A — `--primary-agent` recommendation

### Notes
- No vault migration required …
```

Per the project's "one PR = one CHANGELOG version" rule
(`Brain/preferences/`), every entry in this bundle goes under the
**same** version header — no mid-PR version bumps.

## 8. Implementation order

§§27, 21, 10, 5 are mostly independent. The ordering below is a
suggestion to the writing-plans phase, not a constraint:

1. **§27 first.** It adds one new helper plus a sweep of call-site
   edits. Once landed, the rest of the bundle uses `renderPrefLink`
   from the moment they are written, so no second sweep is needed.
2. **§21 next.** Self-contained; touches `_brain.yaml` schema, init,
   set-primary CLI, dream warning channel, and the new doc.
3. **§10 next.** Schema (`_brain.yaml.confidence`, frontmatter
   `_confidence_value`), dream's `computeConfidence`, digest drops
   section. Depends on §27 only insofar as the digest section emits
   pref wikilinks via `renderPrefLink`.
4. **§5 last.** Pure read-only inspector + dry-run preview. Uses
   `renderPrefLink` for its markdown renderer. Depends on §27 for the
   renderer and on §10 if we want to surface
   `_confidence_value` changes in modified-field listings (we do — the
   diff is more useful with it).

## 9. Open invariants worth re-checking during implementation

These exist today and must survive the bundle:

- Brain writers go through `writeFrontmatterAtomic`; nothing in this
  bundle introduces a non-atomic write.
- `wouldRewritePreference` short-circuit on byte equality is intact.
  Adding `_confidence_value` will trigger a one-time rewrite per pref;
  subsequent refresh runs settle back to no-op when values are stable.
- `Brain/.snapshots/` is preserved across rollback — `extractSnapshotToTemp`
  refactor must not regress this.
- MCP-facing brain_query JSON shape stays additive (no removals, no
  renames).
- Public `BrainConfig`, `BrainPreference`, `BrainRetired` types widen
  only with optional / nullable fields. No required-field additions.
