#!/usr/bin/env bash
#
# Manual end-to-end smoke test for Pay Memory against the real `pay` CLI in
# sandbox mode. Hits the free `https://debugger.pay.sh/mpp/quote/AAPL` endpoint
# (sandbox spends no real funds) and walks the full o2b pipeline:
#
#   pay --sandbox curl  →  o2b init-pay-memory
#                       →  o2b append-payment-receipt --raw-output-file
#                       →  o2b capture-asset
#                       →  o2b payment-report
#
# This script is NOT wired into `bun test` — running it requires the `pay`
# binary on PATH and outbound HTTPS to the pay.sh debugger and Surfpool RPC.
# See README "Pay Memory" and CHANGELOG 0.8.0 for context.
#
# Usage:
#   bash tests/e2e/pay-memory-sandbox.sh [vault-dir]
#
# If no vault-dir is given, a fresh /tmp/o2b-e2e-vault-<ts> is used.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VAULT=${1:-/tmp/o2b-e2e-vault-$(date +%s)}
CONFIG=$(mktemp -t o2b-e2e-config-XXXXXX.yaml)
RAW_OUTPUT=$(mktemp -t pay-sandbox-output-XXXXXX.txt)

cleanup() {
  rm -f "$CONFIG" "$RAW_OUTPUT"
}
trap cleanup EXIT

if ! command -v pay >/dev/null 2>&1; then
  echo "error: \`pay\` CLI not found on PATH." >&2
  echo "Install with:" >&2
  echo "  gh release download pay-v0.16.0 -R solana-foundation/pay \\" >&2
  echo "    -p 'pay-x86_64-unknown-linux-gnu.tar.gz' -D /tmp" >&2
  echo "  tar -xzf /tmp/pay-x86_64-unknown-linux-gnu.tar.gz -C /tmp" >&2
  echo "  sudo install -m 0755 /tmp/pay /usr/local/bin/pay" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: \`bun\` CLI not found on PATH (needed by \`o2b\`)." >&2
  echo "Install from https://bun.sh — e.g. \`curl -fsSL https://bun.sh/install | bash\`," >&2
  echo "then re-run this script. Open Second Brain requires Bun >= 1.1.0." >&2
  exit 1
fi

mkdir -p "$VAULT"
export OPEN_SECOND_BRAIN_CONFIG="$CONFIG"

echo "==> pay --version"
pay --version

echo "==> sandbox call to pay.sh debugger (free)"
pay --sandbox curl https://debugger.pay.sh/mpp/quote/AAPL 2>&1 | tee "$RAW_OUTPUT"

echo
echo "==> o2b init"
bun run "$ROOT/src/cli/main.ts" init \
  --vault "$VAULT" \
  --name "Pay Memory E2E" \
  --agent-name "hermes-vps-agent" >/dev/null

echo "==> o2b init-pay-memory"
bun run "$ROOT/src/cli/main.ts" init-pay-memory --vault "$VAULT"

DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M)

echo
echo "==> o2b append-payment-receipt"
bun run "$ROOT/src/cli/main.ts" append-payment-receipt \
  --vault "$VAULT" \
  --service "debugger.pay.sh/mpp" \
  --status success \
  --reason "Sandbox quote for AAPL via pay.sh debugger" \
  --category market_data \
  --endpoint "https://debugger.pay.sh/mpp/quote/AAPL" \
  --expected-cost '$0.00 (sandbox)' \
  --actual-amount "0" \
  --currency "USDC" \
  --raw-output-file "$RAW_OUTPUT" \
  --slug "aapl-quote-sandbox" \
  --date "$DATE" \
  --time "$TIME"

echo
echo "==> o2b capture-asset"
bun run "$ROOT/src/cli/main.ts" capture-asset \
  --vault "$VAULT" \
  --title "AAPL Quote (sandbox)" \
  --service "debugger.pay.sh/mpp" \
  --result-url "https://debugger.pay.sh/mpp/quote/AAPL" \
  --source-receipt "AI Wiki/payments/$DATE/aapl-quote-sandbox.md" \
  --slug "aapl-quote-sandbox"

echo
echo "==> o2b payment-report"
bun run "$ROOT/src/cli/main.ts" payment-report \
  --vault "$VAULT" \
  --date "$DATE" \
  --title "Pay Memory E2E Sandbox Demo" \
  --task "Verify Pay Memory pipeline against pay.sh sandbox debugger"

echo
echo "==> generated files"
find "$VAULT/AI Wiki" -type f | sort

echo
echo "==> done: vault preserved at $VAULT"
