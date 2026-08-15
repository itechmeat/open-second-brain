# Recon: announced provider/model sunset warning (t_e7a226ce)

Read-only reconnaissance against `feat/nothing-runs-unwatched` at v1.47.0
(`package.json:3`). Every claim below carries an anchor to a line actually read.
Where the source refused to settle a question, that is said plainly.

---

## 1. The presets catalog

**Where it is.** `src/core/search/embeddings/presets.ts`. The whole file was
read.

**What a preset is today.** `EmbeddingModelPreset` at
`src/core/search/embeddings/presets.ts:30-67`, seven fields:

| field | line | note |
| --- | --- | --- |
| `model` | `:32` | the string sent to the endpoint; also the catalog key |
| `label` | `:34` | short human label for CLI listings |
| `dimension` | `:36` | native embedding width |
| `inputWindowTokens` | `:53` | declared max input, from the model's published spec |
| `multilingual` | `:55` | trained for cross-lingual retrieval |
| `note` | `:57` | one-line guidance shown beside the model |
| `queryPrefix` / `passagePrefix` | `:64`, `:66` | optional, e5-family instruction prefixes |

**Keying.** There is no map. `EMBEDDING_MODEL_PRESETS` is a frozen array of six
entries (`presets.ts:75-138`), and lookup is a linear scan on exact model string:
`findEmbeddingPreset` at `presets.ts:144-146` (`p.model === model`). No
normalisation, no family heuristic — `presets.ts:161-166` states the refusal to
infer a window from a name explicitly, because `e5` prefixes are a property of
the instruction format while a window differs between checkpoints of one family.

**Is it a closed vocabulary?** No, and the file says so at `presets.ts:6-10`:
"Advisory only: the free-form custom `--model` entry stays first-class, and OSB
targets arbitrary OpenAI-compatible endpoints, so a preset is guidance … never a
constraint." The array is `Object.freeze`d (`:75`) — frozen as a *value*, not as
a *vocabulary*.

**Where it is consumed.** Three call sites, and only three:

1. `src/cli/search/verbs/provider-registry.ts:215` — passed as `ops.presets`
   into the shared registry-CRUD dispatcher. The `presets` action renders the
   catalog at `provider-registry.ts:116-127`; note `:115` — "`presets` is a
   static catalog listing; it needs no vault/config", so the verb runs before
   `resolveConfig` and knows nothing about what the operator is actually using.
   The human rendering at `:121-124` prints only `model`, `dimension`,
   the multilingual tag and `note`; `inputWindowTokens` is *not* printed. The
   `--json` arm at `:118` dumps the array verbatim, so it does print every field.
2. `src/cli/search/verbs/provider-registry.ts:184` — `RECOMMENDED_EMBEDDING_MODEL`
   (`presets.ts:141`, the first entry) is the default for `--model` when omitted
   on `search provider add`.
3. `src/core/search/indexer.ts:41` → `declaredInputWindowTokens` at
   `indexer.ts:705`, inside `censusChunkWindow` (`indexer.ts:694-739`). This is
   the only *diagnostic* consumer.

`resolveEmbeddingPrefixes` (`presets.ts:232-245`) is a fourth internal consumer,
used by the embed path.

**Where a per-preset sunset field would go, and what it would break.**

- It goes on `EmbeddingModelPreset` as an optional field, beside
  `inputWindowTokens`. Optional matters: five of the six presets are open
  checkpoints on Hugging Face with no vendor shutdown authority at all, so a
  required field would force an invented value onto every row — the exact defect
  `presets.ts:158-159` names ("reported as a check that did not run - never as a
  pass").
- What breaks structurally: **nothing compiles-wrong** for an optional field.
  `provider-registry.ts:118` (`JSON.stringify(ops.presets)`) would start emitting
  the new key in `o2b search provider presets --json` — an additive payload
  change, but a payload change. `tests/core/search/embeddings.presets.test.ts:15`
  iterates every preset asserting per-field invariants; a new field with its own
  invariant belongs there.
- What breaks *semantically*: the catalog's stated purpose is "known-good
  embedding models surfaced when a user registers an OpenAI-compatible provider"
  (`presets.ts:4-6`). A curated list of *recommendations* that also carries
  *obituaries* is two catalogs in one file. A dying model has no business being
  `RECOMMENDED_EMBEDDING_MODEL` (`presets.ts:141` takes index 0 unconditionally)
  nor being defaulted into a new provider profile at
  `provider-registry.ts:184` — and nothing in either site would consult a sunset
  field unless it were wired to.

---

## 2. How the configured provider/model is resolved at runtime

**The chain.** `resolveSearchConfig` at `src/core/search/index.ts:394` onwards.

1. Config file → flat string map. `src/core/search/index.ts:401-403` calls
   `discoverConfig(opts.configPath).data`, which is
   `parseSimpleYaml(readConfigText(resolved))` (`src/core/config.ts:211`).
   `parseSimpleYaml` (`src/core/config.ts:153-174`) is a line-splitter producing
   `Record<string, string>` — **flat only**. `src/core/config.ts:194-196` states
   it "skips whatever it cannot represent (comments, blank lines, nested
   blocks)". A nested block in the o2b config file is silently dropped.
