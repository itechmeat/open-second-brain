# Pay Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a memory/audit layer for paid agent actions to OpenSecondBrain. The agent (Hermes / Claude Code / Codex / OpenClaw) makes paid API calls through `pay.sh`; OpenSecondBrain records the reason, the policy check, the receipt, the generated asset, and a per-task report — all as plain Markdown inside the configured vault.

**Non-goals (MVP):** OpenSecondBrain never executes payments, never holds wallet keys, never enforces budgets at runtime. The spending policy is a Markdown document that the agent reads before paying. Reference: `Projects/open-second-brain/pay-memory.md` in the planning vault.

**Tech stack:** TypeScript on Bun, no new runtime dependencies. Reuses `core/vault.ts` (`writeFrontmatter`, `slugify`), `core/fs-atomic.ts` (`atomicWriteFileSync`), `core/config.ts` (vault/agent/timezone resolution), `cli/argparse.ts`, `mcp/tools.ts` (`ToolDefinition`, `coerceStr`, `ensureInsideVault`).

**Release:** Single PR on `feature/v0.8.0-pay-memory` → `main`. Version bump to `v0.8.0`. Hermetic Bun tests only — no real `pay --sandbox curl` in CI.

---

## Architecture summary

Three layers, in order of dependency:

1. **`src/core/pay-memory/`** — pure helpers: dated paths, slug generation, frontmatter writer wrappers, redactor for `raw_output`, policy template renderer, report aggregator. No I/O concerns leak into CLI/MCP.
2. **`src/cli/main.ts`** — four new subcommands wired into the existing dispatcher: `init-pay-memory`, `append-payment-receipt`, `capture-asset`, `payment-report`.
3. **`src/mcp/tools.ts`** — four new tools mirroring the CLI: `payment_memory_init`, `payment_receipt_append`, `asset_capture`, `payment_report_generate`. Same `ServerContext`, same `coerceStr` validation, same handler shape.

The vault layout this feature creates (relative to `<vault>`):

```text
AI Wiki/
  policies/
    spending.md
  payments/
    YYYY-MM-DD/
      <receipt-slug>.md
  assets/
    <asset-slug>.md
  drafts/                     # written by the agent via existing tools
  reports/
    <report-slug>.md
```

`drafts/` is mentioned for completeness — the agent writes blog drafts through the existing `second_brain_capture` tool (or directly), so this feature does not need a dedicated command for it.

**Date format note:** payment subdirectories use `YYYY-MM-DD` (hyphenated, ISO-style), matching the spec. This intentionally differs from `Daily/YYYY.MM.DD.md` used by the event log — the two layouts are independent.

---

## File structure

- Create `src/core/pay-memory/index.ts` — re-exports the public API of the package.
- Create `src/core/pay-memory/paths.ts` — `payMemoryDirs(vault)`, `receiptPath(vault, date, slug)`, `assetPath(vault, slug)`, `reportPath(vault, slug)`.
- Create `src/core/pay-memory/policy.ts` — `DEFAULT_POLICY_TEMPLATE` constant, `writePolicyIfMissing(vault, opts)`.
- Create `src/core/pay-memory/redactor.ts` — `redactRawOutput(text)` regex-based replacer.
- Create `src/core/pay-memory/receipt.ts` — `RECEIPT_FRONTMATTER_TYPE`, `writeReceipt(vault, input)`, returns `{ path, slug, date }`.
- Create `src/core/pay-memory/asset.ts` — `writeAsset(vault, input)`, returns `{ path, slug }`.
- Create `src/core/pay-memory/report.ts` — `aggregateReceipts(vault, date)`, `writeReport(vault, input)`, returns `{ path, slug, receipts_used }`.
- Create `src/core/pay-memory/types.ts` — shared input/output interfaces (`ReceiptInput`, `AssetInput`, `ReportInput`, `PaymentReceiptSummary`).
- Modify `src/cli/main.ts` — add `cmdInitPayMemory`, `cmdAppendPaymentReceipt`, `cmdCaptureAsset`, `cmdPaymentReport`; extend the `switch` and `HELP` text.
- Modify `src/mcp/tools.ts` — add four tool definitions to `buildToolTable()`.
- Modify `src/mcp/instructions.ts` — append a short paragraph describing the new tools so the LLM discovers them on `initialize`.
- Create `tests/core/pay-memory.paths.test.ts`.
- Create `tests/core/pay-memory.redactor.test.ts`.
- Create `tests/core/pay-memory.policy.test.ts`.
- Create `tests/core/pay-memory.receipt.test.ts`.
- Create `tests/core/pay-memory.asset.test.ts`.
- Create `tests/core/pay-memory.report.test.ts`.
- Create `tests/cli/pay-memory.test.ts` — exercises all four subcommands end-to-end via `main(argv)`.
- Create `tests/mcp/pay-memory.test.ts` — exercises all four MCP tools via `MCPServer.callTool`.
- Modify `README.md` — add a `## Pay Memory` section with the same usage block.
- Modify `docs/mcp.md` — list the four new tools and their input schemas.
- Modify `CHANGELOG.md` — add a `## [0.8.0] - 2026-05-10` section (no `Unreleased`).
- Modify `package.json`, `plugin.yaml`, `pyproject.toml`, `openclaw.plugin.json` — version bump to `0.8.0` (sync via `bun run sync-version`).

