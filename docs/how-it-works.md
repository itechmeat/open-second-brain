# How Open Second Brain Works

A working guide for engineers and agents to the mechanics of the
observing memory layer. Read this when you want to understand what the
system does, not what to configure.

## Mental model

Open Second Brain accumulates **preferences** and learns from real
usage. Three responsibilities:

- **Capture.** Agents and humans drop taste signals into `Brain/inbox/`.
- **Accretion.** A deterministic `dream` pass turns repeat signals into
  rules.
- **Application.** Agents record whether they applied or violated each
  rule when producing durable artifacts.

The LLM lives outside the system: agents use it to detect signals in
conversation and to apply rules during work. The system uses counters,
thresholds, and atomic file operations — no LLM inside the algorithm,
no surprise, no hallucinated memory.

## Vault layout

The vault holds three top-level agent-facing directories. Brain owns
its own.

```text
<vault>/
├── Brain/                          # observing memory (agent-writable)
│   ├── _brain.yaml                 # schema, thresholds, retention
│   ├── _BRAIN.md                   # operating manual for agents
│   ├── inbox/                      # raw taste signals
│   │   ├── sig-<date>-<slug>.md
│   │   └── processed/             # signals already folded into rules
│   ├── preferences/                # active rules
│   │   └── pref-<slug>.md          # status: unconfirmed | confirmed
│   ├── retired/                    # archived rules
│   │   └── ret-<slug>.md           # retired_reason: stale | expired | rebutted | user-rejected
│   ├── log/                        # daily event log
│   │   └── YYYY-MM-DD.md           # append-only, typed events
│   └── .snapshots/                 # pre-dream snapshots
│       └── dream-<run-id>.tar.zst
│
├── AI Wiki/                        # curated knowledge surface
│   ├── identity/                   # user.md, agents.md
│   ├── index.md / hot.md
│   ├── payments/ / assets/ / drafts/ / reports/ / policies/   ← Pay Memory subtree
│   └── system/                     # config snapshots, etc.
│
└── Daily/                          # chronological event log + human narrative
    └── YYYY.MM.DD.md
```

```mermaid
flowchart LR
    Agent[Agent / MCP client]
    subgraph Vault
        Brain[Brain/]
        Wiki[AI Wiki/]
        Daily[Daily/]
        PayMem[(Pay Memory subtree<br/>under AI Wiki/)]
    end

    Agent -- "brain_* (read + write)" --> Brain
    Agent -- "second_brain_query (read)" --> Wiki
    Agent -- "second_brain_query (read)" --> Daily
    Agent -- "payment_* (read + write)" --> PayMem
```

`Brain/` is the only area where the agent records its observing
memory. `AI Wiki/` and `Daily/` are read surfaces for the agent (the
Pay Memory subtree under `AI Wiki/` is the exception: agents write
there through the `payment_*` tools).

## A preference's lifecycle

A preference moves between four states from first signal to retirement:

```mermaid
stateDiagram-v2
    [*] --> Inbox: brain_feedback
    Inbox --> Unconfirmed: dream (≥candidate_threshold<br/>same-sign signals on topic)
    Unconfirmed --> Confirmed: brain_apply_evidence applied<br/>(first such event)
    Unconfirmed --> Retired_Expired: dream (now > unconfirmed_until,<br/>no applied evidence)
    Confirmed --> Retired_Stale: dream (last_evidence_at<br/>older than stale_evidence_days)
    Confirmed --> Retired_Rebutted: dream (≥candidate_threshold<br/>opposite-sign signals collected)
    Confirmed --> Retired_UserRejected: o2b brain reject
    Unconfirmed --> Retired_UserRejected: o2b brain reject
    Retired_Expired --> [*]
    Retired_Stale --> [*]
    Retired_Rebutted --> [*]
    Retired_UserRejected --> [*]

    note right of Confirmed
        Pinned preferences (pinned: true)
        skip all three automatic retire
        transitions. Only o2b brain reject
        can retire them.
    end note
```

`Inbox` is not really a state of the preference — it's the staging
area for the signals that will eventually create one. The first real
state is `Unconfirmed`: the rule exists but has not yet been applied
in real work.

## End-to-end signal → rule flow