2. Provider name: `index.ts:464-470`, `envOrConfig(env, config,
   "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER", "embedding_provider")`.
3. Registry expansion first-but-lower-precedence: `resolveRegistryProvider`
   (`index.ts:377-393`) returns non-null only for a name that is neither null nor
   a built-in (`BUILTIN_PROVIDERS`, `index.ts:369-373`). It is fail-soft — a bad
   registry yields `null` (`index.ts:390-392`).
4. `const provider = registryExpansion ? "openai-compat" : parseProvider(rawProvider)`
   (`index.ts:467`). `parseProvider` (`index.ts:358-366`) accepts exactly four
   strings and throws otherwise. So **the resolved provider is a closed union of
   four**: `openai-compat | zeroentropy | local | disabled`.
5. Model: `index.ts:481-486` reads `embedding_model` /
   `OPEN_SECOND_BRAIN_EMBEDDING_MODEL`, then `index.ts:492`:
   `const model = explicitModel ?? registryExpansion?.model ?? null`.
   **No validation of any kind is applied to the model string.**
6. Registry profiles: `ProviderProfile.defaultModel` (`embeddings/registry.ts:26`)
   is validated only for non-emptiness (`registry.ts:115-117`). The profile name
   is slug-checked (`registry.ts:99-105`) and reserved names refused
   (`registry.ts:106-111`); the model is not checked against anything.
7. At census/status time the *effective* model comes from `activeEmbeddingModel`
   (`indexer.ts:641-647`): `local` → `LOCAL_EMBEDDING_MODEL`, otherwise
   `config.semantic.model ?? storedModel` — i.e. it can also come from the
   index's own `embedding_model` state cell.

**The critical answer: yes, a user can configure a model outside the catalog,
and this is the normal case, not the edge case.**

Evidence beyond the type: the tool's *own onboarding text* recommends an
off-catalog model. `src/cli/main.ts:266-267` prints

```
  embedding_base_url:      "https://openrouter.ai/api/v1"
  embedding_model:         "google/gemini-embedding-2-preview"
```

`google/gemini-embedding-2-preview` is not in `EMBEDDING_MODEL_PRESETS`
(`presets.ts:75-138`) — and it is a *preview* model, precisely the class most
likely to be decommissioned. `findEmbeddingPreset` returns `null` for it
(`presets.ts:145`), which `tests/core/search/embeddings.presets.test.ts:32-34`
pins for a custom model.

**Consequence for the design, stated as the source demands it.** A sunset check
keyed on the catalog can only ever speak about catalog members. For everything
else it must say **"this model is unknown to the curated catalog, so no sunset
statement was made"** — never "no sunset announced". The codebase already has
this exact distinction implemented once, for the input window:
`declaredInputWindowTokens` (`presets.ts:168-171`) returns `null` meaning
UNKNOWN, and `presets.ts:150-159` spells out why it is deliberately *not* shaped
like `pricePerMillionTokens` (`signature.ts:59-63`, which answers `0` for an
unlisted model): "An unknown window has the opposite polarity - treating it as
'fits' would report a passing check for a condition nobody measured, which is
the misleading silence this census exists to remove." A sunset date has the same
polarity as a window, not as a price. The wire-level precedent is
`ChunkWindowCensus`'s `window-undeclared` verdict (`src/core/search/types.ts:186-193`)
mapping to its own diagnostic code (`types.ts:218`).

