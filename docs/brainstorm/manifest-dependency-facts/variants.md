# Deterministic dependency facts - variants and decision

Consultant: Claude Code (`claude -p`, prompt in `cli-output/prompt.md`, verbatim answer in `cli-output/claude.md`). Exit 0, three parseable variants; the fallback consultant was not run.

## Variant 1: Inline extension of the existing files - lost

Grow `readManifest` in `scan.ts` into a per-ecosystem switch, add the Terraform branch inside `pre-extract.ts`, and let each of the three digest readers filter `Brain/active.md` lines itself.

Why it lost: `scan.ts` would absorb four parsers and the status handling and stop being a tree walker; the Bun-only TOML call would sit in a file whose callers grow; line-filtering a compiled digest is lossy and would be implemented three times; and the private detection list in `codegraph.ts` would keep duplicating the manifest names.

## Variant 2: Manifest registry, fact-bearing module edges, reach-rendered digest - chosen, adjusted

A Node-safe shared filename table, a readers module with a closed status vocabulary, inter-module edges resolved in the scan and written to one generator-owned frontmatter key, a Terraform family behind the pre-extractor dispatch with one shared specifier step that runs the URL-credential pass for every family, and a digest rendered over a reach-filtered preference set.

Adjustments by the orchestrator, with evidence in `design.md`:

1. Status vocabulary `read | malformed | unreadable | unsupported` instead of `ok | malformed | unsupported`: an unreadable file and a malformed one are different operator actions, and `read` matches the CLI's verb.
2. One readers module (`src/core/brain/architect/manifests.ts`) instead of a `manifests/` directory: four readers of 20-60 lines each do not justify a directory, and lane ownership stays one file per lane.
3. The digest is re-rendered for a remote reader only when a record is actually withheld, otherwise the file bytes are served, so existing byte-identity tests stay valid and no render runs per call on vaults with nothing reserved.
4. External packages stay a rendered list; "one canonical package node per package" is reduced to one canonical name per dependency per ecosystem (no new write surface).

## Variant 3: Body-sourced typed relations as a new index contract - lost

Keep frontmatter strictly write-once and teach the indexer a second relation source: a sentinel `relations` region with inline `depends_on::` fields.

Why it lost: it changes indexer semantics for every note in every vault, needs its own visibility A/B coverage, and creates two sources of truth for typed edges with precedence questions; the release needs one edge kind on one note family, which a single declared frontmatter exception covers.

## Alternatives considered inside the chosen variant

- Region-only edges with untyped wikilinks (recon recommendation for D1): lost to the card's deliverable, the typed relation; the write-once contract gets one documented exception instead.
- Second Mermaid block inside `module-map`: lost because the region's claim sentence ("Containment only") and its tests would no longer describe the whole region.
- Throwing on a malformed manifest: lost because one bad project file would abort every note of the run; the run fails closed only on vault corruption.
- A hand-rolled TOML reader (extending `readCargoWorkspace`'s helpers): lost because it cannot evaluate inline tables, dotted keys or multi-line strings, and `Bun.TOML.parse` is a built-in with a typed `SyntaxError`.
- Accepting the duplicated detection list (zero bundle impact): lost to DRY; the shared module is Node-safe, so the bundle rebuild is mechanical.
- `.hcl` in the Terraform family: lost because Terragrunt, Packer, Nomad and Vault policy files use other block vocabularies and would be misreported.
- Full `redactRawOutput` on specifiers: lost because its key-value passes would rewrite specifier text; only the URL-credential pass is needed.
- Folding left-overs (d), (e), (f): lost as product decisions, recorded in `design.md` "Out of scope".