A typical sequence from a user remark to a confirmed preference:

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Agent
    participant MCP as MCP layer
    participant Core as Brain core
    participant Vault

    User->>Agent: do not use internal abbreviations
    Agent->>MCP: brain_feedback (topic, signal negative, principle, agent)
    MCP->>Core: writeSignal
    Core->>Vault: atomic write Brain/inbox/sig file
    Core->>Vault: append Brain/log/today.md feedback event
    MCP-->>Agent: signal_path and signal_id
    Agent-->>User: confirmation

    Note over Vault: days pass and two more matching signals arrive on the same topic

    Note over Core: scheduled dream pass (cron or manual)
    Core->>Vault: scan inbox, preferences, log
    Core->>Core: group signals by topic
    Core->>Vault: createSnapshot to .snapshots/dream-run.tar.zst
    Core->>Vault: write Brain/preferences/pref file status unconfirmed
    Core->>Vault: move inbox signals into inbox/processed
    Core->>Vault: append log dream event
    Core->>Vault: pruneSnapshots to retention_count

    Note over Agent,User: later the agent produces a blog draft

    Agent->>Agent: write durable artifact
    Agent->>MCP: brain_apply_evidence (pref_id, artifact, result applied, agent)
    MCP->>Core: appendApplyEvidence
    Core->>Vault: append log apply-evidence event
    MCP-->>Agent: logged_at and log_path

    Note over Core: next dream pass
    Core->>Vault: scan log and count applied or violated per pref
    Core->>Vault: pref file status unconfirmed becomes confirmed
    Core->>Vault: pref file applied_count plus one, last_evidence_at, confidence
    Core->>Vault: append log dream event with confirmed list
```

Two important properties of this flow:

- The `dream` pass is the **only** writer of state transitions
  (unconfirmed → confirmed, anything → retired). Signals and
  apply-evidence events are append-only side inputs.
- Every state change is durable on disk before `dream` returns. There
  is no in-memory buffer that could be lost on crash.

## The dream pass in detail

A single dream invocation is a deterministic pipeline:

```mermaid
flowchart TD
    Start([o2b brain dream]) --> Load[Load _brain.yaml]
    Load --> Scan[Scan inbox/, preferences/, retired/, log/]
    Scan --> Plan[Plan transitions:<br/>new unconfirmed, promotions,<br/>retires, signal moves]
    Plan --> Changed{Any changes planned?}
    Changed -- no --> NoOp([return changed: false<br/>no snapshot, no log])
    Changed -- yes --> Snap["createSnapshot to<br/>.snapshots/dream-RUNID.tar.zst"]
    Snap --> SnapErr{Snapshot OK?}
    SnapErr -- fail --> Abort([throw; no state changed])
    SnapErr -- ok --> Apply

    subgraph Apply [Apply transitions]
        direction TB
        A1[Per topic: signals → unconfirmed pref<br/>if threshold met] --> A2
        A2[Per pref: count log evidence,<br/>compute applied_count / violated_count]
        A2 --> A3{Unconfirmed with applied ≥ 1?}
        A3 -- yes --> A4[Promote to confirmed,<br/>stamp confirmed_at]
        A3 -- no --> A5
        A4 --> A5[Recompute confidence]
        A5 --> A6{Pinned?}
        A6 -- yes --> A7[Skip auto-retire,<br/>log retain-pinned]
        A6 -- no --> A8{Retire conditions?}
        A8 -- stale --> A9[Move to retired/<br/>reason: stale-no-evidence]
        A8 -- expired --> A10[Move to retired/<br/>reason: expired-unconfirmed]
        A8 -- rebutted --> A11[Move to retired/<br/>reason: rebutted]
        A8 -- none --> A12[Leave in preferences/]
        A9 --> A13
        A10 --> A13
        A11 --> A13
        A12 --> A13
        A7 --> A13
        A13[Move consumed signals to processed/]
    end

    Apply --> LogEvent["Append dream event to log/today.md"]
    LogEvent --> Prune[pruneSnapshots to retention_count]
    Prune --> Done([return changed: true with summary])
```

Key rules baked into the pipeline:

- **Threshold by dominant sign.** New unconfirmed preferences are
  created only when `candidate_threshold` (default 3) **same-sign**
  signals on one topic appear within `contradiction_window_days`.
  Mixed signals cancel and the rule does not form.
- **Pre-run snapshot before any mutation.** If snapshot fails, the run
  aborts without writing anything; safety net cannot be bypassed.
- **Idempotency.** A second dream run on unchanged inputs is a no-op:
  no snapshot, no log entry, no file modifications.
- **Corrupted YAML is tolerated.** A single unparseable signal or
  preference is logged as a `skip-corrupted-frontmatter` event; the
  rest of the run proceeds.

## Confidence formula

Confidence is computed for every active preference on every dream
pass:

```mermaid
flowchart LR
    Inputs[applied_count, violated_count,<br/>last_evidence_at, age] --> Q1
    Q1{applied ≤ low_max_applied<br/>OR<br/>violated ≥ applied?}
    Q1 -- yes --> Low[low]
    Q1 -- no --> Q2{applied ≥ high_min_applied<br/>AND violated = 0<br/>AND fresh?}
    Q2 -- yes --> High[high]
    Q2 -- no --> Medium[medium]
