# Claims and refusals — independent review

Scope: the ownership statement, the provider sunset check, the readiness
reclassification and the codegraph switch, the recovery-point liveness check, and
the host-pressure gate with its failure streak. Branch `feat/nothing-runs-unwatched`
against `main`.

Method: read the diff, then reproduce. Where a claim could be settled by running
something, it was run — a scratch copy of `src/ hooks/ plugins/ tests/` under
`/tmp` for mutation tests, scratch `bun test` files for behaviour, `tsc` for the
type-level claims, and this host's own cgroup layout for the pressure probe. No
source file in the repository was modified. One working-tree modification was
already present when I arrived (`tests/core/doctor.test.ts`); it is not mine, and
finding 7 is about it.

Findings are ordered by severity within each confidence class.

Note on moving ground: the branch tip advanced from `751fbb17` to `ceb8b1e3` while
this review was running. Everything below was verified against `751fbb17` and
re-checked against `ceb8b1e3` where the new commit touched it; finding 7 is closed by
it and finding 8 is half-closed. Nothing else moved.

---

## CONFIRMED — reproduced

### 1. The ownership statement asserts where the search index lives without checking

`src/core/install/ownership.ts:300`

The first line of the block an operator reads after a successful install says, with
no condition attached:

> Your brain is `<vault>`. Every memory this tool writes is a Markdown file under
> it, **and the search index beside them is a rebuildable SQLite file in the same
> vault.**

Two lines below, the enumeration contradicts it (`relocated_search_index`, id at
`ownership.ts:100`): the index can be relocated anywhere by
`OPEN_SECOND_BRAIN_SEARCH_DB` or `search_db_path`.

Reproduced by rendering the statement with the override set:

```
$ OPEN_SECOND_BRAIN_SEARCH_DB=/var/tmp/elsewhere/index.sqlite bun run <render>
  Your brain is /tmp/vault-x. Every memory this tool writes is a Markdown file
  under it, and the search index beside them is a rebuildable SQLite file in the
  same vault.
  ...
    - relocated search index — OPEN_SECOND_BRAIN_SEARCH_DB, or the search_db_path
      config key, when either is set
```

The fact is measurable and is one call away from where it is printed:
`ownershipFor` (`src/cli/install/install.ts`, the `resolveSearchConfig` call) already
resolves the search config, whose `dbPath` is `resolveIndexPath`'s answer. Nothing
passes it into `DataOwnershipInput`.

**Failure scenario.** An operator who relocated the index onto a scratch volume
reads a printed guarantee that a copy of every indexed chunk travels with the vault.
It does not.

**Confidence: high.** This is the one clause of the statement that makes an
unconditional claim about a path other than the vault, and it is the only clause
whose input was available and not taken.

---

### 2. The closing sentence re-asserts the claim the block spent twenty lines qualifying

`src/core/install/ownership.ts:322-326`

```
  Delete the vault and the memory is gone. What stays behind is the machine-local
  list above; `o2b uninstall` removes the parts this tool put there.
```

Both halves are contradicted inside the same printed block:

- "Delete the vault and the memory is gone" is exactly the unqualified sentence the
  module docblock (`ownership.ts:4-8`) says is FALSE, and the counterexample is row
  one of the list printed immediately above it — the opencode session spool, whose
  own note reads "Nothing in this tool prunes them, so on a machine using that
  integration this is memory content living outside your vault."
- "`o2b uninstall` removes the parts this tool put there" over-claims.
  `src/cli/uninstall.ts` removes the config directory (guarded by
  `isSafeLocalConfigDir`) and, with `--remove-cli`, the `~/.local/bin` symlinks. It
  does not touch the opencode spool, the `~/.codex/config.toml` fence, the reminder
  markers, the bench-run artifacts, or a relocated index — five of the nine rows.

