You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Nine tracker items were selected together because reconnaissance showed they are one
question seen from nine sides: **what does Open Second Brain know about the machine it
is installed on, where is that knowledge declared, and what proves it is true?**

The nine, with what verification against the live source at v1.49.0 actually found:

1. **A capped host never selects a bounded tool profile.** `src/mcp/profiles.ts` ships
   `TOOL_SURFACE_PROFILES` (full / writer / catalog / recall / minimal) selectable by
   config key `mcp_tool_profile`, env `OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE`, or
   `o2b mcp --tool-profile`. Selection fails OPEN: an unknown name degrades to the full
   surface. `src/core/install/adapters/cursor.ts` is a plain JSON merge with zero
   occurrences of "profile". Measured live: `buildToolTable("full").length === 110`.
   Cursor's documented per-workspace ceiling is about 40. So the host silently drops
   tools with no `second_brain_capabilities` row to say which or why. Fail-open is right
   for an unknown profile NAME and wrong for a host with a KNOWN ceiling.

2. **No install adapter is ever exercised against a live host.**
   `tests/docs/install-verify-conformance.test.ts` derives the adapter population from
   the runtime registry, performs a real plan+apply into a temp home and temp vault,
   and compares `renderVerifyTable(adapter.verify(env))` to an expected-output block in
   `install/<target>.md`. That is strong, but every `verify()` on a JSON host ends with
   the literal note `"configuration comparison; no MCP handshake attempted"`. Only
   `copilot-cli` probes liveness. There is no per-adapter friction comparison telling a
   maintainer which pain is one host's contract problem and which is ours.

3. **`InstallAdapter.sessionPaths?()` is declared with nothing behind it.**
   `src/core/install/types.ts:147`. Zero implementations, zero call sites repo-wide. Its
   `format` union `"claude-jsonl" | "codex-json" | "cursor-sqlite" | "unknown"` is the
   only occurrence of those literals anywhere in `src/` or `tests/`, and it is disjoint
   from the live `SESSION_ADAPTER_ID` vocabulary (claude, codex, hermes, opencode, grok).

4. **Nothing can answer "which session logs exist on this machine and which were never
   imported".** `o2b brain import-session <path>` requires an explicit path. No session
   adapter knows where its own logs live — verified, there is no `homedir`, no
   `process.env` and no path join anywhere under `src/core/brain/sessions/`; the log
   roots exist only as English prose in docblocks. Meanwhile a PARALLEL subsystem,
   `src/core/discipline/transcripts/`, does know roots for claude-code, codex and cursor
   and scans them by mtime day-window for activity metrics — a different question with
   the same input.

5. **Codex is a distribution target this project already maintains, with no install
   adapter.** `.codex-plugin/plugin.json` and `plugins/codex/.codex-plugin/plugin.json`
   are versioned manifests; `codex-json` session import already exists. `install/codex.md`
   documents a manual `codex mcp add ...` procedure and is currently listed in the
   conformance test's `PIPELINE_HOSTED_DOCS` exception map. Verified on a live machine:
   `codex mcp add|remove|list --json` works and `~/.codex/config.toml` holds
   `[mcp_servers.<name>]` with `command` and `args`. The `copilot-cli` adapter is the
   existing precedent for a subprocess-primary adapter with an injectable runner and a
   file-merge fallback.

6. **There is no committed project-level tier feeding install and hook generation, and
   no resolver anywhere reports where a value came from.** Correction to the original
   task text: a committed vault-level config DOES exist — `<vault>/Brain/_brain.yaml`,
   read by `src/core/brain/policy/load.ts` with a per-block safe-loader family. What is
   missing is (a) install/hook generation never reads it, and (b) `ConfigDiscovery` is
   `{path, exists, data}` with no provenance, so an rc value that silently loses to a
   stale user-level key is indistinguishable from one that won. The single choke point
   is `envOrConfig(env, config, envKey, configKey)` in `src/core/validate.ts:100-111`,
   which drives roughly 55 search keys plus `search_db_path`.

