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
🔗 Отчёт: `/root/vault/AI Wiki/reports/payment-report-2026-05-09.md`
```

When there were no receipts the day before, the literal token `[SILENT]` is emitted (or empty / a one-line summary, per `--empty-mode`).

## Standalone shell wrapper (optional)

If you'd rather invoke this from systemd, GitHub Actions, or any non-Hermes scheduler, see [`examples/hermes-payment-digest.sh`](../examples/hermes-payment-digest.sh) — a thin POSIX-shell wrapper around `o2b payment-digest` that takes the vault path as `$1`.