---

## Public API of `core/pay-memory`

### `paths.ts`

```ts
export interface PayMemoryDirs {
  readonly policies: string;   // <vault>/AI Wiki/policies
  readonly payments: string;   // <vault>/AI Wiki/payments
  readonly assets: string;     // <vault>/AI Wiki/assets
  readonly drafts: string;     // <vault>/AI Wiki/drafts
  readonly reports: string;    // <vault>/AI Wiki/reports
}

export function payMemoryDirs(vault: string): PayMemoryDirs;
export function policyPath(vault: string): string;          // policies/spending.md
export function paymentsDateDir(vault: string, date: string): string;
export function receiptPath(vault: string, date: string, slug: string): string;
export function assetPath(vault: string, slug: string): string;
export function reportPath(vault: string, slug: string): string;

/** Validate `YYYY-MM-DD`. Throws on bad input. */
export function validateIsoDate(value: string): string;
```

### `policy.ts`

`DEFAULT_POLICY_TEMPLATE` is a generic placeholder per the user's existing memory rule (don't ship templates that pin specific services). The body lists the structure the agent must satisfy, lists `# allowed_services:` and `# max_*` placeholders, and includes one commented-out `paysponge/fal` example so demo users know how to fill it in.

```ts
export const DEFAULT_POLICY_TEMPLATE: string;

export interface WritePolicyResult {
  readonly path: string;
  readonly created: boolean;     // false when file existed and overwrite=false
  readonly overwritten: boolean;
}

export function writePolicyIfMissing(
  vault: string,
  opts?: { readonly overwrite?: boolean }
): WritePolicyResult;
```

### `redactor.ts`

Six case-insensitive patterns matched in `key=value`, `key: value`, and JSON `"key": "value"` shapes. Each match keeps the key and replaces the value with `***REDACTED***`.

```ts
export const SECRET_KEYS: ReadonlyArray<string>; // api_key, token, secret, bearer, authorization, private_key
export function redactRawOutput(text: string): string;
```

### `receipt.ts`

```ts
export const RECEIPT_FRONTMATTER_TYPE = "agent-payment-receipt";

export interface ReceiptInput {
  readonly agent: string;
  readonly service: string;        // e.g. "paysponge/fal"
  readonly status: string;         // "success" | "failed" | ...
  readonly reason: string;
  readonly category?: string;
  readonly endpoint?: string;
  readonly expectedCost?: string;
  readonly actualAmount?: string;
  readonly currency?: string;
  readonly paymentProof?: string;
  readonly resultRef?: string;
  readonly resultNote?: string;    // wikilink target
  readonly rawOutput?: string;     // run through redactRawOutput before write
  readonly slug?: string;          // optional override
  readonly date?: string;          // YYYY-MM-DD; default = today (vault tz)
  readonly time?: string;          // HH:MM (24h); default = now (vault tz)
  readonly overwrite?: boolean;
}

export interface ReceiptOutput {
  readonly path: string;           // absolute
  readonly relativePath: string;   // vault-relative
  readonly slug: string;
  readonly date: string;
  readonly created: string;        // ISO Z timestamp written into frontmatter
}

export function writeReceipt(vault: string, input: ReceiptInput): ReceiptOutput;
```

