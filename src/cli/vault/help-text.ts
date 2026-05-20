/**
 * Help text for `o2b vault *` (v0.10.9).
 */

export const VAULT_HELP = `usage: o2b vault <verb> [options]

Vault-wide exclusion policy inspection. The policy lives in
<vault>/Brain/_brain.yaml under \`vault.ignore_paths\` (single source
of truth for the search indexer, scan-inline, and future scanners).

verbs:
  status              Walk the vault under the active policy and
                      report inclusion / exclusion counts.
  inspect <relpath>   Point-check one vault-relative path with the
                      matched rule.

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
    "Resolves the policy and runs matchIgnore against <relpath>. The\n" +
    "relpath is vault-relative (POSIX). Path traversal outside the\n" +
    "vault is rejected with exit 2.\n",
};
