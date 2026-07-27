### Variant 1: Strip the path at the throw sites
- **Approach**: Delete the ` (${path})` tail from the ~15 `throw new Error(...)` sites in `src/core/brain/preference.ts` (`requireField`, `requireString`, `requireStringArray`, the `kind`/`retired_reason` enum checks, and the confidence/schema helpers), leaving the message as pure prose about the field. The doctor's existing `path` field then becomes the single source of the location, and the renderer's tail is untouched. Callers that today rely on the message carrying the path (`dream`, `query`, `export`, `merge`, `apply-evidence`, `pin`, `preference-txn`) must each be audited and given the path from the call site they already know.
- **Trade-offs**:
  - Pro: smallest conceptual change; matches the stated fix direction literally — the message stops embedding the path.
  - Pro: no new type, no new indirection; DRY holds because the path was always duplicated for the doctor.
  - Con: the path is *only* recoverable from the message today for every non-doctor caller that surfaces `(exc as Error).message` bare — stripping it there loses operator context unless each of ~10 caller modules is fixed in the same change, which is exactly the "silently does nothing" failure mode the constraints forbid.
  - Con: blast radius is wide for a cosmetic priority-3 item; every test asserting the current message text (parse-error fixtures, doctor fixtures, dream/query error paths) has to move together.
  - Con: nothing structurally prevents the next `throw` from re-adding `(${path})`.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Typed parse error carrying `path` as a field
- **Approach**: Introduce a `BrainParseError` (path + bare message) modelled directly on the `BrainStatusFolderMismatchError` that `classifyParseError` already special-cases in `src/core/brain/doctor.ts` — that class carries `path` structurally and its `message` contains no path, so the doctor already emits it correctly. The preference/retired parsers throw `BrainParseError` instead of bare `Error`; the doctor reads `err.path`/`err.message` as fields, and non-structured callers format location through one shared helper rather than string concatenation at 15 sites.
- **Trade-offs**:
  - Pro: the path is never lost — it moves from prose into a field that every caller can read, which is the same move v1.40.0 made for findings.
  - Pro: follows an in-repo precedent living in the exact function being fixed, so the two parse-error branches of `classifyParseError` stop being asymmetric.
  - Pro: makes regression structural — a future throw site cannot embed the path without going around the typed error.
  - Pro: the `parseErrorCode` regex classification (`/missing field/`, `/ISO-8601/i`) keeps working on the bare message and becomes less coupled to incidental path text.
  - Con: largest of the three; a new exported error type plus migration of every throw site and its `instanceof`-blind catch sites.
  - Con: overshoots the reported defect — most of the work buys structure, not the missing byte.
  - Con: callers doing `catch (exc) { fail(exc.message) }` need a decision per site about whether to append the path, so the change is not mechanical.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Normalize at the doctor boundary
- **Approach**: Leave `preference.ts` untouched and fix it where the two representations meet: `classifyParseError` in `src/core/brain/doctor.ts` builds the issue from a message with its own trailing ` (<path>)` suffix removed, keyed off the `path` it is already passing into the issue. The renderer at `doctor.ts:49` and every non-doctor caller of the parsers keep byte-identical behaviour.
- **Trade-offs**:
  - Pro: one function, one change, no cross-module audit; all four parse-error kinds (`preference-missing-field`, `preference-invalid`, `retired-missing-field`, `retired-invalid`, plus `iso-invalid` routed through the same push) are fixed at once because they share this single construction point.
  - Pro: zero risk to any other surface — dream, query, export, MCP errors are unaffected.
  - Con: it is prose parsing to undo prose formatting — the doctor now depends on the parser's exact suffix spelling, which is a second, quieter coupling replacing the first.
  - Con: fixes the symptom in one consumer; the same duplication reappears anywhere else that pairs these errors with a structured path field.
  - Con: sits awkwardly against the "findings carry data as fields, not prose" convention — the message still carries the data, it is just trimmed on the way out.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 2
**Rationale**: The path only lives in prose today, so Variant 1 deletes operator context from every non-doctor caller unless the same change fixes all of them, and Variant 3 trades one prose coupling for another that the next consumer will hit again. Variant 2 does what the fix direction asks — the message stops embedding the path — while keeping the data as a field, and it does so by extending a pattern (`BrainStatusFolderMismatchError`) that already exists in the very function being changed, so the two branches of `classifyParseError` end up consistent instead of one being the exception. If the cosmetic priority argues against the full migration, the typed error can land scoped to `parsePreference`/`parseRetired` only, with the remaining throw sites converted as they are touched.
