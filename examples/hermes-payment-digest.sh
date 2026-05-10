#!/usr/bin/env bash
#
# Pay Memory daily digest wrapper for Hermes cron `--script --no-agent` jobs
# (or any scheduler that captures stdout). Prints a 4-line Telegram-friendly
# summary of yesterday's receipts, or `[SILENT]` when there are none.
#
# Usage:
#   hermes-payment-digest.sh [vault] [date]
#
# `vault` defaults to /root/vault. `date` defaults to yesterday in UTC and is
# accepted in `YYYY-MM-DD` form — useful for backfilling the digest after a
# cron miss.
#
# This script is deliberately thin. All formatting lives inside `o2b
# payment-digest` so the rendered output stays consistent between
# interactive and scheduled invocations.

set -euo pipefail

VAULT=${1:-/root/vault}
DATE=${2:-$(date -u -d 'yesterday' +%F)}

if ! command -v o2b >/dev/null 2>&1; then
  echo "[SILENT]"
  exit 0
fi

o2b payment-digest --vault "$VAULT" --date "$DATE" --empty-mode silent
