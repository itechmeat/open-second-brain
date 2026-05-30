# Test matrix

## MCP capability layer

- Full scope with no constraints advertises the default candidate set plus capability diagnostics.
- Writer scope remains narrower than full scope.
- Runtime deny hides a named tool and reports reason.
- Runtime allow cannot widen writer scope.
- Probe JSON returns report fields: `scope`, `available`, `withheld`, `tool_count`.

## CLI JSON layer

- Existing semantic JSON command keeps its existing shape.
- Text-only command with `--json` returns fallback envelope.
- CLI usage errors can be represented as JSON when `--json` is present.
- Secret-shaped output is redacted in fallback JSON.

## Completions

- Supported shells: `bash`, `zsh`, `fish`, `elvish`, `nushell`, `powershell`.
- Output includes root commands, `brain` verbs, and common flags.
- Unsupported shell returns usage error.