**Also unestablished by the catalog: the provider.** The task asks the warning to
name "the provider". The four resolved provider values (`index.ts:358-366`) are
transport kinds, not vendors — `openai-compat` says nothing about whose endpoint
it is. The vendor identity, when there is one, lives in `embedding_base_url`
(`index.ts:475-480`) or in a registry profile's `baseUrl`
(`embeddings/registry.ts:25`), both free-form URLs with no validation beyond
non-emptiness (`registry.ts:112-114`). I could not find any place in the tree
that maps a base URL to a vendor identity.

---

## 3. Embedding identity, and what a model change costs

**Identity.** `EmbeddingIdentity` at `src/core/search/embeddings/signature.ts:15-19`
is the triple `{ provider, model, dimension }`. `embeddingSignature`
(`signature.ts:37-42`) canonicalises it to `<provider>:<model>:<dimension>` with
NFC + trim + lowercase (`signature.ts:27-29`) and a `?` sentinel for nulls
(`signature.ts:25`). `LOCAL_EMBEDDING_MODEL = "hashing-ngram-v1"`
(`signature.ts:22`). `isStaleSignature` (`signature.ts:227-229`) is plain string
inequality.

**What happens when the model changes under an existing index.** There *is* an
invalidation path, it is real, and it is gated:

- The index records three ABI tokens: `embedding_model`, `embedding_dimension`,
  `embedding_vec_version` (`src/core/search/store/embedding-abi.ts:29-34`,
  keys at `src/core/search/store/state.ts:33-34`).
- On **read open**, `Store.resolveEmbeddingAbi`
  (`src/core/search/store.ts:224-233`) compares recorded against runtime
  (`store.ts:226-228`), and under mode `fail` throws
  `SearchError("EMBEDDING_DIMENSION_MISMATCH", …)` (`store.ts:232`).
- The mode is operator config. `src/core/brain/policy/blocks/integrity.ts:68`
  — **default is `warn`, not `fail`** — with `:88` showing `fail` only under the
  strict profile. `store.ts:188-191` notes the drift list is structurally empty
  when the gate is `off`.
- A mismatch whose *recorded* side is `null` (a store predating the stamp) is
  reported but never refused: `contradictedAbiFields`
  (`embedding-abi.ts:81-83`) filters to `expected !== null`, and
  `embedding-abi.ts:72-77` explains why.
- The single remediation string is `EMBEDDING_ABI_FIX_COMMAND =
  "o2b search reindex --embeddings"` (`embedding-abi.ts:25`), rendered by
  `formatEmbeddingAbiDrift` (`embedding-abi.ts:90-97`), reused by
  `search check` (`indexer.ts:1488-1494`) and surfaced as `embedding_abi:` in
  both report shapes (`src/cli/search/verbs/check.ts:437-439`, `:394-397`).

So: **not silent nonsense — but by default only a warning**, and only once the
model has *already* changed. The sunset warning is the strictly earlier signal:
it fires while the config is still correct and the index still valid. Nothing in
the ABI machinery can fire before the operator edits the model, which is the gap
t_e7a226ce identifies. What the ABI path does establish is the cost the sunset
warning is warning *about*: a model change invalidates every stored vector and
the remedy is a full re-embed of the corpus, named at `embedding-abi.ts:25`.

---

## 4. The doctor / diagnostics check idiom

### The registry is not the checks

`src/core/brain/diagnostics.ts:348-435` — the lines the task body cites — are
**registry entries**, not checks. `DIAGNOSTIC_SIGNALS`
(`diagnostics.ts:125` … `:718`) is a `ReadonlyMap<string, DiagnosticSignal>`
whose entries are `{ code, issueClass, nextCommand, autoRepairable }`
(`diagnostics.ts:77-86`). The entries at `:371-459` name search-config *states*;
the code that detects them lives in `src/core/search/` and
`src/core/brain/doctor/`. See Divergences.

### Anatomy of a doctor check

- **Contract**: `src/core/brain/doctor/check.ts` — `DoctorCheck` has
  `failSoft: boolean` and `run(ctx, out): void`. `DoctorCheckContext` carries
  `vault`, `now: Date`, `config: BrainConfig | undefined`, `dbPath`,
  `configPath`, `knownBasenames`, `idIndex`, `preferences`, `logs`.
