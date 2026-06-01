# Self-Learning Skill Proposals - implementation plan

## Phase 0 outcome

Recommended architecture: file-first, dream-adjacent modules for proposal learning, procedural memory, and recurrence support. The modules share deterministic helpers but do not merge into one engine and do not modify the existing `dream` preference path.

## Phase 2 TDD plan

1. **Brain path and artifact contracts**
   - Add tests for proposal/procedure/procedural-index/recurrence paths staying inside `Brain/` and rejecting unsafe slugs.
   - Implement path helpers and any narrow shared types.
   - Commit: `feat(brain): add procedural learning artifact paths`.

2. **Skill proposal storage and detectors**
   - Add failing core tests for repeated-action, structural-similarity, co-occurrence, temporal-routine, duplicate suppression, and watermark advancement.
   - Implement deterministic proposal scan over Brain log/session events with conservative detector rules and stable slug/hash behavior.
   - Commit: `feat(brain): detect skill proposal patterns`.

3. **Proposal review lifecycle**
   - Add failing core and CLI tests for list/show/accept/reject, accepted procedure artifact creation, rejected proposal suppression, audit metadata, and JSON output.
   - Implement proposal review core and CLI verbs.
   - Commit: `feat(brain): add skill proposal review workflow`.

4. **Procedural memory reconciler**
   - Add failing tests for frontmatter parsing, scanning Brain procedures and installed skill/runbook roots, stale deletion, source-change updates, and stable IDs.
   - Implement procedural index and CLI list/reconcile behavior.
   - Commit: `feat(brain): index procedural memory entries`.

5. **Procedural usage sidecar**
   - Add failing tests proving usage updates do not rewrite source `SKILL.md`/procedure files and that last-used/count metadata appears in list/export output.
   - Implement usage sidecar and CLI mark-used behavior.
   - Commit: `feat(brain): track procedural memory usage`.

6. **Recurrence support ledger**
   - Add failing tests for same-scope duplicate support increment, cross-scope recurrence evidence, thresholded diagnostic promotion state, locked/no-auto-change behavior, reference-counted forget, and source purge.
   - Implement recurrence ledger and diagnostics without mutating preferences or auto-promoting scope.
   - Commit: `feat(brain): record procedural recurrence support`.

7. **MCP and integration surfaces**
   - Add focused MCP tests for read/diagnostic proposal/procedural surfaces if exposed.
   - Implement handlers only for surfaces that remove meaningful CLI friction.
   - Commit: `feat(mcp): expose procedural learning diagnostics` if needed.

8. **Docs and versioning**
   - Update CLI reference, MCP docs if applicable, README feature summary, CHANGELOG, and version files.
   - Run formatter/linter before commit as requested.
   - Commit: `docs: document procedural learning workflow` or version-specific release commit.

## Validation checklist

- Focused tests after each TDD unit.
- `bun run fmt` and `bun run lint` before every commit.
- Full QA before pre-push stop point: `bun run test`, `bun run typecheck`, `bun run lint`, version sync check if available, and `code_checker`.
- Self-review compares branch diff against `main` and checks the implementation against the selected task acceptance criteria.

## Stop points

- Phase 6 pre-push chat stop-point with Russian `ask_report` before pushing.
- Release/pre-release stop-point per feature-release-playbook after PR approval/merge flow.