7. **State surfaces are scattered with no inventory.** Roughly fourteen surfaces under
   `<vault>/.open-second-brain/` (search index + its query-cache table + writer lock,
   secret custody, ingest manifest, ingest checkpoints, install manifest, protect
   manifest, maintenance lease, maintenance journal, hook audit, watchdog audit, inject
   fail-open cache, aider context artifact) and roughly twenty under `<vault>/Brain/`,
   each resolved by its own function. There is no single command answering "where does
   every state surface actually live, is it reachable, and what override put it there",
   no digest-bound migrate/rollback, and no graceful drain: `src/mcp/http.ts` has no
   signal handling at all and `HttpServerHandle.close` does not await in-flight requests.
   Prior art that must be extended rather than duplicated: `OUT_OF_VAULT_STATE` in
   `src/core/install/ownership.ts:125-259` is already a declared population of
   out-of-vault state with a sweep test demanding every home/XDG/temp-rooted path builder
   in the tree be attributed to a row or excused with a written reason, and
   `SearchIndexVerdict` there is already a `inside_vault | outside_vault | unchecked`
   plus path plus reason tri-state.

8. **The MCP and CLI maintenance surfaces have drifted apart two releases running.**
   `brain_dream` action=step returns `runDreamStep(vault, step)` with no safeguard while
   every sibling branch builds one; `scanBrain(vault)` and `runHealEnrichment(vault)`
   accept no options at all. `brain_maintenance` has no per-task retry while the CLI has
   `--retry`, and the lane's own streak refusal message tells the caller to use `--retry`
   — a flag an MCP caller cannot reach. Root cause: the four lane task names are not a
   closed vocabulary. `MaintenanceTask.name` is a bare `string` and the names live as
   inline literals in two independent lists.

9. **Session parsing is monolithic and the transcript corpus has no way out.** All five
   session adapters do `readFileSync` then `split("\n")`, so peak memory is about twice
   the file size before the first turn is yielded, and `async *iterate` yields lazily
   over an already-materialised array. Autodetect reads the whole file a second time.
   Separately, `export type ExportFormat = "json" | "llms-txt"` at
   `src/core/brain/export.ts:83` is declared and never imported — the CLI verb inlines
   the two literals — and there is no path from recorded session transcripts to any
   machine-consumable dataset.

The design question this brainstorm must answer is the shape of the shared substrate:
where per-runtime and per-state-surface knowledge is declared, who reads it, and how it
is proved. Nine units either collapse onto one honest abstraction or become nine
independent additions that will drift apart the same way items 3, 6 and 8 already did.

# Project context

Open Second Brain — TypeScript on Bun, a CLI (`o2b`) plus two MCP servers over an
Obsidian-compatible Markdown vault. The vault is replicated by Syncthing; there is no
git transport and every `git` invocation under `src/` is read-only.

Recent commits:
```
b49af81e feat: a label is not a boundary (v1.49.0) (#166)
280469d2 feat: nothing runs unwatched (v1.48.0) (#165)
aa818084 feat: wiring what exists (v1.47.0) (#164)
a6d10dab feat: evidence at the boundary (v1.46.0) (#162)
29ea0099 fix: the flush that never landed (v1.45.1) (#158)
8d05a62a feat: silence is not an answer (v1.45.0) (#159)
34f96b84 fix: reuse and reap Hermes MCP bridges (v1.44.1) (#156)
3ee1963a feat: what the index already knew (v1.44.0) (#157)
0ae4b097 feat: provenance at the boundary (v1.43.0) (#154)
7e6a5672 refactor: module boundaries and the fallbacks behind them (v1.42.0) (#153)
5ac866eb feat: signals that survive (v1.41.0) (#152)
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0) (#151)
f91a698b feat: context integrity gates (v1.39.0) (#150)
c31a2574 feat: semantic-health baseline watermark (v1.38.0) (#148)
b0c37977 feat: retrieval quality and context delivery (v1.37.0) (#146)
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
```

Related files:
- `src/core/install/types.ts`, `registry.ts`, `payload.ts`, `payload-equals.ts`,
  `manifest.ts`, `json-merge.ts`, `identity.ts`, `grok-asset.ts`, `ownership.ts`
- `src/core/install/adapters/` — `_json-mcp.ts`, `cursor.ts`, `gemini-cli.ts`, `kiro.ts`,
  `opencode.ts`, `copilot-cli.ts`, `grok.ts`, `aider.ts`, `pi.ts`, `generic.ts`, `all.ts`
- `src/mcp/profiles.ts`, `capabilities.ts`, `tool-contract.ts`, `server.ts`, `http.ts`,
  `tools.ts`, `coerce.ts`, `brain/admin-tools.ts`, `brain/feedback-tools.ts`, `brain/shared.ts`
