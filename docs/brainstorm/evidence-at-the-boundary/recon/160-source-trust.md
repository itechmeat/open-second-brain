# Recon: intake trust is decided from an unverified claim (GitHub #160)

Read-only reconnaissance against `main` @ 29ea0099.

## The claim is confirmed, and a test pins the current behaviour

`classifySourceTrust` (`src/core/brain/intake/source-trust.ts:124-155`) never
touches the filesystem except `ensureInsideVault`, which is lexical plus a
symlink realpath and answers "inside" for a path with no file behind it.

`tests/core/brain/intake/intake-trust-polarity.test.ts:92-112` actively asserts
that `Meeting: Q3 planning.md`, `readme.md` and `Code/widget.ts` classify trusted
in a temp vault where none of those files exist. Any fix rewrites that test.

## Call chain

Two model-facing entry points, no CLI:

- `src/mcp/brain/ner-tools.ts:49` takes `parsed.provenance?.sources[0]`, refuses
  an absent source at `:50-58`, classifies at `:59`, calls `intakeExtraction` at
  `:63`, echoes `trust` back at `:76`.
- `src/core/brain/ingest/ingest.ts:118-131` (reached from
  `src/mcp/brain/ingest-tools.ts:45,56`) does the same on a caller-supplied
  `source_path` and stamps `untrustedSourceFrontmatter(trust)` at `ingest.ts:155`.

The primitive is `resolveIntakeTrust`
(`src/core/brain/intake/extract-intake.ts:159-166`): a caller-declared
`opts.trust` short-circuits everything at `:160`, zero cited sources reads as
trusted at `:162`, otherwise every source must classify trusted. `:181` collapses
it to `untrustedOrigin`, which reaches `upsertEntity` (`:203`) and
`relateEntities` (`:222`).

Quarantine is written in `src/core/brain/entities/registry.ts:443` (`untrusted =
input.untrustedOrigin === true`), `:523` (`status: untrusted ? quarantine :
active`) and `:530-532` (the `untrusted_source` frontmatter marker from
`src/core/brain/trust/untrusted-provenance.ts:68`, read back by
`hasUntrustedSourceMarker` at `:57`).

An entity record persists almost nothing about its source. `BrainEntity`
(`src/core/brain/entities/types.ts:49-69`) has no source field at all; on
creation only, `extract-intake.ts:192-194` writes the wikilink into a `## Sources`
body section, and frontmatter carries `source_agent` (a forgeable name) plus the
untrusted marker. Only the ingest summary page carries `source_path` and
`source_hash`, and that hash is an identity hash of the path string
(`ingest.ts:142`), not of any content.

## Direction (1) is not buildable natively (shape-changing finding)

There is no unforgeable caller identity anywhere in the MCP surface:

- `ServerContext` (`src/mcp/tool-contract.ts:34-61`) carries vault, configPath,
  repoRoot, capabilityReport, artifactStore, agentName. Nothing per-call, nothing
  per-transport.
- `agentName` resolves `VAULT_AGENT_NAME` env, then config `agent_name`, then
  `"agent"` (`src/core/config.ts:371`), and twenty-two tool schemas additionally
  accept a caller-supplied `agent` override taken verbatim.
- `agent_scope` is a filter argument, not a credential (`src/mcp/coerce.ts:93`).
- `initialize` discards `clientInfo` (`src/mcp/server.ts:254+`), and
  `handleToolsCall` performs no JSON-schema validation, so `required` and
  `additionalProperties:false` are advisory to the model only.

The project has already reasoned this out and written it down:
`src/core/write-binding/index.ts:12-22` states there is no credential in this
system to key a fence to, that a caller who can call the tool can name itself
anything, and that the binding therefore reads no identity at all, taking its
whole authority from operator-controlled `_brain.yaml`. Direction (1) would need
a new transport concept plus a cooperating host, and Open Second Brain never
fetches the content in the first place: the agent does.

## Content-hash primitive to reuse

`hashFile(absPath): string` in
`src/core/brain/ingest/content-manifest.ts:80` is SHA-256 over the raw bytes,
timestamp independent, throws on a directory. Siblings `hashTree` `:96` and
`hashPath` `:111`.

`sourceIdentityHash` (`src/core/brain/provenance/provenance.ts:91`) is explicitly
path identity, not content. `content-hash.ts:32,71` is preference-specific, but
its store-and-recompute drift pattern is the precedent for recording a hash as an
audit record rather than a gate. `trust-order.ts` does no hashing at all.