Frontmatter example (matches spec §6.2):

```yaml
type: agent-payment-receipt
agent: hermes-main
payment_layer: pay.sh
network: solana
service: paysponge/fal
category: media_generation
status: success
created: 2026-05-10T17:20:00Z
```

The body is a deterministic Markdown template with the same section headings as the spec (`## Why this paid call was made`, `## Spending policy check`, `## Expected cost`, `## Request`, `## Payment`, `## Result`, `## Raw pay.sh output`). Optional fields render as `_(not provided)_` rather than being skipped, so the receipt is uniformly searchable.

Slug generation: `slug = input.slug ?? slugify(`${service.replace("/", "-")}-${reason}`)`. Reuses `core/vault.ts:slugify`.

### `asset.ts`

Same shape as receipt but for `AI Wiki/assets/<slug>.md`. Frontmatter: `type: generated-asset`, `source`, `source_receipt` (wikilink), `created`. Body has `## Purpose`, `## Prompt`, `## Result`, `## Notes`.

### `report.ts`

```ts
export interface PaymentReceiptSummary {
  readonly path: string;            // vault-relative
  readonly service: string;
  readonly status: string;
  readonly actualAmount?: string;
  readonly currency?: string;
  readonly resultRef?: string;
  readonly resultNote?: string;
}

export function aggregateReceipts(vault: string, date: string): PaymentReceiptSummary[];

export interface ReportInput {
  readonly date: string;
  readonly title?: string;
  readonly task?: string;
  readonly slug?: string;
  readonly overwrite?: boolean;
}

export interface ReportOutput {
  readonly path: string;
  readonly relativePath: string;
  readonly slug: string;
  readonly receiptsUsed: number;
}

export function writeReport(vault: string, input: ReportInput): ReportOutput;
```

`aggregateReceipts` reads every `.md` file under `AI Wiki/payments/<date>/`, parses frontmatter via `core/vault.ts:parseFrontmatter`, extracts the documented fields (best-effort — fields missing from frontmatter are inferred from the body via simple regex on the section headings the receipt writer just emitted). Tests pin both happy path and missing-field shapes.

---

## CLI commands

Each command lives in `src/cli/main.ts` next to existing handlers. They follow the same pattern: `parseFlags(rest, schema)` → core helper → human-readable stdout (or `--json`) → exit code. All commands accept `--vault` and fall back to `requireVault(flags.vault, defaultConfigPath())`.

### `o2b init-pay-memory`

Flags: `--vault`, `--agent` (default = `resolveAgentName(config)`), `--overwrite`.

Behavior:
- Creates `AI Wiki/{policies,payments,assets,drafts,reports}` (idempotent).
- Writes `AI Wiki/policies/spending.md` from `DEFAULT_POLICY_TEMPLATE` only if missing or `--overwrite`.
- Returns JSON to stdout when `--json` is set; otherwise human summary listing created/skipped paths.

### `o2b append-payment-receipt`

Required: `--service`, `--status`, `--reason`. Optional: `--vault`, `--agent`, `--category`, `--endpoint`, `--expected-cost`, `--actual-amount`, `--currency`, `--payment-proof`, `--result-ref`, `--result-note`, `--raw-output-file`, `--slug`, `--date`, `--time`, `--overwrite`, `--json`.

Behavior:
- Reads `--raw-output-file` if provided (UTF-8); pipes through `redactRawOutput` before passing to `writeReceipt`.
- Refuses to overwrite without `--overwrite`; matches existing `init` command exit conventions.
- Stdout: `created: <relative-path>` (or JSON with `{ path, slug, date, created }`).
- **Does not** write to `Daily/`. The agent calls `event_log_append` separately.

### `o2b capture-asset`

Required: `--title`, `--service`, `--result-url`. Optional: `--source-receipt`, `--prompt-file`, `--used-in`, `--slug`, `--overwrite`, `--json`.

Behavior: identical pattern to `append-payment-receipt`, calls `writeAsset`.

### `o2b payment-report`

