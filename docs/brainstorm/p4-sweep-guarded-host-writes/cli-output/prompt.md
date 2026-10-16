# Consultant request: release wave structure for five cards on one branch

You are advising the Open Second Brain release wave `p4-sweep-guarded-host-writes`. Recon is complete for all five cards (premise verdicts, implementation surfaces, risks verified against the live tree). Decide how the wave is structured.

## The task

Five cards ship on one branch (`feat/p4-sweep-guarded-host-writes`), one pull request:

1. t_b6bcd984 - show a diff and ask consent before writing host client settings. Extends the existing diff-plus-fail-closed-consent patterns to the three unguarded write lanes: install JSON-merge into `~/.gemini/settings.json` and peers, `brain protect --apply` into the project `.claude/settings.json`, and `brain doctor --repair --apply`; the consent verdict is recorded in each lane's receipt.
2. t_f4555087 - back up host settings before any agent tool writes them. An opt-in PreToolUse hook that resolves tilde/relative/symlink paths to host settings files, copies the file to a timestamped backup, appends one receipt line (actor, pid, before-hash, summary), and refuses the write when the backup fails.
3. t_5198f0c7 - cursor pagination across MCP list tools. 23 list tools expose `limit` with no continuation cursor; the pattern to copy exists on decisions history, session expand and search expand.
4. t_7ff0b101 - decision-model adapter for bearer-authenticated Converse-protocol gateways. One more adapter on the existing route layer beside `systemone`, `vercel-evaluate` and `llm-emulation`, plus a preset with a declared threshold profile.
5. t_00e9de6a - snooze and movement-gated resurrection for the trigger attention queue. A `snooze` action (bounded window or next refire, whichever first) and dismissal that reopens only on changed `sourceArtifacts`.

Cards 1 and 2 are one cluster (host-settings-write-guards) and must tell one story; the other three are independent of them and of each other.

## Project constraints

- The implementation plan gives each lane a disjoint set of files. `src/core/config.ts` is owned by the trust lane only; the pagination lane owns the MCP list-tool surfaces and the census tests; the adapter lane owns `src/core/decision-model/**`; the trigger lane owns the trigger store and its CLI/MCP projections.
- Repo conventions any structure must respect: typed events are emitted only on a real write and a dry run emits nothing; JSON envelopes stay additive under schema_version 1; four census-style tests (agent-scope-matrix, visibility-surface-census, reader-census, maintenance-parity-census) must be updated in the same commit that changes the surfaces they census; the hook dispatcher is deliberately fail-soft and a deny can only be expressed via stdout JSON, so a standalone hook should stay stdlib-only; openclaw/index.js is a committed build artifact that must be rebuilt after any src/ edit; every task is test-first.
- The consent lanes deliberately break headless callers (doctor repair, protect, install now require an explicit yes under CI/non-TTY); this must be handled as a documented, deliberate edge.

## Required output format

Exactly three variants. Each variant states: the approach (what is shared, what is not, and in what order lanes run), the trade-offs (including per-feature risks where they shape the structure), the complexity, and the risk. The variants must genuinely differ on how much machinery is shared across lanes and whether shared work is serialized before the lanes. End with a single recommendation and its rationale.
