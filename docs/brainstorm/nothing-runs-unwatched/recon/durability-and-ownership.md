# Recon: durability and ownership (t_b5fa7344, t_1037d94e)

Reconnaissance only. Every claim below carries an anchor that was read on
branch `feat/nothing-runs-unwatched` (base v1.47.0). Where a question could
not be settled from source, it says so.

---

## 1. The install/verify success path, end to end

### 1.1 There is no single install "success" surface. There are four.

`o2b install` is one verb with four terminal renderings, chosen in
`cmdInstall` at `src/cli/install/install.ts:158-178`:

| mode | selector | human renderer | machine renderer |
|---|---|---|---|
| detect | no `--target`, no `--check` | `renderDetectTable` `src/cli/install/render.ts:23` | `renderDetectJson` `src/cli/install/render.ts:57` |
| plan | `--target X` | `renderPlan` `src/cli/install/render.ts:70` | inline literal `src/cli/install/install.ts:227` |
| apply | `--target X --apply` | `renderApplyResult` `src/cli/install/render.ts:87` | `renderApplyJson` `src/cli/install/render.ts:107` |
| verify | `--check` | `renderVerifyTable` `src/cli/install/render.ts:111` | `renderVerifyJson` `src/cli/install/render.ts:125` |

A fifth, unrelated verb also prints an install success: `o2b install-cli`
(symlink installer) renders through `renderInstallResult`
`src/cli/install-cli.ts:280`, dispatched at `src/cli/main.ts:751-756`. It
has **no `--json` at all** — `parseFlags` accepts only `--bindir`
(`src/cli/main.ts:752`). The task hint names `install-cli.ts:280` as the
target surface; that is the surface with no machine channel to add a field
to.

### 1.2 The `--json` payloads are not one shape

- Detect: `{ schema_version: 1, targets: [{target,status,config_path,notes}] }`
  — `src/cli/install/render.ts:58-67`.
- Verify: `{ schema_version: 1, targets: VerifyResult[] }` — `src/cli/install/render.ts:126`.
  Note this serialises `VerifyResult` **raw**, so the wire keys are
  `target`, `status`, `details`, `fix_hint` (`src/core/install/types.ts:126-131`).
- Plan: `{ schema_version: 1, plan }` — `src/cli/install/install.ts:227`,
  built inline rather than in `render.ts`.
- Apply: `JSON.stringify(result)` — `src/cli/install/render.ts:108`. **No
  `schema_version` key.** This is the only `--json` install payload without
  one, and it is the payload of the one mode that actually changed the
  machine.

### 1.3 Shared result types

No. Four unrelated result types, all in `src/core/install/types.ts`:
`DetectResult` (:64), `InstallPlan` (:77), `ApplyResult` (:113),
`VerifyResult` (:126). They share only `target: string`. A field added to
"the install result" has to be added to each of them, or carried beside
them by the CLI layer.

### 1.4 Is there a golden / snapshot / parity test on the JSON?

**No JSON parity or golden test exists.** What exists:

- `tests/cli/install-verb.test.ts:64-77` asserts only three things about
  detect `--json`: `schema_version === 1`, `targets` is an array, length > 0.
  Nothing asserts field names, and nothing at all asserts the apply, plan or
  verify payloads.
- `tests/docs/install-verify-conformance.test.ts` is a **human-output**
  conformance test: it installs each target into a temp home/vault, calls
  `verify()`, renders through the same `renderVerifyTable` the CLI uses, and
  diffs against an `<!-- expected-output: o2b install --check --target <t> -->`
  block in `install/<runtime>.md` (header docblock, lines 1-19). So the
  **human** verify surface is pinned byte-for-byte against documentation;
  the JSON twin is pinned by nothing.

Consequence for the design: adding a line to `renderVerifyTable` breaks
every `install/<runtime>.md` expected-output block and that test will name
the documents to edit. Adding the same information to `renderVerifyJson`
breaks nothing and is therefore the half that can silently be forgotten.
Whatever mechanism is chosen must make the two impossible to add
separately, because no test currently notices if only one lands.

### 1.5 Where a two-part close would have to be printed

- Verify success: `runCheck` at `src/cli/install/install.ts:258-289`. It
  already refuses an unset vault by name (`:263-268`) and returns
  `exitCodeForVerify(results)` (`:288`, defined `:305-309`). "Passing" here
  means no `drift` and no `mcp-unreachable`; `not-installed` is also exit 0
  (`:296-299` docblock states this deliberately). So "on a passing verify"
  includes the case where **nothing is installed**, which is a poor place to
  congratulate the operator on owning their brain.
- Apply success: `runTarget` at `src/cli/install/install.ts:234-241`.
- `install-cli` success: `cmdInstallCli` `src/cli/main.ts:751-756`, success
  being `result.errors.length === 0`.

### 1.6 The advisory rail constrains what may be printed forward

`tests/cli/terminal-state-census.test.ts` enumerates every CLI ending and
requires each to name an exit, name a refusal, or be listed as deliberately
silent with a reason. Its detector is `NAMES_EXIT_RE = /emitNextSteps?\(/`
(`tests/cli/terminal-state-census.test.ts:66`) with the comment "The rail is
the only sanctioned way to print a forward pointer."

The rail is `emitNextStep(code, stream)` at `src/cli/advisory-rail.ts:103`.
It resolves strictly through `DIAGNOSTIC_SIGNALS` and **never invents a
command** (`src/core/brain/next-step.ts:29-43`). It also suppresses itself
when `--json` was requested from a command that renders its own JSON
(`advisoryIsLegal`, `src/cli/advisory-rail.ts:84-88`).

`o2b install` is not in the census's hand-classified table; `o2b install-cli`
is, classified as `refusal` (`tests/cli/terminal-state-census.test.ts:133-140`)
with the reason that `renderInstallResult` names each failed outcome.

An ownership statement is **not** a forward pointer and must not be routed
through the rail; the next-action half already is one (see §1.7). Mixing them
would put a prose sentence into a channel whose whole contract is "a
structural CLI string, never prose" (`src/core/brain/diagnostics.ts:83`).

### 1.7 The next-action half already exists and is stronger

