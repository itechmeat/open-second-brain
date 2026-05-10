/**
 * Machine-readable spending policy (`AI Wiki/policies/spending.json`).
 *
 * Optional, opt-in companion to `spending.md`. When the JSON file is present,
 * it can be evaluated by the agent (or by `o2b check-payment-policy`) before
 * making a paid call to decide whether the call is allowed, requires user
 * approval, or is outright denied.
 *
 * Absence of the JSON file ≡ fail-open (`allowed: true`, `has_policy: false`).
 * The rationale is that the policy MVP is documentation-first; opt-in
 * enforcement should not silently block existing flows that have only the
 * Markdown policy. Once a user creates the JSON file, it becomes
 * authoritative.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateReceipts } from "./report.ts";
import { isoDateNow, payMemoryDirs, validateIsoDate } from "./paths.ts";

export const POLICY_SCHEMA_VERSION = 1;

/**
 * Schema for `AI Wiki/policies/spending.json`. All fields are optional —
 * unspecified rules are interpreted as "no constraint".
 */
export interface PolicyRules {
  readonly schema_version?: number;
  /** Currency code all monetary fields are denominated in (default `USDC`). */
  readonly currency?: string;
  /** Maximum sum of `actual_amount` allowed across receipts on a single date. */
  readonly max_total_per_day?: number;
  /** Maximum amount allowed for a single paid call. */
  readonly max_single_call?: number;
  /** Service identifiers (e.g. `paysponge/fal`) the agent may call. */
  readonly allowed_services?: ReadonlyArray<string>;
  /** Per-category receipt-count caps for one date (e.g. `{ media_generation: 1 }`). */
  readonly max_per_category?: Readonly<Record<string, number>>;
  /** Above this amount the call requires explicit human approval. */
  readonly require_approval_above?: number;
}

export interface PolicyCheckRequest {
  readonly service: string;
  readonly expectedAmount?: number | null;
  readonly currency?: string | null;
  readonly category?: string | null;
  /** Date of the prospective receipt (YYYY-MM-DD). Defaults to today. */
  readonly date?: string | null;
  readonly tz?: string | null;
}

export type PolicyDecisionStatus = "allowed" | "approval_required" | "denied";

export interface PolicyDecision {
  readonly status: PolicyDecisionStatus;
  readonly allowed: boolean;
  readonly approvalRequired: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly rule: string | null;
  readonly hasPolicy: boolean;
  readonly policyPath: string | null;
  readonly currency: string | null;
}

/** Return the absolute path of the JSON policy file. */
export function policyJsonPath(vault: string): string {
  return join(payMemoryDirs(vault).policies, "spending.json");
}

/**
 * Load and validate `policies/spending.json` if it exists. Returns `null`
 * when the file is absent. Throws a descriptive error when present but
 * malformed — refusing to silently degrade to "no policy" if the user
 * intended one and miswrote the JSON.
 */
export function loadPolicyRules(vault: string): PolicyRules | null {
  const target = policyJsonPath(vault);
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (err) {
    // Race-free absent-file handling: try the read first; only translate
    // ENOENT into a `null` return. Other I/O errors (EACCES, EISDIR …)
    // are surfaced so the user sees the real cause.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(
      `failed to read ${target}: ${(err as Error).message ?? String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${target} is not valid JSON: ${(err as Error).message ?? String(err)}`,
    );
  }
  return validatePolicyRules(parsed, target);
}

