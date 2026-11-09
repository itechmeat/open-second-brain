/**
 * `o2b view` - the human view: the readable pages one device, the view
 * writer, renders from the brain store into a folder of the user's choice.
 *
 * Verbs:
 *
 *  - `writer`: show which device renders the view, and a move in progress;
 *  - `writer --here [--force]`: make this machine the view writer. Without
 *    `--force` the current writer releases the role at its next catch-up;
 *    with it the role moves at once, for an old writer that is unreachable;
 *  - `render`: run one render pass (only the view writer writes pages);
 *  - `recover <page> [--print <id>]`: list the replaced versions of a page
 *    from the last 30 days, or print one of them.
 *
 * The work lives in `core/view/`; this file parses flags and renders.
 */

import {
  ConfigReadError,
  resolveAgentName,
  resolveDeviceId,
  resolveVault,
} from "../core/config.ts";
import { PartitionUnavailableError } from "../core/store/appender.ts";
import { StoreOpenError, openStore, type StoreHandle } from "../core/store/store-open.ts";
import {
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { VIEW_RECOVER_DAYS } from "../core/view/constants.ts";
import { listReplacedVersions } from "../core/view/recover.ts";
import { runViewPass, type ViewPassReport } from "../core/view/render.ts";
import { resolveViewTarget, ViewTargetError } from "../core/view/target.ts";
import { readViewWriter, requestViewWriter, type RequestResult } from "../core/view/writer.ts";
import { pendingTarget } from "../core/view/writer-fold.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

const USAGE = [
  "usage: o2b view writer [--here [--force]] [--config <file>] [--json]",
  "       o2b view render [--config <file>] [--json]",
  "       o2b view recover <page> [--print <id>] [--config <file>] [--json]",
].join("\n");

const VIEW_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

export async function handleViewSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? VIEW_EXIT.usage : VIEW_EXIT.ok;
  }
  const rest = argv.slice(1);
  try {
    switch (verb) {
      case "writer":
        return cmdWriter(rest);
      case "render":
        return cmdRender(rest);
      case "recover":
        return cmdRecover(rest);
      default:
        process.stderr.write(`error: unknown view verb: ${verb}\n${USAGE}\n`);
        return VIEW_EXIT.usage;
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return VIEW_EXIT.usage;
    }
    if (!(err instanceof Error) || !isViewFailure(err)) throw err;
    // Another pass (a hook, a second `o2b view render`) holds the render lock.
    const message = isLocked(err)
      ? "another render of the human view is in progress; try again in a moment"
      : err.message;
    if (rest.includes("--json")) {
      writeJson({ ok: false, ...(isLocked(err) ? { reason: "busy" } : {}), error: message });
    }
    process.stderr.write(`error: ${message}\n`);
    return VIEW_EXIT.refused;
  }
}

function isLocked(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === "ELOCKED";
}

