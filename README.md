# Open Second Brain

A filesystem-first, agent-owned second brain for Obsidian-compatible
Markdown vaults. Plugs into the agent runtime you already use — Hermes
Agent, Claude Code, OpenAI Codex, OpenClaw, or any MCP-aware client —
and gives it deterministic CLI / MCP / hook surfaces for observing
memory (preference accretion via the `Brain/` layer), wiki indexing,
paid-action audit, and health checks. The model never has to guess at
any of that.

Open Second Brain is **not** a daemon, **not** a vault replacement,
and **not** an LLM-driven knowledge store — the `dream` consolidation
pass is pure deterministic counters. The plugin never writes hidden
state outside the configured vault and config directory.

## How it works

Three loops cooperate over plain Markdown:

- **Capture.** Agents call `brain_feedback` to drop taste signals into
  `Brain/inbox/`.
- **Accretion.** A deterministic `dream` pass clusters repeat signals
  into rules — counters and atomic file moves, no LLM.
- **Application.** Agents log whether each rule was `applied` /
  `violated` / `outdated`, or record a narrative milestone via
  `brain_note` for events that fit neither category. `Brain/active.md`
  is auto-regenerated and injected at session start; `brain_search`
  exposes full-text search across the whole vault.

Every event lands in `Brain/log/<date>.md` (human-facing) plus a
structured `Brain/log/<date>.jsonl` sidecar (machine-facing), written
atomically by one writer so the two stay in lockstep.

```mermaid
flowchart LR
    Agent[Agent / human]
    Agent -- brain_feedback --> Inbox[(Brain/inbox/)]
    Inbox -. dream .-> Pref[(Brain/preferences/)]
    Agent -- brain_apply_evidence --> Log[(Brain/log/)]
    Agent -- brain_note --> Log
    Log -. dream .-> Pref
    Pref -. regenerate .-> Active[Brain/active.md]
    Active -- SessionStart hook --> Agent
    Vault[Vault Markdown] -- o2b search index --> FTS[(SQLite + FTS5<br/>brain_search)]
    FTS --> Agent
```

Mechanics, dream pipeline, state diagram, snapshot model, hygiene
lints, MCP resources, the v0.10.0 search layer, and the full set of
safety invariants are in [`docs/how-it-works.md`](docs/how-it-works.md).

## Supported runtimes

| Runtime         | Integration                                              | Notes                                                                                            |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hermes Agent    | Hermes plugin (`plugin.yaml`) + MCP server               | Adds a per-turn identity reminder via the `pre_llm_call` hook.                                   |
| Claude Code     | Marketplace plugin + bundled `.mcp.json` + lifecycle hooks | `hooks/hooks.json` registers a `PostToolUse` reminder that points the agent at `brain_feedback` / `brain_apply_evidence` after every Write/Edit. See [`hooks/`](hooks/). |
| OpenAI Codex    | Marketplace plugin + MCP server + lifecycle hooks         | Same hook bundle as Claude Code.                                                                 |
| OpenClaw        | Native JS plugin (`openclaw.extensions`) — no MCP needed | Core query/status/health tools are registered directly inside OpenClaw's Node.js process. Native parity with the `brain_*` tools is tracked separately in the post-v0.9 roadmap. |
| Cursor / Aider / opencode / kiro / Copilot CLI / Gemini CLI / Pi | One-shot `o2b install --target <name> --apply` | v0.10.11 multi-runtime orchestrator with idempotent managed block and sidecar manifest. See `install/<name>.md` and `install.md`. |
| Other MCP hosts | Generic adapter (stdio MCP server, persisted plugin config) | `o2b install --target generic --apply --out -` prints the payload; see `install/generic.md`.    |

## What it does

- Bootstraps `Brain/` — the observing-memory layer where the agent
  records taste signals, accreted preferences, evidence, and
  pre-run snapshots.
