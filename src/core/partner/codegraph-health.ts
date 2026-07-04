/**
 * Read-only graph-health gate for the codegraph partner
 * (https://github.com/colbymchenry/codegraph, upstream feature parity with
 * safishamsi/graphify v0.8.46).
 *
 * A code graph can be syntactically present - `codegraph status` reports it
 * `initialized` with node and edge counts - while being subtly wrong: the
 * index was built for a different root, relationship extraction collapsed to
 * zero edges, or the partner's own diagnostics found dangling references and
 * self-loops. Any of those makes the graph an untrustworthy input for
 * labeling, import, or downstream recall.
 *
 * This gate runs AFTER the partner has constructed/indexed the graph and
 * BEFORE any OSB surface (the partner report, `o2b doctor`, and any future
 * codegraph-derived edge import) trusts it. It is strictly read-only and
 * non-destructive: it never runs extraction, never mutates the index or the
 * vault, and NEVER aborts. Every problem is surfaced as a warning; the caller
 * decides how loudly to report it. `ok` is a convenience derived from
 * `warnings.length === 0`.
 *
 * Detection is grounded in the fields the real `codegraph status -j` emits
 * (node/edge counts, `worktreeMismatch`), plus optional partner-provided
 * diagnostic counts (`danglingRefs`, `selfLoops`) consumed when present so the
 * gate stays forward-compatible with a richer status surface.
 */

/** Stable code per health finding so callers can filter without parsing text. */
export type GraphHealthCode =
  | "empty-graph"
  | "collapsed-edges"
  | "dangling-references"
  | "self-loops"
  | "cache-root-mismatch";

/** One non-blocking graph-health finding. */
export interface GraphHealthWarning {
  readonly code: GraphHealthCode;
  readonly message: string;
}

/** Outcome of the gate. `ok` is true exactly when there are no warnings. */
export interface GraphHealthReport {
  readonly ok: boolean;
  readonly warnings: ReadonlyArray<GraphHealthWarning>;
}

export interface GraphHealthInput {
  /** Node count reported by `codegraph status` (defaults to 0 when absent). */
  readonly nodeCount: number;
  /** Edge count reported by `codegraph status` (defaults to 0 when absent). */
  readonly edgeCount: number;
  /**
   * Dangling-reference count from the partner's own diagnostics. Optional:
   * base `codegraph status` does not emit it, so the finding only fires when
   * a status surface provides it. `undefined` means "not measured", not zero.
   */
  readonly danglingRefs?: number;
  /**
   * Self-loop edge count from the partner's diagnostics. Same optional
   * semantics as {@link GraphHealthInput.danglingRefs}.
   */
  readonly selfLoops?: number;
  /**
   * Absolute root the index was built for (`status.projectPath` or
   * `worktreeMismatch.indexRoot`). Compared against {@link
   * GraphHealthInput.worktreeRoot} for the cache-root-mismatch finding.
   */
  readonly indexRoot?: string | null;
  /**
   * Absolute root the graph is being read from (the in-scope project or
   * `worktreeMismatch.worktreeRoot`). A mismatch means file/line references in
   * the graph are rooted elsewhere and may be stale for this tree.
   */
  readonly worktreeRoot?: string | null;
}

/** Strip trailing slashes so `/repo` and `/repo/` compare equal. */
function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Trailing-slash-insensitive path comparison. */
function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(a) === stripTrailingSlash(b);
}

/**
 * Assess graph health from the partner status projection. Pure, total, and
 * never-throwing: unknown or missing inputs simply produce no warning rather
 * than a false positive. Findings are returned in a stable, severity-ordered
 * sequence (structural emptiness first, then reference integrity, then
 * root provenance) so callers can render them deterministically.
 */
export function assessGraphHealth(input: GraphHealthInput): GraphHealthReport {
  const warnings: GraphHealthWarning[] = [];
  const nodes = Number.isFinite(input.nodeCount) ? input.nodeCount : 0;
  const edges = Number.isFinite(input.edgeCount) ? input.edgeCount : 0;

  if (nodes <= 0) {
    warnings.push({
      code: "empty-graph",
      message:
        "index is initialized but holds 0 nodes; extraction produced an empty graph - " +
        "labeling and recall will find nothing until it is re-indexed",
    });
  } else if (edges <= 0) {
    // Nodes without edges: symbols were extracted but no relationships. Only
    // meaningful when there is at least one node (an empty graph is reported
    // above and should not double-warn).
    warnings.push({
      code: "collapsed-edges",
      message:
        `graph has ${nodes} node(s) but 0 edges; relationship extraction collapsed - ` +
        "callers/callees/impact traversal will be empty",
    });
  }

  if (input.danglingRefs !== undefined && input.danglingRefs > 0) {
    warnings.push({
      code: "dangling-references",
      message:
        `${input.danglingRefs} dangling reference(s): edges point at nodes absent from the ` +
        "index; derived labels/imports built from them would reference missing symbols",
    });
  }

  if (input.selfLoops !== undefined && input.selfLoops > 0) {
    warnings.push({
      code: "self-loops",
      message:
        `${input.selfLoops} self-loop edge(s): a node references itself; ` +
        "impact and traversal surfaces may double-count or cycle",
    });
  }

  if (input.indexRoot && input.worktreeRoot && !samePath(input.indexRoot, input.worktreeRoot)) {
    warnings.push({
      code: "cache-root-mismatch",
      message:
        `index was built for '${input.indexRoot}' but is being read from ` +
        `'${input.worktreeRoot}'; file and line references may be stale for this tree - ` +
        "re-index the current root before trusting graph-derived artifacts",
    });
  }

  return { ok: warnings.length === 0, warnings };
}

/** Compact one-line summary of a report, e.g. `2 warning(s) [collapsed-edges, self-loops]`. */
export function summarizeGraphHealth(report: GraphHealthReport): string {
  if (report.warnings.length === 0) return "ok";
  const codes = report.warnings.map((w) => w.code).join(", ");
  return `${report.warnings.length} warning(s) [${codes}]`;
}
