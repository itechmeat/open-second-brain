# Grok Build native integration - brainstorm variants

**Consultant:** Claude Code (`claude -p`), primary, exit 0. Fallback (codex) not needed.
**Orchestrator:** claude-dev-agent (via feature-release-playbook)
**Decision:** Accept the consultant recommendation (Variant 2) without override.

---

## Consultant output (verbatim)

### Variant 1: Native config.toml writer
- **Approach**: Extend the install-adapter registry with a grok adapter that writes the two canonical MCP entries directly into `~/.grok/config.toml` `[mcp_servers.*]` and drops the three lifecycle hooks into `~/.grok/hooks/*.json` (Claude-compatible JSON shape). A grok `SessionAdapter` reads the ACP `updates.jsonl` + `summary.json` stream. No plugin; integration lives entirely in grok's own first-class config surfaces.
- **Trade-offs**:
  - Pro: maximally native to grok's authoritative surfaces; pure-grok users with no `~/.claude` are served directly with zero compat-merge dependency.
  - Pro: `summary.json.parent_session_id` feeds the existing session-lineage work cleanly; hooks get `GROK_HOOK_*`/`CLAUDE_PROJECT_DIR` env for free.
  - Con: config.toml is TOML and the project ships no TOML lib - forces a hand-rolled minimal emitter/patcher for the `[mcp_servers.<name>]` table, which `serializeEntry` does not currently cover (new on-disk shape + drift detection for TOML).
  - Con: produces no marketplace-publishable unit, so goal (b) is unmet; the integration is invisible to `grok plugin`/marketplace tooling.
  - Con: the canonical `McpServerEntry` must be projected into TOML rather than reused as-is, a new serialization seam that can drift from the JSON targets.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Bundled grok plugin as the first-class unit (opencode-style two-pronged)
- **Approach**: Ship a version-stamped grok plugin asset (mirroring `opencode-plugin-asset.ts`): a directory with `plugin.json`, `.mcp.json` in MCP standard format carrying the two canonical entries, and `hooks/hooks.json` for the three lifecycle hooks. The install adapter places it under `~/.grok/plugins/` and force-enables it (config.toml `[plugins] enabled` / `--trust` path), and a grok `SessionAdapter` imports the ACP session stream. The plugin is the marketplace-publishable unit.
- **Trade-offs**:
  - Pro: hits all four goals - pure-grok install path, marketplace-publishable first-class unit, and heavy reuse of the opencode-plugin-asset pattern + session-adapter registry.
  - Pro: MCP lives in `.mcp.json` (standard JSON) so the canonical `McpServerEntry` is reused verbatim with zero TOML for MCP - strongest DRY/anti-drift posture.
  - Pro: precedent #88 proves the config-write + bundled-plugin + session-adapter shape end to end.
  - Con: plugins are disabled by default - the adapter must reliably force-enable (config.toml `[plugins] enabled` append or `grok plugin install --trust`), a narrow TOML touch and a footgun if skipped, which the verify step must assert against.
  - Con: two delivery artifacts (plugin asset + thin config write) to keep version-synced, slightly more surface than a pure config writer.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Claude-compat piggyback shim
- **Approach**: Lean on grok's auto-merge of `~/.claude.json` MCP and `~/.claude/settings.json` hooks via `[compat.claude]`; for pure-grok users, the existing Claude Code adapter writes those Claude-format files, and the only new code is a grok camelCase hook-stdin branch plus the grok `SessionAdapter`. Smallest possible footprint.
- **Trade-offs**:
  - Pro: minimal new code - reuses the Claude adapter outputs almost entirely; only the stdin parser and session adapter are grok-specific.
  - Con: writing `~/.claude.json` / `~/.claude/settings.json` for a user who runs only grok is exactly the silent workaround the constraints forbid (maximally native, no crutches); it pollutes a foreign vendor's namespace.
  - Con: relies on compat-merge priority (config.toml > Claude > Cursor) staying stable across grok versions - fragile, no first-class ownership/drift tracking.
  - Con: yields no marketplace unit (goal b fails) and is not "first-class native" (goal a is served only by impersonating Claude).
- **Complexity**: small
- **Risk**: high

### Recommended: Variant 2
**Rationale**: Only Variant 2 satisfies all four sub-goals at once - it serves pure-grok users via a real install/enable path, ships the marketplace-publishable first-class plugin, and maximally reuses the existing seams (opencode-plugin-asset, `.mcp.json` standard format preserving the canonical `McpServerEntry`, session-adapter registry, hook lib). Routing MCP through the plugin's `.mcp.json` keeps grok off the TOML path entirely for the canonical payload, avoiding both the hand-rolled emitter that burdens Variant 1 and the namespace-impersonation workaround that disqualifies Variant 3, while #88 already proves the two-pronged shape end to end.

---

## Orchestrator final rationale

Accepted Variant 2 without override. It is the only variant consistent with the project's
explicit constraints (maximally native, no crutches, reuse seams) AND the operator's stated
preference to never impersonate or diverge from a foreign vendor's conventions. Variant 3 is
rejected outright: writing into `~/.claude.json` for a pure-grok user is precisely the kind
of misleading workaround the brief forbids. Variant 1 is native but yields no marketplace
unit and forces a TOML serialization seam for the MCP payload that would drift from every
other target.

The one design fork the recommendation leaves open - how to force-enable the plugin (grok
disables plugins by default) - is resolved in `design.md`: copy the bundle into
`~/.grok/plugins/<name>/` (auto-trusted) and ensure a `[plugins] enabled` entry through a
minimal, offline-testable TOML section/array helper, rather than shelling to `grok plugin
install --trust` (which would add a hard runtime dependency on the grok binary and break the
project's offline-unit-testable-adapter convention). MCP itself stays entirely in the
plugin's `.mcp.json`, so no TOML touches the canonical MCP payload.
