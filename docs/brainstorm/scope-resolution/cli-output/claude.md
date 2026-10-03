### Variant 1: Three local seams

- **Approach**: Each lane is fixed where it lives today. In `config.py`, every resolver gains an optional `env: Mapping[str, str]` parameter defaulting to `os.environ`, and `provider.py` builds a per-turn mapping from `agent.secret_scope.get_secret` when `is_multiplex_active()` is true, keying the `o2b mcp` child by `(vault, repo_root, command, PATH, agent_name, timezone)` and passing those two as env overrides to the spawn. Scoped standing rules become sibling files under a new `Brain/standing-rules/` directory (`project/<slug>.md`, `harness/<id>.md`, `host/<device-id>.md`) read by a second reader that appends ranked blocks after the untouched constitution; identity is resolved inline in `server.ts` at `initialize` (clientInfo name mapped through a frozen harness vocabulary, cwd or MCP roots walked for `.o2b-vault.json`, device id from config) and in the hook from cwd and a harness constant. The three left-over views and two doctor counts each take the reach-filtered page list the v1.68 reach-aware reader already produces.
- **Trade-offs**:
  - Pro: smallest diff, every change is near the code it corrects, parity suite and the pinned `ConfigReadError` message untouched because the default argument preserves today's reads byte for byte.
  - Pro: no wire change, no new runtime dependency, scoped rules are plain files an operator can edit in Obsidian.
  - Con: identity derivation lives in two places (server initialize and hook), so the harness vocabulary and the project walk-up can drift between them.
  - Con: per-view reach filtering is five separate edits, each a chance to miss a count that still reads the whole layer.
  - Con: the child-per-profile key multiplies long-lived `o2b mcp` processes on a gateway with many profiles sharing one vault.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: One derived session identity, one rules ladder, one reach layer

- **Approach**: A new `src/core/runtime/session-identity.ts` computes a frozen `{ project, harness, host }` triple exactly once per process from server-held facts only: `--host-target` or the `initialize` clientInfo name mapped through a closed `HARNESS_ID` vocabulary with a census test, the `.o2b-vault.json` walk-up from the server cwd or first MCP root for project, and the device id for host, with a typed `IdentityUnresolved` reason per axis instead of a guess. A `standing-rules-ladder.ts` module reads the constitution with the existing reader and then the scoped files under `Brain/standing-rules/`, ranks them vault, project, harness, host, and renders one block that both the SessionStart hook and `brain_context` consume; the Brain-root refusal plus the named guard extended to the directory keep them unwritable. The Hermes plugin gets a `ProfileSettings` value resolved per turn through a tiny `settings_source` protocol (environ by default, secret scope under multiplexing) that `config.py` functions accept as an argument, and the bridge keys children by that value and overrides their env; the left-overs read from a `ReachLayer` object that pre-filters pages once per request and is passed to the three views and two doctor counts.
- **Trade-offs**:
  - Pro: identity decided in one server-owned module matches the origin-channel precedent and is testable as a vocabulary census; scoped rules can never be caller-named because the ladder takes the triple, not arguments.
  - Pro: a single `ReachLayer` makes "remote never depends on withheld pages" a property of the input rather than of five call sites, and local reach passes the unfiltered layer so bytes stay identical.
  - Pro: `UnscopedSecretError` maps to one new named `ProfileScopeError` sibling of `ConfigReadError`, so the pinned message survives and the failure surfaces by name.
  - Con: largest surface area in one release, touching hook, MCP, CLI, Python and five readers at once.
  - Con: the ladder must decide what to inject at remote reach for a caller whose project and host are meaningless, which needs an explicit rule (constitution only) rather than falling out of the design.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Scope axes extended, identity carried on the wire

- **Approach**: Scoped rules are ordinary Brain pages under `Brain/rules/` whose frontmatter uses the existing `scope-key.ts` vocabulary, with `harness` and `host` added to `SCOPE_AXES`, so selection reuses composite-scope matching and search filters. Identity still comes from the server, but the Hermes plugin stops spawning a child per profile: one child per vault serves all profiles and the bridge attaches the turn's agent name and timezone as JSON-RPC `_meta` on each `tools/call`, which the server reads as transport facts (not tool arguments) and uses to override the inherited environment for that call. Reach is pushed down into the page index so every reader, including the three views and two doctor counts, is filtered without per-site edits.
- **Trade-offs**:
  - Pro: no process multiplication on multiplexed gateways and rules participate in search, backlinks and dedup like any page.
  - Pro: one index-level reach filter covers the left-overs and any future reader.
  - Con: extending `SCOPE_AXES` changes dedup and source-identity keys across search and the query cache, a wide blast radius unrelated to the theme.
  - Con: per-call `_meta` makes agent name a request-time property; every code path that read it from process env at startup (write receipts, ledgers, logs) must become request-scoped or it carries the launch profile over anyway.
  - Con: an index-level reach filter changes what local readers see unless gated carefully, and the "byte-identical at local reach" pin is hard to prove.
  - Con: `Brain/rules/` pages sit outside the Brain-root refusal story of `standing-rules.ts`, so uneditability has to be re-argued.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It is the only variant where identity, rule ranking and reach filtering each have exactly one owner, which is what the release theme demands and what the project's conventions already reward (closed vocabularies with a census, server-derived identity, failures named by class). Variant 1 is cheaper but leaves the harness vocabulary and project walk-up duplicated between hook and server, the exact kind of drift that lets one context carry over into another. Variant 3 reaches into search keys and the page index and would break the byte-identical pins the constraints require.