/** Failures the view verbs report as an answer rather than a crash. */
function isViewFailure(err: Error): boolean {
  return (
    isLocked(err) ||
    err instanceof StoreOpenError ||
    err instanceof StoreRootInsideVaultError ||
    err instanceof ConfigReadError ||
    err instanceof ViewTargetError ||
    err instanceof PartitionUnavailableError
  );
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, sortedReplacer, 2)}\n`);
}

function openConfiguredStore(configPath: string | undefined): StoreHandle {
  const { root } = resolveConfiguredStoreRoot(configPath);
  return openStore({ root, device: resolveDeviceId(configPath) });
}

function cmdWriter(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    here: { type: "boolean" },
    force: { type: "boolean" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  if (flags["force"] === true && flags["here"] !== true) {
    throw new CliError("--force moves the role here, so it needs --here");
  }
  const configPath = flags["config"] as string | undefined;
  const json = flags["json"] === true;
  const store = openConfiguredStore(configPath);
  if (flags["here"] !== true) {
    const state = readViewWriter(store);
    const pending = pendingTarget(state);
    if (json) {
      writeJson({ ok: true, writer: state.writer, pending, device: store.device });
      return VIEW_EXIT.ok;
    }
    process.stdout.write(
      state.writer === null
        ? "No machine renders the human view yet; take the role with `writer --here` on the machine that should.\n"
        : `The human view is rendered by ${state.writer}` +
            (state.writer === store.device ? " (this machine)" : "") +
            (pending !== null ? `; a move to ${pending} waits for its release` : "") +
            ".\n",
    );
    return VIEW_EXIT.ok;
  }
  const result = requestViewWriter(store, {
    agent: resolveAgentName(configPath),
    force: flags["force"] === true,
  });
  if (json) {
    writeJson({ ok: true, ...describeRequest(result), device: store.device });
    return VIEW_EXIT.ok;
  }
  process.stdout.write(`${requestMessage(result, store.device)}\n`);
  if (result.status === "forced" && result.warning !== null) {
    process.stderr.write(`warning: ${result.warning}\n`);
  }
  return VIEW_EXIT.ok;
}

function describeRequest(result: RequestResult): Record<string, unknown> {
  if (result.status === "already-writer") return { status: result.status };
  return { status: result.status, previous: result.previous, warning: result.warning };
}

function requestMessage(result: RequestResult, device: string): string {
  switch (result.status) {
    case "already-writer":
      return `This machine (${device}) already renders the human view.`;
    case "taken":
      return result.previous === device
        ? `This machine (${device}) stays the view writer; the pending move is cancelled.`
        : `This machine (${device}) now renders the human view.`;
    case "requested":
      return (
        `Asked ${result.previous} to hand the view writer role to ${device}. It releases the ` +
        "role at its next catch-up, and this machine renders once that release has synced here."
      );
    case "forced":
      return `This machine (${device}) now renders the human view; ${result.previous} did not release it.`;
  }
}

function cmdRender(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  const configPath = flags["config"] as string | undefined;
  const store = openConfiguredStore(configPath);
  const vault = resolveVault(configPath);
  const target = resolveViewTarget(store.root, configPath, vault);
  const report = runViewPass(store, {
    target: target?.dir ?? null,
    vault,
    agent: resolveAgentName(configPath),
  });
  // One exit rule for both forms: a pass that could not read is refused.
  const refused = report.status === "incomplete-read";
  if (flags["json"] === true) writeJson({ ok: !refused, ...report });
  else process.stdout.write(`${renderMessage(report)}\n`);
  return refused ? VIEW_EXIT.refused : VIEW_EXIT.ok;
}

function renderMessage(report: ViewPassReport): string {
  switch (report.status) {
    case "incomplete-read":
      return `Not rendered: some shards could not be read (${report.shards.join(", ")}).`;
    case "no-writer":
      return "No machine renders the human view yet; take the role with `writer --here` on the machine that should.";
    case "not-writer":
      return `This machine writes no view page: the view writer is ${report.writer}.`;
    case "released":
      return `Handed the view writer role to ${report.to}, as the user asked.`;
    case "waiting-for-claim":
      return "This machine just took the view writer role; it renders from its next catch-up.";
    case "no-target":
      return "No human view folder is configured (`view_target`), so no page was written.";
    case "rendered": {
      const lines = report.pages
        .filter((p) => p.status !== "unchanged")
        .map(
          (p) =>
            `  ${p.page}: ${p.status}` +
            (p.ingested > 0 ? `, ${p.ingested} edit(s) stored` : "") +
            (p.detail !== undefined ? ` (${p.detail})` : ""),
        );
      return lines.length === 0
        ? `Rendered ${report.pages.length} page(s); none changed.`
        : `Rendered ${report.pages.length} page(s):\n${lines.join("\n")}`;
    }
  }
}

function cmdRecover(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    print: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length !== 1)
    throw new CliError("recover takes one page, for example about-me.md");
  const page = positional[0]!.replaceAll("\\", "/");
  const store = openConfiguredStore(flags["config"] as string | undefined);
  const versions = listReplacedVersions(store, page);
  const wanted = flags["print"] as string | undefined;
  if (wanted !== undefined) {
    const version = versions.find((v) => v.id === wanted);
    if (version === undefined || version.text === null) {
      process.stderr.write(
        version === undefined
          ? `error: no replaced version ${wanted} of ${page} in the last ${VIEW_RECOVER_DAYS} days\n`
          : `error: the text of ${wanted} has not synced to this machine yet\n`,
      );
      return VIEW_EXIT.refused;
    }
    process.stdout.write(version.text);
    return VIEW_EXIT.ok;
  }
  if (flags["json"] === true) {
    writeJson({ ok: true, page, versions });
    return VIEW_EXIT.ok;
  }
  if (versions.length === 0) {
    process.stdout.write(
      `No replaced versions of ${page} in the last ${VIEW_RECOVER_DAYS} days.\n`,
    );
    return VIEW_EXIT.ok;
  }
  const rows = versions.map(
    (v) =>
      `  ${v.id}  ${v.at}  ${v.device}  ${v.reason}  ${v.bytes} bytes` +
      (v.text === null ? "  (not synced yet)" : ""),
  );
  process.stdout.write(
    `Replaced versions of ${page}, newest first:\n${rows.join("\n")}\n` +
      "Print one with --print <id>.\n",
  );
  return VIEW_EXIT.ok;
}