`buildOnboardingChecklist` `src/cli/onboarding.ts:77` produces an eight-step,
state-driven, ordered checklist with a per-step copy-pasteable command;
`renderOnboardingChecklist` `src/cli/onboarding.ts:175` renders it. It is
called from `o2b init` (`src/cli/main.ts:197-202`, wrapped in a try/catch so
onboarding can never fail init) and from `o2b onboarding`
(`src/cli/main.ts:206-221`), which has a `--json` mode that serialises the
whole `OnboardingChecklist` — **including `vault`** — at `src/cli/main.ts:216`.

The terminal-state census explicitly credits `o2b onboarding` as naming an
exit and explains why routing it through the rail would be wrong
(`tests/cli/terminal-state-census.test.ts:117-123`).

It is **not** called from `o2b install`, `o2b install --check`, or
`o2b install-cli`. That is the actual gap on the next-action side: the
checklist exists and the install surfaces do not reach it.

The triage verdict `present_weaker` survives contact with the source.

---

## 2. Where the vault path is resolved, and whether the success path holds it

Canonical resolver: `resolveVault(configPath?, {cwd?})` at
`src/core/config.ts:339-359`. Order (docblock `:332-338`, code `:340-358`):

1. `VAULT_DIR` env, tilde-expanded;
2. project pointer walk-up from `cwd` (`resolvePointerVault`, `:349`);
3. active named profile (`resolveActiveProfileVault`, `:354`);
4. `vault` key in the plugin config (`:356`);
5. `null`.

The install verb does **not** call `resolveVault`. It has its own chain in
`buildInstallEnv` at `src/cli/install/install.ts:113-126`:

```
args.vault ?? cfg["vault"] ?? process.env["VAULT_DIR"] ?? ""
```

Three differences from `resolveVault`, all real:

- no pointer walk-up, no profile support;
- `VAULT_DIR` is **last** here and **first** in `resolveVault`, so a machine
  with both a config `vault` and a `VAULT_DIR` gets two different answers
  from `o2b install` and from every other verb;
- the absent case is `""` rather than `null`, and no tilde expansion.

So: at render time the success path **does** have a vault string in hand
(`env.vault`), `runCheck` proves it non-empty at `src/cli/install/install.ts:263`,
and `runTarget` proves it non-empty through `loadPayload`
(`src/cli/install/install.ts:143-156`). But it is not the resolved vault path
that the rest of the CLI would print. An ownership statement naming
`env.vault` can name a different directory than `o2b status` or
`o2b brain doctor` are operating on. **This is a defect the ownership
statement would surface, not create** — but stating a path as "your brain"
that the rest of the tool does not use is exactly the misleading output the
standing rules forbid.

`o2b onboarding --json` uses the shared `requireVault` helper
(`src/cli/main.ts:213`) and therefore already reports the correct path.

---

## 3. The existing "durability gate" is about something else entirely

`src/core/brain/gates/durability.ts` (338 lines, read in full) has **nothing
to do with storage durability**. It is a *fact-triage* gate: given the text
of an extracted fact, decide whether it is worth persisting or is transient
operational noise. Docblock `:1-29`.

- Verdict shape: `{ durable: boolean; reason: DurabilitySignal | null }`
  (`:42-47`). `DurabilitySignal` is a bare string union (`:34-40`) — **not**
  the frozen-object idiom, no members array, no type guard, not in the
  verdict-vocabulary census.
- What it asserts: five pure structural detectors — `hasTempPath` (:74),
  `hasProgressCounter` (:99), `hasRunIdShape` (:120),
  `hasMeasurementDominance` (:143), `hasExitStatusShape` (:165) — plus an
  operator-supplied regex denylist (`compileDurabilityDenylist` :309,
  `resolveDurabilityDenylist` :331).
- Deliberately language-neutral: "there is deliberately zero built-in
  natural-language word list, in any language" (`:6-10`). This is the
  precedent the standing rule about hardcoded natural-language phrases
  points at.
- Liveness: **none**. Everything in the module is pure and does no I/O
  except `resolveDurabilityDenylist`, which reads config.

Callers: I did not find a call site inside `src/` from the searches run;
this recon did not establish the full consumer set of `classifyDurability`.
State that plainly rather than guess.

**Divergence:** the task hint "Nearest surfaces: … `src/core/brain/gates/durability.ts`"
is wrong. Extending this module would collide two unrelated meanings of
"durable" (a fact worth keeping vs. storage that survives) in one namespace.
The sibling `src/core/brain/gates/recoverability.ts` is the module that
actually models "can this be got back" (`RECOVERABILITY_STATE`,
`RECOVERY_COVERAGE`, `RECOVERABILITY_BLOCKER` — all three registered in the
verdict census at `tests/core/architecture/verdict-vocabulary-census.test.ts:518-551`).
That is the neighbourhood, not `durability.ts`.

The only genuine "durability job" machinery in the repo is snapshotting
(`src/core/brain/snapshot.ts`, archives at `Brain/.snapshots/<run_id>.tar.zst`,
docblock `:1-30`) and the cron-recipe renderers
(`src/cli/cron-recipe.ts:1-38`, `src/cli/search-cron-template.ts`,
`src/cli/partner-codegraph-cron.ts`). Every one of those **renders text for
the operator to install into their own scheduler and writes nothing**
(`src/cli/cron-recipe.ts:4-11`). So there is no job the product owns whose
liveness it could check from its own records — a liveness check has to infer
it from artifacts (last snapshot mtime, last index run) or from the host's
scheduler, and the latter is out of reach of a tool that never installed
anything.

---

## 4. The doctor check idiom — and there are two doctors

### 4.1 `o2b doctor` (root) — no codes, no registry, no census

`cmdDoctor` `src/cli/main.ts:284`. Checks come from `doctor(opts)`
`src/core/doctor.ts:394-412`, which **hand-pushes** `CheckResult` values into
an array. A `CheckResult` is `{ name, ok, message, fix? }` — see
`checkVaultWriteable` `src/core/doctor.ts:32-53` for the canonical example.
Human render at `src/cli/main.ts:351-355`, JSON at `src/cli/main.ts:326-348`.

There is **no code, no severity vocabulary, no `nextCommand` registry and no
census** over this family. `fix` is a free-form string (`chmod u+rwx "…"`,
`o2b update`). Adding a check here is `results.push(...)` in
`src/core/doctor.ts:394` and nothing gates it.

