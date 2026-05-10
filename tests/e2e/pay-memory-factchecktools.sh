#!/usr/bin/env bash
#
# Real-data manual e2e for Pay Memory via the Google Fact Check Tools API
# exposed on pay.sh (`solana-foundation/google/factchecktools`).
#
# Why this service:
#   - The endpoint is published in the pay-skills catalog with no `$`
#     marker, i.e. free at the gateway tier — no payment challenge is
#     issued — so we can exercise the full pipeline without spending or
#     even configuring a mainnet wallet.
#   - The upstream is Google's real Fact Check Tools API, so the receipt
#     and asset hold genuine fact-check claims rather than synthetic
#     debugger fixtures.
#
# Usage:
#   bash tests/e2e/pay-memory-factchecktools.sh [vault-dir] [query]
#
#   vault-dir defaults to /tmp/o2b-factchecktools-<ts>
#   query     defaults to "climate change"
#
# To switch to mainnet (real Solana payment when the endpoint actually
# charges):
#   1. Run `pay setup` interactively and fund the resulting account.
#   2. Drop the `--sandbox` flag below.
# Open Second Brain itself never needs to know — the only difference on
# our side is the raw output the receipt embeds.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VAULT=${1:-/tmp/o2b-factchecktools-$(date +%s)}
QUERY=${2:-climate change}
CONFIG=$(mktemp -t o2b-factchecktools-config-XXXXXX.yaml)
RAW_OUTPUT=$(mktemp -t pay-factchecktools-output-XXXXXX.txt)

cleanup() {
  rm -f "$CONFIG" "$RAW_OUTPUT"
}
trap cleanup EXIT

if ! command -v pay >/dev/null 2>&1; then
  echo "error: \`pay\` CLI not found on PATH." >&2
  echo "Install per tests/e2e/pay-memory-sandbox.sh prerequisites." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: \`bun\` CLI not found on PATH (needed by \`o2b\`)." >&2
  exit 1
fi

mkdir -p "$VAULT"
export OPEN_SECOND_BRAIN_CONFIG="$CONFIG"

ENDPOINT="https://factchecktools.google.gateway-402.com/v1alpha1/claims:search"
# URL-encode the query — bash printf + jq -sRr would be heavier; the
# subset we accept ([a-zA-Z0-9 ]+) maps directly via tr.
ENCODED_QUERY=$(printf '%s' "$QUERY" | sed 's/ /+/g')
URL="${ENDPOINT}?query=${ENCODED_QUERY}&languageCode=en&pageSize=5"

echo "==> pay --version"
pay --version

echo "==> pay --sandbox curl ${URL}"
pay --sandbox curl "$URL" 2>&1 | tee "$RAW_OUTPUT"

# Bail early if the upstream returned an error rather than a JSON claims
# payload — keeps the receipt honest about what actually happened.
if ! grep -q '"claims"' "$RAW_OUTPUT"; then
  echo "error: response did not include a \"claims\" field; aborting before saving a receipt." >&2
  exit 1
fi

DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M)

echo
echo "==> o2b init"
bun run "$ROOT/src/cli/main.ts" init \
  --vault "$VAULT" \
  --name "Fact Check E2E" \
  --agent-name "claude-vps-agent" >/dev/null

echo "==> o2b init-pay-memory"
bun run "$ROOT/src/cli/main.ts" init-pay-memory --vault "$VAULT"

echo
echo "==> o2b append-payment-receipt"
bun run "$ROOT/src/cli/main.ts" append-payment-receipt \
  --vault "$VAULT" \
  --service "solana-foundation/google/factchecktools" \
  --status success \
  --reason "Fact-check claims search for \"$QUERY\"" \
  --category fact_check \
  --endpoint "$URL" \
  --expected-cost "\$0.00 (free at gateway)" \
  --actual-amount "0" \
  --currency "USDC" \
  --raw-output-file "$RAW_OUTPUT" \
  --slug "factcheck-${ENCODED_QUERY//+/-}" \
  --date "$DATE" \
  --time "$TIME" \
  --policy-status not_checked

echo
echo "==> o2b capture-asset"
RESULT_URL=$(grep -oE '"url": *"[^"]+"' "$RAW_OUTPUT" | head -1 | sed 's/^"url": *"//; s/"$//')
bun run "$ROOT/src/cli/main.ts" capture-asset \
  --vault "$VAULT" \
  --title "Fact-check claims: $QUERY" \
  --service "solana-foundation/google/factchecktools" \
  --result-url "${RESULT_URL:-https://factchecktools.google.com/}" \
  --source-receipt "AI Wiki/payments/$DATE/factcheck-${ENCODED_QUERY//+/-}.md" \
  --slug "factcheck-${ENCODED_QUERY//+/-}"

echo
echo "==> o2b payment-report"
bun run "$ROOT/src/cli/main.ts" payment-report \
  --vault "$VAULT" \
  --date "$DATE" \
  --title "Fact Check Tools E2E ($DATE)" \
  --task "Verify Pay Memory pipeline against Google factchecktools (real data)"

echo
echo "==> generated files"
find "$VAULT/AI Wiki" -type f | sort

echo
echo "==> done: vault preserved at $VAULT"
echo "Inspect the receipt to see real Google fact-check claims under \"## Raw pay.sh output\"."
