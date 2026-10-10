/**
 * `src/cli/bootstrap/` barrel (write-side-trust, Task 14).
 *
 * The two operator surfaces this lane owns: `o2b bootstrap` (one
 * idempotent provisioning command per harness) and `o2b mcp token`
 * (the named-token management dispatcher riding the `mcp` command).
 */

export { cmdBootstrap, BOOTSTRAP_EXIT } from "./run.ts";
export { handleMcpTokenCommand, TOKEN_EXIT, MCP_TOKEN_VERBS } from "./token-cli.ts";
export {
  BOOTSTRAP_TARGETS,
  BOOTSTRAP_TARGET_LIST,
  resolveBootstrapTarget,
  tokenNameForTarget,
} from "./targets.ts";
export type { BootstrapMode, BootstrapTarget } from "./targets.ts";
export {
  BOOTSTRAP_SCHEMA_VERSION,
  bootstrapReceiptPath,
  readBootstrapReceipt,
  upsertBootstrapReceiptEntry,
} from "./receipt.ts";
export type { BootstrapReceipt, BootstrapReceiptEntry, BootstrapTokenEntry } from "./receipt.ts";