The opt-in readiness probes hang off the same verb: `--readiness`
(`src/cli/main.ts:290, 316-323`), `runReadinessProbes`
`src/core/doctor-readiness.ts:529`, default probe set
`src/core/doctor-readiness.ts:515-520`. Adding a probe is one row in
`DEFAULT_PROBES`. This family **does** have a closed vocabulary
(`READINESS_STATUS`, §5.4) and is censused.

### 4.2 `o2b brain doctor` — codes, registry, and a hard census

`runDoctor` `src/core/brain/doctor.ts:202`. Registration is one row in
`DOCTOR_CHECKS`, `src/core/brain/doctor.ts:132-166` — a frozen array whose
**order is part of the contract** (`:125-131`). A check implements
`DoctorCheck` `src/core/brain/doctor/check.ts:64-76`:

```
readonly failSoft: boolean;
run(ctx: DoctorCheckContext, out: DoctorFindings): void;
```

`failSoft: true` means a throw is swallowed (`src/core/brain/doctor.ts:265-277`);
`false` is reserved for the store's structural core.

A finding is a `DoctorIssue` `src/core/brain/types.ts:1977-2001`:
`severity` (`DoctorSeverity = "warning" | "error"`, `src/core/brain/types.ts:1971`
— exactly two members, no `info`), `code: string`, optional `path`,
`message`, plus optional `field`/`target`/`sources`. Anything the check
attempted but cannot claim it verified goes into the **separate** `uncertain`
stream (`DoctorFindings.uncertain`, `src/core/brain/doctor/check.ts:59-62`;
surfaced conditionally at `src/core/brain/doctor.ts:341`).

`nextCommand` does not live on the issue. It lives in `DIAGNOSTIC_SIGNALS`,
keyed by `code` — `DiagnosticSignal` is `{code, issueClass, nextCommand,
autoRepairable}` (`src/core/brain/diagnostics.ts:77-86`). Worked example, the
search-index family at `src/core/brain/diagnostics.ts:332-358`:

```
{ code: "search-index-built",          issueClass: "search index up to date",
  nextCommand: "o2b search query <text>",  autoRepairable: false },
{ code: SEARCH_INDEX_MISSING_CODE,     issueClass: "search index not built",
  nextCommand: "o2b search index",         autoRepairable: false },
{ code: SEARCH_INDEX_CORRUPT_CODE,     issueClass: "search index failed a structural integrity check",
  nextCommand: "o2b search reindex",       autoRepairable: false },
```

The codes are hoisted to module constants `SEARCH_INDEX_MISSING_CODE` /
`SEARCH_INDEX_CORRUPT_CODE` at `src/core/brain/diagnostics.ts:94-95`
precisely so producer and registry cannot drift into two spellings.

### 4.3 The doctor-exit census — exact obligations

`tests/core/brain/doctor-exit-census.test.ts`. It reads the population **out
of the source of `doctor.ts` plus every `.ts` under `src/core/brain/doctor/`
recursively** (`:74-124`), not out of the tables. A new check module is
swept the moment it exists. Two recognised code shapes (`:126-130`):

- `code: "<literal>"` — `LITERAL_CODE_RE`;
- `const <NAME>_CODE = "<literal>";` at module scope — `CONSTANT_CODE_RE`
  (anchored `^…$` multiline, so the declaration must be on one line, exactly
  in that form, with the identifier matching `/^[A-Z0-9_]*CODE[A-Z0-9_]*$/`).

A new check must satisfy **all** of:

1. **Classified exactly once.** Every code it spells is in `DIAGNOSTIC_SIGNALS`
   *or* in `DOCTOR_EXIT_EXCLUSIONS` (`src/core/brain/doctor-exits.ts`),
   never both, never neither — tests at `:235-248`.
2. **Registered codes pinned by hand.** If the code gets a `nextCommand`, its
   literal string must be added to `DOCTOR_REGISTERED_CODES`
   (`tests/core/brain/doctor-exit-census.test.ts:177-200`), and the test at
   `:250-258` asserts *set equality* between that list and the doctor codes
   found in `DIAGNOSTIC_SIGNALS`. Adding a registered code without editing
   this array fails. This is the assertion that catches "declared and never
   registered".
3. **Exclusions must be specific.** If it goes into `DOCTOR_EXIT_EXCLUSIONS`,
   the reason must be ≥ 80 characters (`MIN_REASON_LENGTH`, `:203`, test `:266-272`)
   and must **not** match `/\bo2b\s+[a-z]/` (`INVOCATION_RE`, `:205`, test
   `:274-279`) — a reason that names a command belongs in the registry
   instead. Only two shapes earn an exclusion, stated at
   `src/core/brain/doctor-exits.ts:19-31`: the repair is a judgement over
   content, or an edit whose target shape is not derivable from the finding.
4. **No opaque code site.** Any `code:` property whose value is neither a
   string literal nor a `*_CODE` identifier must be declared in
   `NON_LITERAL_CODE_SITES` with an explanation of where its values are
   enumerated (`:145-161`, test `:296-303`).
5. **Floors must keep rising.** The non-vacuity test `:281-292` asserts
   `DOCTOR_SOURCE_PATHS.length > 10`, `codes.length > 35`,
   `constantCodes().size > 3`, registered > 14, excluded > 20. A new check
   only ever pushes these up, so it is not an obstacle — but note that
   *deleting* a check family fails here, which is the regression the previous
   release was about.

### 4.4 Which doctor should a durability/liveness check live in?

Unresolved by source alone, and the answer is load-bearing:

- `o2b brain doctor` gives the check a `code`, a registered `nextCommand`, an
  `uncertain` stream for "could not measure", and census enforcement. Its
  `DoctorCheckContext` (`src/core/brain/doctor/check.ts:23-52`) carries
  `vault`, `now`, `config`, `dbPath`, `configPath` — enough for an artifact-
  mtime liveness probe. It does **not** carry `home`, `env` or `platform`.
- `o2b doctor` is where `checkVaultWriteable` already lives
  (`src/core/doctor.ts:32`) and where `--readiness` probes run, but it has no
  census and no next-command registry, so a check added there gets none of
  the guarantees this project's recent releases were built to provide.

---

## 5. Environment-class detection: what is honestly detectable

