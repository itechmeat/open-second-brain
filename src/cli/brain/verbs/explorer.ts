import { existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import {
  buildLiveServer,
  collectExplorerData,
  collectExplorerDenials,
  renderExportedHtml,
  type ExplorerGraph,
  type ExplorerParseFailure,
  type LiveServerHandle,
} from "../../../core/brain/explorer.ts";
import { preferenceDenialNotice, type PreferenceDenial } from "../../../core/brain/export.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, info, ok, parse } from "../helpers.ts";

/** How many unreadable files the refusal names before it stops listing. */
const MAX_NAMED_PARSE_FAILURES = 10;

/**
 * One sentence naming what could not be read. The graph is the whole
 * point of both modes, so an unreadable rule is reported rather than
 * skipped: a graph missing a node reads exactly like a vault that never
 * had one, and the reader is the person least able to tell the difference.
 */
function parseFailureDetail(failures: ReadonlyArray<ExplorerParseFailure>): string {
  const named = failures
    .slice(0, MAX_NAMED_PARSE_FAILURES)
    .map((f) => `${f.path} (${f.reason})`)
    .join("; ");
  const rest =
    failures.length > MAX_NAMED_PARSE_FAILURES
      ? ` and ${failures.length - MAX_NAMED_PARSE_FAILURES} more`
      : "";
  return (
    `${failures.length} file(s) under Brain/ could not be parsed, so the graph would be ` +
    `incomplete and nothing was written: ${named}${rest}. Repair or remove them, then ` +
    "re-run; `o2b brain doctor` reports the same files."
  );
}

/**
 * Collect the graph, refusing on anything unreadable. Returns the graph or
 * the exit code the caller should return, so both modes answer a corrupt
 * vault the same way.
 */
function collectOrRefuse(vault: string): ExplorerGraph | number {
  const graph = collectExplorerData(vault);
  if (graph.parse_failures.length > 0) return fail(parseFailureDetail(graph.parse_failures));
  return graph;
}

export async function cmdBrainExplorer(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    port: { type: "string" },
    export: { type: "string" },
    force: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const exportPath = flags["export"] as string | undefined;
  const force = flags["force"] === true;

  if (exportPath !== undefined) {
    if (existsSync(exportPath) && !force)
      return fail(`${exportPath} exists; pass --force to overwrite`);
    const collected = collectOrRefuse(vault);
    if (typeof collected === "number") return collected;
    // The shared lanes' denial judgment, applied to the explorer's own
    // node kinds: a preference or retired file the privacy deny markers
    // reserve is withheld from the file - the export is handed to another
    // reader, and the live view (the operator's own) keeps every node.
    const denials = collectExplorerDenials(vault);
    const reserved = new Set(denials.map((d) => d.id));
    const shared: ExplorerGraph =
      reserved.size > 0
        ? { ...collected, nodes: collected.nodes.filter((node) => !reserved.has(node.id)) }
        : collected;
    // Registry entry `brain-explorer-export`. The scan runs over the graph
    // TREE and the template substitution happens afterwards, so redaction
    // can never disturb the document's own quoting.
    const verdict = redactForEgress("brain-explorer-export", shared);
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
    // The denial names ride the same guard as the llms-txt lane's
    // omission list: the notice names each denied id in the scrubbed form
    // the boundary released, never a raw hand-edited frontmatter value.
    let noticeDenials: ReadonlyArray<PreferenceDenial> = denials;
    if (denials.length > 0) {
      const denialVerdict = redactForEgress("brain-explorer-export", denials);
      if (denialVerdict.outcome !== EGRESS_OUTCOME.released) return fail(denialVerdict.detail);
      noticeDenials = denialVerdict.payload;
    }
    const html = renderExportedHtml(verdict.payload);
    try {
      atomicWriteFileSync(exportPath, html);
    } catch (err) {
      return fail(`failed to write ${exportPath}: ${(err as Error).message ?? err}`);
    }
    // The count answers for what was written: the withheld nodes are not
    // in the file, so they are not in the number either - what stayed out
    // is named on stderr beside the notice.
    ok(`exported ${verdict.payload.nodes.length} nodes to ${exportPath}`);
    if (noticeDenials.length > 0) process.stderr.write(preferenceDenialNotice(noticeDenials));
    if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
    return 0;
  }

  // The live server re-reads the vault on every request, so the same
  // refusal is applied once at boot rather than per request: a browser
  // showing a silently smaller graph is the same lie as a written file.
  const preflight = collectOrRefuse(vault);
  if (typeof preflight === "number") return preflight;

  const portRaw = (flags["port"] as string | undefined) ?? "7777";
  const port = Number.parseInt(portRaw, 10);
  if (!/^\d+$/.test(portRaw) || !Number.isFinite(port) || port < 1 || port > 65535)
    return fail(`invalid --port value: ${portRaw}`);

  let server: LiveServerHandle;
  try {
    server = buildLiveServer(vault, port, { configPath: config });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/EADDRINUSE|address already in use/i.test(msg))
      return fail(`port ${port} already in use; try --port <other>`);
    return fail(`failed to start explorer: ${msg}`);
  }

  ok(`Live explorer at ${server.url}`);
  info("Counts and operator status are served at /counts.json and /status.json.");
  info("Press Ctrl+C to stop.");
  await new Promise<void>((resolveStop) => {
    // `.catch(() => undefined).finally(...)` so the shutdown promise
    // always settles — without the catch, a rejected `server.close()`
    // leaves the outer await pending and Ctrl+C hangs the process.
    const stop = (): void => {
      void server
        .close()
        .catch(() => undefined)
        .finally(() => resolveStop());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
