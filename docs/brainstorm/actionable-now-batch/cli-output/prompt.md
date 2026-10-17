You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation. You are running inside the project repository and MAY read files to ground your variants; cite file paths you relied on.

# Task

This is a release wave of SEVEN actionable-now kanban cards that ship as ONE feature branch, ONE pull request and ONE release of Open Second Brain. Produce variants for the architecture of the whole wave (how the seven pieces group into parallel work lanes, where the file-ownership boundaries are, in what order things land, where the integrator sweeps), not seven separate mini-designs. A read-only recon pass has verified all seven premises against the branch head; the corrected anchors below supersede the card text.

## Cards (recon-corrected summaries)

- **t_28a8789d (priority 4) - Preview-and-apply entity page merge repair.** `brain entity merge` accepts BOTH doctor subjects (`entity-alias-candidate` opt-in, `duplicate-entity` always-on; message text at `src/core/brain/entities/entity-checks.ts:60-65` must not change - verdicts match by exact message). Plan = old name becomes an alias on the survivor (claims append-only, zero rewrites); old page archived behind `withDestructiveSnapshot` or body folded, never bare delete. Plan-hash accept gate is NEW surface modeled on `dream-stage.ts:362` (`plan_hash: sha256Hex(JSON.stringify(plan))`) and bench run-store expected-hash gates: preview echoes the hash, apply requires `--expect-hash` / TTY y-N / `--force`. Quarantine-lane records refused or routed explicitly. Optional `guardEntityMerge` (`src/core/brain/truth/merge-guard.ts:77`) over the two bodies.
- **t_d8e7320f (priority 4) - Locale-aware numeric collation for note listing sort.** Single sort site `listVaultPages` (`src/core/vault.ts:692`): module-level `new Intl.Collator("en", { numeric: true })`, keep the `toLowerCase` pre-pass. Callers `cmdIndex` (`src/cli/main.ts:722`) and MCP `second_brain_query` inherit the order. Do NOT collate the `feedback.ts:160` tie-break.
- **t_3b44cd9a (priority 4) - Cross-agent shared job logbook, session-start catch-up.** New read-only opt-in SessionStart hook lane handing the agent other agents' log lines since its last look (newest 50 + older count; `buildActivityTimeline` limit/total pattern). Cursor = `(date, shardId, line)` watermark, un-synced, in the derived store `<vault>/.open-second-brain/` (backlog-nudge-state precedent), never a `Brain/log` row. Config-resolved agent name with device-id fallback; filter `entry.agent !== self`; own process like gap-agenda with a per-lane cap. Registration: `hooks/hooks.json` entry + codex mirror via `bun run sync-plugin-mirrors`; dispatcher is name-based.
- **t_ba04a81a (priority 3) - Injection-hardened framing for SessionStart lanes.** Do NOT flip `untrusted_source_delimiting` (single reader `context-pack.ts:748`; flipping kills detection reporting pinned by operator-summary/doctor-trust tests and does nothing for hook lanes). Extend the guard: promote `neutralizeSingleLine` (duplicated at `recall-inject.ts:1091` and `navmap.ts:66`) into `src/core/brain/untrusted-source.ts`; guard the active-context assembly chokepoint (`hooks/lib/active-context.ts:213-237`) BEFORE the meter push (attribution at `active-inject.ts:388-412` matches exact strings); charge fence/header overhead to `inject_budget_chars`; lighter header (not full fence) for active/lessons; full fence for the small gap-agenda block (`gap-loop.ts:387`); neutralize answer-quote-check spans before collapse. Standing/scoped rules stay trusted-with-precedence-header.
- **t_69fec179 (priority 2) - Destination-keyed write ledger aggregate.** LOG-DERIVED on query, no persisted table: one walk reading BOTH `note-write` (`write-record.ts:235-265`) and `write-session` (`engine.ts:494-509`) kinds - the write-session lane emits no note-write events. Group key = vault-relative target as recorded; default 7-day window; per-destination `kinds` coverage field (slug-derived/fully-derived binding sites emit neither kind - honesty required). Exposure over one shared core reader: CLI subcommand under `brain writes` and a new MCP tool beside `brain_writes` (`query-tools.ts:351-443`) with filters, limit/cursor, `total_matched`, warnings passthrough, reach filtering so a withheld page moves no count. Frozen-surface pins: `tests/mcp/mcp.test.ts`, `brain-tools-parity.test.ts`, `tool-probe-catalogue.ts`, `tool-ceiling.test.ts`, `agent-scope-matrix.test.ts`; `VISIBILITY_SURFACE_REGISTRY` row + two-way census pin; registry-guard bounded summary.
- **t_ffdb4fac (priority 2) - OKF v0.2 export compliance.** Spec facts (fetched 2026-10-17): `okf_version: "0.2"` is a MAY declaration in bundle-root index.md frontmatter, NOT a schema value; per-concept `sources:` list with REQUIRED `resource` (URL as-is; wikilink -> bundle-relative path via the `bundle_path` map at `okf.ts:276-283`; otherwise drop - dangling drop is an allowed producer choice); `generated: {by, at}` per concept; `status` only draft|stable|deprecated. Keep the Open Second Brain dialect manifest `schema: "1"`; add the v0.2 declarations beside it; conservative lifecycle map (deprecated/retired/superseded/archived -> deprecated; done/closed/resolved -> stable, never deprecated); per-page `generated.at` shares ONE `isoSecond()` value or the determinism test breaks. Importer dual-accepts `schema: "1"` and `okf_version: "0.2"`, preserves the on-disk schema in the returned manifest (:615), refuses the rest by name. `redactForEgress` stays in-module (egress registry keys on the verb module).
- **t_dee22e5d (priority 3) - Hermes memory_providers entry point.** Add `[project.entry-points."hermes_agent.memory_providers"]` with `open-second-brain = "plugins.hermes"` (module target; loader contract `hasattr(loaded, "register")`, documented at the Hermes root `__init__.py:9-16`) to the repo-root `pyproject.toml`; amend its "no CLI entry points" header comment. The inverted pre_llm_call/prefetch design is REFUSED (prefetch is the deliberate single injection lane, pinned by `test_no_pre_llm_call_hook_registered`). Tests: tomllib parse + loader-contract mimicry; install/hermes.md notes the PATH/checkout caveat.

## Constraints

- Four review contexts maximum is strongly preferred; seven one-card reviews are known to churn the shared pin files (`src/cli/brain/verbs/index.ts`, `help-text.ts`, `command-manifest.ts`, `docs/cli-reference.md`, MCP frozen-surface counts, census tests).
- Lanes must have DISJOINT file ownership - no file may be owned by two lanes; cross-lane dependencies are forbidden.
- An integrator pass runs the full gates and reviews census registrations across lanes; CHANGELOG and version are handled elsewhere.
- Each card pair that shares a seam must stay inside one lane (the plan-hash gate with its verb; the guard with the meter it feeds).

# Required output format

Produce exactly three variants, each as:

```
### Variant N: <name>

- **Approach**: <how the wave is structured: lane grouping, ownership boundaries, landing order, integrator role>
- **Trade-offs**:
  - Pro: ...
  - Con: ...
- **Complexity**: <small|medium|large>
- **Risk**: <low|medium|high>
```

Then `### Recommended: Variant N` with rationale grounded in the recon facts above. Cite file paths for every ownership claim you make.