### 5.1 Signals, measured on this host

Probed directly (Bun 1.3.14, linux):

| signal | availability here | what it proves | what it cannot distinguish |
|---|---|---|---|
| `/.dockerenv` exists | absent | Docker (and only Docker) created the rootfs | absent on podman, containerd/CRI-O, Kubernetes without Docker shim, LXC, systemd-nspawn, gVisor, and on any image where it was deleted. **Absence proves nothing.** |
| `/run/.containerenv` | absent | podman | same one-way property |
| `/proc/1/cgroup` readable | yes → `0::/init.scope` | on cgroup **v1** hosts, a `/docker/<id>` or `/kubepods/` path is strong evidence | on cgroup **v2 unified** (what this host runs) the line is just `0::/<path>`, and a container often shows `0::/` — indistinguishable from a plain systemd scope. The v1 heuristic is dead on modern hosts. |
| `/proc/1/sched` first token | yes → `systemd (1, …)` | pid 1 is an init system → **not** a single-process container | a container *can* run systemd (`systemd-nspawn`, `docker run --init` variants). One-way at best. |
| `/proc/self/mountinfo` | yes, 32 lines | names the fs type backing any path, including `overlay` and `tmpfs` | tells you the *storage driver*, not the *lifetime*. An overlayfs root is normal for every container, ephemeral or not; a bind-mounted persistent volume inside a container is `ext4`. |
| `statfsSync(path).type` | yes — returned `61267` (`0xEF53`, ext4) for `/` | the fs magic of the path's filesystem. `0x794c7630` overlayfs, `0x01021994` tmpfs | same limit as above. Also **not portable**: `type` is a Linux magic number; on macOS/Windows the value means something else or nothing. |
| CI env vars (`CI`, `GITHUB_ACTIONS`, …) | none set here | when set by a known CI, high confidence it is CI | `CI=true` is set by hand constantly; a self-hosted persistent runner is CI **and** durable; a CI job in a VM is not a container |
| sandbox env vars (`CODESPACES`, `GITPOD_*`, `REPL_ID`, `REMOTE_CONTAINERS`) | none set here | positive identification of that specific product | one variable per vendor, unbounded set, absence proves nothing |
| agent-host vars (`CLAUDECODE`, `CLAUDE_CODE_*`) | **9 set on this host** | an agent CLI is driving the process | says nothing about durability — this host is a durable VPS |
| vault path writability | already implemented, `checkVaultWriteable` `src/core/doctor.ts:32` | the vault can be written **now** | says nothing about whether the write survives the process |

### 5.2 The honest conclusion

**No combination of these signals can prove ephemerality.** Every container
signal is one-way: a positive is decent evidence of "containerised", a
negative is evidence of nothing. And "containerised" is not "ephemeral" —
the property that matters is *whether this filesystem outlives the process*,
and nothing on the machine reports it. A bind-mounted volume in a Docker
container is more durable than a laptop's `/tmp`.

The one signal that is *close* to the real question is the filesystem type
under the **resolved vault path** specifically (not `/`): a vault on `tmpfs`
is provably lost at reboot, and a vault on `overlay` with no lower bind mount
is very likely lost at container exit. That is a claim about **one path**,
which is the claim the ownership statement actually makes. It is also
Linux-only.

A classifier that answers "local / cloud sandbox / ephemeral container" as a
single fact would be guessing on two of three members. **Recommendation: do
not build that classifier.** Build the narrower thing that can be proved:
*what backs the vault path, and can that be established at all.*

### 5.3 Recommended verdict vocabulary

Two vocabularies, not one — following the project's own stated rule that a
union of disjoint sets is a namespace rather than an abstraction
(`tests/core/architecture/verdict-vocabulary-census.test.ts:285-292`):

- **Vault durability verdict** — what backs the vault path:
  `durable` (a filesystem that survives process and reboot),
  `volatile` (proved memory-backed, e.g. tmpfs),
  `layered` (proved container-overlay-backed, survival unknown),
  `undetermined` (could not be established) — the mandatory
  "could-not-be-determined" member.
- **Undetermined reason** — why the probe reached no verdict:
  `probe_unsupported` (platform exposes no filesystem-type facility),
  `path_unreadable`, `fs_type_unknown` (a magic number this build does not
  recognise). Separate vocabulary so a guard cannot let a reason be read back
  as a verdict — the exact argument made for
  `MATERIALIZE_UNKNOWN_REASON` at
  `tests/core/architecture/verdict-vocabulary-census.test.ts:364-383`.

Deliberately **absent**: any member meaning "cloud sandbox". No signal
distinguishes it from a container, and naming it would be the guess this
document argues against.

### 5.4 The closed-vocabulary idiom, confirmed against a real example

`READINESS_STATUS` — `src/core/doctor-readiness.ts:102-127` — is the complete
trio and the one the census seeds with
(`tests/core/architecture/verdict-vocabulary-census.test.ts:250-260`):

1. `export const X = Object.freeze({ camelCaseKey: "value", … } as const);`
2. `export type XName = (typeof X)[keyof typeof X];` (derived union)
3. `export const X_MEMBERS: ReadonlyArray<XName> = Object.freeze([X.a, X.b, …]);`
4. `export function isXName(value: unknown): value is XName { return typeof value === "string" && (X_MEMBERS as ReadonlyArray<string>).includes(value); }`
   — the parameter is `unknown`, always.
5. A row in `CENSUS` at
   `tests/core/architecture/verdict-vocabulary-census.test.ts:250-617` with a
   comment saying why the vocabulary is registered.

The audit (`:213-243`) checks: object frozen, no duplicate values, no
duplicate members, every declared value is a member, the guard accepts every
declared value, no member is declared by nothing, and the guard rejects
`""`, `" "`, `"unknown-vocabulary-member"`, `null`, `undefined`, `42`, `{}`.

**Divergence from the brief:** the brief says "snake_case values". The
codebase's actual convention is *camelCase key, snake_case value for
multi-word values* — `nothingAtRisk: "nothing_at_risk"`
(`src/core/brain/gates/recoverability.ts:60`),
`outputsUnreadable: "outputs_unreadable"` (`src/core/brain/staleness.ts:146`),
`refusedScanTruncated: "refused_scan_truncated"` (`src/core/egress/guard.ts:76`).
Single-word values are the bare word (`pass`, `fail`, `skipped`, `unknown` —
`src/core/doctor-readiness.ts:104-110`). One registered outlier uses
kebab-case: `PROVIDER_PROBE` has `notConfigured: "not-configured"`,
`timedOut: "timed-out"` (`src/core/search/provider-probe.ts:58-64`). Follow
the snake_case majority.