function validatePolicyRules(value: unknown, source: string): PolicyRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object at the root`);
  }
  const obj = value as Record<string, unknown>;

  const out: Record<string, unknown> = {};

  if ("schema_version" in obj) {
    if (typeof obj["schema_version"] !== "number") {
      throw new Error(`${source}: schema_version must be a number`);
    }
    out["schema_version"] = obj["schema_version"];
  }
  if ("currency" in obj) {
    if (typeof obj["currency"] !== "string") {
      throw new Error(`${source}: currency must be a string`);
    }
    out["currency"] = obj["currency"];
  }
  for (const k of ["max_total_per_day", "max_single_call", "require_approval_above"] as const) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`${source}: ${k} must be a non-negative finite number`);
      }
      out[k] = v;
    }
  }
  if ("allowed_services" in obj) {
    const v = obj["allowed_services"];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      throw new Error(`${source}: allowed_services must be an array of strings`);
    }
    out["allowed_services"] = [...v] as string[];
  }
  if ("max_per_category" in obj) {
    const v = obj["max_per_category"];
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`${source}: max_per_category must be an object`);
    }
    const map: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new Error(
          `${source}: max_per_category.${k} must be a non-negative integer`,
        );
      }
      map[k] = n;
    }
    out["max_per_category"] = map;
  }
  return out as PolicyRules;
}

/**
 * Evaluate a prospective paid call against the loaded policy. Pure function
 * — does not read or write any file. The caller is expected to have already
 * loaded the policy and pre-aggregated today's receipts (or the helper
 * `checkPolicy` below will do both).
 */
export function evaluatePolicy(
  rules: PolicyRules | null,
  request: PolicyCheckRequest,
  context: { readonly daySpend: number; readonly dayCategoryCount: number },
): PolicyDecision {
  if (!rules) {
    return {
      status: "allowed",
      allowed: true,
      approvalRequired: false,
      reasons: [],
      rule: null,
      hasPolicy: false,
      policyPath: null,
      currency: null,
    };
  }

  const reasons: string[] = [];
  let denyRule: string | null = null;
  let approvalRule: string | null = null;
  const policyCurrency = rules.currency ?? "USDC";

  // 1. Allowlist on `service`.
  if (rules.allowed_services && rules.allowed_services.length > 0) {
    if (!rules.allowed_services.includes(request.service)) {
      reasons.push(
        `service ${JSON.stringify(request.service)} is not in allowed_services`,
      );
      denyRule ??= "allowed_services";
    }
  }

  // 2. Currency mismatch — non-fatal, but flagged so caller knows.
  const reqCurrency = request.currency ?? policyCurrency;
  if (request.currency && request.currency !== policyCurrency) {
    reasons.push(
      `request currency ${request.currency} differs from policy ${policyCurrency} — ` +
        "amount-based limits cannot be evaluated; please normalize before checking",
    );
    denyRule ??= "currency_mismatch";
  }

  const amount = typeof request.expectedAmount === "number" ? request.expectedAmount : null;

  // 3. Single-call cap.
  if (
    rules.max_single_call !== undefined &&
    amount !== null &&
    amount > rules.max_single_call
  ) {
    reasons.push(
      `expected amount ${amount} ${reqCurrency} exceeds max_single_call ` +
        `${rules.max_single_call} ${policyCurrency}`,
    );
    denyRule ??= "max_single_call";
  }

  // 4. Day-budget cap (sum of recorded actuals + this expected).
  if (
    rules.max_total_per_day !== undefined &&
    amount !== null &&
    context.daySpend + amount > rules.max_total_per_day
  ) {
    reasons.push(
      `daily spend ${context.daySpend} + ${amount} = ${context.daySpend + amount} ` +
        `exceeds max_total_per_day ${rules.max_total_per_day} ${policyCurrency}`,
    );
    denyRule ??= "max_total_per_day";
  }

  // 5. Per-category count cap.
  if (request.category && rules.max_per_category) {
    const cap = rules.max_per_category[request.category];
    if (cap !== undefined && context.dayCategoryCount >= cap) {
      reasons.push(
        `category '${request.category}' already has ${context.dayCategoryCount} ` +
          `receipt(s) today; cap is ${cap}`,
      );
      denyRule ??= "max_per_category";
    }
  }

  // 6. Approval threshold (soft gate; only marks if otherwise allowed).
  if (
    rules.require_approval_above !== undefined &&
    amount !== null &&
    amount > rules.require_approval_above
  ) {
    approvalRule = "require_approval_above";
    reasons.push(
      `expected amount ${amount} ${reqCurrency} exceeds approval threshold ` +
        `${rules.require_approval_above} ${policyCurrency}`,
    );
  }

  const status: PolicyDecisionStatus = denyRule
    ? "denied"
    : approvalRule
    ? "approval_required"
    : "allowed";

  return {
    status,
    allowed: status === "allowed",
    approvalRequired: status === "approval_required",
    reasons,
    rule: denyRule ?? approvalRule,
    hasPolicy: true,
    policyPath: null, // set by `checkPolicy` wrapper that knows the source
    currency: policyCurrency,
  };
}

/**
 * Top-level convenience: load the policy, aggregate today's receipts to
 * compute spend/count context, and evaluate.
 */
export function checkPolicy(
  vault: string,
  request: PolicyCheckRequest,
): PolicyDecision {
  const rules = loadPolicyRules(vault);
  const date = validateIsoDate(request.date ?? isoDateNow(request.tz));
  const summaries = aggregateReceipts(vault, date);
  const policyCurrency = rules?.currency ?? "USDC";

  let daySpend = 0;
  for (const s of summaries) {
    if (!s.actualAmount) continue;
    if (s.currency && s.currency !== policyCurrency) continue;
    const n = parseFloat(s.actualAmount);
    if (Number.isFinite(n)) daySpend += n;
  }
  const dayCategoryCount = request.category
    ? summaries.filter((s) => s.category === request.category).length
    : 0;

  const decision = evaluatePolicy(rules, request, { daySpend, dayCategoryCount });
  return {
    ...decision,
    policyPath: rules ? policyJsonPath(vault) : null,
  };
}
