/**
 * Help text for `o2b vault *` (v0.10.9).
 */

export const VAULT_HELP = `usage: o2b vault <verb> [options]

Vault-wide scope policy inspection. The policy lives in
<vault>/Brain/_brain.yaml under \`vault.ignore_paths\` and the optional
\`vault.include_paths\` allowlist (single source of truth for the search
indexer, scan-inline, and future scanners). A path is in scope when it
is not excluded AND, if an allowlist is declared, under one of its roots.

verbs:
  status              Walk the vault under the active policy and
                      report inclusion / exclusion counts.
  inspect <relpath>   Point-check one vault-relative path with the
                      matched rule.
  profile <sub>       Manage named multi-vault profiles
                      (list | create <name> <vault> | switch <name>).
  map [show]          Print the resolved vault-map (role token -> folder).

global flags:
  --vault <path>      Override the configured vault path.
  --json              Emit a machine-readable JSON payload.
`;

export const VAULT_VERB_HELP: Record<string, string> = {
  status:
    "usage: o2b vault status [--vault <path>] [--json]\n\n" +
    "Walks the vault under the active policy and reports counts plus\n" +
    "every excluded directory with the matched rule. Files inside an\n" +
    "excluded subtree are not enumerated separately.\n",
  inspect:
    "usage: o2b vault inspect <relpath> [--vault <path>] [--json]\n\n" +
    "Resolves the policy and reports whether <relpath> is in scope,\n" +
    "naming which polarity refused it when it is not, plus whether the\n" +
    "search index would accept it. The relpath is vault-relative\n" +
    "(POSIX). Path traversal outside the vault is rejected with exit 2.\n",
  profile:
    "usage: o2b vault profile <list | create <name> <vault> | switch <name>> [--json]\n\n" +
    "Manage named multi-vault profiles stored in profiles.json beside the\n" +
    "config. switch sets the active pointer (no symlinks); resolveVault uses\n" +
    "the active profile before the bare config vault key.\n",
  map:
    "usage: o2b vault map [show] [--vault <path>] [--json]\n\n" +
    "Print the resolved vault-map (role token -> folder), merging an optional\n" +
    "Brain/_vault-map.yaml over the built-in defaults. Read-only.\n",
};