- **Registration**: append to the frozen `DOCTOR_CHECKS` array in
  `src/core/brain/doctor.ts:132-166`. Order is contractual
  (`doctor.ts:126-130`). The runner is `doctor.ts:264-282`; a `failSoft` check's
  throw is swallowed there (`:277-281`).
- **Finding shape**: `DoctorIssue` at `src/core/brain/types.ts:1977-2010` —
  `severity`, `code`, optional `path`, `message`, optional `field`, `target`,
  `sources`.
- **Severity vocabulary**: exactly two values.
  `export type DoctorSeverity = "warning" | "error"` at
  `src/core/brain/types.ts:1971`. There is no `info`. Partitioning is
  `doctor.ts:294-296`.
- **Message**: a free string, rendered by `renderIssueLine` in the CLI.
- **`nextCommand`**: never written at the finding site. It is resolved from the
  registry — `resolveNextStep` (`src/core/brain/next-step.ts:36-43`, returns
  `null` for an unregistered code) or `requireNextStep`
  (`next-step.ts:67-71`, throws `UnregisteredNextStepError`). The JSON key is
  `NEXT_COMMAND_KEY = "next_command"` (`next-step.ts:79`). New consumers MUST use
  `next-step.ts`, not the lenient `resolveSignal`
  (`diagnostics.ts:719-731, 732-740`), which fabricates a generic
  `o2b brain doctor` hint for unknown codes.

### Severity → process exit

`src/cli/brain/verbs/doctor.ts:212-214`:

```
if (result.errors.length > 0) return 1;
if (result.warnings.length > 0 && flags["strict"]) return 2;
return 0;
```

A `warning` therefore exits **0** unless `--strict` is passed, in which case
**2**. The `uncertain` stream deliberately does not feed the exit code
(`doctor.ts:156-162`).

For contrast, `o2b search check` has its own table:
`SEARCH_CHECK_EXIT = { ok: 0, fatal: 1, providerUnreachable: 5, probeIncomplete: 6 }`
(`src/cli/search/verbs/check.ts:107-112`), computed by `exitCodeForCheck`
(`check.ts:129-144`).

### What the doctor-exit census requires — precisely

`tests/core/brain/doctor-exit-census.test.ts`. It enumerates the population from
source, not from the tables: `doctor.ts` plus every `.ts` under
`src/core/brain/doctor/` recursively (`:74-85`, `:113-117`), plus modules
followed through `import { …_CODE… } from "./…"` statements (`:91-111`).
Two code shapes are read: `code: "<literal>"` (`:127`) and
`const <NAME>_CODE = "<literal>";` (`:130`).

A new doctor check must satisfy all of:

1. **Classified exactly once.** Its code is in `DIAGNOSTIC_SIGNALS` **or** in
   `DOCTOR_EXIT_EXCLUSIONS`, never both, never neither (`:235-248`).
2. **If registered, it must be added to the pinned list.**
   `DOCTOR_REGISTERED_CODES` (`:177-200`, currently 22 entries) is asserted
   equal, as a sorted newline-joined string, to the doctor codes present in the
   registry (`:250-258`). Adding a registered doctor code without editing this
   array fails. The docblock at `:163-176` states this is deliberate — "Adding a
   doctor code with a command, or retiring one, edits this list in the same
   commit - which is the review this census exists to force."
3. **If excluded instead**, the reason must be ≥ 80 characters
   (`MIN_REASON_LENGTH`, `:203`; asserted `:266-272`) and must **not** contain an
   `o2b <verb>` invocation (`INVOCATION_RE`, `:206`; asserted `:274-279`) —
   "a code with one belongs in the registry".
4. **The code must be syntactically readable.** A `code:` value that is neither a
   string literal nor a `*_CODE` identifier fails `:296-303` unless declared in
   `NON_LITERAL_CODE_SITES` (`:145-161`).
5. **Non-vacuity floors** at `:281-292` (`codes.length > 35`, registered `> 14`,
   excluded `> 20`, source paths `> 10`) rise as codes are added; adding one
   never breaks them.

Additionally, any new `DIAGNOSTIC_SIGNALS` entry must pass the registry prose
guard in `tests/core/brain/next-step.test.ts:58-70`: `nextCommand` must match
`STRUCTURAL_COMMAND_RE` (`:29-30`) — `o2b` plus one-to-three verb words plus only
long flags or `<placeholder>` arguments — and contain no `.!?;,:`
(`SENTENCE_PUNCTUATION_RE`, `:33`), no newline, no double space.

