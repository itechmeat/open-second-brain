import { existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import {
  buildLiveServer,
  collectExplorerData,
  renderExportedHtml,
  type LiveServerHandle,
} from "../../../core/brain/explorer.ts";
import { brainVerbContext, fail, info, ok, parse } from "../helpers.ts";

export async function cmdBrainExplorer(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    port: { type: "string" },
    export: { type: "string" },
    force: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const exportPath = flags["export"] as string | undefined;
  const force = flags["force"] === true;

  if (exportPath !== undefined) {
    if (existsSync(exportPath) && !force)
      return fail(`${exportPath} exists; pass --force to overwrite`);
    const graph = collectExplorerData(vault);
    const html = renderExportedHtml(graph);
    try {
      atomicWriteFileSync(exportPath, html);
    } catch (err) {
      return fail(`failed to write ${exportPath}: ${(err as Error).message ?? err}`);
    }
    ok(`exported ${graph.nodes.length} nodes to ${exportPath}`);
    return 0;
  }

  const portRaw = (flags["port"] as string | undefined) ?? "7777";
  const port = Number.parseInt(portRaw, 10);
  if (!/^\d+$/.test(portRaw) || !Number.isFinite(port) || port < 1 || port > 65535)
    return fail(`invalid --port value: ${portRaw}`);

  let server: LiveServerHandle;
  try {
    server = buildLiveServer(vault, port);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/EADDRINUSE|address already in use/i.test(msg))
      return fail(`port ${port} already in use; try --port <other>`);
    return fail(`failed to start explorer: ${msg}`);
  }

  ok(`Live explorer at ${server.url}`);
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