---

## 6. Existing environment / platform detection in the repo

There is **no host-classification layer**. What exists, and what a design
should extend rather than duplicate:

**Agent-runtime detection (a different axis, but the nearest existing one).**
`detectHookRuntime(payload, env)` at `hooks/lib/detect.ts:200`, with
`export type HookRuntime = "claudecode" | "codex" | "grok" | "unknown"` at
`hooks/lib/detect.ts:174`. Payload-shape-first, env-second: `GROK_HOOK_EVENT` /
`GROK_SESSION_ID` / `GROK_WORKSPACE_ROOT` at `hooks/lib/detect.ts:208-210`,
transcript-path needles at `:176-177`. It lives **outside `src/`**, and
`src/core/` receives the classification as an injected label rather than
probing — see `src/core/brain/pretool-orient.ts:74` (`readonly runtime: string`)
and the short-circuit at `:132`. Note `HookRuntime` is a bare union, **not**
the frozen-object trio, and is not in the verdict census.

A second, unrelated runtime axis: `O2B_TARGET` read at
`src/core/identity-reminder.ts:109` against a fixed
`KNOWN_RUNTIME_TARGETS = ["hermes", "openclaw"]` (`:41`).

**Injected-environment records** (the two shapes to extend):
- `ConfigPathEnv { platform, home, env }` — `src/core/config.ts:99-105`,
  consumed by the pure `resolveDefaultConfigPath` `:120`, with the only
  `process.platform` / `homedir()` read isolated in `defaultConfigPath` `:138-144`.
- `InstallEnv { vault, home, cwd, env, now }` — `src/core/install/types.ts:56-62`.
  It carries **no `platform` field**; every adapter receives it through
  `detect`/`plan`/`apply`/`verify` (`src/core/install/types.ts:142-147`).

**Platform branching**, scattered, no shared helper:
`UNSUPPORTED_CONFIG_PLATFORMS = ["win32"]` `src/core/config.ts:35`;
`src/core/path-safety.ts:74-75`;
`src/core/brain/health/remediation.ts:188-191` (`opts.platform ?? process.platform`
— the house style for testable injection);
`src/core/brain/snapshot.ts:493-497` (PATH separator, `PATHEXT`);
`src/core/search/indexer.ts:1506` (`darwin` → brew hint).

**TTY / interactivity**: the idiom `flags["json"] || !process.stdin.isTTY` is
inlined at six sites — `src/cli/brain/verbs/lint.ts:25`,
`page-dedup.ts:24`, `rollback.ts:146`, `upgrade.ts:72`, and TTY-only variants
at `merge.ts:68`, `import-claude-memory.ts:87`. No shared helper exists.

**Filesystem probing**: no fs-type probe anywhere. Two *writability* probes
that already coexist with different techniques —
`checkVaultWriteable` create-and-unlink at `src/core/doctor.ts:32-53`, and
`accessSync(dir, W_OK)` at `src/core/search/indexer.ts:1311`.

**The existing push channel for environment degradation** is
`collectRuntimeNotices` `src/core/brain/runtime-notices.ts:74`. It already
carries a `vault_read_only` notice built from `checkVaultWriteable`
(`src/core/brain/runtime-notices.ts:92-105`), it rides SessionStart injection
and `vault_health`, and it deliberately carries **no** `next_command` for
that notice because the two exits are an OS permission change or a different
`VAULT_DIR`, "neither of them an `o2b` verb" (`:87-91`). That is the exact
precedent for a vault-durability notice, and `RuntimeNotice` is already
serialised whole by `o2b onboarding --json` (`src/core/brain/runtime-notices.ts:42-53`).

**No CI detection, no container detection, no cloud-sandbox detection exists
anywhere in `src/`, `hooks/`, `scripts/`, or `tests/`.**

---

## 7. Cross-check: is the ownership claim true as shipped?

### 7.1 What is inside the vault

Memory itself: `Brain/` and its subtrees — `Brain/preferences`, `inbox`,
`retired`, `log`, `decisions`, `theses`, `tensions`, `handoffs`, and the rest,
all named vault-relative in `src/core/brain/path-constants.ts:22-62`. Plain
Markdown files. This half of the statement is true.

Derived and operational state, also inside the vault:
- Search index: `<vault>/.open-second-brain/brain.sqlite` —
  `resolveIndexPath` `src/core/search/paths.ts:28-34`, name constants
  `src/core/brain/path-constants.ts:137-138`.
- Maintenance lease DB: `<vault>/.open-second-brain/maintenance.sqlite` —
  `src/core/brain/maintenance/lease.ts:36`.
- Install manifest: `<vault>/.open-second-brain/install.lock.json` —
  `manifestPath` `src/core/install/manifest.ts:36-38`.
- Snapshots: `Brain/.snapshots/<run_id>.tar.zst` —
  `src/core/brain/snapshot.ts:6-8`; store archives
  `src/core/brain/paths.ts:589,602`.
- **Encrypted secrets store, key included**:
  `<vault>/.open-second-brain/secrets/secrets.json` plus the AES keyfile at
  `<vault>/.open-second-brain/secrets/keyfile` —
  `secretsDir` / `storePath` / `keyPath` `src/core/brain/secrets/store.ts:69-79`,
  keyfile creation `src/core/brain/secrets/crypto.ts:36-60`. The key sits
  beside the ciphertext, so this is obfuscation at rest, not protection
  against whoever holds the vault. It reinforces the ownership claim
  (nothing is escrowed elsewhere) and is worth knowing before a design says
  "just copy it to another machine".

No `~/.cache` or `XDG_CACHE_HOME` write exists anywhere in the tree.

### 7.2 Durable state that lives OUTSIDE the vault

