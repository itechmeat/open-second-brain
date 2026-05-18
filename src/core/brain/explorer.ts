/**
 * §14 Brain explorer — data collector.
 *
 * Pure read. Walks `Brain/preferences/` and `Brain/retired/`, builds
 * a node list plus an edge list derived from:
 *
 *   1. Frontmatter `supersedes` / `superseded_by` (kind `supersedes`).
 *   2. Inline `[[wikilinks]]` anywhere in the file's frontmatter
 *      values and body, filtered to refs landing on another node
 *      (kind `wikilink`).
 *
 * Signal (`sig-*`) and log refs never appear in `edges` — the
 * explorer view is about the rule graph, not the audit trail.
 *
 * Output is deterministic: nodes sorted by `(kind, id)`, edges by
 * `(source, target, kind)`. The collector emits a frozen object so
 * the live HTTP handler and the static export branch cannot
 * accidentally mutate it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBacklinkIndex, type BacklinkIndex } from "./backlinks.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  type BrainConfidence,
  type BrainPreference,
  type BrainRetired,
} from "./types.ts";

export const EXPLORER_SCHEMA_VERSION = 1 as const;

export type ExplorerNodeKind = "preference" | "retired";
export type ExplorerNodeStatus =
  | "unconfirmed"
  | "confirmed"
  | "quarantine"
  | "retired";
export type ExplorerEdgeKind = "supersedes" | "wikilink";

export interface ExplorerNode {
  readonly id: string;
  readonly kind: ExplorerNodeKind;
  readonly topic: string;
  readonly scope: string | null;
  readonly principle: string;
  readonly status: ExplorerNodeStatus;
  readonly confidence: BrainConfidence | null;
  readonly confidence_value: number | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly pinned: boolean;
  readonly retired_reason: string | null;
  readonly last_evidence_at: string | null;
  readonly backlink_count: number;
}

export interface ExplorerEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: ExplorerEdgeKind;
}

export interface ExplorerGraph {
  readonly generated_at: string;
  readonly schema_version: typeof EXPLORER_SCHEMA_VERSION;
  readonly vault_basename: string;
  readonly nodes: ReadonlyArray<ExplorerNode>;
  readonly edges: ReadonlyArray<ExplorerEdge>;
}

export interface CollectExplorerDataOptions {
  /** Wall clock for `generated_at`. Defaults to `new Date()`. */
  readonly now?: Date;
}

