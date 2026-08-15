# Recon: content leaves the vault through six export paths, one of which redacts

Kanban: `t_df234a38` (priority 4), filed as "pre-commit credential scanner that reads
exact staged bytes before push". The intent transfers; the mechanism named in the
task does not exist in this architecture and is refused on purpose. Both halves are
argued below, because narrowing a task silently is worse than the gap it closes.

## The framing in the task body is not buildable here, and that is a decision

The task asks for a scanner on the git commit/push egress path. Reconnaissance
against the source says there is no such path and there is deliberately never going
to be one for the vault:

- `src/core/brain/git/reader.ts:1-11` states the contract: "Sanitized read-only git
  reader ... The reader never modifies the repository or its index." Searching `src/`
  for `git add`, `git commit`, `git push`, `git init`, `git clone` and the rest of
  the write verbs returns nothing. Only two call sites invoke the binary at all
  (`git/reader.ts:104`, `discipline/activity-git.ts:24`), both `execFileSync` with
  fixed argv and both read-only.
- The vault is not a git repository, and this is a repeated written constraint, not
  an omission. The sentence "There is NO git transport for the vault, and nothing may
  place a `.git` directory inside the replicated tree" appears verbatim in seven
  design prompts under `docs/brainstorm/`, and
  `docs/brainstorm/no-dead-ends/cli-output/prompt.md:206` puts it as an instruction:
  "The vault has no git transport; do not propose vault-side git." Replication is
  Syncthing.
- `.git` is a hard skip in nine separate vault walkers (`src/core/vault.ts:116`,
  `vault-scope/defaults.ts:73`, `vault-scope/index.ts:274` where it is never
  re-admitted, and six more).
- `src/core/hygiene/scan-repo.ts` is not an integration point despite the name. It is
  a dev-time lint over the Open Second Brain source tree looking for hardcoded home
  paths, reached from exactly one caller, `scripts/check-hardcoded-paths.ts:34`. No
  module under `src/cli/` or `src/mcp/` imports it.

Building the requested scanner means first building the git write half the project
has refused. That is the crutch the brief forbids, so it is not built.

## The gap the task is actually about does exist, one boundary over

The task's own justification is "OSB currently redacts secrets flowing INTO context
but has no gate on the bytes about to leave the machine." That is true, and the
boundary where it is true is the export surface.

### The shared redactor is mature and structural

`src/core/redactor.ts` (496 lines, 18 importers) is the canonical implementation.
Its detection is entirely shape-based, which matters because this project forbids
hardcoded natural-language word lists:

- `SECRET_KEYS` (`:94-110`) is fifteen credential *field identifiers* (`api_key`,
  `authorization`, `private_key`, ...), matched through `KEY_PATTERN` (`:112`) which
  makes `_` and `-` interchangeable and optional, across three assignment shapes:
  `ENV_RE` (`:115`), `COLON_VALUE_RE` (`:119`), `JSON_ENTRY_RE` (`:125`), plus
  `BEARER_RE` (`:134`).
- `VENDOR_TOKEN_RE` (`:243`) covers vendor key prefixes; `HIGH_ENTROPY_TOKEN_RE`
  (`:262`) is pure character-class structure - a run of at least 24 `[A-Za-z0-9_-]`
  containing at least one letter and one digit, no dictionary at all.
- Infra topology (`:152-241`) redacts public addresses and keeps private ranges,
  decided by `isPrivateOrReservedIPv4` (`:205`) / `isPrivateOrReservedIPv6` (`:219`).
- It fails closed on size: input over `MAX_REDACTOR_INPUT` (`:56`, 1 MiB) is truncated
  and stamped `SCAN_TRUNCATED_MARKER` (`:70`), so an oversized artifact reads as
  unverified rather than clean. `wasScanTruncated` (`:80`) is the reader.

Nothing in it is an English prose word. Every literal is a protocol identifier, a DNS
suffix, a file extension, or a vendor prefix.

### Five of the six export paths never call it

| Verb | Entry | Redacts before writing |
|---|---|---|
| `o2b brain continuity export` | `src/cli/brain/verbs/continuity.ts:58` | yes, via `continuity/redaction.ts:12` |
| `o2b brain bank-export` | `src/cli/brain/verbs/bank-export.ts:12` | no |
| `o2b brain graph-export` | `src/cli/brain/verbs/graph-export.ts:10` | no |
| `o2b brain okf-export` | `src/cli/brain/verbs/okf-export.ts:9` | no |
| `o2b brain export` | `src/cli/brain/verbs/export.ts:6` | no |
| `o2b export-config` | `src/cli/main.ts:388` | only the weak copy, see below |

`continuity export` also defaults its destination to the current working directory
(`continuity.ts:58`, `resolve(flags["out"] ?? ".")`), so the default target for the
one path that does redact is already outside the vault. None of the six applies any
containment check to the operator-supplied `--out`.

`bank-export` is the widest: `exportBankBundle` (`portability/bundle.ts:53`) composes
preferences, the page graph, page contracts and the sources dashboard into one JSON
file. A vault note containing a pasted key reaches that file byte for byte.

### Three drifted copies, and the weakest one is on an export path

- `src/core/config.ts:1133` `redactMapping` matches five substrings
  (`SECRET_KEY_PARTS`, `:28`) against key *names* only and never inspects a value. It
  is what `o2b export-config` uses (`main.ts:397`), and it is also reached from
  `src/mcp/tools.ts:207` and `src/openclaw/index.ts:80`.
- `src/cli/json-helpers.ts:1-3` carries its own two regexes and is the last-mile
  filter on every `--json` CLI response (`withJsonFallback`, `:120`). No vendor
  prefixes, no entropy detector, no infra pass, no `<private>` handling.
- `src/core/secret-ref.ts:67` `redactKnownSecretValues` scrubs a known literal list.
  This one is legitimately narrower by design and is not drift.

The first two are the drift risk: three answers to "is this a secret", and the
weakest of them guards a file the operator is about to hand to someone else.

## Verdict

Put the shared redactor on the export boundary, make truncation a refusal rather
than a silent pass, and collapse the key-name-only copy into the shared one. The
scanner the task asks for already exists; what is missing is the call on the way out.