## Recommendation, with the limit stated honestly

Take direction (2), and say plainly what it does not buy. Content-hash binding
does not stop the lie: an attacker forced to name a real file names `README.md`,
and the hash then records which bytes were claimed, not which produced the
entities - the docstring at `source-trust.ts:36-37` already concedes this. What
it removes is the free bypass. Today any plausible-looking string works; after
the change the caller must name a file that actually exists in the operator's
vault, and the recorded hash makes the claim auditable later.

The docstring's counter-argument at `:113-116` (a note the operator has not
written yet is still inside their namespace) is answerable on its own terms and
should be rewritten rather than deleted. `brain_intake_entities` asserts that
these entities were extracted from this material. A path with no bytes behind it
cannot have produced an extraction. Absence here is not "not yet written", it is
"there was nothing to read".

## Minimal surface

`src/core/brain/intake/source-trust.ts`
- Export `normalizeSourceIdentity(source)`: the wikilink strip plus
  `canonicalNotePath`, currently inlined at `:125`, so one normaliser serves both
  callers.
- Replace `classifySourceTrust(vault, sourcePath): IntakeTrust` with
  `classifySourceOrigin(vault, sourcePath): SourceOrigin` where `SourceOrigin =
  { trust, contentHash? }`. Shape gate unchanged, then `statSync`: not a file, or
  ENOENT/ENOTDIR, means untrusted; any other errno rethrows, because an
  unreadable file is not a trust verdict. On success attach `hashFile`.

`src/core/brain/intake/extract-intake.ts`
- Delete `IntakeOptions.trust` and the short-circuit; classify once inside the
  primitive. Require provenance with at least one source, so a zero-source intake
  throws instead of reading as trusted.
- Return the verdict on `IntakeResult` so `ner-tools.ts` reads it back instead of
  computing its own.

`src/core/brain/entities/registry.ts`
- `UpsertEntityInput` gains the source content hash, merged into the same extras
  map as the untrusted marker (`:502-505`, `:530-532`) under a named key beside
  `UNTRUSTED_SOURCE_FRONTMATTER_KEY`. Nothing reads it in this pass; that is
  deliberate and documented as an audit record, mirroring how `content-hash.ts`
  documents preference drift.

Do not add a `trust` argument to any tool schema: that hands the attacker the
switch outright.

## Adjacent defects found in the same path

1. `ner-tools.ts:67` guards `trust !== undefined` on a non-optional return: dead branch.
2. Trust is classified twice, at `ner-tools.ts:59` and `extract-intake.ts:160`;
   the `opts.trust` escape hatch exists only to suppress the second.
3. `extract-intake.ts:162` treats zero cited sources as trusted. It is only
   unreachable because one caller guards it, and nothing enforces that a third
   caller will.
4. Wikilink normalisation is duplicated and inconsistent: `source-trust.ts:57,125`
   strips `[[...]]`, `ingest.ts:118` does not, so an ingest with a bracketed
   source writes a doubly wrapped link and a different identity hash, producing
   two summary pages for one source and breaking documented idempotency.
5. The wikilink regex handles neither `|alias` nor `#anchor`, so `[[note|Alias]]`
   quarantines a legitimate operator note.
6. `ingest-tools.ts:52` builds a provenance from a `source` argument its schema
   does not declare and its handler never reads.
7. Source required-ness is encoded in three places (`ner-tools.ts:143`,
   `intake-args.ts:129`, `ner-tools.ts:50`).
8. `src/core/brain/distill/distill-source.ts` writes claims from a caller-named
   source path with no trust classification at all. Same defect class, out of
   scope for this pass, worth its own issue.

## Test blast radius

Sixteen test files touch `ingestSource`, `intakeExtraction`, `NER_TOOLS` or
`INGEST_TOOLS`, with roughly 186 literal source-path occurrences, nearly all
naming vault-shaped files that are never created. Seeding those files in setup is
mechanical but is the bulk of the work for this unit.

Convention: `tests/` mirrors `src/` path for path, one file per rule rather than
per source file, a docstring header naming the regression the file prevents,
`mkdtempSync` vault plus a separate config home plus `bootstrapBrain` in
`beforeEach`, `atomicWriteFileSync` for fixtures.