```

Defaults from `_brain.yaml`:

- `low_max_applied: 2` — rules with two or fewer applications stay
  `low` until they prove themselves.
- `high_min_applied: 10` — high confidence requires ten clean applications.
- `high_freshness_factor: 0.8` — "fresh" means
  `now - last_evidence_at < stale_evidence_days * 0.8`.
- `stale_evidence_days: 90` — the boundary for fresh / stale.

All four are tunable per vault in `Brain/_brain.yaml`.

## CLI / MCP surface

The same operations are reachable through two channels. Read columns
are mirrored in MCP; destructive operations are CLI-only by design.

| Operation                | CLI verb                   | MCP tool              | Side effect            |
|--------------------------|----------------------------|-----------------------|------------------------|
| Bootstrap layer          | `o2b brain init`           | —                     | creates `Brain/` skeleton |
| Record taste signal      | `o2b brain feedback`       | `brain_feedback`      | writes signal + log event |
| Consolidation pass       | `o2b brain dream`          | `brain_dream`         | mutates preferences/retired, atomic snapshot |
| Record application       | `o2b brain apply-evidence` | `brain_apply_evidence`| appends log event      |
| Render summary           | `o2b brain digest`         | `brain_digest`        | read-only              |
| Inspect state            | `o2b brain query`          | `brain_query`         | read-only              |
| Validate invariants      | `o2b brain doctor`         | `brain_doctor`        | read-only              |
| Retire manually          | `o2b brain reject`         | — (CLI-only)          | moves pref → retired/  |
| Toggle pin               | `o2b brain pin / unpin`    | — (CLI-only)          | flips `pinned` field   |
| Restore snapshot         | `o2b brain rollback`       | — (CLI-only)          | overwrites Brain/ from snapshot |

Operations that change the **protected set** (`pin`, `unpin`,
`reject`, `rollback`) are kept off the MCP surface so an autonomous
agent cannot quietly alter what is shielded from automatic retire or
roll back state.

## Snapshots and rollback

A snapshot is taken before any state-changing dream run:

```mermaid
flowchart TD
    Trigger[dream wants to mutate] --> CS[createSnapshot]
    CS -- failure --> Abort([abort; nothing changed])
    CS -- success --> Mutate[apply mutations]
    Mutate --> Log[append dream log event]
    Log --> Prune[pruneSnapshots to retention_count]

    RB["o2b brain rollback RUNID"] --> Restore[restoreSnapshot]
    Restore --> Extract[extract .tar.zst into tmp]
    Extract --> Replace[replace Brain/ entries<br/>excluding .snapshots/]
    Replace --> LogR[append rollback log event]
```

A snapshot captures every file under `Brain/` **except** `.snapshots/`
itself — otherwise rollback would erase any snapshots taken after
this one. Retention defaults to ten newest archives.

```mermaid
flowchart LR
    BrainRoot[Brain/]
    BrainRoot --> Yaml[_brain.yaml]
    BrainRoot --> Manual[_BRAIN.md]
    BrainRoot --> Inbox[inbox/]
    BrainRoot --> Prefs[preferences/]
    BrainRoot --> Ret[retired/]
    BrainRoot --> LogD[log/]
    BrainRoot --> Snaps[.snapshots/]
    Yaml --> Archive((snapshot.tar.zst))
    Manual --> Archive
    Inbox --> Archive
    Prefs --> Archive
    Ret --> Archive
    LogD --> Archive
    Snaps -. excluded .-> Archive
```

## Integration with agent runtimes

The same MCP tools are advertised to every runtime; only the wiring
differs:

```mermaid
graph LR
    Hermes -- "mcp_servers.yaml" --> Stdio["o2b mcp (stdio)"]
    ClaudeCode["Claude Code"] -- "bundled .mcp.json" --> Stdio
    Codex -- "codex mcp add" --> Stdio
    OpenClaw -- "native JS plugin" --> InProc["in-process tools"]
    Stdio --> Vault[(Brain/ on disk)]
    InProc --> Vault
