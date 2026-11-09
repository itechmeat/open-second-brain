/**
 * The wire codes of the vault adapter's refusals, in a leaf module so the
 * MCP tool contract shares the one definition without importing the
 * adapter's write guards.
 */

/** The refusal code every vault-adapter surface uses without a vault. */
export const VAULT_ADAPTER_REQUIRED_CODE = "vault_required";
