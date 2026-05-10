#!/usr/bin/env bash
#
# Mainnet end-to-end for Pay Memory via the Google Places API exposed on
# pay.sh (`solana-foundation/google/places`).
#
# Unlike `pay-memory-sandbox.sh` and `pay-memory-factchecktools.sh`, this
# script issues a real Solana mainnet payment — fractions of a cent in
# USDC — and captures the resulting transaction signature into the
# receipt's `payment_proof` frontmatter field.
#
# Prerequisites:
#   - `pay` CLI on PATH.
#   - `bun` CLI on PATH (needed by `o2b`).
#   - A funded mainnet account in `~/.config/pay/accounts.yml`. On a
#     headless server the simplest path is `keystore: ephemeral` with
#     an inline `secret_key_b58` — gnome-keyring is not required.
#   - The account must hold enough USDC to cover the call (the Places
#     `searchText` endpoint costs about $0.001 per request).
#   - SOL is NOT required: the gateway (`places.google.gateway-402.com`)
#     runs in operator-fee-payer mode and pays the Solana transaction
#     fee on the sender's behalf.
#
# Usage:
#   bash tests/e2e/pay-memory-mainnet-places.sh \
#       [vault-dir] [account-name] [yolo-cap-usd] [query]
#
#   vault-dir     defaults to /tmp/o2b-mainnet-places-<ts>
#   account-name  defaults to `work` (must exist in accounts.yml)
#   yolo-cap-usd  defaults to 0.05 (auto-approve any 402 challenge under)
#   query         defaults to "coffee in Belgrade"

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VAULT=${1:-/tmp/o2b-mainnet-places-$(date +%s)}
ACCOUNT=${2:-work}
YOLO_CAP=${3:-0.05}
QUERY=${4:-coffee in Belgrade}
CONFIG=$(mktemp -t o2b-mainnet-places-config-XXXXXX.yaml)
RAW_OUTPUT=$(mktemp -t pay-mainnet-places-output-XXXXXX.txt)

cleanup() {
  rm -f "$CONFIG" "$RAW_OUTPUT"
}
trap cleanup EXIT

if ! command -v pay >/dev/null 2>&1; then
  echo "error: \`pay\` CLI not found on PATH." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: \`bun\` CLI not found on PATH (needed by \`o2b\`)." >&2
  exit 1
fi

mkdir -p "$VAULT"
export OPEN_SECOND_BRAIN_CONFIG="$CONFIG"

ENDPOINT="https://places.google.gateway-402.com/v1/places:searchText"

echo "==> pay --version + account preview"
pay --version
echo
pay account list 2>&1 | grep -A 1 "$ACCOUNT" || true
echo

echo "==> mainnet pay curl (yolo-upto \$$YOLO_CAP)"
pay --mainnet --account "$ACCOUNT" --yolo-upto "$YOLO_CAP" \
  curl -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H 'X-Goog-FieldMask: places.displayName,places.formattedAddress,places.types' \
  -d "$(printf '{"textQuery":"%s","pageSize":3}' "$QUERY")" \
  2>&1 | tee "$RAW_OUTPUT"

if ! grep -q '"places"' "$RAW_OUTPUT"; then
  echo "error: response did not include a \"places\" field; aborting before saving a receipt." >&2
  exit 1
fi

# Discover the tx signature on-chain. The gateway returns the API body
# but not the Solana signature; we look up the most recent tx on the
# sender's address. The first `getSignaturesForAddress` entry is always
# the freshly-finalised payment tx (memo `[12] Operator fee;
# [12] Platform fee` is pay.sh's MPP convention).
PUBKEY=$(pay account list 2>&1 | grep -oE 'mainnet [^]]+' | head -1 | sed 's/^mainnet //')
echo
echo "==> sender pubkey: $PUBKEY"

# Snapshot the most recent signature BEFORE pay curl effects propagate so
# we know which one is new. Skipped here because we already ran pay curl
# above — but `getSignaturesForAddress` on mainnet RPC can lag a few
# seconds behind tx finalisation, so retry a handful of times until a
# previously-unknown signature appears or we time out.
KNOWN=$(curl -sS -X POST -H "Content-Type: application/json" \
  -d "$(printf '{"jsonrpc":"2.0","id":0,"method":"getSignaturesForAddress","params":["%s",{"limit":5}]}' "$PUBKEY")" \
  https://api.mainnet-beta.solana.com 2>&1 |
  python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('result') or [];print(','.join(x['signature'] for x in r))")
TX=""
for attempt in $(seq 1 8); do
  CURRENT=$(curl -sS -X POST -H "Content-Type: application/json" \
    -d "$(printf '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["%s",{"limit":1}]}' "$PUBKEY")" \
    https://api.mainnet-beta.solana.com 2>&1 |
    python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('result') or [];print(r[0]['signature'] if r else '')")
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$(printf '%s' "$KNOWN" | cut -d, -f2-)" ]; then
    # Heuristic: the latest signature changed compared to what was the
    # second-most-recent before — i.e. a new tx landed.
    TX="$CURRENT"
    break
  fi
  sleep 2
done
echo "==> latest tx signature: ${TX:-<none>}"

DATE=$(date -u +%Y-%m-%d)
TIME=$(date -u +%H:%M)

echo
echo "==> o2b init"
bun run "$ROOT/src/cli/main.ts" init \
  --vault "$VAULT" \
  --name "Mainnet Places E2E" \
  --agent-name "claude-vps-agent" >/dev/null

echo "==> o2b init-pay-memory"
bun run "$ROOT/src/cli/main.ts" init-pay-memory --vault "$VAULT"

echo
echo "==> o2b append-payment-receipt (with real tx signature)"
bun run "$ROOT/src/cli/main.ts" append-payment-receipt \
  --vault "$VAULT" \
  --service "solana-foundation/google/places" \
  --status success \
  --reason "Places searchText for \"$QUERY\"" \
  --category place_search \
  --endpoint "$ENDPOINT" \
  --expected-cost "≤\$$YOLO_CAP (yolo cap)" \
  --actual-amount "0.001" \
  --currency "USDC" \
  --payment-proof "${TX:-(signature lookup failed)}" \
  --raw-output-file "$RAW_OUTPUT" \
  --slug "places-$(echo "$QUERY" | tr ' ' '-' | tr -cd 'a-z0-9-')" \
  --date "$DATE" \
  --time "$TIME" \
  --policy-status not_checked

echo
echo "==> o2b capture-asset"
RESULT_NAME=$(grep -oE '"text": *"[^"]+"' "$RAW_OUTPUT" | head -1 | sed 's/^"text": *"//; s/"$//')
SLUG="places-$(echo "$QUERY" | tr ' ' '-' | tr -cd 'a-z0-9-')"
bun run "$ROOT/src/cli/main.ts" capture-asset \
  --vault "$VAULT" \
  --title "Places searchText: $QUERY" \
  --service "solana-foundation/google/places" \
  --result-url "${ENDPOINT}" \
  --source-receipt "AI Wiki/payments/$DATE/$SLUG.md" \
  --slug "$SLUG"

echo
echo "==> o2b payment-report"
bun run "$ROOT/src/cli/main.ts" payment-report \
  --vault "$VAULT" \
  --date "$DATE" \
  --title "Mainnet Places E2E ($DATE)" \
  --task "Real Solana payment via pay.sh against Google Places searchText"

echo
echo "==> generated files"
find "$VAULT/AI Wiki" -type f | sort

echo
echo "==> done: vault preserved at $VAULT"
echo "Solscan: https://solscan.io/tx/${TX:-<none>}"
