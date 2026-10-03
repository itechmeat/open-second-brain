You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release of Open Second Brain whose theme is "a setting or a rule meant for one context must not carry over into another".

1. Per-profile configuration for the Hermes memory plugin on multiplexed gateways. The Python plugin (`plugins/hermes/`) reads `VAULT_DIR`, `VAULT_AGENT_NAME`, `VAULT_TIMEZONE`, `OPEN_SECOND_BRAIN_CONFIG` (config.py) and `OPEN_SECOND_BRAIN_MCP_TIMEOUT` (bridge.py) straight from `os.environ`. A Hermes gateway with `multiplex_profiles: true` serves several profiles from one process; the process environment belongs to the launch profile. Hermes exposes `agent.secret_scope` with `is_multiplex_active()` and `get_secret(name, default)`, which reads the turn's bound profile scope and raises `UnscopedSecretError` when multiplexing is on and no scope is bound. The plugin also spawns one long-lived `o2b mcp` child per key `(vault, repo_root, command, PATH)` and gives it a copy of the gateway's environment, so the TypeScript core reads the launch profile's agent name and timezone from its inherited environment. `config.py` must stay importable without Hermes and without a package (a doctor check and a parity suite load it by file location and pin today's answers byte for byte). The plugin's existing `ConfigReadError` message is pinned by a parity test.

2. Standing rules scoped to project, harness and host, ranked below the operator's vault-wide constitution (`Brain/standing-rules.md`, read by `readStandingRules`, injected first by the SessionStart hook and by the `brain_context` MCP tool, exempt from the injection budget, refused to every write tool by the Brain-root refusal and a named guard). Today the server resolves no project, harness or machine identity: the `project` scope axis comes from page frontmatter or a tool argument, "host" in the code means an install target (a harness), `clientInfo` from MCP initialize is never read, and the only machine identity is an 8-hex device id kept in device-local config. `o2b mcp` already accepts `--host-target <install target id>` written by install adapters; the Claude Code plugin, Hermes and OpenClaw launch it without that flag, and those three are not install targets. A linked project directory carries a `.o2b-vault.json` pointer. Results at remote reach (a caller with no minted reach) must not depend on content withheld from that caller.

3. A small lane of reach left-overs from the previous release: the today brief view lists open loops (text and path) from pages hidden by visibility at remote reach; the monthly and operator brief views and two doctor counts (a removed-tool warning cap, a stale-dependency count) are computed over the whole layer.

# Project context

Open Second Brain, TypeScript on Bun 1.4.0 (part of src/ is also bundled for Node as the OpenClaw plugin), a Python 3.11 stdlib-only Hermes plugin, MCP server plus `o2b` CLI over an Obsidian-compatible Markdown vault.
Recent commits:
d49c4697 feat: ingest that reads CSV, TSV and HTML into table and parts sections, names the formats it skips and previews with o2b brain extract (v1.69.0) (#228)
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0) (#227)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0) (#215)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0) (#214)
0afa0c5a chore(deps): bump the bun-minor-and-patch group with 5 updates (#201)
f6212cd2 fix: quiet one-line Stop reminder via Claude Code feedback channel (v1.58.2) (#202)
534befdb chore(deps): bump the github-actions group with 3 updates (#200)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1) (#199)
6f33c424 feat: payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0) (#197)
a4d3ecf8 fix(codex): real plugin files and a truthful install check (v1.57.1) (#193)
d7e6094a feat: a second platform (v1.57.0) (#191)
Related files:
- plugins/hermes/config.py, plugins/hermes/bridge.py, plugins/hermes/provider.py, tests/python/test_resolver_parity.py
- src/core/brain/standing-rules.ts, src/core/brain/path-constants.ts, src/core/brain/paths.ts, src/core/scope-key.ts
- hooks/active-inject.ts, src/mcp/brain/context-tools.ts, src/mcp/server.ts, src/mcp/tool-contract.ts, src/cli/main.ts
- src/core/runtime/host-facts.ts, src/core/config.ts (resolveDeviceId), src/core/brain/portability/pointer.ts
- src/core/brain/open-loops.ts, src/core/brain/today-dashboard.ts, src/core/brain/monthly-review.ts, src/core/brain/trust/operator-summary.ts, src/core/brain/doctor/*
Conventions:
- Closed vocabularies are frozen objects with a census test; named error classes with structured fields; operator text is opaque bytes; every failure surfaces by name.
- Identity that decides scope is derived by the server, never named by the caller (precedent: origin channel, never a tool argument).
- The version bump and the CHANGELOG entry ride inside the feature PR.
Constraints:
- No new runtime dependency, no `os.hostname()`, no host names in public text.
- The vault-wide constitution file and its reader stay byte-identical; its header text and its budget exemption are pinned by tests.
- `brain_context` takes no input argument (`additionalProperties: false`); no scope may be caller-named.
- Local reach behaviour stays byte-identical for the left-overs; remote reach must not depend on withheld pages.
- Without Hermes multiplexing the plugin must answer exactly as today.

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