1. **Machine-local plugin config** —
   `$OPEN_SECOND_BRAIN_CONFIG` → `$XDG_CONFIG_HOME/open-second-brain/config.yaml`
   → `$HOME/.config/open-second-brain/config.yaml`
   (`resolveDefaultConfigPath` `src/core/config.ts:120-131`, written by
   `setConfigValue` `src/core/config.ts:277`). Holds `vault`, `agent_name`,
   `timezone`, `search_db_path`, `embedding_api_key`, `embedding_base_url`,
   `device_id`, `installation_secret`. Not memory; but the pointer *to*
   memory, and a live credential.
2. **Vault profiles registry** — `~/.config/open-second-brain/profiles.json`,
   a sibling of the config file (`profilesPath`
   `src/core/brain/portability/profiles.ts:45-47`, written by `save` `:76-79`).
   Records the name and absolute path of every registered vault plus which is
   active. Delete a vault and this file still names it.
3. **`device_id`** — minted on first use and persisted into the machine config
   (`resolveDeviceId` `src/core/config.ts:415`). Consumed by
   `src/core/brain/log.ts`, `log-jsonl.ts`, `truth/store.ts`,
   `decisions/receipts.ts`, `portability/profiles.ts`, `src/mcp/server.ts`.
   Vault records are attributed to it, so deleting the machine config mints a
   new identity and past log shards stay attributed to a device that no
   longer exists.
4. **`installation_secret`** — 16 random bytes generated under a directory
   lock and written into the machine config (`src/core/config.ts:496-546`).
   It **is** live: `vaultStoreReference` (`src/core/config.ts:569-576`) uses it
   as the HMAC-SHA256 key over the absolute vault path to produce the opaque
   `vault://<32-hex>` identifier that MCP tools return in place of a host path
   (`src/mcp/tools.ts:28, 114`). Lose the machine config and every previously
   emitted `vault://` reference stops resolving to this vault — a durable,
   out-of-vault secret with correlation value.
5. **Runtime config files the installer owns.** Nine adapters, each with its
   own out-of-vault path — `~/.cursor/mcp.json`
   (`src/core/install/adapters/cursor.ts:18-19`),
   `~/.gemini/settings.json` (`gemini-cli.ts:12-13`),
   `~/.kiro/settings.json` (`kiro.ts:16-18`),
   `${XDG_CONFIG_HOME:-~/.config}/github-copilot/mcp.json`
   (`copilot-cli.ts:107-111`),
   `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json` plus a plugin file
   copy (`opencode.ts:38-48`), `${GROK_HOME:-~/.grok}/config.toml` plus a
   hooks file (`grok.ts:48-58`), `~/.aider.conf.yml` (`aider.ts:55-60`), a
   symlink at `${PI_HOME:-~/.pi}/skills/brain-memory` (`pi.ts:62-75`), and the
   operator-named `--out` path for `generic` (`generic.ts:119`).
   Separately, `o2b brain protect --target codex` patches a managed fence into
   `~/.codex/config.toml` (`src/core/brain/protect.ts:515-518`); its
   `claudecode` target stays in-vault (`:19`). **There is no `~/.claude.json`
   write** — the Claude Code integration ships as a plugin and
   `~/.claude/projects/**` is read-only
   (`src/core/brain/claude-memory-paths.ts:15, 27`).
   Note: `tests/core/architecture/write-site-census.test.ts:940-948`
   **explicitly excludes the install adapters** from the vault write-site
   population, so none of these paths is covered by that guard.
6. **CLI symlinks** — `~/.local/bin/{o2b,vault-log,o2b-hook}`,
   `src/cli/install-cli.ts:25, 125`. Self-healed automatically on every
   Claude Code SessionStart (`hooks/active-inject.ts:143` → `healCliSymlinks`
   `src/cli/install-cli.ts:200`).
7. **The opencode session spool — the one out-of-vault artifact that carries
   memory content.** The bundled plugin appends normalised turn text and tool
   calls as JSONL to
   `${OSB_OPENCODE_SPOOL_DIR:-${XDG_DATA_HOME:-~/.local/share}}/open-second-brain/opencode/<session>.jsonl`
   — path at `plugins/opencode/open-second-brain.ts:72-78`, atomic write at
   `:167-173`. Consumed back by `src/core/brain/sessions/opencode.ts`. This is
   raw conversation content living in `~/.local/share`, and nothing in the
   tree prunes it. **This is the sharpest counterexample to the ownership
   claim as worded**, and it applies only to operators using the opencode
   integration.
8. **Hook reminder markers** — one empty file per session id under
   `${TMPDIR}/o2b-reminder-markers/` (`hooks/post-write-reminder.ts:38-40`,
   written `:63`), pruned at 48h (`:68-79`). Metadata only.
9. **Bench run artifacts** — `resolve(".open-second-brain/bench-runs")`,
   resolved against **CWD, not the vault**
   (`src/cli/brain/verbs/bench.ts:25, 54-58`). Out-of-vault whenever CWD is
   not the vault.
10. **The search index can be relocated out of the vault** —
    `SEARCH_DB_ENV = "OPEN_SECOND_BRAIN_SEARCH_DB"` and
    `SEARCH_DB_CONFIG_KEY = "search_db_path"`
    (`src/core/search/paths.ts:23-26`, honoured in
    `resolveConfiguredIndexPath` `:53-60`). Derived and rebuildable, so no
    memory is *lost* — but on a machine with the override set, a copy of every
    indexed chunk lives somewhere else.
11. **Read-only external sources** — `~/.claude/projects/<slug>/memory`
    (`src/core/brain/claude-memory-paths.ts:13-16`), transcript collectors
    under `home` (`src/core/discipline/transcripts/{claude-code,codex}.ts:19-20`),
    and Cursor's `state.vscdb` opened `{ readonly: true }`
    (`src/core/discipline/transcripts/cursor.ts:57`). Inputs, never written.
12. **Temp scratch only** — `mkdtempSync(tmpdir(), …)` at
    `src/core/brain/snapshot.ts:853, 1324` and
    `src/core/search/link-ratchet.ts:278`. Created and removed.
13. **Config-directory lock files** — `proper-lockfile` anchored on
    `dirname(~/.config/open-second-brain/config.yaml)`
    (`src/core/config.ts:447`, `:530`).

### 7.3 "No service to cancel"

True of the product. There is no account, no sync server, no update check, no
analytics endpoint, and no phone-home. Every `fetch()` in `src/` is on a path
the operator configured:

