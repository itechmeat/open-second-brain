# Recon: health asserted from artifact presence (kanban t_a3254fe8)

Read-only reconnaissance against `main` @ 29ea0099. Note the readiness module is
`src/core/doctor-readiness.ts`, top-level `core/`, not under `core/brain/`.

## What is live and what is merely present

Genuinely live: `probeEmbeddingProvider` (`doctor-readiness.ts:226`) awaits a real
`provider.ping()`; `checkVaultWriteable` (`core/doctor.ts:41-53`) creates and
removes a probe file; `checkConfigWriteable` (`:57-75`) actually appends.

Asserted from presence, with line numbers:

- `probeRuntimeAdapterWiring` (`doctor-readiness.ts:251-296`) reports `pass` from
  in-process construction only. It never touches disk, never calls
  `adapter.detect` or `adapter.verify`, and returns "N runtime adapter(s) wired"
  on a machine where nothing is installed.
- `_json-mcp.ts:417-457` `verify()` returns `status: "ok"` because two JSON keys
  exist and hash-match. This is the install-artifact-presence assertion the unit
  targets.
- `doctor/records.ts:67`, `semantic-health-check.ts:78`, `active-budget-check.ts:34`,
  `uncertainty-probes.ts:51,137` all gate on bare `existsSync`, so an unreadable
  directory silently shrinks what was examined. The last one is the sharpest: the
  two probes whose whole job is reporting uncertainty are themselves gated on a
  probe that cannot tell absent from unreadable.
- `config-checks.ts:137` has the inverse defect: a path behind a permission denial
  is reported as a missing ignore path, contradicting the same file's comment at
  `:31-37`.
- `core/partner/codegraph.ts:294-299` returns null when the CLI is not on PATH, so
  no doctor output at all, which is indistinguishable from a clean check.

## staleness.ts has no clock at all

`src/core/brain/staleness.ts:49-63`. Fresh means
`min(outputs.mtime) >= max(inputs.mtime)`. Purely content-relative: an output
materialized in 2019 from inputs untouched since is fresh forever. `Date.now()` is
never read and the module takes no clock seam, against the project-wide `now?: Date`
convention.

Line 61 carries a second defect: `newestInputMs === null` is reported as fresh.
That branch fires when inputs were listed but none could be stat'ed, which is a
measurement failure, and the sole caller passes the whole vault page list. So "the
walk returned nothing readable" currently reads as "outputs are up to date, skip
the recompute". `tests/core/brain/staleness.test.ts:61-70` pins this as intended.

Sole consumer: `src/cli/brain/verbs/clusters.ts:49-60` and `:143-165`, where
`--if-stale` emits `skipped: "fresh"` and exits 0.

Config home: `policy/blocks/health.ts`. Three neighbouring keys live in a
`POSITIVE_INT_KEYS` tuple (`:16-20`) validated by one loop (`:88-95`), so a new
`materialize_max_age_days` is one tuple entry, one default, one line in
`resolveHealth`, one field on the two config types, and nothing else.
`stale_claim_max_age_days: 180` is the naming and unit precedent.

## Registries and the cost of a new check

Three registries, not unified: `DOCTOR_CHECKS` (a frozen array at
`brain/doctor.ts:130-162`, order is report order and is asserted),
`DEFAULT_PROBES` (`doctor-readiness.ts:306-310`, injectable as the second argument
of `runReadinessProbes`, which is how tests substitute), and `core/doctor.ts:394-414`
which has no registry at all and is a hand-written sequence of pushes.

A new Brain doctor check that emits a new code costs three to four files, because
`tests/core/brain/doctor-exit-census.test.ts` scans `src/core/brain/doctor/**` for
code literals and fails unless every code is either in `DIAGNOSTIC_SIGNALS`
(`brain/diagnostics.ts:113+`) with a structural next command or in
`DOCTOR_EXIT_EXCLUSIONS` (`brain/doctor-exits.ts:54-225`) with a written reason,
never both and never neither. A readiness probe costs one line; there is no census
over probe names.

