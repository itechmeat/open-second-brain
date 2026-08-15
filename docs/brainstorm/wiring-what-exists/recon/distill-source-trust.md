# Recon: `brain_distill_source` writes under `stated` authority with no trust classification

Kanban: `t_84d0ff47` (priority 4). Filed out of the v1.46.0 scope and named in that
release's CHANGELOG rather than quietly included.

## What the module does today

`src/core/brain/distill/distill-source.ts:146-212` is the whole write. Its only
validation is `validate()` at `:116-130`, which is lexical and only over the
claims: non-empty list, non-blank `text`, block id matching `BLOCK_ID_RE` at
`:50`. Nothing in the module looks at the source at all - `grep trust` over it
returns nothing, and its import block at `:21-41` names no member of
`intake/source-trust.ts`.

Both arguments are fully caller-supplied. `src/mcp/brain/distill-tools.ts:54-84`
declares `source_path` as "a vault-relative path or a URL" and `claims` as a free
array, both required, `additionalProperties: false`. The tool is model-callable
(`distill-tools.ts:22`), and the same core function is reached a second way from
the CLI verb `src/cli/brain/verbs/distill.ts:84-88` - so a guard placed in the MCP
handler alone would cover one of the two entry points.

## The five divergences from the paths hardened in v1.46.0

### 1. Identity is canonicalised with the wrong function

```
distill-source.ts:155   const canonicalSource = canonicalNotePath(input.sourcePath);
distill-source.ts:156   const sourceLink = `[[${canonicalSource}]]`;
```

`canonicalNotePath` (`src/core/path-safety.ts:136-138`) is POSIX-slash plus
Unicode NFC and nothing else. `ingestSource` was moved off exactly this call in
v1.46.0 and documents why at `src/core/brain/ingest/ingest.ts:118-124`: a caller
who writes `[[Articles/primer.md]]` keeps the wrapper, so `:156` produces
`[[[[Articles/primer.md]]]]` and `sourceIdentityHash` at `:166` yields a second
identity for one source. `normalizeSourceIdentity` (`intake/source-trust.ts:198`)
strips the wrapper, an `|alias` and a `#anchor`, and was exported for this reuse.

### 2. No trust classification, and therefore no quarantine lane

`classifySourceOrigin(vault, sourcePath)` (`intake/source-trust.ts:351`) returns
`SourceOrigin { trust: IntakeTrust; contentHash?: string }`. Both hardened writers
consume it before writing: `extract-intake.ts:179` for one cited source,
`:183-185` conservatively for several. `distillSource` calls neither.

Quarantine on the intake path is three coupled effects, none of which this page
can receive: `status: quarantine` (`entities/registry.ts:541`), the
`untrusted_source: true` frontmatter marker (`trust/untrusted-provenance.ts:88-90`),
and read exclusion, since `status-scope.ts:54` admits `quarantine` to no scope and
`trust/retrieval-gate.ts:69-102` filters on `hasUntrustedSourceMarker`. A
distillation page carries no marker, so the retrieval gate has nothing to read and
the claims rank beside operator-authored notes.

### 3. Absence is recorded as a value instead of decided as a verdict

```
distill-source.ts:46    const MISSING_SOURCE_HASH = "missing";
distill-source.ts:161   const absSource = join(vault, canonicalSource);
distill-source.ts:162   const sourceHash = existsSync(absSource)
distill-source.ts:163     ? createHash("sha256").update(readFileSync(absSource)).digest("hex")
distill-source.ts:164     : MISSING_SOURCE_HASH;
```

A source with no bytes behind it produces the literal string `"missing"`, and the
page is written anyway under `provenance: stated` (`:157`, `:187`) - the top
authority tier. This is the precise case `classifySourceOrigin` treats as
untrusted at `intake/source-trust.ts:318-326`.

### 4. The source read is not bounded to the vault - found during this recon, not in the task body

`join(vault, canonicalSource)` at `:161` passes through no shape gate. Verified by
reading the function body directly: `canonicalNotePath` does not reject `..`, so
`source_path: "../../../etc/passwd"` resolves outside the vault, `existsSync`
succeeds, and its sha256 is stamped into the page as `source_hash`. Three
consequences:

- the tool is an existence oracle over any path the process can stat, which is the
  same defect class fixed on the intake error path in v1.46.0;
- a raw `readFileSync` errno (EACCES on an unreadable file) propagates unwrapped
  through the MCP boundary, leaking the absolute path;
- there is no byte ceiling. The shared path uses `hashFile`
  (`ingest/content-manifest.ts:80-86`) under `SOURCE_HASH_MAX_BYTES = 8_388_608`
  (`intake/source-trust.ts:94`); this inline digest reads a file of any size into
  memory.

`resolveVaultShapedPath` (`intake/source-trust.ts:212-239`) already rejects
absolute paths, empty segments, scheme-bearing segments, authority-shaped heads,
and out-of-vault resolution. Nothing here calls it.

The write target is not affected: `distillationPagePath` (`brain/paths.ts:284-287`)
composes from `slugify(canonicalSource)`, so a traversal cannot steer the write.
The read is the leak.

### 5. The result says nothing about trust

`DistillSourceResult` (`:97-106`) carries `distillationPath`, `created`,
`claimCount`, `sourceHash`. The MCP response (`distill-tools.ts:40-45`) mirrors it.
`brain_intake_entities` returns the lane it actually committed to
(`ner-tools.ts:56`) and advertises the guarantee in its own description
(`ner-tools.ts:65`: "Entities are quarantined unless the source names a file that
exists."). `distill-tools.ts:52-53` makes no such statement, and adding one is
additive-safe: the tool declares no `outputSchema`, and `assertOutputContract`
(`src/mcp/server.ts:398`) is a no-op for an undeclared schema.

## Test coverage that exists, and the shape of what is missing

`tests/core/brain/distill/distill-source.test.ts` has five tests: rendering,
`source_hash` equals the sha256 of the source bytes, empty and blank claims
refused with no write, malformed block id, idempotency. None of them names a
source that does not exist, a source outside the vault, or trust.

The suite to mirror is the intake one:
`tests/core/brain/intake/source-trust-existence.test.ts:92-212`,
`source-identity-normalisation.test.ts:74-96`, `intake-trust-polarity.test.ts:87`.

## Verdict

Route the third writer through the same two functions the other two use, and treat
a source with no readable bytes as a verdict rather than a sentinel. The machinery
is already exported for it; nothing here needs to be invented.
