# Variants and rationale

This fix is constrained by verified host behavior, not an open design space, so
the orchestrator decided the approach directly rather than generating speculative
architectural variants. The constraints that close the space:

- Claude Code has no stable (non-versioned) plugin path; it does provide
  `CLAUDE_PLUGIN_ROOT` for hooks. -> resolution must key off that env, not a
  PATH symlink that goes stale.
- Codex provides no plugin-root substitution and uses a stable directory. -> a
  PATH fallback is required and is safe there.
- Hook exit code 2 blocks; other codes do not. -> the wrapper must never exit 2.
- `hooks.json` is read fresh from the active version, so the command shape itself
  is the self-heal vector for already-broken installs.

Approaches considered and rejected:

- **A. Re-run `install-cli` on every update (status quo + docs).** Rejected: needs
  user action every update; does not heal a broken install; the operator explicitly
  ruled out manual steps.
- **B. Pin a stable symlink target.** Rejected: Claude Code exposes no stable path;
  every install dir is versioned.
- **C. Drop the PATH wrapper and inline `${CLAUDE_PLUGIN_ROOT}/scripts/o2b-hook`
  only.** Rejected as sole fix: breaks Codex, which has no such env.

Chosen: **D. env-first resolution with PATH fallback + unconditional fail-soft +
opportunistic self-heal** (see design.md). It satisfies all four constraints,
heals already-broken installs on the next update with no user action, and keeps
Codex working.
