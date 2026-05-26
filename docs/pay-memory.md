# Pay Memory

Pay Memory is an audit layer for paid agent actions. The agent makes the paid API call itself (typically through `pay` from [solana-foundation/pay](https://github.com/solana-foundation/pay)); Open Second Brain records the reason, the policy check, the receipt, and any generated asset as plain Markdown inside the vault. It never executes payments and never holds wallet keys.

## Bootstrap

```bash
o2b init-pay-memory --vault /path/to/vault
# -> Brain/payments/{policies,assets,drafts,reports}/ (+ dated YYYY-MM-DD receipt subdirs) and policies/spending.md
```

## Recording a paid call

After running `pay --sandbox curl ...` and capturing the output:

```bash
o2b append-payment-receipt \
  --vault /path/to/vault \
  --service paysponge/fal \
  --status success \
  --reason "Generate one original blog header image" \
  --actual-amount 0.05 --currency USDC \
  --result-ref https://fal-cdn.example/img.png \
  --result-note "Brain/payments/assets/blog-header.md" \
  --raw-output-file /tmp/pay-output.txt

o2b capture-asset \
  --vault /path/to/vault \
  --title "Blog Header: Pay Memory" \
  --service paysponge/fal \
  --result-url https://fal-cdn.example/img.png \
  --source-receipt "Brain/payments/2026-05-10/<receipt-slug>.md"

o2b payment-report --vault /path/to/vault --date 2026-05-10
```

The `--raw-output-file` of a receipt is run through a redactor that masks values for `api_key` / `token` / `secret` / `bearer` / `authorization` / `private_key` / `password` / `passwd` / `pwd` / `credential` / `session_token` in env, YAML, JSON, and HTTP-header shapes. Best-effort only - verify the saved receipt before sharing it externally.

The spending policy at `Brain/payments/policies/spending.md` is read by the agent before each paid call; the MVP does not enforce policy at runtime.

## Machine-readable spending policy (optional)

To enable runtime enforcement, drop a JSON companion at `Brain/payments/policies/spending.json`:

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

Then check before each paid call:

```bash
o2b check-payment-policy --service paysponge/fal --expected-amount 0.05
```

Exit codes are `0` (allowed), `1` (denied), `3` (approval required) so a shell script can branch. The MCP tool `payment_policy_check` returns the same structured decision. If `spending.json` is absent, the check fails open (`has_policy: false`) - existing flows that rely on the Markdown-only policy keep working.

## Approval workflow (optional)

For paid calls that should not happen until a human signs off, Pay Memory ships a pending-payment-request artifact under `Brain/payments/_pending/` with a `pending -> approved/rejected -> consumed` state machine.

Agent side:

```bash
o2b request-payment-approval \
  --service paysponge/fal \
  --reason "Generate one blog header image" \
  --expected-amount 0.05 --currency USDC
# -> Brain/payments/_pending/req-2026-05-10-1000-fal-...md
```

Human side, after reviewing the request file in Obsidian:

```bash
o2b approve-payment-request --id <id> --approved-by <name>
# or
o2b reject-payment-request  --id <id> --rejected-by <name> --reason "..."
```

Agent side, after the approved paid call succeeded and the receipt was saved:

```bash
o2b consume-payment-request --id <id> \
  --receipt "Brain/payments/2026-05-10/<receipt-slug>.md"
```

The MCP-server side mirrors `payment_request_approval`, `payment_request_status` (poll for approval), and `payment_request_consume`.

## Daily Telegram digest via Hermes cron (optional)

`o2b payment-digest --vault <vault> --date <YYYY-MM-DD>` renders a 4-line summary suitable for delivery via Hermes cron `--script --no-agent` jobs. See [`hermes-cron.md`](hermes-cron.md) for the ready-to-paste `hermes cron create` command. The same command can be wrapped by any other scheduler that pipes its stdout to a chat destination - the digest itself is runtime-neutral.

## Installing the `pay` CLI on a Linux VPS

`pay` is the Solana-Foundation payment wrapper that turns a regular HTTP client into one that handles HTTP 402 payment challenges. It is published as a prebuilt static binary on GitHub Releases - no Rust toolchain or Node.js is needed on the host:

```bash
TAG=pay-v0.16.0  # pin a specific release
gh release download "$TAG" -R solana-foundation/pay \
  -p 'pay-x86_64-unknown-linux-gnu.tar.gz' -p 'sha256sums.txt' -D /tmp
cd /tmp && sha256sum -c --ignore-missing sha256sums.txt
tar -xzf pay-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 pay /usr/local/bin/pay
pay --version
```

Sandbox mode (`pay --sandbox curl <url>`) does not require running `pay setup` first - it generates an ephemeral Solana keypair and funds it locally via the Surfpool sandbox RPC. That makes it safe to wire into a CI / e2e test that exercises the full Pay Memory pipeline without spending real funds. See `tests/e2e/pay-memory-sandbox.sh` for a reference run.

For non-sandbox use the local secure storage helper (macOS Keychain, GNOME Keyring, Windows Hello, 1Password) is configured by `pay setup`. Open Second Brain itself never holds wallet keys.

## MCP tool surface

Eight Pay Memory tools, all on the full MCP scope:

| Tool | Purpose |
| --- | --- |
| `payment_memory_init` | Bootstrap `Brain/payments/{policies,assets,drafts,reports}/ (+ dated YYYY-MM-DD receipt subdirs)`. |
| `payment_receipt_append` | Save a redacted Markdown receipt for one paid API call. |
| `asset_capture` | Save a Markdown note for an asset produced by a paid call, linked to its receipt. |
| `payment_report_generate` | Aggregate a date's receipts into a Markdown report under `Brain/payments/reports/`. |
| `payment_policy_check` | Evaluate a prospective paid call against `policies/spending.json`. |
| `payment_request_approval` | Create a pending-payment-request the user must approve. |
| `payment_request_status` | Look up a pending request by id (agent uses this to poll). |
| `payment_request_consume` | Mark an approved request as consumed and link the resulting receipt. |

See [`mcp.md`](mcp.md) for the protocol envelope and lifecycle.
