# Hook update resilience - self-healing plugin hooks and CLI symlinks

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

After a Claude Code plugin update, Open Second Brain hooks break and block the agent. Every `UserPromptSubmit` is rejected with `o2b-hook: <old-version-path>/hooks/session-capture.ts not found`. The agent becomes unusable until the user manually deletes stale symlinks - an unacceptable per-update workaround.

## Root cause

- `hooks/hooks.json` invokes hooks as `o2b-hook <name>`, a wrapper found on `PATH`.
- `o2b install-cli` creates `~/.local/bin/o2b-hook` as a symlink into a *versioned* plugin install dir (`~/.claude/plugins/cache/open-second-brain/open-second-brain/<version>/scripts/o2b-hook`).
- Claude Code has no stable (non-versioned) plugin path; on update the active version dir changes. The `~/.local/bin` symlink keeps pointing at the old version, so the wrapper resolves an outdated checkout (`REPO_ROOT = realpath(self)/..`) whose `hooks/<name>.ts` may not exist.
- `o2b-hook` then runs `exit 2`. Per Claude Code semantics, **exit code 2 from a hook blocks** the operation; any other non-zero code is non-blocking. So the stale path plus the hard `exit 2` brick the agent.
- `o2b install-cli` refuses to overwrite a symlink that points at a different checkout, which is why recovery currently needs a manual `rm`.

Verified host facts:
- Claude Code sets `CLAUDE_PLUGIN_ROOT` in the hook process and substitutes `${CLAUDE_PLUGIN_ROOT}` in hook `command` strings; it always points at the active version. There is no stable non-versioned path.
- Codex does **not** provide a plugin-root substitution (`hooks/README.md`), which is why the `o2b-hook` PATH wrapper exists. On Codex/VPS the wrapper points at a stable directory marketplace, so it does not go stale there.
- `hooks/hooks.json` is shared by both runtimes (`plugins/codex/hooks -> ../../hooks`).
- Hook exit 2 blocks; other exit codes do not.

## Scope

- `scripts/o2b-hook`: never `exit 2`; resolve the hook root robustly (`$CLAUDE_PLUGIN_ROOT` -> own realpath -> `$OSB_PLUGIN_ROOT` -> PATH-derived); on any failure warn to stderr and `exit 0`. When running from a valid current root, opportunistically re-point a stale/dangling OSB-owned `~/.local/bin` symlink to the current checkout (self-heal the global CLI).
- `hooks/hooks.json`: each command resolves via `$CLAUDE_PLUGIN_ROOT/scripts/o2b-hook` when that env is present (Claude Code, current version), else falls back to PATH `o2b-hook` (Codex / stable dir), else no-ops without blocking. This is what heals an already-broken install on the next update: Claude Code reads the new `hooks.json` from the active version and bypasses the stale PATH symlink.
- `scripts/_bun-precheck.sh` usage in hook context must not produce a blocking exit (route through o2b-hook's soft-fail).
- `o2b install-cli`: idempotent re-point of OSB-owned or dangling symlinks (no manual `rm`); still refuse to clobber a symlink owned by an unrelated tool or a real non-symlink file.
- Hard update-safety instruction: `CLAUDE.md` <-> `AGENTS.md` (mirrored) plus `docs/`.

## Out of scope

- Changing the Codex plugin-root story (Codex has no env to use; PATH fallback is correct there).
- Reworking the `.mcp.json` `${CLAUDE_PLUGIN_ROOT}` project-vs-plugin warning (tracked separately; non-blocking).

## Chosen approach

Two independent guarantees, each sufficient on its own, applied together (defense in depth):

1. **Fail-soft**: a hook can never block the agent. `o2b-hook` exits 0 on every internal error path; only the real hook script's own decisions can ever influence the runtime, and those scripts are already silent-on-failure.
2. **Version-current resolution**: the hook command prefers `$CLAUDE_PLUGIN_ROOT` (always the active version) over the PATH symlink, so updates never strand the hook. Because Claude Code reads `hooks.json` fresh from the active version, shipping this command form means the *next* update repairs any already-broken install with no user action.

Self-healing of the global `o2b`/`o2b-hook`/`vault-log` symlinks is a convenience layer on top: when a hook runs from a known-good current root and detects an OSB-owned PATH symlink that is dangling or points at a different OSB checkout, it re-points it (best-effort, never fatal).

## Design decisions

- Prefer env-based resolution over PATH for Claude Code because PATH is the thing that goes stale. Keep PATH fallback for Codex, which has no env and a stable target.
- `exit 0` (not 2, not 1) on wrapper failure: 0 is unambiguously non-blocking and signals "nothing to do" rather than "soft error" that some runtimes might surface.
- Self-heal only OSB-owned symlinks (target path under an `open-second-brain` checkout) or dangling links; never touch a symlink a different tool owns, and never replace a real file.
- One shared `hooks.json` command shape that is safe whether `$CLAUDE_PLUGIN_ROOT` is substituted by the host, present as an env var, or absent.

## File changes

- `scripts/o2b-hook` (rewrite resolution + soft-fail + self-heal).
- `hooks/hooks.json` (robust command for all 8 hook entries).
- `scripts/_bun-precheck.sh` (ensure non-fatal in hook context, or guard at call site).
- `src/cli/install-cli.ts` (idempotent re-point of OSB-owned/dangling links).
- `CLAUDE.md` + `AGENTS.md` (mirrored update-safety section).
- `docs/updating.md` (new) + reference from README.
- Tests: `tests/hooks/o2b-hook.test.ts` (new), extend `tests/cli/install-cli.test.ts`, a hooks.json command-shape assertion.

## Risks and open questions

- `hooks.json` is live on this VPS for Hermes and Codex. The new command shape must be validated against both before merge (Codex env-absent fallback; Hermes/Claude env-present path).
- Claude Code's exact `${CLAUDE_PLUGIN_ROOT}` substitution vs shell env expansion: use the bare env var (`$CLAUDE_PLUGIN_ROOT`) so the shell expands it (CC sets the env; Codex leaves it empty) and avoid relying on host placeholder substitution inside compound shell.
- Self-heal must be race-safe and never fatal; wrap in best-effort with full error suppression.