- `src/core/brain/sessions/` — `types.ts`, `registry.ts`, `import.ts`, and five adapters
- `src/core/discipline/transcripts/` — `types.ts`, `claude-code.ts`, `codex.ts`, `cursor.ts`, `index.ts`
- `src/core/brain/ingest/content-manifest.ts`, `checkpoint.ts`
- `src/core/brain/export.ts`, `src/cli/brain/verbs/export.ts`
- `src/core/egress/guard.ts`, `src/core/egress/registry.ts`
- `src/core/integrity/digest.ts`, `src/core/brain/dedup-hash.ts`
- `src/core/config.ts`, `src/core/validate.ts`, `src/core/types.ts`,
  `src/core/brain/policy/load.ts`, `src/core/brain/paths.ts`, `src/core/brain/path-constants.ts`
- `src/core/brain/safeguard.ts`, `progress.ts`, `dream-step.ts`, `dream-scan.ts`,
  `heal-run.ts`, `maintenance/lane.ts`, `maintenance/journal.ts`
- `src/core/doctor.ts`, `src/core/doctor-readiness.ts`, `src/core/maintenance/ensure-current.ts`
- `src/cli/main.ts`, `src/cli/command-manifest.ts`, `src/cli/install/`,
  `src/cli/brain/verbs/` (`maintenance.ts`, `import-session.ts`, `upgrade.ts`, `doctor.ts`)
- `tests/core/architecture/` — `egress-census.test.ts`, `write-site-census.test.ts`,
  `destructive-site-census.test.ts`, `progress-census.test.ts`,
  `verdict-vocabulary-census.test.ts`, `import-cycles.test.ts`
- `tests/docs/install-verify-conformance.test.ts`, `tests/cli/manifest-completeness.test.ts`,
  `tests/cli/progress-emitter-census.test.ts`, `tests/cli/help-surface-parity.test.ts`

Conventions:
- Closed vocabulary house pattern: a frozen object, a union derived from it, a frozen
  members array, and a type guard. Used correctly by `SESSION_ADAPTER_ID`
  (`src/core/brain/sessions/types.ts:37-60`), `TOOL_SCOPE`, `MAINTENANCE_VERDICT`,
  `OPERATION`. The install subsystem uses a weaker `Set`-plus-conditional-type form with
  no guard and has no target-id vocabulary at all.
- Census and ratchet tests derive their population STRUCTURALLY from source or from a
  live registry, never from a hand-written list. Exceptions are declared in a frozen map
  with a written reason of a minimum length. A census that found nothing must fail. A
  count that has drifted is pinned as an equality, not a floor. There is a shared source
  lexer at `tests/helpers/source-lexer.ts`.
- Install verification works by RE-CONSTRUCTION, never a stored hash: same input yields
  byte-identical output, which is what makes `--apply` idempotent and lets `verify()`
  detect drift. `expectedPayloadFromEnv(env)` recomputes from `InstallEnv` alone.
- Mutating commands preview by default. The canonical ladder is
  `src/cli/brain/verbs/upgrade.ts`: `--dry-run` and `--apply` mutually exclusive,
  `--check` exits 2 when work pends, `--apply` refused without `--yes` when `--json` or
  a non-TTY, a TTY prompt accepting only y/yes, and a pre-apply snapshot.
- Anything leaving the vault passes `redactForEgress` and carries a declared entry in
  `EGRESS_SITES`; the egress census counts guard calls against destination declarations
  in the same module.
- Any options type that accepts a `Safeguard` must also accept a `ProgressSink`, or
  carry a written exemption. Progress stage names are identifiers, never prose.
- The kernel calls no model. LLM work leaves through a `needs-llm-step` envelope.
- Public artifacts use the full project name, never an abbreviation.

Constraints:
- No new external dependencies.
- No misleading fallbacks. A path that silently does nothing, or degrades without saying
  so, is forbidden; an error must be explicit and name its remedy. No stubs.
- No hardcoded natural-language word lists of any kind. Language-specific behaviour must
  be expressed structurally.
- Do not break existing public CLI or MCP surfaces. Existing generated install output
  must stay byte-identical unless a change is deliberate and pinned by an updated
  expected-output block.
- Adding an argument to the generated MCP payload is only safe if the new dimension is
  derivable from `InstallEnv`, because `verify()` recomputes the expected payload from
  `InstallEnv` alone and would otherwise report permanent drift.
- `Operation` (used by both the safeguard and the progress rail) is a closed enum;
  adding a long-running operation means adding a member and satisfying both censuses.
- The work must land as separable atomic units on one branch, each independently
  testable, because they ship as one release.
- SOLID, KISS, DRY. Anything that can be lifted into a shared local or module constant
  should be.

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