```

- **Hermes** loads the MCP server via `mcp_servers:` in
  `~/.hermes/config.yaml`. The agent surface also needs the
  `brain-memory` skill enabled in the active profile (via
  `hermes-skills-sync enable <profile> brain-memory`) so the LLM
  recognises preference triggers in conversation.
- **Claude Code** picks up the bundled `.mcp.json` and the
  plugin-shipped `brain-memory/SKILL.md` automatically.
- **Codex** registers the MCP server with `codex mcp add`; the same
  skill bundle is loaded automatically.
- **OpenClaw** runs tools natively in the plugin's Node.js process
  (no subprocess, by security-scanner requirement).

## Safety properties

These are invariants of the system, not configuration to enable.

- **Filesystem-first.** Every Brain artifact is a Markdown file with
  YAML frontmatter. `cp -r Brain/` is a complete backup; `tar -czf`
  is a portable bundle.
- **Deterministic.** The dream pass is a pure function of (signals,
  preferences, retired, log, configuration, current time). Given
  identical inputs and a fixed `--now`, two runs produce byte-identical
  output.
- **Idempotent.** Re-running dream without new input or expired
  timestamps is a no-op. Safe to schedule at any frequency.
- **Atomic per-file writes.** Every mutation goes through
  write-temp + rename; an interrupted run never leaves partial files.
- **Audit-traceable.** Every state change emits a typed event in
  `Brain/log/<day>.md`. The log is append-only; the dream log entry
  for a run records exactly which preferences moved and why.
- **Reversible.** Pre-run snapshots plus
  `o2b brain rollback <run-id>` let you undo any single dream pass.
- **Path-safe.** Every writer routes through a vault-boundary check;
  `Brain/` operations cannot escape the configured vault root.
- **No LLM inside the algorithm.** Semantic merging of similar but
  differently-slugged topics is left to external agents who can call
  the CLI / MCP surface directly — the dream pass itself only does
  counting and atomic file moves.

## Sample lifecycle of one preference

A worked example spanning a hundred days of vault activity:

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent
    participant Brain
    participant Dream as dream pass

    User->>Agent: day 0 — "don't use internal abbreviations"
    Agent->>Brain: brain_feedback (neg, topic)
    Brain-->>Brain: sig #1 in inbox/

    User->>Agent: day 1 — same complaint
    Agent->>Brain: brain_feedback
    Brain-->>Brain: sig #2

    User->>Agent: day 3 — third complaint
    Agent->>Brain: brain_feedback
    Brain-->>Brain: sig #3 (threshold met)

    Note over Dream: day 3 dream pass
    Dream->>Brain: create pref-X status: unconfirmed<br/>(trial: 14 days)
    Dream->>Brain: move sig #1..3 → processed/

    Agent->>Agent: day 5 — produces public blog post
    Agent->>Brain: brain_apply_evidence applied

    Note over Dream: day 5 dream pass
    Dream->>Brain: pref-X status: confirmed,<br/>applied_count=1, confidence=low

    Agent->>Brain: days 6..30 — nine more applied evidences

    Note over Dream: day 30 dream pass
    Dream->>Brain: pref-X applied_count=10,<br/>confidence=high

    Note over Dream: days 31..120 — silence on this topic

    Note over Dream: day 120 dream pass (90 days past last evidence)
    Dream->>Brain: move pref-X → retired/<br/>reason: stale-no-evidence
```

At day 120 the rule has retired itself. The retired note keeps the
full origin (the three signals, the confirmation timestamp, the
ten evidence applications) so its history is auditable forever; only
the active-rule attention budget is freed.

## How a new vault gets bootstrapped

```mermaid
flowchart LR
    User[operator] --> Init([o2b brain init])
    Init --> Skel["Create Brain/inbox, preferences, retired, log, .snapshots"]
    Init --> Yaml[Render Brain/_brain.yaml with defaults]
    Init --> Manual[Render Brain/_BRAIN.md operating manual]
    Init --> Overview[Write AI Wiki/_OPEN_SECOND_BRAIN.md vault overview]
```

`Brain/_brain.yaml` defaults are sensible for most uses; tune them in
place when real usage reveals different timing. `Brain/_BRAIN.md` is
the per-vault contract for agents — agents read it at the top of any
session that interacts with this vault, and `o2b brain init --force`
re-renders it from the current template.

## Where to go next

- **`docs/architecture.md`** — layered system architecture beyond
  Brain (vault model, runtime adapters, configuration model).
- **`docs/plans/2026-05-15-brain-observing-memory.md`** — the design
  document, including the full file-format specs and test strategy.
- **`docs/plans/2026-05-15-brain-roadmap.md`** — trigger-based roadmap
  of future capabilities (`BRAIN-FUT-NNN` entries).
- **`Brain/_BRAIN.md`** (in any initialised vault) — the operating
  manual for agents working with that specific vault.
