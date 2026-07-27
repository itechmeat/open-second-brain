/**
 * The `link_graph:` block — the MOC-audit thresholds and the name of the
 * user-authored vault-root instruction file.
 *
 * One reason to change: how a hub note is recognised structurally. Both
 * thresholds are counts and ratios over `[[…]]` links - there is no
 * vocabulary detection of "this looks like a MOC".
 */

import type {
  BrainConfig,
  BrainLinkGraphConfig,
  ResolvedBrainLinkGraphConfig,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "link_graph";

/**
 * Default `link_graph` block (v0.10.17). Absent from `_brain.yaml`
 * (or with absent individual keys) falls back here via
 * `resolveLinkGraph`. Both knobs are purely structural - no
 * vocabulary detection of "this looks like a MOC".
 *
 * Defaults:
 *   - `moc_min_outbound_links: 5` - the heuristic floor for "this
 *     is a hub note", chosen to filter out prose notes with a few
 *     inline references.
 *   - `moc_min_link_ratio: 0.3` - 30 % of the body's non-whitespace
 *     characters must sit inside `[[…]]` for the audit to accept
 *     the note as a MOC. Prose notes typically score below 0.1.
 *   - `vault_instruction_file: "VAULT.md"` - the user-authored
 *     vault-root instruction file `brain_context` surfaces when
 *     present. Configurable per vault.
 */
export const BRAIN_LINK_GRAPH_DEFAULTS: ResolvedBrainLinkGraphConfig = Object.freeze({
  moc_min_outbound_links: 5,
  moc_min_link_ratio: 0.3,
  vault_instruction_file: "VAULT.md",
}) as ResolvedBrainLinkGraphConfig;

/**
 * Merge a parsed `link_graph` block (or `undefined`) with
 * `BRAIN_LINK_GRAPH_DEFAULTS`.
 */
export function resolveLinkGraph(cfg: BrainConfig): ResolvedBrainLinkGraphConfig {
  const lg = cfg.link_graph;
  if (lg === undefined) return BRAIN_LINK_GRAPH_DEFAULTS;
  return {
    moc_min_outbound_links:
      lg.moc_min_outbound_links ?? BRAIN_LINK_GRAPH_DEFAULTS.moc_min_outbound_links,
    moc_min_link_ratio: lg.moc_min_link_ratio ?? BRAIN_LINK_GRAPH_DEFAULTS.moc_min_link_ratio,
    vault_instruction_file:
      lg.vault_instruction_file ?? BRAIN_LINK_GRAPH_DEFAULTS.vault_instruction_file,
  };
}

/**
 * Shape:
 *   link_graph:
 *     moc_min_outbound_links: 5        # positive integer
 *     moc_min_link_ratio: 0.3          # number in (0, 1]
 *     vault_instruction_file: VAULT.md # vault-relative path
 */
export function parseLinkGraphBlock(ctx: BlockParseContext): BrainLinkGraphConfig | undefined {
  const lgObj = openBlock(ctx, BLOCK);
  if (lgObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  if ("moc_min_outbound_links" in lgObj) {
    const v = lgObj["moc_min_outbound_links"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new BrainConfigError(
        "must be a positive integer",
        "link_graph.moc_min_outbound_links",
        ctx.source,
      );
    }
    partial["moc_min_outbound_links"] = v;
  }
  if ("moc_min_link_ratio" in lgObj) {
    const v = lgObj["moc_min_link_ratio"];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
      throw new BrainConfigError(
        "must be a number in (0, 1]",
        "link_graph.moc_min_link_ratio",
        ctx.source,
      );
    }
    partial["moc_min_link_ratio"] = v;
  }
  if ("vault_instruction_file" in lgObj) {
    const v = lgObj["vault_instruction_file"];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new BrainConfigError(
        "must be a non-empty string",
        "link_graph.vault_instruction_file",
        ctx.source,
      );
    }
    // Trim BEFORE the path-shape check so a value like
    // `" VAULT.md "` doesn't survive validation and fail at
    // read time as a missing file.
    const trimmed = v.trim();
    // Reject absolute paths and `..` traversal at load time so
    // the config surface fails loudly instead of silently
    // omitting the envelope field at read time.
    if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.includes("..")) {
      throw new BrainConfigError(
        "must be a vault-relative path without '..' segments",
        "link_graph.vault_instruction_file",
        ctx.source,
      );
    }
    partial["vault_instruction_file"] = trimmed;
  }
  warnUnknownKeys(
    ctx,
    lgObj,
    ["moc_min_outbound_links", "moc_min_link_ratio", "vault_instruction_file"],
    BLOCK,
  );
  return partial as BrainLinkGraphConfig;
}
