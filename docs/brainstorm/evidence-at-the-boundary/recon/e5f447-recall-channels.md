# Recon: two silences that look identical (kanban t_e5f447c1)

Read-only reconnaissance against `main` @ 29ea0099.

## The record, and why `host` cannot be reused as a channel

`emitRecallTelemetry` writes into the shared continuity store,
`appendContinuityRecord(vault, {kind:"recall_telemetry", ...})`
(`recall-telemetry.ts:304`), which lands in
`<vault>/Brain/log/continuity/YYYY-MM.jsonl` (`continuity/store.ts:97`) under the
closed `ContinuityRecordKind` union (`continuity/types.ts:30-57`). Payloads pass
through redaction and `clipPayloadToBudget` (`store.ts:210-235`), which drops
non-protected keys under pressure; only `session_id` and `agent_id` are protected
(`continuity/types.ts:25-28`).

Payload keys today (`recall-telemetry.ts:311-327`): `host`, `session_id?`,
`turn_id?`, `mode`, `status`, `duration_ms`, `result_count`, `top_artifacts[]`,
`gaps[]`, `metadata?`, `signals?`.

`host` is an open, caller-supplied free string capped at 200 characters and never
validated (`mcp/brain/shared.ts:240`, `mcp/search-tools.ts:713`,
`mcp/brain/query-tools.ts:125`, `cli/brain/verbs/context-pack.ts:77`). Its meaning
is already overloaded: the defaults `"mcp"` and `"cli"` are channel-ish while real
callers put runtime identity in it. One column answering both questions answers
neither reliably. `agent_scope` exists only as a search-visibility argument and is
never recorded.

## The channels that actually exist

`emitRecallTelemetry` has four production callers: `search-tools.ts:844` and
`:808`, `query-tools.ts:143`, `context-pack.ts:702` (reached from both MCP and
CLI, distinguished today only by a free-text default), and
`pre-compress-pack.ts:291`.

The hole is hooks. `hooks/recall-inject.ts` is the `UserPromptSubmit` hook that
actually injects recalled notes as `additionalContext`, and it emits zero recall
telemetry: it writes one `appendAuditRecord` line at `:48-57` with
`decision: inject | abstain | error` and nothing else. Same for the sibling
injectors.

There is no Hermes code path in this repository: `hermes` appears as a placeholder
agent name, an install doc, and a `telemetry_host` string in tests. It is a host,
not a channel. Do not mint a `hermes` channel.

The honest closed set is `mcp | cli | hook`. Anything finer belongs in `mode` or
`metadata`.

## What can testify that a hook is installed

Of the nine registered adapters only grok writes hooks
(`install/adapters/grok.ts:57,120,138`). Claude Code hooks ship inside the plugin
(`hooks/hooks.json`, `plugin.yaml`) with no adapter and no manifest entry, so
`defaultRegistry.get(host)?.verify(env).status` cannot answer the question for the
channel operators actually complain about.

What can: the hook audit trail at
`<vault>/.open-second-brain/hook-audit/<ISO-week>.jsonl`
(`core/reliability/audit.ts:15-33`), plus the config gate
`resolveRecallInjectEnabled` (`core/config.ts:978-984`, default off). Enabled plus
audit evidence gives the three-way distinction the unit needs.

## Recommended surface

Declare the vocabulary in `recall-telemetry.ts` following the
`INGEST_DEDUP_SURFACES` shape (`dedup-telemetry.ts:48-54`), which is the existing
correct precedent for a closed dimension:

```ts
export const RECALL_CHANNELS = Object.freeze(["mcp", "cli", "hook"] as const);
export type RecallChannel = (typeof RECALL_CHANNELS)[number];
export function isRecallChannel(value: unknown): value is RecallChannel;
```

While there, convert the two existing open vocabularies to the same shape.
`RecallTelemetryMode` gained `query` and three copies of the old list went stale:
`cli/brain/verbs/recall-telemetry.ts:255` and `mcp/brain/recall-tools.ts:305` say
"search, context_pack, or pre_compress" in prose, and `recall-tools.ts:1002`
declares a JSON schema enum without `query`, which rejects a legitimately recorded
mode at the tool boundary. That is a hardcoded word list standing in for a closed
set, in three places. Deriving all three from one frozen array removes them rather
than adding a fourth.

