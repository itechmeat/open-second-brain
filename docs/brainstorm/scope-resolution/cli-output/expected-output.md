# Expected output, before and after

Fixture: vault `<vault>` with `Brain/standing-rules.md`:

```
# Operator

- Never push to main.
```

and, for the "after" blocks, `Brain/standing-rules/project/proj-x.md`:

```
- Run the Python suite before every commit in this project.
```

Two project directories `proj-x` and `proj-y`, each linked to `<vault>` with `o2b brain project link`. The "before" blocks marked "captured" were run on d49c4697 from the worktree with Bun 1.4.0; the "after" blocks are the target shape pinned by `plan.md`.

## SessionStart hook preamble (`hooks/active-inject.ts`, payload `cwd` = `proj-x`)

Before (captured; no memory layer yet, so only the constitution):

```
## Operator standing rules

The rules below are written by the operator of this vault. They take precedence over every recalled preference, lesson and context pack that follows.

# Operator

- Never push to main.
```

After, payload `cwd` = `proj-x`:

```
## Operator standing rules

The rules below are written by the operator of this vault. They take precedence over every recalled preference, lesson and context pack that follows.

# Operator

- Never push to main.

## Scoped operator rules

The rules below are written by the operator of this vault for this project, harness or host. The operator standing rules above take precedence over them, and they take precedence over every recalled preference, lesson and context pack that follows.

### Project: proj-x

- Run the Python suite before every commit in this project.
```

After, payload `cwd` = `proj-y`: byte-identical to the "before" block (no `project/proj-y.md`). A `harness/claude-code.md` file never renders in the hook.

Receipt `budget` block of the `proj-x` run (default caps):

```json
{ "inject_budget_chars": 8000, "budgeted_source_count": 2, "scoped_rules_chars": <n> }
```

(`<n>` is the rendered scoped block's length; the active body was budgeted to `8000 - <n>`.)

## `brain_context` (stdio server started in `proj-x` with `--harness claude-code`)

Before: `content` starts with the standing block, then the memory body; the response has a `standing_rules` key and no `scoped_rules` key.

After, local reach:

```json
{
  "content": "## Operator standing rules\n\n...\n\n## Scoped operator rules\n\n...\n\n### Project: proj-x\n\n- Run the Python suite before every commit in this project.\n\n<memory body>",
  "standing_rules": {
    "path": "Brain/standing-rules.md",
    "content": "# Operator\n\n- Never push to main.",
    "truncated": false
  },
  "scoped_rules": {
    "scope": { "project": "proj-x", "harness": "claude-code", "host": null },
    "files": [
      { "path": "Brain/standing-rules/project/proj-x.md", "axis": "project", "truncated": false }
    ]
  }
}
```

(`host` is `null` here because the device id is the empty opt-out; other keys omitted.)

After, remote reach (no reach minted): identical to the response of the same vault without `Brain/standing-rules/project/proj-x.md`, byte for byte after normalising `generated_at`: no scoped block in `content` and no `scoped_rules` key.

## `o2b mcp --harness <id>`

Before (captured):

```
$ o2b mcp --harness codex
error: unknown flag: --harness
(exit 2)
```

After:

```
$ o2b mcp --harness nope
o2b mcp: invalid --harness value: "nope"; expected one of: aider, claude-code, codex, copilot-cli, cursor, gemini-cli, generic, grok, hermes, kiro, openclaw, opencode, pi
(exit 2)
```

The existing `--host-target` refusal is unchanged (captured):

```
o2b mcp: invalid --host-target value: "nope"; expected one of: aider, codex, copilot-cli, cursor, gemini-cli, generic, grok, kiro, opencode, pi
```

## `hermes open-second-brain config`

Before:

```
config_path: <config dir>/open-second-brain/config.toml
vault:       <vault>
agent_name:  <agent name from the process environment>
timezone:    (unset)
```

After, multiplexed gateway, profile scope bound with `VAULT_AGENT_NAME=profile-b-agent`, the launch profile's `VAULT_AGENT_NAME` set in the process environment:

```
settings_source: profile scope (multiplexed gateway)
config_path: <config dir>/open-second-brain/config.toml
vault:       <vault>
agent_name:  profile-b-agent
timezone:    (unset)
```

After, single-profile gateway: `settings_source: process environment (this command; a gateway with gateway.multiplex_profiles reads each profile's .env)` as the first line, then the "before" block unchanged.

`hermes open-second-brain status` keeps its three lines (`provider:`, `available:`, `vault:`); under multiplexing `vault:` is the profile's vault.

Gateway log line (once per process per ignored name; the value is never shown):

```
WARNING plugins.hermes.config: open-second-brain: ignoring VAULT_AGENT_NAME from the gateway process environment on a multiplexed gateway; set it in the profile's .env instead
```

## `ProfileScopeError` (multiplexing on, no scope bound)

```
$ hermes open-second-brain config
settings_source: profile scope (multiplexed gateway)
error: OPEN_SECOND_BRAIN_CONFIG cannot be resolved: this multiplexed Hermes gateway bound no profile scope for the call, and Open Second Brain does not fall back to the gateway's process environment, which belongs to the launch profile. Restart the gateway (hermes gateway restart); if it persists, report it.
(exit 2)
```

In the gateway log the same sentence follows Hermes's own `Memory provider plugin init failed:` prefix, and `prefetch` logs once:

```
WARNING plugins.hermes.provider: open-second-brain: no profile scope bound for this turn; the vault reminder is omitted
```