- embeddings, OpenAI-compatible — `${embedding_base_url}/embeddings`,
  `src/core/search/embeddings/openai-compat.ts:431`. **No default base URL**:
  construction refuses without one
  (`src/core/search/embeddings/provider-resolve.ts:66-82`), and semantic
  search is default-off;
- embeddings, ZeroEntropy — `src/core/search/embeddings/zeroentropy.ts:192`;
- reranker — `src/core/search/rerank/cross-encoder.ts:74, 85`;
- research providers, hard-coded endpoints —
  `src/core/brain/research/providers/tavily.ts:17`,
  `.../brave.ts:18`, and arbitrary-URL fetch
  `src/core/brain/research/external-fetch.ts:231`;
- Telegram capture — `src/core/brain/capture/telegram-capture.ts:44, 418, 433`.

Local-only servers, not egress: the MCP HTTP transport binds `127.0.0.1` and
refuses a non-loopback bind without an API key (`src/mcp/http.ts:40-50`); the
vault explorer binds `127.0.0.1` (`src/core/brain/explorer.ts:352`).

**`tests/core/architecture/egress-census.test.ts` is not a network census.**
It measures *local file destinations* (`--out`, `--dest`) and whether each
runs the shared redactor; its registry is
`src/core/egress/registry.ts:84-160`, seven sites. Its docblock states
outright that "The vault has no git transport and deliberately never will"
(`src/core/egress/registry.ts:6-7`) — which is the source-level confirmation
of the validator's note that the upstream per-turn git-push persistence model
does not apply to this project.

The caveat: an operator who configured a cloud embedding provider **does**
have a third-party account, and vault content has been sent to it. Saying
"no service to cancel" unconditionally to that operator is false. The
statement should either be unconditional about *Open Second Brain itself*
("this tool has no account and no server") or be state-aware — and the state
is already resolvable through `resolveSemanticCapability`
(`src/core/search/capability-tier.ts`, called at
`src/core/doctor-readiness.ts:277`).

### 7.4 Verdict on the ownership statement

- "Every memory is a Markdown file in your own vault" — **true for the Brain
  layer**, with two qualifiers: the search index can be relocated out of the
  vault by config (§7.2 item 10), and the **opencode session spool writes raw
  conversation turns to `~/.local/share`** (§7.2 item 7). The second is a
  genuine counterexample and the design must either exclude opencode users
  from the unqualified sentence or name the spool.
- "Copy it to another machine" — **true**, and the in-vault secrets keyfile
  travels with it (§7.1). The machine config, `profiles.json`, `device_id`
  and `installation_secret` do not (§7.2 items 1-4), so `vault://` references
  minted on the old machine stop resolving on the new one.
- "Delete it and the brain is gone" — **true for memory**. What is left
  behind is machine-local plumbing: the config, the profiles registry, the
  device id and installation secret, nine adapter config files, the
  `~/.codex/config.toml` fence and the `~/.local/bin` symlinks (§7.2 items
  1-6). None of it is memory, so the sentence is honest — a design that
  claims "nothing is left" would not be. `o2b uninstall` is the exit for that
  residue.
- "No service to cancel" — **true of this tool**, false as a blanket claim on
  a vault configured against a cloud embedding provider (§7.3).

**Honest restatement that survives the source:** every memory is a Markdown
file in your vault, and the search index beside it is a rebuildable SQLite
file also inside the vault. There is no account and no server. What lives
outside the vault is machine-local plumbing — a `~/.config/open-second-brain/`
config plus the managed blocks `o2b install` added to your agent's own config
files, removable with `o2b uninstall`. If you use the opencode integration,
raw session transcripts also spool to `~/.local/share/open-second-brain/opencode/`.

---

## Divergences

Points where a task body does not survive contact with the source.

1. **`src/core/brain/gates/durability.ts` is not about durability of storage.**
   It classifies extracted-fact text as durable-vs-transient noise
   (`:1-29`, verdict shape `:42-47`). It has no I/O in its classifier, no
   presence check and no liveness check. Naming it as a "nearest surface" for
   a persistence-durability feature is a namespace collision.
   `src/core/brain/gates/recoverability.ts` is the actual neighbour.
   (§3)
2. **`src/core/brain/doctor-readiness.ts` does not exist.** The module is
   `src/core/doctor-readiness.ts` — one level up, and it belongs to the root
   `o2b doctor`, not to `o2b brain doctor`. (§4.1)
3. **There is no one install "success path" and no shared result type.** Four
   modes, four result types, four `--json` shapes, one of which
   (`renderApplyJson`, `src/cli/install/render.ts:107`) has no
   `schema_version` at all. (§1.1-1.3)
4. **`src/cli/install-cli.ts:280` (`renderInstallResult`) has no `--json`
   surface.** `cmdInstallCli` parses only `--bindir`
   (`src/cli/main.ts:751-756`). A machine-readable handoff field cannot be
   added there without first giving the verb a JSON mode. (§1.1)
5. **No golden/snapshot/parity test asserts any install `--json` shape.**
   `tests/cli/install-verb.test.ts:64-77` checks three properties of one
   payload. The *human* verify output, by contrast, is pinned byte-for-byte
   against the `install/*.md` documents by
   `tests/docs/install-verify-conformance.test.ts`. Human and JSON are
   asymmetrically protected. (§1.4)
6. **`o2b install` does not use the canonical vault resolver.**
   `buildInstallEnv` (`src/cli/install/install.ts:113-126`) uses a different
   chain, in a different precedence order, from `resolveVault`
   (`src/core/config.ts:339-359`) — no pointer walk-up, no profiles, and
   `VAULT_DIR` last instead of first. Printing "your brain lives here" from
   `env.vault` can name a directory the rest of the CLI is not using. (§2)
7. **"Passing verify" includes "nothing is installed".**
   `exitCodeForVerify` returns 0 for `not-installed` by design
   (`src/cli/install/install.ts:291-308`). An ownership + next-action close
   fired on exit 0 would fire on a machine where the install did nothing. (§1.5)
8. **The verdict-vocabulary casing in the brief is slightly wrong.** Values
   are snake_case for multi-word members, bare words for single-word ones;
   one registered vocabulary uses kebab-case. (§5.4)
