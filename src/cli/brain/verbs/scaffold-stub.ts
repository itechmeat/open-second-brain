/**
 * `o2b brain scaffold-stub <list|write>` - the unresolved wikilink
 * targets, and the verb that materialises one (B3).
 *
 * CLI mirror of the `brain_scaffold_stub` MCP tool; both delegate to
 * `core/brain/notes/scaffold-stub.ts`, so the fail-closed target
 * resolution and the index refusal cannot mean two different things on
 * two surfaces.
 *
 * `list` prints the REFUSAL when the index is missing or only partially
 * resolved, and it exits zero doing so: an unmeasurable index is an
 * answer, not a failure of this command. What it must never do is print
 * an empty list, which a shell reads as a clean vault.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  listDanglingTargets,
  scaffoldStub,
  DANGLING_SCAN,
  type DanglingScanResult,
  type ScaffoldStubResult,
} from "../../../core/brain/notes/scaffold-stub.ts";
import {
  CREATE_NOTE_IF_EXISTS,
  type CreateNoteIfExists,
} from "../../../core/brain/notes/create-note.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

/** The two sub-actions, named once so the usage line cannot drift. */
const ACTIONS = Object.freeze(["list", "write"] as const);

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

function renderScanJson(scan: DanglingScanResult): Record<string, unknown> {
  return {
    state: scan.state,
    targets: scan.targets.map((t) => ({ target: t.target, sources: [...t.sources] })),
    detail: scan.detail,
    next_command: scan.nextCommand,
  };
}

/**
 * The human rendering. A refusal names its state, its detail and the
 * command that resolves it; a measured scan with nothing in it says so
 * in words that cannot be confused with a refusal.
 */
function renderScanText(scan: DanglingScanResult): string {
  if (scan.state !== DANGLING_SCAN.measured) {
    return (
      `dangling targets: ${scan.state} (not measured)\n` +
      `  ${scan.detail ?? ""}\n` +
      `  next: ${scan.nextCommand}`
    );
  }
  if (scan.targets.length === 0) return "dangling targets: measured, none";
  const lines = scan.targets.map((t) => `  ${t.target} <- ${t.sources.join(", ")}`);
  return [`dangling targets: measured, ${scan.targets.length}`, ...lines].join("\n");
}

function renderStubJson(res: ScaffoldStubResult): Record<string, unknown> {
  return {
    target: res.target,
    path: res.path,
    applied: res.applied,
    outcome: res.outcome,
    sources: [...res.sources],
  };
}

export async function cmdBrainScaffoldStub(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    path: { type: "string" },
    source: { type: "string-array" },
    "if-exists": { type: "string" },
    limit: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined || !(ACTIONS as ReadonlyArray<string>).includes(action)) {
    return usageError(`brain scaffold-stub requires an action: ${ACTIONS.join(" | ")}`);
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const wantsJson = flags["json"] === true;

  try {
    if (action === "list") {
      const limitRaw = normalizeFlagString(flags["limit"]);
      const limit = limitRaw === null ? null : Number(limitRaw);
      if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
        return usageError("brain scaffold-stub --limit must be a non-negative integer");
      }
      const scan = await listDanglingTargets(vault, limit === null ? {} : { limit });
      if (wantsJson) okJson(renderScanJson(scan));
      else ok(renderScanText(scan));
      return 0;
    }

    const target = positional[1];
    if (target === undefined) {
      return usageError("brain scaffold-stub write requires a wikilink target");
    }
    const ifExistsRaw = normalizeFlagString(flags["if-exists"]);
    if (
      ifExistsRaw !== null &&
      !CREATE_NOTE_IF_EXISTS.includes(ifExistsRaw as CreateNoteIfExists)
    ) {
      return usageError(
        `brain scaffold-stub --if-exists must be one of ${CREATE_NOTE_IF_EXISTS.join(", ")}`,
      );
    }
    const path = normalizeFlagString(flags["path"]);
    const rawSources = flags["source"];
    const sources = Array.isArray(rawSources)
      ? rawSources.filter((s): s is string => typeof s === "string")
      : typeof rawSources === "string"
        ? [rawSources]
        : [];

    const res = scaffoldStub(vault, {
      target,
      ...(path !== null ? { path } : {}),
      sources,
      ...(ifExistsRaw !== null ? { ifExists: ifExistsRaw as CreateNoteIfExists } : {}),
      apply: flags["apply"] === true,
    });
    if (wantsJson) okJson(renderStubJson(res));
    else {
      ok(
        `${res.applied ? (res.outcome ?? "") : "plan"}: ${res.target} -> ${res.path}` +
          (res.sources.length > 0 ? ` (${res.sources.length} source(s))` : ""),
      );
    }
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
