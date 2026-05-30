# Agent capability + CLI integration - runtime-aware tools and scriptable CLI

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain currently exposes MCP tools through a static `ToolScope` (`full` or `writer`) and has no runtime capability report that explains which tools are available under the current process constraints. The CLI has many useful JSON branches, but `--json` is not globally accepted and command discovery/completions do not come from a shared command manifest. Agents therefore need per-command parsing knowledge, and operators get no completion support for the long `o2b` command tree.

## Scope

- Add a runtime capability layer for MCP tools that evaluates after static `ToolScope`.
- Expose capability diagnostics through an always-available MCP diagnostic tool and `o2b mcp --probe --json`.
- Add a dependency-free CLI command manifest for root commands and major nested command groups.
- Make `--json` an inherited CLI flag so unsupported commands can still return a structured fallback envelope instead of rejecting the flag.
- Add `o2b help --json` and `o2b completions <shell>` backed by the same CLI manifest.
- Support shell completion output for `bash`, `zsh`, `fish`, `elvish`, `nushell`, and `powershell` without a new CLI framework dependency.

## Out of scope

- Replacing the handwritten CLI parser with commander/yargs or another framework.
- A single unified registry for both MCP tools and CLI commands.
- Provider-specific LLM capability probing, token-cost accounting, or subagent orchestration.
- Changing existing successful human-readable CLI output.
- Moving selected Hermes tasks out of `triage` before release closure.

## Chosen approach

Use the consultant's Variant 3. The CLI gets one manifest that drives machine-readable discovery and completions, while MCP runtime capability checks remain a small independent layer over `buildToolTable(scope)`. Default behavior remains backward-compatible: without runtime constraints, the full/writer tool lists stay equivalent except for the new diagnostic tool, and existing commands with semantic JSON keep their existing JSON payloads.

## Design decisions

- Keep static scope as the first filter. Runtime checks never widen a static writer scope into full access.
- Add an explicit capability report instead of silent filtering. The report includes advertised and withheld tools with reasons.
- Keep the capability model deterministic and local. The first implementation supports explicit allow/deny constraints and resource-window limits from runtime options/CLI flags; no network calls or provider SDKs.
- Prefer fallback JSON over a mass rewrite of every command renderer. Existing commands that already implement semantic `--json` keep that shape; commands without semantic JSON can return `{ ok, command, code, stdout, stderr }` from a global wrapper.
- Redact secret-shaped fields in fallback envelopes using a shared helper before writing JSON.
- Generate completions from the manifest, not from duplicated hand-written scripts.

## File changes

Expected new files:

- `src/mcp/capabilities.ts`
- `src/cli/command-manifest.ts`
- `src/cli/completions.ts`
- `src/cli/json-helpers.ts`
- `tests/mcp/runtime-capabilities.test.ts`
- `tests/cli/cli-json-contract.test.ts`
- `tests/cli/completions.test.ts`

Expected modified files:

- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `src/cli/argparse.ts`
- `src/cli/main.ts`
- `src/cli/brain/helpers.ts`
- `docs/mcp.md`
- `docs/cli-reference.md`
- `README.md`
- `CHANGELOG.md`
- version-bearing package/plugin files during the pre-push docs/version phase

## Risks and open questions

- Some existing tests may assert raw text for commands that will now accept `--json`; fallback JSON must be opt-in and must not change default output.
- Wrapping stdout/stderr for fallback JSON needs careful implementation so commands with existing semantic JSON are not double-wrapped.
- Completion scripts should be useful without pretending to model every dynamic positional argument perfectly.
- Tool count docs must be updated after the diagnostic MCP tool is added.