9. **"Cloud sandbox" is not detectable.** Every container signal is one-way,
   cgroup v2 has erased the classic `/proc/1/cgroup` heuristic (measured on
   this host: `0::/init.scope`), and no signal separates a sandbox from a
   container or a container from a durable one. (§5.1-5.2)
10. **"Durability job" has no referent in this product.** Every scheduled-job
    surface is a *recipe renderer* that writes nothing and installs nothing
    (`src/cli/cron-recipe.ts:4-11`). There is no job whose registration the
    tool could look up, so "presence" can only mean an artifact on disk. (§3)
11. **"Handoff" is already taken.** `src/core/brain/handoff.ts` means
    operator-readable session handoff notes at
    `Brain/handoffs/<date>-<scope>.md` (`:2-5, 141-146`), with a
    `session_handoff` config gate (`src/core/config.ts:715-720`) and a bench
    category (`src/core/bench/types.ts:22`). A new install-close field named
    `handoff` would collide.
12. **The ownership statement as briefed is not unconditionally true.** The
    opencode plugin spools raw conversation turns to
    `~/.local/share/open-second-brain/opencode/`
    (`plugins/opencode/open-second-brain.ts:72-78, 167-173`) with no pruning.
    "Every memory is a Markdown file in your own vault" is false for an
    operator using that integration. (§7.2 item 7)
13. **`tests/core/architecture/egress-census.test.ts` does not census network
    egress.** It censuses local file export destinations
    (`src/core/egress/registry.ts:84-160`). A design that cites it as proof
    of "no network" would be citing the wrong artifact — though the same
    file's docblock does carry the relevant statement, that the vault has no
    git transport and never will (`src/core/egress/registry.ts:6-7`).
14. **The install adapters are exempt from the write-site census.**
    `tests/core/architecture/write-site-census.test.ts:940-948` explicitly
    excludes them, so nothing enforces an inventory of the nine out-of-vault
    paths they own. Any ownership statement that enumerates residue is
    enumerating an unguarded set.
15. **Unestablished by this recon:** the call sites of `classifyDurability`
    (§3), and whether any adapter's `verify()` currently returns
    `mcp-unreachable` in practice — `src/cli/install/install.ts:300-304`
    states it is reachable only from an adapter that shells out to a runtime
    CLI, which a CLI-level test cannot stage.

---

## What a design must not assume

1. **Do not assume the vault path in `env.vault` is the vault.** Until the
   install verb goes through `resolveVault` (or the two chains are
   reconciled), any path printed as "your brain" from the install path may
   differ from the one every other verb uses. Fix the resolver or state the
   source of the path.
2. **Do not print an ownership statement without a durability verdict.**
   "These files on this machine are your brain, delete them and it is gone"
   is a claim about persistence. Printing it where persistence has not been
   established — and it usually cannot be, §5.2 — is the misleading output
   the standing rules forbid. If the verdict is `undetermined`, the sentence
   must say so, not omit the qualifier.
3. **Do not build a three-way local/sandbox/ephemeral classifier.** Two of
   its three members are unprovable. Build the narrow, provable thing: what
   filesystem backs the resolved vault path, plus an explicit "could not be
   determined".
4. **Do not treat a negative container signal as evidence of durability.**
   Absent `/.dockerenv`, absent `/run/.containerenv` and a plain cgroup v2
   line are the *normal* readings inside modern containers.
5. **Do not treat "containerised" as "ephemeral".** A bind-mounted volume in
   a container outlives a laptop's `/tmp`.
6. **Do not assume the human and JSON install surfaces will stay in sync on
   their own.** Nothing tests the JSON shapes. Either add the field through a
   single value both renderers consume, or add the golden test at the same
   time.
7. **Do not route prose through the advisory rail.** `DIAGNOSTIC_SIGNALS`
   holds "a structural CLI string, never prose"
   (`src/core/brain/diagnostics.ts:83`) and `emitNextStep` never invents one
   (`src/core/brain/next-step.ts:29-43`). The next-action half belongs there;
   the ownership half does not.
8. **Do not declare a doctor code without registering it.** The census
   asserts set equality between `DOCTOR_REGISTERED_CODES` and the doctor
   codes present in `DIAGNOSTIC_SIGNALS`
   (`tests/core/brain/doctor-exit-census.test.ts:250-258`). A code declared
   and never registered — or registered and never pinned — fails by name.
9. **Do not add a boolean where a verdict is needed.** The project has
   repeatedly converted `boolean`/`boolean | null` to a four-member
   vocabulary precisely because "could not measure" had nowhere to go
   (`src/core/doctor-readiness.ts:28-38`,
   `tests/core/architecture/verdict-vocabulary-census.test.ts:492-505`).
   A durability probe must be able to say `undetermined` with a reason.
10. **Do not hardcode natural-language phrases for classification.** The
    existing gate in this very directory states the rule and holds to it —
    zero built-in word list, in any language, structural signals only
    (`src/core/brain/gates/durability.ts:6-10`).
11. **Do not claim "nothing is left behind".** Machine config,
    `profiles.json`, `device_id`, `installation_secret`, nine adapter config
    files and the `~/.local/bin` symlinks all survive vault deletion (§7.2).
    None is memory, so the ownership claim holds — but only as worded about
    *memory*, and `o2b uninstall` is the exit for the residue.
12. **Do not claim "every memory is a Markdown file in your vault"
    unconditionally.** It is false on a machine using the opencode
    integration, which spools raw turns to `~/.local/share`
    (`plugins/opencode/open-second-brain.ts:72-78`). Either scope the
    sentence or name the spool.
13. **Do not say "no service to cancel" unconditionally** on a vault
    configured against a cloud embedding provider (§7.3).
14. **Do not assume the vault is self-contained for identity.** The opaque
    `vault://<hex>` reference every MCP tool returns is keyed by
    `installation_secret` in the machine config
    (`src/core/config.ts:569-576`, `src/mcp/tools.ts:114`). "Copy it to
    another machine" does not carry that key, and the references break.
15. **Do not fire the close on every exit-0 verify.** Exit 0 includes
    `not-installed` (`src/cli/install/install.ts:296-299`).
16. **Do not name the new field `handoff`.** The name is taken by session
    handoff notes (§Divergences 11).
