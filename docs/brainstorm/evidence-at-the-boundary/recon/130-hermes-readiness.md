# Recon: Hermes reports "Needs Setup" after setup (GitHub #130)

Read-only reconnaissance against `main` @ 29ea0099. The string "Needs Setup" is
rendered by the Hermes host and appears nowhere in this repository, so the work
is to find what the plugin reports into that badge and whether it is true.

## The plugin's entire readiness computation

| Surface | Location | What it reports |
|---|---|---|
| `is_available()` | `plugins/hermes/provider.py:184-186` | `config.resolve_vault() is not None`, and nothing else |
| `get_config_schema()` | `provider.py:308-323` | three dicts keyed `key` / `description` / `required`; only `vault` is required |
| `_CONFIG_KEYS` | `provider.py:53` | the same three keys, written out a second time by hand |
| `save_config(values, hermes_home)` | `provider.py:325-350` | writes into the Open Second Brain config; `hermes_home` is accepted and never used |
| health check | `plugins/hermes/__init__.py:30-45` | file presence only, never touches config |
| operator diagnostic | `plugins/hermes/cli.py:35-49` | `hermes open-second-brain status/config`, prints the resolved `config_path` and `vault` |

## The resolver is a truncated copy of the contract it claims to mirror

`config.py:9-12` states the Python resolver "mirrors `src/core/config.ts` exactly".
It does not.

`resolve_vault` (`plugins/hermes/config.py:95-100`) is two steps: `VAULT_DIR`
returned verbatim, then the first `vault:` line in the config file.

`resolveVault` (`src/core/config.ts:341-361`) is four: `VAULT_DIR` with tilde
expansion, then a project-pointer walk-up for `.o2b-vault.json`
(`src/core/brain/portability/pointer.ts`), then the active named profile from
`profiles.json` (`src/core/brain/portability/profiles.ts:216-220`), then the
config key, each tilde-expanded.

Two further divergences: `parseSimpleYaml` (`config.ts:155-176`) lets the last
duplicate key win while `config.py:69-71` takes the first; and a
present-but-unreadable config is a hard `ConfigReadError` in TypeScript
(`config.ts:77-98`, `201-214`, `255-270`) but silently becomes `None` in Python
(`config.py:48-55`).

`switchProfile` (`profiles.ts:190-201`) never writes the `vault:` key, so an
operator who switched profiles, or who uses a project pointer, or who wrote
`vault: ~/vault`, has a vault that `o2b` resolves correctly and that the provider
reports as absent. That is the reported symptom, reachable without any host bug.

## The wizard round trip has no return path

The plugin has no reader for any host-side store: no `load_config`, no
`configure`, nothing that reads back what a wizard collected. `hermes_home`
reaches `initialize` (`provider.py:191`) and is used only for the session
transcript (`provider.py:527-541`); the parameter on `save_config` is dead. This
repository never writes `~/.hermes/config.yaml`, and that is deliberate policy
(`src/cli/main.ts:853`, `src/cli/uninstall.ts:145`).

The vendored host contract
(`docs/brainstorm/hermes-memory-provider/cli-output/prompt.md:12-19`) says plugin
storage must be scoped under `hermes_home`, and the design consciously overrode
that for config (`docs/brainstorm/hermes-memory-provider/design.md:40`). The same
design document flags the open risk at `:65`: the `get_config_schema()` field
names were never verified against a real wizard run.

## Doctor cannot catch it

One check, `checkHermesManifest` (`src/core/doctor.ts:268-298`, wired at `:402`),
regex-tests `plugins/hermes/plugin.yaml` for three literal lines. `o2b brain
doctor` is vault-content hygiene and knows nothing about Hermes.

`cmdDoctor` (`src/cli/main.ts:283-304`) resolves through `requireVault`
(`src/cli/helpers.ts:41-55`), so `o2b doctor --vault /path` validates the path the
operator typed, never the path the provider would resolve. Nothing executes the
Python resolver or compares the two. Two disjoint views with no cross-check, which
is why a clean doctor and a "Needs Setup" badge coexist without contradiction.

There is also no Hermes install adapter. `src/core/install/adapters/all.ts:15-23`
registers nine targets, none of them Hermes. Every other runtime has a
write-then-verify loop returning `VerifyResult` (`src/core/install/types.ts:126-129`);
Hermes has prose telling the operator to eyeball the output
(`docs/install/hermes.md:87-102`).