Required: `--date`. Optional: `--title`, `--task`, `--slug`, `--overwrite`, `--json`.

Behavior: aggregates receipts for `--date`, renders the report Markdown, writes to `AI Wiki/reports/<slug>.md`.

### Help text

`HELP` constant in `src/cli/main.ts` gains a `Pay Memory` group:

```
Pay Memory:
  init-pay-memory          Bootstrap policies/, payments/, assets/, drafts/, reports/
  append-payment-receipt   Save a Markdown receipt for a paid API call
  capture-asset            Save a Markdown note for a generated asset
  payment-report           Generate a daily payment report from existing receipts
```

---

## MCP tools

Added to `buildToolTable()` in `src/mcp/tools.ts`. Each tool reuses `coerceStr`, `coerceStrList`, `ensureInsideVault`, and the same `ServerContext` resolved at server startup. JSON Schema mirrors the CLI flags exactly, so an agent can move between CLI and MCP without rebuilding its mental model.

| Tool | Required args | Optional args |
| --- | --- | --- |
| `payment_memory_init` | — | `agent`, `overwrite` |
| `payment_receipt_append` | `service`, `status`, `reason` | `agent`, `category`, `endpoint`, `expected_cost`, `actual_amount`, `currency`, `payment_proof`, `result_ref`, `result_note`, `raw_output`, `slug`, `date`, `time`, `overwrite` |
| `asset_capture` | `title`, `service`, `result_url` | `source_receipt`, `prompt`, `used_in`, `slug`, `overwrite` |
| `payment_report_generate` | `date` | `title`, `task`, `slug`, `overwrite` |

`raw_output` arrives as a string (CLI uses `--raw-output-file`; MCP receives the content directly). The redactor runs in the core helper, not the tool layer — that keeps both surfaces consistent.

`src/mcp/instructions.ts` gains one paragraph after the existing tool list:

> **Pay Memory tools.** When the agent makes a paid API call through pay.sh (or any other payment layer), call `payment_memory_init` once per vault to bootstrap the layout, `payment_receipt_append` to record the call, `asset_capture` for generated outputs, and `payment_report_generate` to produce a daily report. These tools never execute payments — they only persist memory. After a successful paid call, also append a daily event with `event_log_append` so the receipt is discoverable from `Daily/`.

---

## Redaction

`redactRawOutput` runs over the raw payment output before it lands on disk, replacing values for these keys (case-insensitive):

- `api_key`, `apikey`, `api-key`
- `token`, `access_token`, `refresh_token`, `bearer`
- `secret`, `client_secret`
- `authorization` (HTTP header)
- `private_key`

Recognised shapes:

- `key=value` (env-style)
- `key: value` (YAML / log lines)
- `"key": "value"` (JSON)
- `Authorization: Bearer <token>` (HTTP header)

The replacement is the literal string `***REDACTED***`. Tests pin all four shapes plus a "no false positive" case (`description: secret recipe` is not matched because the value is not a credential pattern — we only replace within the recognized assignment forms).

This is best-effort. The receipt body keeps the disclaimer that the agent must visually inspect raw output before sharing externally.

---

## Tests

All Bun-native (`bun test`), hermetic — each test creates a tmp vault under `Bun.tempDir()` (or `mkdtempSync`) and asserts on filesystem state. Test naming mirrors the existing `tests/core/`, `tests/cli/`, `tests/mcp/` layout.

Coverage targets:

- `pay-memory.paths.test.ts` — `payMemoryDirs`, `receiptPath`, `validateIsoDate` (good and bad inputs).
- `pay-memory.redactor.test.ts` — all four shapes, no-false-positive case, multi-line input.
- `pay-memory.policy.test.ts` — first-run creation, idempotent re-run, `--overwrite` behavior.
- `pay-memory.receipt.test.ts` — happy path, slug auto-generation, overwrite refusal, raw_output redaction, `--date` override.
- `pay-memory.asset.test.ts` — happy path, source_receipt wikilink rendering, overwrite refusal.
- `pay-memory.report.test.ts` — aggregates two receipts under a date, ignores non-`.md` files, missing-frontmatter graceful handling.
- `pay-memory.test.ts` (CLI) — full flow: `init-pay-memory` → `append-payment-receipt` → `capture-asset` → `payment-report`, asserts file paths and exit codes for each.
- `pay-memory.test.ts` (MCP) — same flow via `server.callTool(name, args)`, asserts `structuredContent` and `isError`.

