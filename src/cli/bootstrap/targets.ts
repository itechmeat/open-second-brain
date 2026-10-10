/**
 * The bootstrap target table (write-side-trust, Task 14).
 *
 * One command spans the three real install models the design names:
 *
 * - `adapter` - a registered install adapter whose idempotent apply
 *   writes the MCP registration. Wave-1 covers the config-writing
 *   adapters (codex, grok, opencode).
 * - `print` - the `generic` print-and-paste target: the payload is
 *   printed with the manual steps, and no harness config is touched.
 * - `verify-only` - plugin runtimes (claude-code, zcode). They are
 *   deliberately NOT adapter targets (`host-facts.ts`), so bootstrap
 *   writes nothing but the token and the receipt and points at the
 *   plugin's own verification.
 *
 * A target outside this table is refused with the list, exactly as the
 * install verb refuses an unregistered runtime. `claude-code` and
 * `zcode` are bootstrap names, not install-target ids, which is why the
 * table is declared here rather than read off the adapter registry.
 */

export type BootstrapMode = "adapter" | "print" | "verify-only";

export interface BootstrapTarget {
  readonly target: string;
  readonly mode: BootstrapMode;
  readonly label: string;
}

/** Alphabetical: the order the refusal message lists them in. */
export const BOOTSTRAP_TARGETS: ReadonlyArray<BootstrapTarget> = Object.freeze([
  { target: "claude-code", mode: "verify-only", label: "Claude Code (plugin)" },
  { target: "codex", mode: "adapter", label: "Codex CLI" },
  { target: "generic", mode: "print", label: "Generic (print-and-paste)" },
  { target: "grok", mode: "adapter", label: "Grok CLI" },
  { target: "opencode", mode: "adapter", label: "OpenCode" },
  { target: "zcode", mode: "verify-only", label: "ZCode (plugin)" },
]);

/** The `--target` refusal list, spelled once. */
export const BOOTSTRAP_TARGET_LIST = BOOTSTRAP_TARGETS.map((t) => t.target).join(", ");

export function resolveBootstrapTarget(value: string): BootstrapTarget | null {
  return BOOTSTRAP_TARGETS.find((t) => t.target === value) ?? null;
}

/**
 * The per-agent token name bootstrap provisions for a target.
 *
 * `mcp_token_<slug>` with underscores only - the store's name grammar
 * doubles as the `$secret:NAME` body grammar, which admits no dashes -
 * so a dashed target id (claude-code) becomes `mcp_token_claude_code`.
 */
export function tokenNameForTarget(target: string): string {
  return `mcp_token_${target.replaceAll("-", "_")}`;
}
