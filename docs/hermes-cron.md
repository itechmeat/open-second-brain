# Hermes cron — daily Pay Memory digest

This guide wires `o2b payment-digest` into [Hermes](https://github.com/NousResearch/hermes-agent)'s built-in cron scheduler so a short daily summary of the previous day's paid actions is delivered to a Telegram topic.

The digest is produced by `o2b payment-digest` itself — pure TypeScript, no LLM in the loop. That gives a deterministic 4-line message regardless of the orchestrator model's mood and avoids the "lazy single-sentence" output mode the gateway default (`combo-orchestrator`) sometimes falls into when the prompt has too many conditionals.

## Prerequisites

- Hermes is installed and the gateway is running (`hermes gateway status`).
- The Open Second Brain plugin is enabled in Hermes (`hermes plugins list | grep open-second-brain`).
- `o2b` is on `PATH` for the user that runs the gateway. If not, run `o2b install-cli` once.
- Your vault is at `/path/to/vault` (the same one the gateway is configured to use).
- You have a Telegram supergroup `chat_id` and a thread/topic id to post to.

## Register the cron job

Hermes cron uses 5-field cron syntax in **UTC**. The example below runs at 06:00 Belgrade summer (= 04:00 UTC):

```bash
hermes cron create \
  --name "pay-memory-daily-digest" \
  --deliver "telegram:<chat_id>:<topic_id>" \
  --workdir "/" \
  --no-agent --script \
  '0 4 * * *' \
  'o2b payment-digest --vault /path/to/vault --date "$(date -u -d yesterday +%F)" --empty-mode silent'
```

Notes:

- `--no-agent --script` makes Hermes shell out to the prompt instead of routing it through the LLM. The prompt's stdout becomes the delivered Telegram message verbatim (because `cron.wrap_response: false` is set in the default Hermes config).
- `--empty-mode silent` makes the command emit `[SILENT]` when no receipts exist for that date. Use `--empty-mode empty` if you'd rather have no output at all (Hermes will then send an empty message — most clients suppress it). Use `--empty-mode summary` to always send a one-liner.
- `--workdir /` is fine; the script doesn't read relative paths.

After creation, verify:

```bash
hermes cron list
hermes cron run pay-memory-daily-digest        # one-shot dry run
```

The first scheduled run will populate `~/.hermes/cron/output/<job_id>/<timestamp>.md` with the prompt + the response (the digest text) Hermes delivered.

## Edit / pause / remove

```bash
hermes cron edit pay-memory-daily-digest --schedule '0 5 * * *'
hermes cron pause pay-memory-daily-digest
hermes cron resume pay-memory-daily-digest
hermes cron remove pay-memory-daily-digest
```

## What the digest looks like

```text
💳 Оплачено сервисов: **2**
💰 Сумма: **0.07 USDC**
📁 Файлы чеков: **2**
🔗 Отчёт: `/root/vault/Brain/payments/reports/payment-report-2026-05-09.md`
```

When there were no receipts the day before, the literal token `[SILENT]` is emitted (or empty / a one-line summary, per `--empty-mode`).

## Standalone shell wrapper (optional)

If you'd rather invoke this from systemd, GitHub Actions, or any non-Hermes scheduler, see [`examples/hermes-payment-digest.sh`](../examples/hermes-payment-digest.sh) — a thin Bash wrapper around `o2b payment-digest` that takes the vault path as `$1`.

---

# Hermes cron — daily Brain digest

`o2b brain digest` renders a short Markdown summary of what the `dream` pass did over a given window: new unconfirmed preferences, confirmations, retirements, confidence shifts, and contradictions. The same wiring as the Pay Memory digest above — `--no-agent --script` ships the markdown verbatim, `--silent-if-empty` suppresses delivery when nothing changed.

## Prerequisites

Same as the Pay Memory digest: Hermes installed, the plugin enabled, `o2b` on `PATH`, vault path known, and a Telegram destination. Additionally, `o2b brain init --vault <path>` must have been run once on the target vault so `Brain/_brain.yaml` exists.

## Register the cron job

The example below fires at 20:00 UTC daily and reports the trailing 24 hours of `Brain/log/`:

```bash
hermes cron create \
  --name "brain-digest-daily" \
  --deliver "telegram:<chat_id>:<topic_id>" \
  --workdir "/" \
  --no-agent --script \
  '0 20 * * *' \
  'o2b brain digest --vault /path/to/vault --silent-if-empty'
```

Notes:

- `--no-agent --script` makes Hermes shell out to the command and deliver its stdout verbatim. `cron.wrap_response: false` (default Hermes config) keeps the framing clean.
- `--silent-if-empty` produces no output AND exits with code `2` when nothing changed in the window; Hermes treats the empty stdout as a no-op and does not push a Telegram message.
- The default window is the trailing 24h. Use `--since <ISO>` / `--until <ISO>` to override.
- Run frequency is up to you; `dream` is idempotent, so a higher-frequency digest does not produce duplicate noise — it only reports new transitions.

## Run, edit, pause, remove

```bash
hermes cron list
hermes cron run brain-digest-daily          # one-shot dry run
hermes cron edit brain-digest-daily --schedule '0 19 * * *'
hermes cron pause brain-digest-daily
hermes cron resume brain-digest-daily
hermes cron remove brain-digest-daily
```

## What the digest looks like

```markdown
# Brain digest — 2026-05-14T20:00Z (24h)

## New (unconfirmed, in trial)

- [[pref-no-internal-abbrev]] — writing, 3 signals, trial ends 2026-05-28
- [[pref-imperative-prompts]] — coding, 4 signals, trial ends 2026-05-28

## Confirmed

- [[pref-prefer-typed-errors]] — coding, first applied in [[src/cli/main.ts]]

## Retired

- [[ret-prefer-bullets-over-prose]] — writing, stale-no-evidence (91 days)

## Confidence shifts

- [[pref-no-internal-abbrev]] medium → high (applied: 11, violated: 0)
```

When `--silent-if-empty` is set and the window has no changes, the command writes nothing to stdout and exits `2` — Hermes posts nothing to the Telegram topic on those days.

## Pairing with the dream pass

`o2b brain digest` is read-only and never runs `dream` on its own. If you want a single nightly job that *first* consolidates and *then* posts the digest, chain them:

```bash
'o2b brain dream --vault /path/to/vault >/dev/null && o2b brain digest --vault /path/to/vault --silent-if-empty'
```

`dream` is itself idempotent — running it on top of an unchanged Brain is a no-op (no log entry written, no snapshot taken). The chained form is safe at any cadence.

## Discipline report (daily logging-discipline sanity-check)

`o2b discipline report` renders a deterministic Telegram MarkdownV2 block comparing brain-event counts per agent (parsed from `Brain/log/<yesterday>.md`) against runtime-agnostic activity proxies (git on watched repos + mtime walk on watched non-repo paths + vault delta on `Brain/inbox|preferences|retired/`). Status is binary - `alert` if taste events (`feedback`+`apply_evidence`) are zero while activity is non-zero, `info` for a quiet day, `ok` otherwise. No LLM in the report path.

`o2b discipline install --vault <v> --telegram-target <target>` writes one cron entry into the Hermes scheduler (job id derived from `sha256(vault)` so multiple vaults on one host do not collide). The configuration block lives in `Brain/_brain.yaml`:

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

When the section is absent or `enabled: false`, the report exits `0` with a stderr note and the cron job stays silent.

A weekly digest variant ships under `--weekly` (Monday 08:59 local timezone by default); `o2b discipline uninstall --weekly` removes only the weekly job, without the flag removes both.