And any new closed vocabulary (e.g. a sunset verdict enum) whose values cross the
TypeScript boundary into a `--json` payload must register in
`tests/core/architecture/verdict-vocabulary-census.test.ts` with the
frozen-object / members-list / type-guard trio — the file's own rule at `:1-26`,
and `PROVIDER_PROBE` is registered there at `:494-505` for exactly this reason.

---

## 5. Time

**There is an injectable clock seam, and the doctor already uses it.**

- `DoctorCheckContext.now: Date` (`src/core/brain/doctor/check.ts:26`) —
  "Wall clock for the age-based lints, so tests can pin it."
- Supplied by `runDoctor`: `now: opts.now ?? new Date()`
  (`src/core/brain/doctor.ts:371`), with `now?: Date` declared on the options at
  `src/core/brain/doctor/report.ts:24`.
- A check consumes it by destructuring: `run({ vault, now }, …)` in
  `src/core/brain/doctor/stale-dependency-check.ts:438`, passed on at `:441`.

**The v1.47.0 "refuse a declared instant later than the reading clock" idiom.**
`src/core/search/authored-at.ts`. `usableAuthoredAtSeconds`
(`authored-at.ts:39-47`) takes `nowMs` as a parameter and returns `null` for
`authoredAtSeconds * 1000 > nowMs` (`:45`). The module header states the
discipline verbatim at `:16-17`: "Pure and injectable: the caller passes the
clock, so nothing here reads `Date.now()`". `:33-37` explains why a refusal
returns `null` rather than a clamped substitute — "Clamping to the reading clock
instead would leave the document at the top of the freshness curve forever,
which is the defect rather than its fix."

The same shape exists in the Brain layer: `src/core/brain/stale-dependency.ts:420`
drops a state whose `changed_at` parses to `> nowMs`, with the rationale at
`:394-396` ("a `valid_until` in the future has not closed yet").

**Where `Date.now()`/`new Date()` is called directly**, for contrast:
`src/core/search/store/sql.ts:13-15` (`nowIso`), `src/core/brain/time.ts:100-107`
(`isoSecond`/`isoDate`, both defaulting `d: Date = new Date()`).
`src/core/brain/time.ts:87-95` shows the preferred alternative — `fileAgeMs`
takes `nowMs` as a required parameter, "so a caller that already holds a pinned
clock cannot accidentally measure against a second, later one mid-scan".

**`indexCheck` has no clock at all.** Reading `src/core/search/indexer.ts:1331-1473`
end to end: no `Date`, no `now`, no time parameter. `IndexCheckOptions`
(`indexer.ts:1319-1329`) carries only `probeProvider`. A sunset comparison placed
in `search check` would be the first time-dependent statement in that report, and
would need a new seam.

**Date format in this codebase.** Two accepted shapes, one parser:
`parseIsoUtc` (`src/core/brain/health/iso-time.ts:20-23`) accepts date-only
`YYYY-MM-DD` (`ISO_DATE_ONLY_RE`, `:12`) and expands it to `T00:00:00Z` before
`Date.parse` — explicitly "so the millisecond result is identical on every engine
and peer, never drifting to a local-midnight interpretation" (`:15-18`).
`isValidIsoInstant` (`:30-32`) is the loud-rejection predicate. Frontmatter
emits UTC via `isoSecond` → `YYYY-MM-DDTHH:MM:SSZ` and `isoDate` →
`YYYY-MM-DD` (`src/core/brain/time.ts:100-107`). Everything is UTC; I found no
timezone-aware date handling anywhere in the tree. The doctor already has a code
for a malformed one: `iso-invalid`, excluded from the registry with the reason at
`src/core/brain/doctor-exits.ts:185-191`.

Note the polarity clash to design around: a sunset date is a *future* instant and
therefore legitimately `> nowMs`, which is the exact condition both
`authored-at.ts:45` and `stale-dependency.ts:420` refuse. The v1.47.0 idiom to
reuse here is the *injectable-clock parameter*, not the future-refusal predicate.

---

## 6. Where sunset metadata could honestly come from

Four options are visible in this tree. Evidence and failure modes only; no
recommendation.