`channel` goes on `RecallTelemetryInput` and `RecallTelemetryOptions` as
**required**, not optional: an optional field lets a call site omit it and produce
a record that reads as "no channel", which is the ambiguity being removed. Because
these are not a public plugin API, required makes all five call sites fail to
compile until each names its channel, and that is the enforcement mechanism.

Add `channel` to `CLIP_PROTECTED_PAYLOAD_KEYS`: a clipped record that lost its
channel is attributed to nothing.

Kill the duplication at the same time. Five sites repeat the same unpack of
`createdAt/host/sessionId/turnId` (`context-pack.ts:701-706`,
`pre-compress-pack.ts:290-296`, `search-tools.ts:809-812` and `:845-848`,
`query-tools.ts:144-146`). Export `recallTelemetryEnvelope(options)` so the
correlation fields are copied once.

Extend `RecallTelemetryFilter` with `channel`, one line in
`matchesTelemetryFilter`, and `RecallTelemetrySummary.by_channel`, which is the
rollup that makes the doctor check cheap. Surface `--channel` on the CLI and
`channel` on the MCP schema, both rendering their enum from `RECALL_CHANNELS`.

`hooks/recall-inject.ts` must emit, or the channel dimension has an empty column
by construction and the check can only ever say "unknown" for the one channel
under complaint. The `inject` branch emits `status: "ok"`, and `abstain` / `error`
map to `empty` / `error`: the hook ran and decided not to inject is exactly the
signal that separates the two silences. Emission goes through the gated helper so
a telemetry failure can never break the prompt.

## The doctor check

New module `src/core/brain/doctor/recall-channel-coverage.ts`, appended to
`DOCTOR_CHECKS`, `failSoft: true`. For each channel, cross an install state
against the delivery count:

| install state | deliveries | outcome |
|---|---|---|
| expected | 0 | warning `recall-channel-silent` |
| expected | >0 | nothing |
| not expected | any | nothing |
| unknown | any | `pushUncertain` with `recall-channel-unmeasured`, naming why the install side could not be read |

The expected/unknown split is the whole unit. The install state is computed by a
`switch` over `RecallChannel` with no default arm, which is where the closed set
becomes a compile-time guarantee rather than a runtime guard.

`DoctorCheckContext` carries no config path, and the hook branch needs
`resolveRecallInjectEnabled(configPath)`. Add `configPath` to the context and to
`RunDoctorOptions`; both existing `runDoctor` callers already hold it. Passing it
explicitly rather than letting the check discover it is what makes the check
testable without mutating process env.

Two registrations are mandatory or CI fails: `recall-channel-silent` into
`DIAGNOSTIC_SIGNALS` with a structural next command, and
`recall-channel-unmeasured` into `DOCTOR_EXIT_EXCLUSIONS` with a reason, since
"the install side could not be read" has no single repair command. The census
forbids an exclusion reason from naming an `o2b` invocation.

## Adjacent defects worth the same pass

1. `isRecallTelemetryMode` and `isRecallTelemetryStatus`
   (`recall-telemetry.ts:385-393`) are hand-rolled equality chains, so adding a
   member compiles and silently fails the predicate.
2. `telemetryOptionsFromArgs` (`mcp/brain/shared.ts:241-247`) parses `session_id`
   and `turn_id` twice each for the conditional-spread idiom; the CLI filter does
   the same for four flags.
3. `listRecallTelemetry`, `listGateTelemetry` and `listIngestDedupReports` are the
   same six lines of filter, reverse and limit, three times.
4. The hook-audit root is spelled as a raw three-argument join in six hook files
   while `DERIVED_STORE_DIR` already exists (`path-constants.ts:137`). The new
   check needs to read that directory, so it needs the constant anyway.
5. `contextPackBudgetMetadata` is computed twice inside
   `finalizeContextPackReport`.

## Sequencing

Vocabulary and the three stale lists first (no behaviour change), then the
`channel` field plus the shared envelope (the five call sites fail to compile
until each declares its channel, which is the checklist), then the path constant,
then the hook emission, then the check plus its two registry entries, then the CLI
and MCP filter surfaces. The census test is the step most likely to fail first.