The renderer already carries the hedge two lines earlier ("`N` of those can hold
memory content rather than plumbing, which is why the first line says what this tool
WRITES rather than everything you have ever said to it") and then throws it away in
the closing sentence.

**Confidence: high.** Read directly off the rendered output reproduced in finding 1.

---

### 3. The census that is supposed to make finding 2 impossible cannot see an async writer

`tests/core/install/ownership.test.ts:167`

```ts
const WRITE_RE =
  /(?:writeFileSync|appendFileSync|mkdirSync|symlinkSync|copyFileSync|mkdtempSync)\(/;
```

The whole argument for `OUT_OF_VAULT_STATE` being a list rather than prose
(`ownership.ts:29-35`) is that this sweep "demands each be attributed to an entry
here or excused" — "so a new out-of-vault location cannot ship without the sentence
learning about it".

Reproduced in a scratch copy of the tree. Adding `src/core/scratch-spool.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function spoolTurn(text: string): Promise<void> {
  const dir = join(homedir(), ".local", "share", "open-second-brain", "scratch");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "turns.jsonl"), text + "\n", { flag: "a" });
}
```

— a module that appends raw conversation turns to a home-rooted spool, i.e. the
exact shape of the `opencode_session_spool` row the enumeration exists for —

```
15 pass  0 fail
```

Control: the same module written with `appendFileSync` **is** caught —

```
Received: "src/core/scratch-spool2.ts"
(fail) no out-of-vault write escapes the enumeration > every writer is either
       attributed to an entry or excused in writing
14 pass  1 fail
```

So the test works, and its guarantee is scoped to the synchronous `*Sync` family
only. Uncovered: `fs/promises` (`writeFile`, `appendFile`, `mkdir`, `cp`, `rename`),
`renameSync`, `cpSync`, `createWriteStream`, `Bun.write`, and `openSync`+`writeSync`.

**Failure scenario.** The next integration that spools sessions — the natural way to
write one today is `await writeFile(...)` — ships with the ownership statement
silently unaware of it, which is the defect the module was built to make impossible.

**Confidence: high (reproduced both ways).**

---

### 4. "No account, no server … nothing to cancel" is checked against one of at least three third-party services

`src/core/install/ownership.ts:303` and `src/cli/install/install.ts` (`ownershipFor`)

The blanket claim is qualified by exactly one measured input,
`third_party_embedding_configured`. Two other operator-configurable outbound
services exist in the tree and neither is consulted:

- **Reranker.** `search_rerank_enabled` / `search_rerank_base_url` /
  `search_rerank_env_key` (`src/core/search/index.ts:584,603,612`) drive
  `src/core/search/rerank/cross-encoder.ts:85`, which POSTs the query **and the
  candidate document text** to that endpoint under an API key. That is a third-party
  account holding vault text, by the statement's own definition.
- **Telegram capture.** `src/core/brain/capture/telegram-capture.ts:418,433` long-polls
  `https://api.telegram.org` with a bot token. The token is an account with a third
  party, and the messages it carries are capture content that lives on Telegram's
  servers.

**Failure scenario.** An operator running the reranker reads "no account, no server,
no sync endpoint … nothing to cancel" and takes it as an inventory. It is an
inventory of one integration.

**Confidence: high** for the reranker (config keys, API key, document text in the
request body); **high** for Telegram as an account claim.

---

### 5. The enumeration is a static table printed as a measurement

`src/core/install/ownership.ts:243-252`, docblock claim at `ownership.ts:23-27`

> So the statement is COMPOSED rather than written … **Every one of those is a
> measurement; none is an assumption.**

Three inputs are measured: the resolved vault, the backing verdict, and the
embedding flag. The nine rows are not. They are printed unconditionally, under a
sentence that reads as a statement of fact about *this* machine:

```
  Copy the vault and the memory goes with it. These 9 things live outside it and
  do not travel in the copy:
```

On a machine that has never run the opencode plugin, never run `o2b install-cli`,
never run `o2b brain protect --target codex`, never run `o2b brain bench`, and set no
`search_db_path`, five of those nine do not exist.

The one row that *is* parameterised makes it worse rather than better.
`withAdapterTargets` is fed `defaultRegistry.targets()` — every adapter this build
registers, verified as `aider, copilot-cli, cursor, gemini-cli, generic, grok, kiro,
opencode, pi` — so the statement names nine runtimes' config files as places state
was left, on a machine where one target was installed. `probeInstalledRuntimes`
(`src/core/doctor-readiness.ts`) already answers that question by calling each
adapter's own `verify(env)`; the ownership path calls `targets()` instead.

**Failure scenario.** The operator is handed a nine-item cleanup list, most of which
is not on their disk, by a surface whose stated purpose is not saying more than it
knows. The over-claim is the mirror of the defect this release removes.

**Confidence: high.** `targets()` vs. `verify()` is a one-line read; the
unconditional rows are visible in the rendered output above.

---

### 6. The recovery-point check is silent when the history exists and lists nothing

`src/core/brain/doctor/recovery-point-liveness.ts:116` with
`src/core/brain/snapshot.ts:1129-1140`

The docblock (`recovery-point-liveness.ts:32-44`) states three states and asserts:

> a directory that IS there and cannot be enumerated throws, and that is neither
> answer — it reaches the uncertain stream naming why.

Only `readdirSync` failure throws (`snapshot.ts:1119`). Every *per-entry* failure
inside `listSnapshots` is swallowed with `continue`: a name whose `validateRunId`
fails (`:1131`), and a `statSync` that throws (`:1138`). A populated
`Brain/.snapshots/` in which no entry survives both filters returns `[]`, which the
check reads as `kind: "empty"` — "No state-changing pass has ever run" — and returns
without a warning and without an uncertain entry.

Reproduced with a scratch `bun test`:

```
issues: [] uncertain: []
2 pass
```

Case A: `Brain/.snapshots/20240101T000000Z.tar.zst` as a dangling symlink →
`statSync` throws → skipped → `[]`.
Case B: archives present with an unrecognised suffix (`.tar.gz`) → filtered → `[]`.

The shipped test (`tests/core/brain/doctor/recovery-point-liveness.test.ts:136`) covers
only the `chmod 000` directory, i.e. the one path that does throw.

**Failure scenario.** A vault synced with preserved ownership — a shape this project
designs for, and the scenario the uncertain stream's own docblock cites — where the
archives are not stattable by this user. The doctor reports a clean bill on a vault
whose rollback history it could not read at all.

**Confidence: high (reproduced).**

---

### 7. RESOLVED DURING REVIEW — the codegraph switch shipped one commit ahead of its test

`tests/core/doctor.test.ts:259`, against `src/core/partner/codegraph.ts:314`

At `751fbb17` — the branch tip when this review started — `checkCodegraph` already
returned `codegraphDisabledResult()` instead of `null`, while the test still asserted
the old behaviour. Reproduced by extracting that commit's copy of the file and
running it against the branch source:

```
(fail) doctor aggregator > omits code_graph when partner.codegraph.disabled is true
23 pass  1 fail
```

`ceb8b1e3` ("fix(tests): stop the doctor suites paying for a partner they never
assert on") landed mid-review and reconciles it. **No action needed.** Recorded
because the shape is worth noticing: a behaviour change and the test that pins it
rode in separate commits, so the branch was red at a pushable tip for the length of
that gap.

---

### 8. The partner consult is unbounded, and only the test-side cost was removed

`src/core/partner/codegraph.ts:243,258`

Both `Bun.spawnSync` calls — `codegraph status --help` and `codegraph status --json`
— are issued with `cmd`, `stdout`, `stderr`, `env` and **no `timeout`** (verified
after `ceb8b1e3`: the file still contains no `timeout` key). `doctor()` calls them
synchronously, and `doctor()` has three callers: the CLI, the MCP `vault_health`
tool, and the OpenClaw extension.

Measured on this host, where codegraph is installed:

```
doctor()                                      → 4285 ms
doctor({partner:{codegraph:{disabled:true}}}) →    0 ms
```

Before `ceb8b1e3` that made `tests/core/doctor.test.ts` "returns at least the vault
check" time out at the 5000 ms default:

```
(fail) doctor aggregator > returns at least the vault check [5999.41ms]
  ^ this test timed out after 5000ms.
```

`ceb8b1e3` fixes that by passing `partner: { codegraph: { disabled: true } }` in the
suites and setting the env var in the three MCP suites — i.e. it removes the cost
from the tests, with a commit message that measures it honestly (21.55 s → 0.652 s).
The production path is unchanged: `vault_health` over MCP still pays the four
seconds by default on any machine with the binary on PATH, and a partner CLI that
hangs blocks `doctor()` for as long as it hangs, with no deadline, no refusal and no
progress record.

The new config docblock (`src/core/config.ts`, `resolvePartnerCodegraphDisabled`)
names the cost precisely — "asking it costs seconds against a cold HOME" — and
answers it with an opt-out rather than a budget. In a release that gave four MCP
tools a progress token and a cancel seam, the one synchronous subprocess in the
doctor got neither.

**Confidence: high (measured, and re-verified after `ceb8b1e3`).**

---

### 9. The pressure gate reads a cgroup that is never the process's own

`src/core/brain/maintenance/host-pressure.ts:51-52,169-183`

`probeCpuQuota()` reads exactly two absolute paths:

```ts
const CGROUP_V2_CPU_MAX = "/sys/fs/cgroup/cpu.max";
const CGROUP_V1_CPU_QUOTA = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
```

Under cgroup v2 the **root cgroup carries no `cpu.max`** — the file exists on every
child, not on the root. The process's own cgroup is found in `/proc/self/cgroup`,
which this module never reads. Demonstrated on this host:

```
$ ls /sys/fs/cgroup/cpu.max
ls: cannot access '/sys/fs/cgroup/cpu.max': No such file or directory
$ cat /proc/self/cgroup
0::/user.slice/user-1001.slice/session-9028.scope
$ cat /sys/fs/cgroup/user.slice/user-1001.slice/session-9028.scope/cpu.max
max 100000
```

So `readFirstLine(v2)` returns `null`, `readFirstLine(v1)` returns `null` on a
v2-only host, and `probeCpuQuota()` returns `false`. The docblock's justification for
that `false` (`:164-168`) is:

> When neither interface is present there is no bandwidth controller to be limited
> by, which is a real answer — `false` — rather than an absence.

That inference does not hold. Absence at the root path says nothing about the cgroup
the process is in, and the effective limit is the minimum over the whole ancestor
chain, not one file.

**Failure scenario.** A systemd unit with `CPUQuota=50%`, or a container whose limit
is expressed on its own cgroup path rather than at the mount root. `measureHostPressure`
skips the `cpuQuotaInForce` refusal and returns
`percent = loadavg1m / availableParallelism() * 100` — the host's run queue over a CPU
count the process may not have — which is precisely the "confident number where the
metric is degenerate" the module's opening paragraph exists to forbid. The gate then
lets heavy work through on a machine it believes is idle, or closes on a machine that
is not.

**Confidence: high** that the wrong path is read (demonstrated); **high** that a
quota in force is therefore missed; not directly reproduced with a live quota, since
no cgroup on this host carries one.

---

### 10. `readFirstLine` conflates absent with unreadable, and the comment says the caller separates them

`src/core/brain/maintenance/host-pressure.ts:150-158`

```ts
} catch {
  // Absent and unreadable are told apart by the caller, which knows
  // which of the two interfaces it asked for.
  return null;
}
```

The caller does not tell them apart. `probeCpuQuota` treats `null` from v2 as "try
v1" and `null` from v1 as "no interface exists" → `false`. An `EACCES` on an existing
`cpu.max` (a restricted `/sys` mount, a hardened runtime) is therefore reported as
"no quota in force", not as `cpu_quota_unknown`.

The comment is a claim about a behaviour the code does not have — which also leaves
`HOST_PRESSURE_UNMEASURABLE_REASON.cpuQuotaUnknown` reachable only through the
narrow case of an *empty or unparseable but readable* `cpu.max` (see finding 13).

**Confidence: high (read directly).**

---

## PLAUSIBLE — reasoned, not executed against a live trigger

### 11. `declaration_malformed` has no producer

`src/core/search/embeddings/sunset.ts:451` and `:159-164` in
`src/core/brain/doctor/embedding-sunset-check.ts`

```ts
if (declaration !== undefined && declaration.model === model) {
  if (!isValidIsoInstant(declaration.sunsetAt)) {
    return undetermined(model, ...declarationMalformed, reviewedAt);
  }
```

The only producer of `cfg.embeddings` is `parseEmbeddingsBlock`
(`src/core/brain/policy/blocks/embeddings.ts:98-108`), which validates `sunset_at`
with the **same** `isValidIsoInstant` and throws `BrainConfigError` otherwise. A
declaration that reaches the classifier has therefore already been proved
well-formed. The state, its reason member, and the four-sentence message in
`undeterminedMessage` can be produced only by a test calling
`classifyEmbeddingSunset` directly.

This is the defect class the release names: a declared surface with no producer.
`tests/core/architecture/verdict-vocabulary-census.test.ts` does not catch it and
says so explicitly at `:405-410` — it asserts object/list/guard agreement, not
reachability.

**Confidence: high** that the path is dead in production; **medium** on severity —
it is dead code plus an unreachable operator message, not a wrong answer.

### 12. `survey_entry_malformed` likewise

`sunset.ts:488`. Every row of `EMBEDDING_SUNSET_SURVEY` is built from
`OPENAI_FIRST_GENERATION_SHUTDOWN` (a valid literal) or `null`, so no shipped entry
can trip it. Defensible as a guard over shipped data, but its only producer is an
injected survey.

### 13. Four of the five host-pressure refusal reasons have no realistic producer

`src/core/brain/maintenance/host-pressure.ts:83-94`

- `parallelismUnknown` — `availableParallelism()` is specified to return ≥ 1.
- `loadAverageInvalid` — `loadavg()[0]` is a finite non-negative double on every
  platform that implements it.
- `cpuQuotaUnknown` — only an empty/unparseable but readable `cpu.max`; finding 10
  routes the realistic failure (EACCES) to `false` instead.
- `platformBlind` — `win32` only, and `resolveDefaultConfigPath`
  (`src/core/config.ts:127`) refuses win32 by name with the note that "nothing here
  (no adapter, no install document, no path handling) targets Windows".

That leaves `cpuQuotaInForce` as the sole producible refusal, and finding 9 says it
is under-produced. The module's own headline argument — "on the platform Node and
Bun do not implement it for, it returns `[0, 0, 0]`" — is about a platform this build
declines to configure itself on.

**Confidence: medium-high.** Each individually is a reading of a spec or of another
module; together they say the refusal vocabulary is wider than what the probe can
reach.

### 14. A streak refusal is printed and exited as a failure — against this branch's own precedent

`src/cli/brain/verbs/maintenance.ts:265,274`

```ts
ok(`  ${t.name}: ${t.ok ? "ok" : `FAILED (${t.error})`} in ${t.duration_ms}ms`);
...
return result.tasks.some((t) => !t.ok) ? 1 : 0;
```

`refuseOnStreak` mints `refused: true` and `failure_streak: N` on
`MaintenanceTaskResult` precisely so a refusal is not read as an attempt, and the
journal row deliberately omits `ok` for the same reason
(`src/core/brain/maintenance/lane.ts`, the `entry:` comment). The human renderer
reads neither field and prints `FAILED`; the exit code is 1, identical to four
genuinely broken passes.

This is the same question `doctorExitCode` answers correctly forty lines of diff
away (`src/cli/main.ts:313-321`): a run that did not attempt gets its own number,
`DOCTOR_EXIT.probeIncomplete = 6`, pinned against `SEARCH_CHECK_EXIT.probeIncomplete`.
The maintenance verb spends no new code and collapses the distinction the unit was
built to draw. `--json` is fine — it emits the whole task record.

**Confidence: high on the behaviour, high on the inconsistency.**

### 15. The streak refusal is a function of a ring buffer, so it clears itself

`src/core/brain/maintenance/journal.ts:119` with `MAINTENANCE_JOURNAL_CAP = 500`

`consecutiveTaskFailures` walks `listJournal(vault)`, which reads only what
`sweepJournal` has kept: the newest 500 lines. The lane writes four task rows per
run plus gate rows, so roughly 125 runs of history are retained. A permanently broken
task that has tripped its limit keeps producing one `refused:streak` row per run —
and those rows, plus the other three tasks' rows, push its three original `run/ok:false`
rows off the tail. Once they roll off, `consecutiveTaskFailures` returns 0 and the
task is retried as if nothing had happened.

Nothing reports that. The refusal the operator was told to clear with `--force`
un-refuses itself on a schedule that depends on how chatty the journal is.

**Confidence: medium-high** — the arithmetic is direct; I did not drive 125 lane runs
to watch it happen.

### 16. The sunset horizon expires negatives whose justification cannot expire

`src/core/search/embeddings/sunset.ts:510-515`

`EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS = 365` is applied to every negative
identically. Two classes of negative are in the table and only one is observational:

- `text-embedding-3-{small,large}`, `text-embedding-ada-002` — sourced as "not listed
  in any deprecation entry … as of the review date". A claim about the world; it
  should expire, and the entry note says so.
- `hashing-ngram-v1` — sourced as "this build ships the local embedder, so this
  project is the only party that could".
- The six `EMBEDDING_MODEL_PRESETS` open-weight checkpoints — sourced as "there is no
  operator of a hosted endpoint with the authority to decommission the model itself".

The last two classes are structural: they are facts about who could announce
anything, not observations that go stale. After `reviewedAt + 365d` (2026-08-15 +
365 = 2027-08-15) they degrade to `undetermined/survey_stale` all the same.

**Failure scenario.** On 2027-08-16 every vault on the default local provider gains a
standing `[UNSURE] embedding-model-sunset-undetermined` finding whose message reads
"the decommission survey covers hashing-ngram-v1 and records no announcement, but it
was reviewed … more than 365 days ago" — about a model this repository ships and is
the only party able to retire. That is a report of ignorance the build does not have.

**Confidence: medium-high.** The mechanism is certain; whether the noise matters is a
judgement, but it is noise-by-construction on the default configuration.

### 17. `ownershipFor` swallows a config-resolution failure without saying so

`src/cli/install/install.ts`, the `try { resolveSearchConfig(...) } catch { }` in
`ownershipFor`

```ts
} catch {
  // A config that will not resolve is not evidence of a cloud account.
}
```

The conservative direction is right; the silence is not. An operator whose search
config throws (an out-of-range `search_chunk_size`, an unparseable key) reads the
unqualified "nothing to cancel" with no indication that the clause was skipped
because the check could not run. The branch's own standard elsewhere — the sunset
check's `pushUncertain` on the same failure (`embedding-sunset-check.ts:198-208`) —
is to emit the "could not be resolved" record. `DataOwnership` has no field for it.

**Confidence: high on behaviour, medium on severity.**

### 18. The third-party clause is decided by provider kind, not by endpoint host

`src/cli/install/install.ts` (`ownershipFor`) and `src/core/install/ownership.ts:284`

```ts
networked = semantic.provider !== "local" && semantic.provider !== "disabled";
```

`EmbeddingProviderName` is `"openai-compat" | "disabled" | "local" | "zeroentropy"`
(`src/core/search/types.ts:931`) — four *transport* kinds, as `sunset.ts:80-84` itself
points out. `openai-compat` pointed at `http://localhost:11434` is the documented way
to run Ollama or LM Studio, and it prints:

> embedding requests send vault text to the endpoint in `embedding_base_url`, which
> is a third-party account this tool neither owns nor cancels.

`semantic.baseUrl` is resolved on the same object and would settle it (a loopback or
private-range host is not a third-party account).

**Confidence: high** that the over-claim fires for a local OpenAI-compatible server.

### 19. Minor: the census walk errors on any dangling symlink

`tests/core/install/ownership.test.ts:183` uses `statSync` inside `walk`, which throws
on a broken link anywhere under `src/`, `hooks/`, `plugins/`. Observed while setting
up the scratch copy (`plugins/codex/skills` is a symlink): three tests error rather
than fail with a finding. `lstatSync`, or a `try`/skip, would keep the census
reporting instead of crashing.

### 20. Minor: the MCP `brain_maintenance` contract is stale about `force`

`src/mcp/brain/admin-tools.ts:472,477`

> "force bypasses the soft gates, never the lease" … `force: "Bypass window and busy
> gates (run)."`

`force` now also bypasses the **pressure** gate and the **streak refusal**, and it is
the only documented route out of a streak refusal (`refuseOnStreak`'s message says
"re-run with `--force`"). An MCP-only operator whose lane has refused a task reads a
schema that does not mention the state they are in.

---

## Answers to the questions asked

**1. Is every claim these surfaces print actually checked?** No — findings 1, 2, 4,
5, 18. Three separate clauses of the ownership statement assert things the composer
had the inputs to measure and did not: where the index lives, which runtimes hold
managed blocks, and whether the configured embedding endpoint is a third party. Two
more (the "nothing to cancel" blanket and the uninstall promise) are checked against
one integration out of three and against a verb that removes two rows out of nine.

I swept for out-of-vault writes myself rather than trusting the enumeration: home-,
XDG-, temp- and `env.home`-rooted writers across `src/`, `hooks/`, `plugins/`, plus
async and non-`Sync` write APIs, plus CWD-rooted writes, plus `bin/`, `install/`,
`openclaw/`, `scripts/`, `templates/`, `skills/`. I found no *currently shipping*
out-of-vault location that the nine rows miss. What I found is that the mechanism
guaranteeing that stays true does not cover the async half of the filesystem API
(finding 3), and that `src/cli/uninstall.ts` — which the statement names — is not in
the swept population at all (it only removes).

**2. Are the verdicts reachable?** The vault-backing vocabulary is fully reachable
(`durable`/`volatile`/`layered` by filesystem, all three undetermined reasons by
platform, path and magic number). The sunset vocabulary has two unreachable reason
members (findings 11, 12); its states are all reachable, and `announced` has a real
shipped producer (the sixteen first-generation OpenAI rows, with a past date, which
is the arm that matters). The host-pressure refusal vocabulary is the weak one:
four of five reasons have no realistic producer (finding 13), and the fifth is
under-produced (finding 9). The census test explicitly does not check reachability,
so nothing in the suite covers any of this.

**3. The sunset check.** A positive does depend on shipped data, and the asymmetry is
right: positives survive a stale survey, negatives expire. The degradation is honest
for the hosted-model negatives and category-wrong for the structural ones (finding
16). `unsurveyed` is genuinely distinguishable from `none_announced` on every surface
I could find: `none_announced` returns silently, `unsurveyed` pushes an uncertain
entry with its own code, and the uncertain stream reaches the human `[UNSURE]` lines
(`src/cli/brain/verbs/doctor.ts:195`), the CLI `--json` payload (`:182`) and the MCP
`vault_health` payload (`src/mcp/brain/health-tools.ts:144`). One residual: a
`none_announced` silence is indistinguishable from the check having thrown, because
`runDoctor` swallows a `failSoft` throw with a bare `catch {}` (`src/core/brain/doctor.ts:278`)
and the sunset check's own `try` covers only `resolveSearchConfig`. That mechanism
predates this branch, but it now guards a new check whose entire point is that
silence must mean something specific.

**4. The pressure gate.** The refusal paths are correct *given the probe*, and the
probe is wrong (findings 9, 10). No path produces a number when the refusals fire;
the problem is that the quota refusal does not fire when it should. The
open-and-said-so behaviour **is** distinguishable in the journal: an unmeasurable
reading writes its own `pressure:unmeasurable` row with `pressure_reason` before the
lane proceeds (`lane.ts`, the two-line comment), and a gate that evaluated and passed
writes nothing at all. Two caveats: with `--force`, `evaluateGates` is never called,
so nothing is journaled about pressure and that is indistinguishable from an
unconfigured gate; and a *measured* passing reading is not journaled either, so the
percentage the gate saw when it let work through is unrecoverable.

**5. The streak.** A refusal cannot deepen the streak it reports —
`consecutiveTaskFailures` `continue`s past any row whose verdict is not `run`, and
`refused:streak` rows carry no `ok`. A transient failure cannot become permanent by
accumulation: a single success breaks the walk. There is no state requiring manual
file surgery — `--force` clears it on both the CLI and the MCP tool. Two things do go
the other way: the refusal is *reported* as a failure (finding 14), and it *clears
itself* as journal rows roll off the 500-line cap (finding 15). Also worth naming:
`--force` is lane-wide, so an operator retrying one wedged task necessarily also
overrides the window, busy and pressure gates for the other three.

**6. Does a broken system now exit 0?** No — I looked hard and could not construct
one. `unknown` is routed to `DOCTOR_EXIT.probeIncomplete = 6`, not to 0, in every
path including the `catch` around `runReadinessProbes` (which falls back to
`failed > 0 ? 1 : 6`), and the `--json` `ok` field is now derived from the exit code
rather than from `failed` alone, so it went from too permissive to correct. The
reclassification is strictly stricter than what shipped before: an `unknown` probe
used to exit 0. `runReadinessProbes` is the only consumer of the report and
`cmdDoctor` is its only caller. The one asymmetry worth noting is that an
unresolvable search config surfaces as `fail` from `probeEmbeddingProvider` (which
catches) and as `unknown` from `probeLlmKey` (which does not) — the same condition
reported two ways — but `fail` wins the precedence, so the exit code is right.

**7. Exit codes.** The doctor's new code is consistent and well-pinned:
`DOCTOR_EXIT.probeIncomplete` is asserted equal to `SEARCH_CHECK_EXIT.probeIncomplete`
rather than to `6` (`tests/cli/doctor-exit.test.ts:83`), and the end-to-end test
asserts `not.toBe(ok)` and `not.toBe(failed)` alongside it, so a table collapse fails
loudly. That is the standard the rest of the branch should have been held to, and the
maintenance verb was not (finding 14).

---

## Checked and found sound

An absent finding here is a positive result, not an omission.

- **The unknown-vs-fail reclassification is load-bearing.** Mutated
  `src/core/doctor-readiness.ts:580` back to `READINESS_STATUS.fail` in a scratch copy:
  `tests/core/doctor-readiness.test.ts` went 21 pass / 3 fail, including "a probe that
  throws claims nothing about the surface it could not read". The test cannot pass
  against the old behaviour.
- **The quota refusal is load-bearing.** Deleted the `cpuQuotaInForce` arm from
  `measureHostPressure` in a scratch copy: `tests/core/brain/maintenance/` went
  37 pass / 1 fail on "a CPU bandwidth quota makes the run queue the wrong machine's".
- **The out-of-vault census does catch the writers it can see.** Control mutation in
  finding 3: a synchronous home-rooted writer is named in the failure message.
- **The closed vocabularies are genuinely closed at the type level.** I suspected
  `Object.freeze({...})` without `as const` in `host-pressure.ts:58,83` and
  `journal.ts:36` had widened the members to `string`, breaking both the guards' return
  types and the discrimination of `HostPressureReading`. It has not: `tsc` rejects
  `const x: MaintenanceVerdict = "totally-bogus-verdict"` and `HostPressureState =
  "totally-bogus-state"` exactly as it rejects the `as const` control
  (`VaultBackingState`), and narrowing to `.reason` inside
  `if (r.state === HOST_PRESSURE.unmeasurable)` compiles. `Object.freeze`'s
  primitive-constrained overload preserves the literals. The only residual is
  cosmetic: `HOST_PRESSURE_STATES` and `MAINTENANCE_VERDICTS` are annotated
  `ReadonlyArray<string>` where their siblings use the member type, so a missing member
  is caught only by the runtime census, not by the compiler.
- **`probeVaultBacking` refuses in the right direction.** Unlisted magic numbers are
  `fs_type_unknown`, not "assumed durable"; the platform gate is by allow-list;
  network filesystems are `durable` with a stated argument; the probe never throws;
  and `filesystem`/`reason` are exclusive by construction. `survivalLine` is
  exhaustive with no default arm, so a fifth state fails the build.
- **The declaration layer is both-or-neither, and enforced at parse time.**
  `parseEmbeddingsBlock` throws on half a declaration rather than dropping it
  (`policy/blocks/embeddings.ts:117`), which is what makes finding 11 a dead branch
  rather than a silent no-op.
- **The sunset disagreement is carried, not erased.** `overrode_survey` /
  `survey_sunset_at` reach the message via `provenance()`, so a declaration that
  contradicts the table names both records.
- **The uncertain stream reaches every reader.** Deduplicated per `(code, path)`,
  capped per code, and serialised into the human `[UNSURE]` lines, the CLI `--json`
  payload and the MCP payload. `unsurveyed` is visible everywhere.
- **The `disabled` codegraph arm has a real producer for all three callers.**
  `codegraphCheckDisabled` resolves the env var / config key when no explicit option
  is passed, and `tests/core/doctor-codegraph-switch.test.ts:91` asserts the *unswitched*
  path actually spawns — so the "the switch stops the spawn" tests are not vacuous.
  The fallback on an unreadable config is the value that changes nothing (check runs),
  not an invented "disabled".
- **The install vault chain is now single-source.** `resolveInstallVault` delegates to
  `resolveVault` and `loadPayload`'s second read of the `vault` config key is gone, so
  the installer and `o2b status` cannot disagree. `tests/cli/install-vault-resolution.test.ts`
  pins the precedence against `resolveVault`'s order rather than restating it.
- **The install `--json` envelope.** One exit (`installJson`), version prepended
  centrally, `data_ownership` spelled once as a named constant, and additive on the
  apply payload rather than re-nested. The ownership close is correctly gated on
  `results.some(r => r.status === "ok")` for `--check`, so a `not-installed` run does
  not congratulate anyone.
- **The onboarding checklist and the install close read one record.** `data_ownership`
  is built once in `buildOnboardingChecklist` from the same `networked` value the
  notices use, so the two surfaces cannot gain fields separately.
- **The streak walk.** Verified by reading: refusal rows are skipped, lease and gate
  rows are skipped, `ok !== false` breaks, and a row that ran with no recorded outcome
  breaks — all four match the docblock.
- **Journal rows for the fourth gate.** `pressure:unmeasurable` is emitted on its own
  line *before* the decision row and never instead of it; `pressure_percent` rides only
  on a measured `skipped:pressure` row. The two facts are never collapsed.
- **`maintenance:` block bounds.** `host_pressure_percent` has no default (an
  unconfigured gate never fires), `failure_streak_limit` defaults to 3 with a stated
  argument, and both are hard errors out of range rather than clamped.
- **Suite state.** With a clean `HOME`, the thirteen test files covering this scope ran
  246 pass / 1 fail at `751fbb17`, the single failure being the 5 s partner timeout of
  finding 8; `ceb8b1e3` removes that cost from the suite. Findings 7 and 8's test-side
  symptom are therefore closed; finding 8's production half is not.