### (a) A static field on `EmbeddingModelPreset`

Fits `presets.ts:30-67` mechanically (see §1). Precedent: `inputWindowTokens`
(`:53`) is exactly this — a third-party fact hardcoded from published specs, with
per-entry source comments (`:80-81`, `:92`, `:102-104`, `:112`, `:121-122`,
`:131-133`).

- **Stale**: a date passes, the model is already gone, and the check keeps
  warning about a shutdown in the past — or, worse, a vendor *postpones* and the
  tool warns about a date that no longer exists. The binary is the only source of
  truth and the operator cannot correct it without a release.
- **Absent**: the model is off-catalog (§2 — the normal case, including this
  tool's own onboarding recommendation at `src/cli/main.ts:267`). The check
  cannot speak. It must say "unknown to the catalog", which the codebase already
  models via `null`-means-UNKNOWN (`presets.ts:150-159`) and the
  `window-undeclared` verdict (`src/core/search/types.ts:186-193`).
- Note also: five of six presets are open checkpoints with no vendor able to
  announce a shutdown, so the field would be absent on most rows even in-catalog.

### (b) A config-declared date

The o2b config file is flat `Record<string, string>` — `parseSimpleYaml`
(`src/core/config.ts:153-174`), nested blocks silently dropped
(`src/core/config.ts:194-196`). So this can only be a scalar key such as
`embedding_model_sunset: "2026-11-01"`, resolved through the same
`envOrConfig` idiom as every other search key (`index.ts:481-486`), and it
describes exactly one model — the one currently configured.

`Brain/_brain.yaml` is the other config surface and *does* support nested blocks
(`src/core/brain/policy/blocks/`, e.g. `integrity.ts:104`), so a per-provider map
could live there — but it is read by the Brain layer, not by
`resolveSearchConfig`, and `DoctorCheckContext.config` (`doctor/check.ts:28`) is
already that type.

- **Stale**: an operator writes a date, the vendor moves it, nobody edits the
  file. The tool warns confidently about a wrong date. Nothing can detect this.
- **Absent**: silence. And silence here is the defect this project keeps fixing —
  the check must distinguish "operator declared no date" from "no shutdown
  exists", which a single optional key cannot do on its own.
- **Malformed**: covered by the existing predicate `isValidIsoInstant`
  (`health/iso-time.ts:30-32`) and the existing `iso-invalid` disposition
  (`doctor-exits.ts:185-191`) — reject loudly, never treat as absent.

### (c) A fetched registry (network)

**The project's stance, as found:**

- `presets.ts:9-10`: "No server, no network - the list is consulted entirely at
  registration time."
- `src/cli/search/verbs/check.ts:507-511`: the provider probe is "The one
  outbound call this verb makes", opt-*out* via `--no-probe`, and `--no-probe`
  exists "for the caller who cannot spend a network round-trip - an air-gapped
  machine, a tight CI loop".
- `src/core/brain/runtime-notices.ts:8-9`: notices are computed "deterministically
  - no network, no LLM, no DB open".
- `src/core/doctor-readiness.ts:257-261`: a key-less remote provider is refused
  locally rather than "making a credential-free outbound request whose only
  possible outcome is an auth error".
- The vault deliberately has no git transport — see CHANGELOG v1.47.0, "the vault
  has no git transport and deliberately never will, a constraint written verbatim
  in seven design documents".
- `tests/core/architecture/egress-census.test.ts` polices *outbound vault
  content*, not inbound fetches, so it would not by itself block a registry
  fetch — but every module docblock above treats an unrequested network call as a
  cost that must be declared.

Failure modes: **stale** — a cached registry is the same lie as (a) with more
machinery; **absent/unreachable** — the check did not run, and per
`check.ts:140-143` and `provider-probe.ts:21-28` that is a first-class third
answer requiring its own state, not a fold into pass or fail.

### (d) An operator-declared date per provider profile

`ProviderProfile` (`src/core/search/embeddings/registry.ts:23-34`) is a
persisted, editable JSON record at
`Brain/search/embedding-providers.json` (`registry.ts:52-54`), loaded fail-soft
(`registry.ts:73-88`) and validated field by field (`registry.ts:98-124`). Adding
an optional `sunsetAt` there gives a per-provider, per-model, operator-owned date
that survives upgrades, is not baked into the binary, and is already
round-tripped through `add`/`show`/`list` in
`src/cli/search/verbs/provider-registry.ts`.

- **Stale**: same as (b) — the operator's date, nobody's job to refresh.
- **Absent**: only registered profiles have one. A provider configured purely
  through `embedding_base_url` + `embedding_model` (the path `src/cli/main.ts:266-268`
  actually recommends) has no profile at all, so there is nowhere to put the
  date. `isProfile` (`registry.ts:61-70`) would need to keep accepting profiles
  without the field or every existing registry file becomes unparseable —
  fail-soft loading (`registry.ts:73-79`) means a validation tightening here
  degrades to "empty registry", i.e. the provider silently stops resolving.

---

## Divergences

Every point where t_e7a226ce's framing did not survive contact with the source.

1. **"`src/core/brain/diagnostics.ts:348-435` already hosts adjacent search-config
   checks."** It does not host *checks*. Those lines are entries in the
   `DIAGNOSTIC_SIGNALS` registry (`diagnostics.ts:125`–`:718`), which maps a code
   to a `nextCommand` string (`diagnostics.ts:77-86`). No detection runs there.
   The detection for `search-chunk-window-undeclared` is `censusChunkWindow` in
   `src/core/search/indexer.ts:694-739`; the capability-tier states at
   `diagnostics.ts:371-398` are resolved by `src/core/search/capability-tier.ts`.
   A new check therefore needs **two** edits in two layers, not one.

2. **"provider not configured / disabled" is not a doctor check either.** It is
   `resolveSemanticCapability` consumed by `indexCheck`
   (`src/core/search/indexer.ts:1340`, `:1401-1404`) and by `probeEmbeddingProvider`
   (`src/core/doctor-readiness.ts:275-282`). The registry entries at
   `diagnostics.ts:371-388` deliberately point at `o2b search check`, not at an
   edit command, because "no verb in this tool writes one" (`diagnostics.ts:366-370`).

3. **"a curated presets catalog exists but no sunset registry" — the catalog is
   also the wrong shape for one.** Five of its six entries
   (`presets.ts:75-138`) are open-weight checkpoints (`intfloat/…`, `BAAI/…`,
   `sentence-transformers/…`, `Alibaba-NLP/…`) with no vendor decommission
   authority. The models that actually get decommissioned — hosted, versioned,
   preview — are precisely the ones **not** in the catalog. The three model names
   that appear in `EMBEDDING_PRICING` (`signature.ts:51-56`:
   `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`)
   are hosted OpenAI models and are in *that* table but not in the presets
   catalog at all. So the repo already keeps a second, disjoint list of
   vendor-hosted model names, and neither list is the other's superset.

4. **"warns … the warning names the provider".** The resolved provider is one of
   four transport kinds (`index.ts:358-366`), not a vendor. Vendor identity, when
   it exists, is only inferable from a free-form `embedding_base_url`
   (`index.ts:475-480`) or profile `baseUrl` (`registry.ts:25`), and no code in
   the tree maps a URL to a vendor.

5. **"the migration command".** There is exactly one relevant command already
   named in the tree and it is a *reindex*, not a migration:
   `EMBEDDING_ABI_FIX_COMMAND = "o2b search reindex --embeddings"`
   (`embedding-abi.ts:25`). Nothing in this tool writes a config key — stated at
   `diagnostics.ts:366-370` and again at `diagnostics.ts:443-446` and `:455-457`
   — so "switch to model X" cannot be a command. The existing precedent for this
   exact shape is `search-chunk-window-undeclared`, whose `nextCommand` is
   `o2b search provider presets` (`diagnostics.ts:451-458`): the catalog is
   pointed at *because* the config edit has no verb.

6. **"a diagnostics/doctor check" — the two candidate homes are not
   interchangeable, and neither is free.**
   - `o2b brain doctor`: has the clock seam (`doctor/check.ts:26`), has the
     severity vocabulary, is bound by the doctor-exit census (§4). But **no
     doctor check currently resolves search config**; the only index-aware check
     is `doctor/store-integrity.ts:34-36`, which uses `ctx.dbPath` and never
     `resolveSearchConfig`. The `core/brain → core/search` import edge does
     already exist (`src/core/brain/runtime-notices.ts:32` imports
     `resolveSearchConfig` from `../search/index.ts`), so the edge is permitted.
   - `o2b search check`: already owns the provider question and the exit codes
     5/6, but has **no clock** (`indexer.ts:1331-1473`) and no severity ladder —
     only `warnings[]`, `fatal[]`, `recommendations[]`
     (`src/core/search/types.ts:407` onward, rendered at `check.ts:446-452`).
   The task body names neither, and picking one is a real decision.

7. **The companion framing is right, and the source makes the boundary sharper
   than "now vs later".** The probe answers in a five-member closed vocabulary
   (`PROVIDER_PROBE`, `src/core/search/provider-probe.ts:58-64`) about *this
   endpoint, this instant*, with the whole point being that `timed-out` and
   `skipped` are not verdicts (`provider-probe.ts:21-28`). A sunset check makes
   no call and produces no probe state. There is no duplication risk — but there
   is a **precedence** question the task does not raise: `exitCodeForCheck`
   (`check.ts:129-144`) already orders faults by how basic they are, and a
   provider proved unreachable *today* plus a shutdown announced for *next month*
   are two true statements about one endpoint that would both want to be said.

8. **"surfacing the risk weeks ahead" implies a threshold the source has no
   convention for.** I found no configured "warn N days before" window anywhere
   in the search or doctor layers. The nearest thing is
   `MS_PER_DAY`/`msToWholeDays` (`src/core/brain/time.ts:57-75`), a pure unit
   conversion with no policy attached.

---

## What a design must not assume

- **Do not assume the configured model is in the catalog.** It usually is not
  (§2), and this tool's own onboarding text recommends one that is not
  (`src/cli/main.ts:267`).
- **Do not report "unknown to the catalog" as "no sunset announced".** These are
  different statements. The codebase has already ruled on this polarity twice:
  `presets.ts:150-159` (unknown window ≠ fits) and
  `src/core/search/types.ts:186-193` + `:218` (`window-undeclared` gets its own
  verdict and its own diagnostic code). The price table's opposite convention
  (`signature.ts:59-63`, unknown → 0) is explicitly called out as safe only
  because its fallback makes a gate *decline* to fire.
- **Do not assume a `warning` severity produces a non-zero exit.** It exits 0
  unless `--strict` (`src/cli/brain/verbs/doctor.ts:212-214`).
- **Do not assume the provider name identifies a vendor.** Four transport kinds,
  no vendor mapping (`index.ts:358-366`).
- **Do not assume a nested config block will be read.** `parseSimpleYaml` drops
  them silently (`src/core/config.ts:153-174`, `:194-196`). Only `Brain/_brain.yaml`
  takes nesting (`src/core/brain/policy/blocks/`).
- **Do not read `Date.now()` inside the check.** Take the clock as a parameter —
  `DoctorCheckContext.now` (`doctor/check.ts:26`) if in the doctor,
  a new explicit parameter if in `search check`, following
  `authored-at.ts:16-17` and `time.ts:87-95`.
- **Do not reuse the future-instant refusal.** `authored-at.ts:45` and
  `stale-dependency.ts:420` both discard instants later than now; a sunset date
  is *supposed* to be later than now.
- **Do not write the command at the finding site.** Register it in
  `DIAGNOSTIC_SIGNALS` and resolve through `next-step.ts:36-43` / `:67-71`; the
  string must pass `STRUCTURAL_COMMAND_RE`
  (`tests/core/brain/next-step.test.ts:29-30`) — no punctuation, no prose.
- **Do not add a doctor code without editing `DOCTOR_REGISTERED_CODES`**
  (`tests/core/brain/doctor-exit-census.test.ts:177-200`, asserted `:250-258`).
- **Do not assume a stale date is detectable.** No option in §6 can tell a
  correct date from one the vendor has since moved. Whatever the source, the
  design has to say where the number came from and when it was last true, or it
  will eventually assert a shutdown that did not happen — which is the same class
  of defect as the silence it is trying to remove.
- **Do not assume `search check` and `brain doctor` can share the finding shape.**
  They have different vocabularies (`DoctorSeverity` at `types.ts:1971` vs
  `warnings`/`fatal`/`recommendations` at `src/core/search/types.ts:407`+) and
  different exit tables (`doctor.ts:212-214` vs `check.ts:107-112`).
