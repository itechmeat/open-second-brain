/**
 * Public surface of the Pay Memory layer. CLI and MCP entry points import
 * from this barrel; the underlying modules stay internal so we can move
 * private helpers around without breaking call sites.
 */

// Public path helpers used by CLI / MCP / OpenClaw runtime adapters. The
// internal-only path constructors (`paymentsDateDir`, `receiptPath`,
// `assetPath`, `reportPath`) and date validators stay private to the
// pay-memory package — adapters only need to know about the directory
// roots and the vault-relative renderer.
export {
  payMemoryDirs,
  policyPath,
  vaultRelative as vaultRelativePath,
} from "./paths.ts";
export type { PayMemoryDirs } from "./paths.ts";

export { redactRawOutput, SECRET_KEYS } from "./redactor.ts";

export {
  DEFAULT_POLICY_TEMPLATE,
  writePolicyIfMissing,
  readPolicy,
} from "./policy.ts";
export type { WritePolicyOptions, WritePolicyResult } from "./policy.ts";

export { writeReceipt, RECEIPT_FRONTMATTER_TYPE } from "./receipt.ts";

export { writeAsset, ASSET_FRONTMATTER_TYPE } from "./asset.ts";

export {
  aggregateReceipts,
  writeReport,
  REPORT_FRONTMATTER_TYPE,
} from "./report.ts";

export {
  POLICY_SCHEMA_VERSION,
  policyJsonPath,
  loadPolicyRules,
  evaluatePolicy,
  checkPolicy,
} from "./policy-rules.ts";
export type {
  PolicyRules,
  PolicyCheckRequest,
  PolicyDecision,
  PolicyDecisionStatus,
} from "./policy-rules.ts";

export {
  buildPaymentDigest,
  renderPaymentDigestTelegram,
  DIGEST_SILENT_TOKEN,
} from "./digest.ts";
export type { PaymentDigest, BuildPaymentDigestOptions, RenderDigestOptions } from "./digest.ts";

export {
  PENDING_REQUEST_FRONTMATTER_TYPE,
  pendingDir,
  pendingRequestPath,
  writePendingRequest,
  loadPendingRequest,
  listPendingRequests,
  approvePendingRequest,
  rejectPendingRequest,
  consumePendingRequest,
} from "./approval.ts";
export type {
  RequestStatus,
  PendingRequestInput,
  PendingRequestOutput,
  PendingRequestSummary,
  ListPendingRequestsOptions,
  ApproveOptions,
  RejectOptions,
  ConsumeOptions,
  LoadedPendingRequest,
} from "./approval.ts";

export type {
  ReceiptInput,
  ReceiptOutput,
  AssetInput,
  AssetOutput,
  ReportInput,
  ReportOutput,
  PaymentReceiptSummary,
} from "./types.ts";