## What a check emits, and the honest-unknown idiom

`DoctorIssue` (`brain/types.ts:1948-1976`) is severity, stable code, optional path,
message, and two link-only fields. There is no next command on the issue: it is
resolved out of band at render time by `nextCommandField(issue.code)`
(`cli/brain/verbs/doctor.ts:36`).

The unknown channel is the third stream. `DoctorUncertainEntry`
(`doctor/report.ts:126-137`) is for sub-operations the doctor attempted but cannot
claim completed cleanly, written only through `pushUncertain`
(`doctor/uncertain-stream.ts:54-71`), rendered `[UNSURE]`, emitted in JSON only
when non-empty, and deliberately excluded from the exit code. The governing
sentence is in `doctor/unreadable-path.ts:5-10`: no findings is what every surface
renders as a clean bill of health, so the operator was told the vault was fine
exactly where the doctor had been unable to look.

The closed-vocabulary form to copy for a new verdict is the frozen object plus
membership list plus type guard trio at `brain/schema-integrity.ts:61-125`, whose
docblock states the rule that none of the members is a softer way of saying ok.
Its twin is `NEGATIVE_RECALL_STATE`. Every such trio must register in
`tests/core/architecture/verdict-vocabulary-census.test.ts`.

`ReadinessStatus` is `pass | fail | skipped` (`doctor-readiness.ts:70`) with no
membership list, no guard, and no census entry. A probe that could not measure has
nowhere honest to go.

## Recommended surface

`staleness.ts` gains a three-state verdict and a wall-clock ceiling: a
`MATERIALIZE_FRESHNESS` trio of `fresh | stale | unknown`, a stale-reason
vocabulary of `not-materialized | input-newer | ceiling-exceeded`, and an
unknown-reason vocabulary of `outputs-unreadable | inputs-unreadable`, all
census-registered. `evaluateStaleness(inputs, outputs, { nowMs?, maxAgeMs? })`
returns state, the matching reason, the two instants and the age. The boolean
`fresh` is dropped rather than kept as a shim, because there is exactly one caller
and a boolean cannot carry unknown. The `--if-stale` branch then skips only on
fresh and, on unknown, recomputes and prints the reason.

Extract `MS_PER_DAY` once and re-point the five independent copies of
wall-clock-age-from-mtime math (`profile-doc.ts:124`, `temporal/stale-watch.ts:160`,
`idea-discovery.ts:96`, `deep-synthesis.ts:455`, `temporal/weekly-brief.ts:306`,
plus the existing `stale-dependency.ts:85`), which today spell one day three
different ways and disagree about whether a stat failure means fresh or stale.

`doctor-readiness.ts` gains `unknown` to `ReadinessStatus` with a membership list,
a guard and a census entry, plus `probeInstalledRuntimes` reading live installed
state: `adapter.verify(env)` per registered target, mapping `ok` to pass, `drift`
and `mcp-unreachable` to fail naming the target, `not-installed` to skipped, and an
unreadable manifest to unknown. `probeRuntimeAdapterWiring` keeps its name and
narrows its detail to what it actually proves, so the two claims stop being
conflated.

## Adjacent defects worth the same pass

1. `_json-mcp.ts:69` declares `probeMcp` and zero adapters implement it (two grep
   hits, the declaration and the call), so every JSON-MCP runtime reports ok on the
   strength of two JSON keys while the `mcp-unreachable` status is reachable only
   from `copilot-cli.ts:385`. A dead seam that makes an unverifiable check report
   clean.
2. `cli/install/install.ts:268-269` exits 0 for both `mcp-unreachable` and
   `not-installed`, so `o2b install --check` reports success for a runtime it
   proved unreachable.
3. `idea-discovery.ts:94-100` returns age 0 on a stat failure, so an unreadable
   note reads as brand new.
4. `runtime-notices.ts:210-217` catches everything and returns false while its own
   docblock says any probe error means not detectable, which the return type cannot
   express.
5. `config-checks.ts:137` false-positives on an unstattable path.