## Ranked hypotheses

The reporter wrote "settings are in the specific config.yml". Every code path in
this repository looks for `config.yaml`.

1. **H2, fully verified from code**: the truncated resolver. Profiles, pointers
   and tilde all produce a configured vault that the provider cannot see. Fixable
   here, today, with no host access.
2. **H4, fully verified from code**: `config.py:53-55` catches `OSError` and
   returns `None`, so a permissions fault, an `EISDIR`, a symlink loop, or a file
   named `config.yml` are all indistinguishable from "not configured". The
   TypeScript side refuses this conflation and spends twenty lines of comment
   saying why (`config.ts:63-98`).
3. **H3, mechanism verified**: the gateway resolves `config_path()` from its own
   `HOME` / `XDG_CONFIG_HOME`, and the shipped assumption is a root-owned gateway
   (`src/cli/discipline-install.ts:17`). A config written by a non-root operator is
   invisible, and nothing prints which path was used.
4. **H1, unverifiable without the host**: the badge may read the host's own store,
   which `save_config` never writes.
5. **H5, unverifiable without the host**: `get_config_schema()` field names may not
   match what the wizard expects.

One command separates them, and it must run as the gateway user:
`hermes open-second-brain config` plus `hermes open-second-brain status`
(`plugins/hermes/cli.py:44-49`) print `config_path`, `vault`, `agent_name` and
`timezone` exactly as the provider sees them.

## Tests today, and what the regression suite must be

`tests/python/test_memory_provider.py` covers `resolve_vault` env-vs-config
(89-101), `is_available` both ways (180-187), the schema shape (247-251) and
`save_config` writing plus Windows quoting (253-286). Every one of them pins
`OPEN_SECOND_BRAIN_CONFIG` to a tempdir (`:69`, `:166`), which makes the
config-path resolution the bug turns on invisible. Nothing tests profiles,
pointers, tilde, duplicate keys or unreadable files.

The class of bug is "these two resolvers disagree", so the test has to be a
comparison rather than two independent assertions: one fixture table driven
through both `resolveVault` and `resolve_vault`, asserting byte-equal results
across `VAULT_DIR` set and unset, tilde and absolute, `profiles.json` active,
absent and dangling, duplicate keys, and config absent, present, unreadable and a
directory. Plus a wizard round trip replaying the documented host sequence, and
explicit-failure tests that an unreadable config raises a named error rather than
yielding "not available".

## Adjacent defects worth fixing in the same pass

Silent swallows that hide real configuration errors:

- `config.py:53-55` turns an unreadable config into "not configured". Top
  offender: it degrades a permissions fault into exactly the symptom under report.
- `provider.py:219-220` swallows every bridge-start failure, leaving the provider
  registered, `is_available()` true, and every `_safe_call` returning `None`
  forever (`provider.py:487-488`). `bridge.py:17,27` already has a logger;
  `provider.py` and `config.py` import none.
- `plugins/hermes/__init__.py:83-84` swallows any construction failure, so a broken
  provider is never registered and the host has nothing to show.
- `provider.py:277-278` falls back to static schemas on any exception, masking a
  dead bridge behind a plausible tool list.

Correctness:

- `provider.py:340` skips falsy values, so a wizard clearing a field can never
  unset it and the operator's edit is silently ignored.
- `save_config` never verifies its own effect; it should re-resolve and refuse
  loudly when the effective value differs from what was written, which is exactly
  the `VAULT_DIR`-shadows-config case.
- `provider.py:343` and `config.py:69` use `^\s*{key}\s*:`, which matches an
  indented key nested under another block.
- `config.py:95-100` has no tilde expansion, so `vault: ~/vault` reaches
  `o2b mcp --vault "~/vault"` (`bridge.py:238-240`) and operates on a literal
  `./~` directory.

DRY:

- `"open-second-brain"` is written three times (`config.py:22`, `provider.py:165`,
  `provider.py:531`).
- `_CONFIG_KEYS` and the hand-written list inside `get_config_schema()` are the
  same list twice, so adding a field can half-land.
- `"session-transcript.jsonl"` is an inline literal (`provider.py:531`).
