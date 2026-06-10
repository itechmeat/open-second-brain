# opencode native integration - brainstorm audit trail

Consultant: Claude Code (`claude -p`), 2026-06-10. Prompt: `cli-output/prompt.md`. Raw output: `cli-output/claude.md`.

## Variants produced

### Variant 1: Config-surface only (no plugin)

- **Approach**: Rewrite `src/core/install/adapters/opencode.ts` to write the real `~/.config/opencode/opencode.json` (extending `createJsonMcpAdapter` with a pluggable entry-shape transform to emit `{type: "local", command: [...], environment, enabled}`), migrate and delete the stale `mcp.json`, and wire rules via the native `instructions` key pointing at the vault's active-context file. Session parity comes from a new session adapter in `SESSION_ADAPTERS` that parses opencode's on-disk storage under `~/.local/share/opencode/storage/`. No plugin is shipped.
- **Trade-offs**:
  - Pro: smallest surface; everything fits the existing install-adapter and session-adapter patterns with zero new runtime pieces.
  - Pro: nothing runs inside opencode, so fail-soft is trivial.
  - Con: the storage format is undocumented and unstable; the importer will silently break on opencode upgrades and fixtures will drift from reality.
  - Con: no live behavior at all - no session-start context inject timing, no idle/compact capture triggers, no post-write reminders; clearly below Claude Code/Codex parity.
  - Con: `instructions` injects statically per config load, not per session, so freshness of active context is weaker.
- **Complexity**: small
- **Risk**: high

### Variant 2: Bundled self-contained plugin plus spool-file session adapter

- **Approach**: The install adapter does three things: writes the correct `mcp` entry into `opencode.json` (via the extended `_json-mcp.ts` entry-shape hook), migrates the stale `mcp.json`, and copies a single zero-dependency bundled plugin file into `~/.config/opencode/plugins/`. The plugin uses public hooks only: on `session.created` it injects active context (spawning `o2b` or reading `Brain/active.md`, wrapped in try/catch for fail-soft), and on `session.idle` / `session.compacted` / `session.deleted` it pulls messages through the SDK `client` and appends a normalized JSONL spool file; a fourth session adapter (`opencode`) with `detect(firstLine)` plus `iterate(path)` imports that spool through the existing registry, exactly like claude/codex/hermes. Rules ride on native AGENTS.md support.
- **Trade-offs**:
  - Pro: the JSONL format is owned by Open Second Brain, so the session adapter and its fixtures are stable and fully testable offline; the only untested-on-CI piece is the thin plugin, which is a pure function testable with a fake `client`.
  - Pro: reuses every existing pattern (install lifecycle, manifest, drift detection, session registry) and keeps the MCP server runtime-agnostic.
  - Pro: fail-soft is localized in one small plugin file; opencode keeps working if vault or binary is absent.
  - Con: capture is event-driven only; sessions where opencode crashes before `session.idle` may lose the tail.
  - Con: a copied plugin file can drift from the installed o2b version; needs a version marker plus drift check in the manifest.
  - Con: some hooks used for niceties (`experimental.chat.system.transform`) are experimental; must degrade gracefully.
- **Complexity**: medium
- **Risk**: low

### Variant 3: npm-distributed plugin with live streaming capture

- **Approach**: Publish `@open-second-brain/opencode-plugin` to npm and register it under the `plugin` key in `opencode.json`; the install adapter only edits config. The plugin streams continuously: `message.updated` and `tool.execute.after` events are translated into the existing hook payload protocol and piped to the bundled `o2b-hook` binary on stdin (extending `hooks/lib/detect.ts` with an opencode payload shape), so capture, reminders, and guardrails all flow through the same hook layer Claude Code and Codex use, with no import adapter and no spool files.
- **Trade-offs**:
  - Pro: deepest parity - the opencode runtime becomes a first-class peer in the existing hook layer rather than a parallel path; capture is real-time with no tail loss.
  - Pro: opencode-native distribution with version pinning and auto-install; no copied-file drift.
  - Con: requires a publish pipeline and network at user install time; dev and CI machines without network cannot exercise the real install path.
  - Con: lockstep versioning between the npm plugin and the local o2b binary becomes an ongoing release burden.
  - Con: per-message spawning of the hook binary is chatty and harder to fixture-test end to end; failure modes multiply.

- **Complexity**: large
- **Risk**: medium

### Consultant recommendation: Variant 2

Variant 2 reaches genuine parity (live context inject, event-driven capture, registry-based session import) while keeping every risky dependency under the project's control: the spool JSONL is an owned format, the plugin is one self-contained file shipped by the existing install framework, and everything is testable from fixtures with opencode absent, which Variants 1 and 3 cannot claim. Variant 1 stakes session capture on an undocumented storage format, and Variant 3 buys marginal extra parity at the cost of a publish pipeline, network-dependent installs, and lockstep versioning that contradict the zero-dep and offline-test constraints.

## Orchestrator decision

Variant 2, accepted as recommended. Project context confirms the consultant's reasoning on every axis that matters here: the repo's test discipline requires offline fixtures (opencode is absent on the dev server and CI), the install framework already carries manifest plus drift detection that a copied plugin file slots into, and the project has been burned before by reverse-engineered third-party formats (the session adapters deliberately parse only documented or self-owned shapes). No override needed.

Two scope refinements on top of the consultant's sketch, both subtractive:

1. The Claude Code `stop-log-guardrail` has no opencode analog - opencode exposes no blocking stop hook. Explicitly out of scope rather than approximated through `session.idle`, which cannot block and would only add noise.
2. The `instructions` config key is not wired by the install adapter. opencode reads AGENTS.md natively, and the active-context freshness problem is solved by the plugin's per-session inject; a third, statically-loaded context channel would duplicate content.