export function collectExplorerData(
  vault: string,
  opts: CollectExplorerDataOptions = {},
): ExplorerGraph {
  const dirs = brainDirs(vault);
  // Build the backlink index first so node factories can stamp the
  // final count in one pass — avoids the prior write-then-overwrite
  // shape that left a transient `backlink_count: 0` on every node.
  const backlinkIndex = buildBacklinkIndex(vault);
  const countFor = (id: string): number =>
    (backlinkIndex.get(id) ?? []).length;

  const nodes: ExplorerNode[] = [];
  const knownIds = new Set<string>();

  if (existsSync(dirs.preferences)) {
    for (const entry of readdirSync(dirs.preferences, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (!entry.name.startsWith("pref-")) continue;
      const path = join(dirs.preferences, entry.name);
      try {
        const pref = parsePreference(path);
        nodes.push(nodeFromPreference(pref, countFor(pref.id)));
        knownIds.add(pref.id);
      } catch {
        // Doctor reports parse-level corruption; the explorer skips
        // silently so one bad file does not blank the whole graph.
      }
    }
  }

  if (existsSync(dirs.retired)) {
    for (const entry of readdirSync(dirs.retired, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (!entry.name.startsWith("ret-")) continue;
      const path = join(dirs.retired, entry.name);
      try {
        const ret = parseRetired(path);
        nodes.push(nodeFromRetired(ret, countFor(ret.id)));
        knownIds.add(ret.id);
      } catch {
        // ditto
      }
    }
  }

  // Edges derived from the backlink index. The index maps
  //    `target → ref[]` where each ref carries `source` + `field`.
  //    Field name `supersedes` / `superseded_by` → kind `supersedes`;
  //    anything else (`evidenced_by`, `body`, …) → kind `wikilink`.
  //    Self-references and refs whose source is not a node (log
  //    files, signals) are filtered out.
  const edges = deriveEdges(backlinkIndex, knownIds);

  // 5. Stable order.
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });
  edges.sort((a, b) => {
    const s = a.source.localeCompare(b.source);
    if (s !== 0) return s;
    const t = a.target.localeCompare(b.target);
    if (t !== 0) return t;
    return a.kind.localeCompare(b.kind);
  });

  const now = opts.now ?? new Date();
  return Object.freeze({
    generated_at: now.toISOString(),
    schema_version: EXPLORER_SCHEMA_VERSION,
    vault_basename: basename(vault),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

function nodeFromPreference(
  pref: BrainPreference,
  backlinkCount: number,
): ExplorerNode {
  return {
    id: pref.id,
    kind: "preference",
    topic: pref.topic,
    scope: pref.scope ?? null,
    principle: pref.principle,
    status: statusOf(pref.status),
    confidence: pref.confidence,
    confidence_value: pref.confidence_value,
    applied_count: pref.applied_count,
    violated_count: pref.violated_count,
    pinned: pref.pinned,
    retired_reason: null,
    last_evidence_at: pref.last_evidence_at,
    backlink_count: backlinkCount,
  };
}

function nodeFromRetired(
  ret: BrainRetired,
  backlinkCount: number,
): ExplorerNode {
  return {
    id: ret.id,
    kind: "retired",
    topic: ret.topic,
    scope: ret.scope ?? null,
    principle: ret.principle,
    status: "retired",
    confidence: ret.confidence ?? null,
    confidence_value: ret.confidence_value ?? null,
    applied_count: ret.applied_count,
    violated_count: ret.violated_count,
    pinned: ret.pinned ?? false,
    retired_reason: ret.retired_reason,
    last_evidence_at: ret.last_evidence_at,
    backlink_count: backlinkCount,
  };
}

function statusOf(s: BrainPreference["status"]): ExplorerNodeStatus {
  switch (s) {
    case BRAIN_PREFERENCE_STATUS.unconfirmed:
      return "unconfirmed";
    case BRAIN_PREFERENCE_STATUS.confirmed:
      return "confirmed";
    case BRAIN_PREFERENCE_STATUS.quarantine:
      return "quarantine";
    default:
      // Forward-compat: future statuses fall back to the closest
      // visual category (unconfirmed) rather than crashing.
      return "unconfirmed";
  }
}

// ---- Template rendering -------------------------------------------------

const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "brain-explorer.html",
);

/**
 * Unique sentinel string substituted with the graph JSON. Must appear
 * exactly once in the template; the renderer fails loudly otherwise so
 * a stale template (missing or accidentally double-substituted marker)
 * surfaces immediately instead of producing a half-rendered HTML file.
 */
const PLACEHOLDER = "__GRAPH_JSON__";

let templateCache: string | undefined;

function loadTemplate(): string {
  if (templateCache !== undefined) return templateCache;
  let raw: string;
  try {
    raw = readFileSync(TEMPLATE_PATH, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load brain-explorer template from ${TEMPLATE_PATH}: ${msg}`,
    );
  }
  const first = raw.indexOf(PLACEHOLDER);
  const last = raw.lastIndexOf(PLACEHOLDER);
  if (first === -1) {
    throw new Error(
      `brain-explorer.html template is missing the ${PLACEHOLDER} marker`,
    );
  }
  if (first !== last) {
    throw new Error(
      `brain-explorer.html template carries ${PLACEHOLDER} more than once;`
      + ` substitution must be unique to keep the output deterministic`,
    );
  }
  templateCache = raw;
  return templateCache;
}

/**
 * Substitute the placeholder with a single-line JSON serialisation of
 * `graph`. Single-line keeps the export size lean — the rendered file
 * routinely lands in a Drive backup or PR comment.
 *
 * Uses the function-form of `String.prototype.replace` to avoid `$&`
 * / `$1` injection through the JSON body (principle bodies are free
 * text and may contain `$`).
 */
export function renderExportedHtml(graph: ExplorerGraph): string {
  const json = JSON.stringify(graph).replace(/[<>&]/g, (c) => {
    switch (c) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      default:
        return c;
    }
  });
  return loadTemplate().replace(PLACEHOLDER, () => json);
}

/** Test-only escape hatch: forget the cached template body. */
export function __resetExplorerTemplateCacheForTests(): void {
  templateCache = undefined;
}

// ---- Live server -------------------------------------------------------

export interface LiveServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Boot a loopback-only HTTP server that serves the explorer template
 * and a JSON endpoint. Each GET re-reads the vault — no caches, no
 * watchers, no write endpoints. Binding to `127.0.0.1` is non-optional;
 * the explorer is single-user observability and should not be
 * reachable across the network.
 *
 * Throws when the port is unavailable; the CLI catches `EADDRINUSE`
 * and turns it into a friendly exit message.
 */
export function buildLiveServer(vault: string, port: number): LiveServerHandle {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const graph = collectExplorerData(vault);
        const html = renderExportedHtml(graph);
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/data.json") {
        const graph = collectExplorerData(vault);
        return new Response(JSON.stringify(graph), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // Bun's `Server.port` is typed as `number | undefined` because the
  // server might bind to a Unix socket. The HTTP path above always
  // resolves to a TCP port, so a missing value is a runtime
  // contradiction worth surfacing explicitly.
  const actualPort = server.port;
  if (typeof actualPort !== "number") {
    server.stop();
    throw new Error("buildLiveServer: server bound without a TCP port");
  }
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    close: async () => {
      server.stop();
    },
  };
}

// ---- Helpers ------------------------------------------------------------

function deriveEdges(
  index: BacklinkIndex,
  knownIds: ReadonlySet<string>,
): ExplorerEdge[] {
  const edges: ExplorerEdge[] = [];
  const seen = new Set<string>();
  for (const [target, refs] of index) {
    if (!knownIds.has(target)) continue;
    for (const ref of refs) {
      if (!knownIds.has(ref.source)) continue; // logs / signals
      if (ref.source === target) continue;
      const kind: ExplorerEdgeKind =
        ref.field === "supersedes" || ref.field === "superseded_by"
          ? "supersedes"
          : "wikilink";
      const key = `${ref.source}\x00${target}\x00${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: ref.source, target, kind });
    }
  }
  return edges;
}