CI matrix: `bun run typecheck && bun test`. Existing CI workflow already runs both — no workflow change.

---

## Step-by-step task list

### Task 1: Core helpers

**Files:**
- Create: `src/core/pay-memory/index.ts`, `paths.ts`, `policy.ts`, `redactor.ts`, `receipt.ts`, `asset.ts`, `report.ts`, `types.ts`
- Create: `tests/core/pay-memory.paths.test.ts`, `pay-memory.redactor.test.ts`, `pay-memory.policy.test.ts`, `pay-memory.receipt.test.ts`, `pay-memory.asset.test.ts`, `pay-memory.report.test.ts`

- [ ] **Step 1: scaffold `core/pay-memory/` modules and types.**
- [ ] **Step 2: implement `paths.ts` and pin behavior with tests.**
- [ ] **Step 3: implement `redactor.ts` and pin all shapes with tests.**
- [ ] **Step 4: implement `policy.ts` (template + `writePolicyIfMissing`) with tests.**
- [ ] **Step 5: implement `receipt.ts` with deterministic body renderer; tests cover slug, frontmatter, overwrite, redaction integration.**
- [ ] **Step 6: implement `asset.ts`; tests cover wikilink rendering and overwrite.**
- [ ] **Step 7: implement `report.ts` (`aggregateReceipts` + `writeReport`); tests cover multi-receipt aggregation and missing-field tolerance.**

### Task 2: CLI commands

**Files:**
- Modify: `src/cli/main.ts`
- Create: `tests/cli/pay-memory.test.ts`

- [ ] **Step 8: extend `HELP` with the Pay Memory group; wire dispatcher cases.**
- [ ] **Step 9: implement `cmdInitPayMemory`; assert via CLI test.**
- [ ] **Step 10: implement `cmdAppendPaymentReceipt`; CLI test covers `--raw-output-file` redaction path.**
- [ ] **Step 11: implement `cmdCaptureAsset`; CLI test covers `--prompt-file` and overwrite refusal.**
- [ ] **Step 12: implement `cmdPaymentReport`; CLI test covers `--date` aggregation across two receipts.**

### Task 3: MCP tools

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/instructions.ts`
- Create: `tests/mcp/pay-memory.test.ts`

- [ ] **Step 13: add four `ToolDefinition` entries to `buildToolTable()` mirroring the CLI inputs.**
- [ ] **Step 14: extend `instructions.ts` with the Pay Memory paragraph.**
- [ ] **Step 15: MCP test runs end-to-end: `payment_memory_init` → `payment_receipt_append` → `asset_capture` → `payment_report_generate`.**

### Task 4: Docs and release

**Files:**
- Modify: `README.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json`, `plugin.yaml`, `pyproject.toml`, `openclaw.plugin.json`

- [ ] **Step 16: README — add `## Pay Memory` section with CLI usage block, link to spec, and security note.**
- [ ] **Step 17: `docs/mcp.md` — append the four new tools with their input schemas.**
- [ ] **Step 18: `CHANGELOG.md` — add `## [0.8.0] - 2026-05-10` with concrete bullets (no `Unreleased`).**
- [ ] **Step 19: bump version to `0.8.0`; run `bun run sync-version` to propagate to `plugin.yaml`, `pyproject.toml`, `openclaw.plugin.json`.**
- [ ] **Step 20: run `bun run typecheck && bun test` end-to-end and confirm green.**

### Task 5: PR

- [ ] **Step 21: create branch `feature/v0.8.0-pay-memory`, commit, push, open PR against `main` titled `feat: pay-memory layer (v0.8.0)`.**

---

## Open questions deferred to future work (not in this PR)

- _All listed deferred items have since landed in v0.8.0 except those
  explicitly excluded below; see CHANGELOG.md for the final scope._
- Out of scope for this project: on-chain anchoring of vault hashes
  (Solana memo, web3 RPC). Pay Memory records `payment_proof` strings
  opaquely; the audit trail is the vault itself.