- Runs a deterministic `dream` pass that turns repeat signals into
  confirmed rules, retires stale ones, and surfaces contradictions
  — no LLM inside the algorithm, only counters, thresholds, and
  atomic file operations. See [Brain section](#brain-observing-memory).
- Regenerates a Markdown page index from frontmatter and wikilinks
  (`o2b index`).
- Exports config snapshots with secret-like values redacted
  (`o2b export-config`).
- Runs vault + adapter health checks (`o2b doctor`, plus
  `o2b brain doctor` for Brain-specific invariants).
- Surfaces vault care signals as one ranked next-step list
  (`o2b brain actions`): page-level duplicates
  (`o2b brain page-dedup`), self-healing structural drift
  (`o2b brain lint --consolidate`), token-budget monitoring
  (`o2b brain token-footprint`), and a bounded-token vault slice
  for priming an agent's context window
  (`o2b brain context-pack --max-tokens N`). Per-page metadata
  (`_lifecycle`, `tier`, `merged_into`) feeds the ranker and the
  search relevance signal.
- Aggregates an operator dashboard from trust verdict, doctor /
  dream counts, verification delta, instruction-file ceiling
  warnings, and top maintenance actions
  (`o2b brain summary` / `brain_operator_summary`). The verdict
  band (`clean | watch | investigate`) is computed from
  structural signals only - no LLM, no per-language vocabulary.
- Exposes the vault as a connected link graph: frontmatter
  `aliases:` resolve transparently into the backlink index;
  every `BacklinkRef` keeps `#heading` / `#^block-id` anchors so
  consumers see paragraph-level intent; raw-text mentions outside
  `[[...]]` surface via `o2b brain unlinked` /
  `brain_unlinked_mentions`; a concept-scoped cluster (target +
  linkers, optionally + unlinked mentions) lands as a
  deterministic JSON envelope via `o2b brain synthesise` /
  `brain_concept_synthesis`; per-MOC coverage audit classifies
  cluster members into well-covered / fragile / candidate-missing
  via `o2b brain moc-audit` / `brain_moc_audit`. Match boundaries
  are Unicode-aware (codepoint class) and the MOC heuristic uses
  link density only - no per-language vocabulary anywhere.
- Layers structured property filters on top of full-text search
  (`o2b search "<query>" --property type=decision --property
  status=open`). The filter applies to frontmatter scalars as a
  post-FTS phase; `additionalProperties` extension on
  `brain_search` mirrors it at the MCP boundary.
- Surfaces a user-authored vault-root instruction file
  (`VAULT.md` by default, configurable via
  `link_graph.vault_instruction_file`) through the `brain_context`
  envelope. Absent file = field omitted; existing hosts stay
  byte-identical.
- Treats time as a first-class axis. The `temporal:` config block
  drives a new `src/core/brain/temporal/` subsystem that
  materializes one `TimelineIndex` per invocation from
  `Brain/log/<date>.jsonl` plus retired/ frontmatter and feeds
  five operator surfaces over the same deterministic projection:
  a chronological event list (`o2b brain timeline` /
  `brain_timeline`), per-preference or per-topic belief evolution
  (`o2b brain evolution` / `brain_belief_evolution`) with running
  evidence counts and retire-chain walking, structural staleness
  reports (`o2b brain stale` / `brain_stale_scan`) using
  configurable per-kind thresholds, a daily brief
  (`o2b brain daily` / `brain_daily_brief`), and a 7-day synthesis
  with contradictions list (`o2b brain weekly` /
  `brain_weekly_synthesis`). All helpers ship deterministic data
  shapes - no LLM call inside. Preference, signal, and retired
  frontmatter grow additive optional `valid_from` / `valid_until`
  / `recorded_at` slots so future write paths can populate the
  bi-temporal axis without breaking existing files.
- (Optional) Records paid agent actions through **Pay Memory**:
  receipts, generated assets, spending policy decisions, human
  approval state, and per-day reports — all as plain Markdown
  inside the vault.

## Install

`install.md` is a short router. Pick the matching per-runtime page
under [`install/`](install/) and follow it end-to-end. The
MCP-aware runtimes share one CLI orchestrator:

```bash
o2b install --target <name> --apply
o2b install --check
```

Supported `--target` values: `cursor`, `aider`, `opencode`, `kiro`,
`copilot-cli`, `gemini-cli`, `pi`, `generic`. Each writes a sidecar
manifest at `<vault>/.open-second-brain/install.lock.json` so
`o2b uninstall --target <name> --apply` removes exactly what was
added.

For runtimes that ship their own plugin/MCP install pipeline
(Hermes, Claude Code, Codex, OpenClaw) the corresponding
`install/<runtime>.md` walks through the runtime-native flow.

First-time-setup users can also run a guided wizard:

```bash
o2b init --interactive
```

The wizard composes `o2b init`, optional `o2b brain init`, and
per-target `o2b install` behind a single linear question/answer
flow with an explicit confirmation gate.

## CLI

After `o2b install-cli` the following commands are on PATH:

```text
o2b status                    Show config / vault status
o2b init                      Bootstrap the vault profile (idempotent)
o2b install-cli               Symlink o2b and o2b-hook into ~/.local/bin
o2b doctor                    Run vault + adapter checks
o2b index                     Rebuild the Markdown page index
o2b export-config             Write a redacted config snapshot
o2b mcp                       Run the MCP tool server (stdio)
o2b tool-call                 Invoke an MCP tool handler from the CLI
o2b uninstall                 Print uninstall plan; --apply-local cleans config; --remove-cli removes symlinks
o2b update                    Update OSB installation across all detected runtimes; --target <name> / --dry-run / --force / --json

# Brain (observing memory)
o2b brain init                Bootstrap Brain/{inbox,preferences,retired,log,.snapshots}/ + _brain.yaml + _BRAIN.md; --starter drops the bundled example set
o2b brain feedback            Record one taste signal (--topic, --signal, --principle, ...)
o2b brain dream               Run the deterministic consolidation pass (idempotent; usually cron'd)
o2b brain apply-evidence      Record applied / violated against a preference for a durable artifact
o2b brain note <text>         Append a one-line narrative milestone to Brain/log/<today>.md (cron / shell mirror of brain_note)
o2b brain digest              Render a Markdown or JSON summary of recent Brain transitions; --window 7d for arbitrary lookback
o2b brain query               Read helper: by preference, by topic, or by log timestamp
o2b brain reject              (CLI-only) Retire a preference; requires --reason "<text>". Subsequent signals on the same topic are suppressed.
o2b brain merge               (CLI-only) Fold one confirmed/quarantine pref into another (<keep> <drop>); --dry-run / --force; drop retires with reason 'merged-into'
o2b brain pin / unpin         (CLI-only) Toggle pinned: true on a preference (exempt from auto-retire)
o2b brain set-primary         (CLI-only) Declare or clear primary_agent in Brain/_brain.yaml (--clear)
o2b brain protect             (CLI-only) Emit / apply native deny rules for Brain/ (--target {claudecode|codex} [--apply])
o2b brain unprotect           (CLI-only) Remove the OSB-managed deny rules for the chosen target
o2b brain snapshot diff       (CLI-only) Read-only diff between two snapshots, or snapshot vs live Brain/
o2b brain rollback            (CLI-only) Restore Brain/ from a pre-dream snapshot (--dry-run previews; drift abort vs --force-rollback)
o2b brain upgrade             (CLI-only) Migrate release-owned files forward (_brain.yaml, _BRAIN.md, _OPEN_SECOND_BRAIN.md); --dry-run / --check / --apply --yes
o2b brain export              Read-only dump of active preferences (--format json|llms-txt [--out <path>] [--force])
o2b brain explorer            (CLI-only) Force-directed HTML graph of Brain/preferences + retired; live HTTP on 127.0.0.1 or --export <path> single-file. Keyboard-accessible listbox + localStorage layout persistence. Double-click a node to open it in Obsidian (live mode).
o2b brain doctor              Check Brain-specific invariants (status-vs-folder, broken wikilinks, …)
o2b brain backlinks           List inbound references to a Brain artifact id
o2b brain scan-inline         Capture `@osb` markers from vault markdown files (Daily/, project notes, …)
o2b brain import-session      Replay signals from a Claude/Codex/Hermes session .jsonl (or directory)
o2b brain import-claude-memory (CLI-only) Import metadata.type=feedback entries from a Claude Code memory directory into Brain/preferences/. --dry-run / --apply, sidecar manifest for idempotency, UPDATE preserves accumulated evidence
o2b brain migrate-frontmatter (CLI-only) Rewrite legacy `status:` keys to `_status:`

# Vault scope (single exclusion policy for every vault walker)
o2b vault status              Walks the vault under the active policy; reports include / exclude counts and which rules fired
o2b vault inspect <relpath>   Point-check one vault-relative path; reports matched rule, source, and whether the path exists on disk

# Discipline (daily logging-discipline cron)
o2b discipline report         Render the daily MarkdownV2 block to stdout (brain-event counts per agent vs git/mtime activity); status ok | info | alert
o2b discipline install        Register the Hermes cron job that delivers the report. --telegram-target is required; --at defaults to "59 4 * * *" UTC; --weekly installs a Monday 08:59 weekly digest
o2b discipline uninstall      Remove the cron job; --weekly removes only the weekly digest, without flag removes both

# Pay Memory
o2b init-pay-memory           Bootstrap AI Wiki/{policies,payments,assets,drafts,reports}/
o2b append-payment-receipt    Save a Markdown receipt for a paid API call
o2b capture-asset             Save a Markdown note for a generated asset
o2b payment-report            Aggregate a date's receipts into a Markdown report
o2b check-payment-policy      Evaluate a paid call against policies/spending.json
o2b request-payment-approval  Create a pending payment request (human must approve)
o2b approve-payment-request   Mark a pending request as approved
o2b reject-payment-request    Mark a pending request as rejected
o2b consume-payment-request   Link an approved request to its resulting receipt
o2b list-pending-payments     List pending / approved / etc. requests
o2b payment-digest            Render a 4-line digest for a date

# Helpers
o2b-hook                      Internal launcher invoked by hooks/hooks.json (Claude Code & Codex)
```

The local checkout can also be used without installing the symlinks
— run commands through `scripts/o2b` and `scripts/vault-log`.

## MCP tool server

The plugin ships an optional stdio MCP server (`o2b mcp`) that
exposes the same deterministic operations as MCP tools:

- **Core (3):** `second_brain_status`, `second_brain_query`,
  `vault_health`.
- **Brain (19):** `brain_feedback`, `brain_dream`,
  `brain_apply_evidence`, `brain_note`, `brain_context`,
  `brain_digest`, `brain_query`, `brain_doctor`, `brain_backlinks`,
  `brain_context_pack`, `brain_unlinked_mentions`,
  `brain_concept_synthesis`, `brain_moc_audit`, `brain_timeline`,
  `brain_belief_evolution`, `brain_stale_scan`,
  `brain_daily_brief`, `brain_weekly_synthesis`,
  `brain_operator_summary`. See the
  [Brain section](#brain-observing-memory) below.
- **Pay Memory (8):** `payment_memory_init`,
  `payment_receipt_append`, `asset_capture`,
  `payment_report_generate`, `payment_policy_check`,
  `payment_request_approval`, `payment_request_status`,
  `payment_request_consume`.

Each runtime registers the server differently — Hermes via
`mcp_servers:` in `~/.hermes/config.yaml`, Codex via `codex mcp add`
(written to `~/.codex/config.toml`), Claude Code automatically through
the plugin-bundled `.mcp.json`, OpenClaw not at all (tools registered
natively). The exact wiring is in `install.md`; the protocol,
schemas, and lifecycle details are in [`docs/mcp.md`](docs/mcp.md).

### Writer split (Claude Code 2.1.121+)

The plugin's `.mcp.json` ships **two** MCP-server entries:

- `open-second-brain` — the full surface (21 tools); subject to
  Claude Code's `MCPSearch` tool-search deferral when MCP
  definitions push the system prompt past 10% of the context window.
- `open-second-brain-writer` — a minimal always-loaded surface of
  four tools: `brain_feedback`, `brain_apply_evidence`, `brain_note`
  (writers) and `brain_context` (read-only pull-bootstrap of
  `Brain/active.md`, v0.10.10). The agent records taste signals,
  evidence events, and milestone notes — and fetches the active
  rule digest at session start in runtimes without a SessionStart
  hook — without a ToolSearch round-trip on every session boot.

Both servers reuse the same backing CLI (`o2b mcp --scope writer`
vs the default `--scope full`). Handlers are byte-identical; the
writer-mode instructions text explicitly tells the agent to prefer
the writer copy over any duplicate the full server still exposes
(both call the same code path).

## Lifecycle hooks (Claude Code & Codex)

The plugin bundles a `hooks/hooks.json` that both runtimes auto-load.
One hook fires per turn:

- **PostToolUse** (matcher `Write|Edit|MultiEdit|apply_patch`) —
  after a file-mutating tool succeeds, injects a short reminder
  pointing the agent at `brain_feedback` (when the turn contained a
  user preference or correction) and `brain_apply_evidence` (when an
  active preference in `Brain/preferences/` scopes to the artifact
  just produced).

Hermes and OpenClaw don't load these hooks — they have their own
per-turn channels. Full design notes:
[`hooks/README.md`](hooks/README.md).

## Brain (observing memory)

Brain is the agent-writable observing-memory layer. Agents record
user preferences as raw taste signals; a deterministic `dream` pass
accretes repeat signals into rules with confidence that grows from
real applications and decays when nothing applies the rule any more.
There is no LLM inside the algorithm — only counters, thresholds,
and `mv` operations.

```bash
o2b brain init --vault /path/to/vault
# → Brain/{inbox,preferences,retired,log,.snapshots}/ plus _brain.yaml and _BRAIN.md

# Record a taste signal (agent or human, mid-conversation):
o2b brain feedback \
  --vault /path/to/vault \
  --topic no-internal-abbrev --signal negative \
  --principle "Do not use internal abbreviations in user-facing copy unless explained first" \
  --agent claude

# After producing a durable artifact, record evidence:
o2b brain apply-evidence \
  --vault /path/to/vault \
  --pref pref-no-internal-abbrev \
  --artifact "[[Daily/2026.05.14#section-blog-post]]" \
  --result applied --agent claude

# Run a dream pass (cron or manual): promotes candidates, retires stale rules:
o2b brain dream --vault /path/to/vault

# Short daily summary (markdown or JSON), suitable for Hermes cron → Telegram:
o2b brain digest --vault /path/to/vault --silent-if-empty
```

The Brain verbs in full: `init`, `feedback`, `dream`,
`apply-evidence`, `digest`, `query`, `reject`, `merge`, `pin`,
`unpin`, `set-primary`, `protect`, `unprotect`, `snapshot diff`,
`rollback`, `upgrade`, `export`, `doctor`, `backlinks`,
`scan-inline`, `import-session`, `import-claude-memory`,
`migrate-frontmatter`, `explorer`. Seven are mirrored as MCP tools
(`brain_*`); the rest are intentionally CLI-only because they
change the protected set, overwrite vault state, or are
operator-only maintenance commands.

### Discipline (daily logging sanity-check)

`o2b discipline report` renders a deterministic Telegram MarkdownV2
block comparing brain-event counts per agent (parsed from
`Brain/log/<yesterday>.md`) against runtime-agnostic activity proxies
(git on watched repos + mtime walk on watched non-repo paths + vault
delta on `Brain/inbox|preferences|retired/`). Status is binary —
`alert` if taste events (`feedback`+`apply_evidence`) are zero while
activity is non-zero, `info` for a quiet day, `ok` otherwise. No LLM
in the report path.

`o2b discipline install --vault <v> --telegram-target <target>`
writes one cron entry into the Hermes scheduler (job id derived from
`sha256(vault)` so multiple vaults on one host do not collide). The
configuration block lives in `Brain/_brain.yaml`:

```yaml
discipline_report:
  enabled: true
  timezone: "Europe/Belgrade"
  watched_paths:
    - "/srv/projects/open-second-brain"
    - "/root/.hermes/plugins"
  known_agents:
    - "@claude-vps-agent"
    - "@codex-vps-agent"
```

When the section is absent or `enabled: false`, the report exits 0
with a stderr note and the cron job stays silent.

### Cross-project setup

When your coding work happens in a project directory that is not the
vault itself, add a pointer snippet to your project's `CLAUDE.md` or
`AGENTS.md` so the agent knows where to read preferences from. The
canonical snippet, the rules for multi-device Syncthing setups, and
the `o2b brain set-primary` invocation are in
[`docs/cross-project-pointer.md`](docs/cross-project-pointer.md).

A vault shared across hosts should declare a single
`primary_agent` in `Brain/_brain.yaml` — the runtime that owns the
dream cron. Dream runs from a different agent emit a non-fatal
warning (stderr for CLI, `warnings` array for MCP) and tag the dream
summary log with `non_primary_agent: <caller>`.

### Capture surfaces

Three independent paths land a signal in `Brain/inbox/`:

- **Live** — the agent calls `brain_feedback` (MCP) or `o2b brain
  feedback` (CLI) the moment the rule is formulated.
- **Inline** — the user (or agent) writes an `@osb` marker into any
  vault markdown file. `o2b brain scan-inline` finds every marker,
  creates the corresponding signal, and annotates the source file
  with `@osb✓ [[sig-...]]` so a re-run is a no-op. Two marker
  shapes: a single line `@osb feedback negative topic=... principle="..."`
  or a fenced ` ```osb` block with YAML inside.
- **Session import** — `o2b brain import-session <path>` reads a
  Claude Code / Codex CLI / Hermes session JSONL and extracts both
  `@osb` markers from message text and replays of `brain_feedback`
  tool-use calls. Useful when MCP wasn't available at recording time
  or the agent didn't make the call live.

All three paths share a normalised payload hash so the same rule
captured twice from different surfaces dedups automatically. Pre-run snapshots of `Brain/` go to `Brain/.snapshots/` and
support `o2b brain rollback <run_id>`. Pinned preferences are exempt
from automatic retire (`stale-no-evidence`, `expired-unconfirmed`,
`rebutted`); only `o2b brain reject` can retire them.

Full design and implementation plan:
[`docs/plans/2026-05-15-brain-observing-memory.md`](docs/plans/2026-05-15-brain-observing-memory.md).
Post-v0.9 trigger-based roadmap:
[`docs/plans/2026-05-15-brain-roadmap.md`](docs/plans/2026-05-15-brain-roadmap.md).
The `brain-memory` skill (loaded automatically) instructs agents when
to call `brain_feedback` and `brain_apply_evidence`.

## Pay Memory

Pay Memory is an audit layer for paid agent actions. The agent makes
the paid API call itself (typically through `pay` from
[solana-foundation/pay](https://github.com/solana-foundation/pay));
Open Second Brain records the reason, the policy check, the receipt,
and any generated asset as plain Markdown inside the vault. It never
executes payments and never holds wallet keys.

```bash
o2b init-pay-memory --vault /path/to/vault
# → AI Wiki/{policies,payments,assets,drafts,reports}/ and policies/spending.md

# After running `pay --sandbox curl …` and capturing the output:
o2b append-payment-receipt \
  --vault /path/to/vault \
  --service paysponge/fal \
  --status success \
  --reason "Generate one original blog header image" \
  --actual-amount 0.05 --currency USDC \
  --result-ref https://fal-cdn.example/img.png \
  --result-note "AI Wiki/assets/blog-header.md" \
  --raw-output-file /tmp/pay-output.txt

o2b capture-asset \
  --vault /path/to/vault \
  --title "Blog Header: Pay Memory" \
  --service paysponge/fal \
  --result-url https://fal-cdn.example/img.png \
  --source-receipt "AI Wiki/payments/2026-05-10/<receipt-slug>.md"

o2b payment-report --vault /path/to/vault --date 2026-05-10
```

The spending policy at `AI Wiki/policies/spending.md` is read by the
agent before each paid call; this MVP does not enforce policy at
runtime. The `--raw-output-file` of a receipt is run through a
redactor that masks values for `api_key` / `token` / `secret` /
`bearer` / `authorization` / `private_key` / `password` / `passwd` /
`pwd` / `credential` / `session_token` in env, YAML, JSON, and
HTTP-header shapes. Best-effort only — verify the saved receipt
before sharing it externally.

### Optional: machine-readable spending policy

To enable runtime enforcement, drop a JSON companion at
`AI Wiki/policies/spending.json`:

```json
{
  "schema_version": 1,
  "currency": "USDC",
  "max_total_per_day": 0.10,
  "max_single_call": 0.07,
  "allowed_services": ["paysponge/fal"],
  "max_per_category": { "media_generation": 1 },
  "require_approval_above": 0.05
}
```

Then have the agent (or the user) run:

```bash
o2b check-payment-policy --service paysponge/fal --expected-amount 0.05
```

Exit codes are `0` (allowed), `1` (denied), `3` (approval required)
so a shell script can branch. The MCP tool `payment_policy_check`
returns the same structured decision. If `spending.json` is absent,
the check fails open (`has_policy: false`) — existing flows that
rely on the Markdown-only policy keep working.

### Optional: approval workflow

For paid calls that should not happen until a human signs off, Pay
Memory ships a pending-payment-request artifact under
`AI Wiki/payments/_pending/` with a
`pending → approved/rejected → consumed` state machine.

Agent side:

```bash
o2b request-payment-approval \
  --service paysponge/fal \
  --reason "Generate one blog header image" \
  --expected-amount 0.05 --currency USDC
# → AI Wiki/payments/_pending/req-2026-05-10-1000-fal-...md
```

Human side, after reviewing the request file in Obsidian:

```bash
o2b approve-payment-request --id <id> --approved-by <name>
# or
o2b reject-payment-request  --id <id> --rejected-by <name> --reason "..."
```

Agent side, after the approved paid call succeeded and the receipt
was saved:

```bash
o2b consume-payment-request --id <id> \
  --receipt "AI Wiki/payments/2026-05-10/<receipt-slug>.md"
```

The MCP-server side mirrors `payment_request_approval`,
`payment_request_status` (poll for approval), and
`payment_request_consume`.

### Optional: daily Telegram digest via Hermes cron

`o2b payment-digest --vault <vault> --date <YYYY-MM-DD>` renders a
4-line Russian summary suitable for delivery via Hermes cron
`--script --no-agent` jobs. See
[`docs/hermes-cron.md`](docs/hermes-cron.md) for the ready-to-paste
`hermes cron create` command. The same command can be wrapped by
any other scheduler that can pipe its stdout to a chat
destination — the digest itself is runtime-neutral.

### Installing the `pay` CLI on a Linux VPS

`pay` is the Solana-Foundation payment wrapper that turns a regular
HTTP client into one that handles HTTP 402 payment challenges. It is
published as a prebuilt static binary on GitHub Releases — no Rust
toolchain or Node.js is needed on the host:

```bash
TAG=pay-v0.16.0  # pin a specific release
gh release download "$TAG" -R solana-foundation/pay \
  -p 'pay-x86_64-unknown-linux-gnu.tar.gz' -p 'sha256sums.txt' -D /tmp
cd /tmp && sha256sum -c --ignore-missing sha256sums.txt
tar -xzf pay-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 pay /usr/local/bin/pay
pay --version
```

Sandbox mode (`pay --sandbox curl <url>`) does **not** require
running `pay setup` first — it generates an ephemeral Solana keypair
and funds it locally via the Surfpool sandbox RPC. That makes it
safe to wire into a CI / e2e test that exercises the full Pay Memory
pipeline without spending real funds. See
`tests/e2e/pay-memory-sandbox.sh` for a reference run.

For non-sandbox use the local secure storage helper (macOS Keychain,
GNOME Keyring, Windows Hello, 1Password) is configured by
`pay setup`. Open Second Brain itself never holds wallet keys.

## Updating

The quickest path is `o2b update` — it detects all installed runtimes,
skips unchanged payloads, applies updates sequentially, and verifies
afterwards. For manual per-runtime updates, follow the matching
`## 7. Update` section in `install.md`:

- Hermes: `hermes plugins update open-second-brain && hermes gateway restart`
- Claude Code: `claude plugin marketplace update open-second-brain && claude plugin update open-second-brain@open-second-brain`
- Codex (Git source): `codex plugin marketplace upgrade open-second-brain`
- Codex (local source): re-add the marketplace; there is no
  `upgrade` for local sources.
- OpenClaw: `openclaw plugins update open-second-brain && openclaw gateway restart`

The CLI symlinks created by `o2b install-cli` point into the cached
plugin checkout and survive in-place updates — no need to re-run
`install-cli`. After an update, run
`o2b doctor --vault /path/to/vault --repo .` to confirm the new
manifest still validates.

The `version` field in each runtime manifest is informational; the
canonical version lives in `package.json` and is mirrored by
`bun run sync-version`.

## Uninstalling

Open Second Brain treats your vault as the source of truth and never
removes Markdown notes, `Daily/`, or `AI Wiki/`. Uninstalling has
three independent layers; do them in this order:

1. Print a plan and review the leftovers (read-only):

   ```bash
   o2b uninstall
   ```

2. Run your runtime's plugin-remove command (see the matching
   `## 8. Uninstall` section in `install.md`), then clean local
   state:

   ```bash
   o2b uninstall --apply-local --remove-cli
   ```

3. Optionally delete the machine-local config directory (typically
   `~/.config/open-second-brain` or `$OPEN_SECOND_BRAIN_CONFIG`'s
   parent) — `--apply-local` handles this and refuses to touch
   anything outside that directory.

The vault is never deleted by the uninstall flow, even with
`--apply-local`. Delete it yourself with normal filesystem tools if
you want to.

## Safety model

- Your notes stay as plain Markdown.
- Secrets are not meant to be stored in the vault. Daily logs and
  config exports go through a best-effort redactor that masks
  common secret-name patterns.
- Daily logs are append-only below `## Raw events`.
- The plugin never starts background processes or daemons. The
  optional MCP server is a stdio subprocess that exits when its
  parent runtime exits.
- Hooks (Claude Code, Codex) only inject text into the agent's
  context. They never write to the vault directly — every Brain
  entry goes through `brain_feedback` / `brain_apply_evidence`
  (MCP) or the equivalent CLI (`o2b brain *`).
- Brain mutations (`o2b brain dream`, `merge`,
  `migrate-frontmatter`, `upgrade`) take an automatic pre-run
  snapshot (`Brain/.snapshots/<run_id>.tar.zst`) before any state
  change. From v0.10.6 the snapshot ships with a SHA-256 sidecar
  manifest (`<run_id>.manifest.json`); `o2b brain rollback`
  compares it against the live tree and aborts with exit 2 on
  drift (typically a Syncthing-delivered edit on another device
  between snapshot and rollback). Pass `--force-rollback` to
  overwrite anyway. Legacy snapshots without sidecar fall back to
  the pre-v0.10.6 direct-restore path with a stderr warning.
  Retention is configurable in `_brain.yaml`.

## Partner tools

OSB stays in the vault / Brain / prose lane. When the user works on
code next to the vault, the agent benefits from a complementary index
over the source - call graphs, callers, callees, impact. The
[codegraph](https://github.com/colbymchenry/codegraph) CLI and its
stdio MCP server cover that surface. OSB detects codegraph through
`o2b doctor` (a `code_graph` line appears when a code project is in
scope) and ships an agent-facing playbook at
`skills/codegraph-partner/SKILL.md` that tells the agent when to
recommend installation and how to disambiguate `codegraph_*` vs
`brain_*` queries. OSB never installs, initializes, or writes data
for codegraph - that stays in codegraph's own installer.

## Repository

GitHub: <https://github.com/itechmeat/open-second-brain>

License: MIT.
