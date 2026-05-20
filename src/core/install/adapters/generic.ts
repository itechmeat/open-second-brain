/**
 * Generic adapter — long-tail fallback.
 *
 * Prints the canonical MCP server payload to stdout or a named file.
 * Never edits any runtime's own config files. The operator is in
 * charge of copying the printed snippet into wherever their runtime
 * expects it.
 *
 * - `detect` always returns `not-installed` (no canonical config to
 *   probe for this target).
 * - `apply` writes payload as JSON (default) or YAML.
 * - `uninstall` reports the path the operator wrote to but does not
 *   delete it — the consuming runtime may rely on it.
 */

import { writeFileSync } from "node:fs";

import { recordEntry, removeEntry, readManifest } from "../manifest.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import type {
  ApplyOpts,
  ApplyResult,
  DetectResult,
  InstallAdapter,
  InstallEnv,
  InstallPlan,
  ManifestEntry,
  McpPayload,
  McpServerEntry,
  UninstallResult,
  VerifyResult,
} from "../types.ts";
import { defaultRegistry } from "../registry.ts";

const TARGET = "generic";
const LABEL = "Generic (printout)";

function renderJson(payload: McpPayload): string {
  const out = {
    mcpServers: {
      [OSB_KEY_FULL]: serializeEntry(payload.full),
      [OSB_KEY_WRITER]: serializeEntry(payload.writer),
    },
  };
  return JSON.stringify(out, null, 2) + "\n";
}

function renderYaml(payload: McpPayload): string {
  const lines: string[] = ["mcpServers:"];
  for (const [name, entry] of [
    [OSB_KEY_FULL, payload.full],
    [OSB_KEY_WRITER, payload.writer],
  ] as const) {
    lines.push(`  ${name}:`);
    lines.push(`    command: ${yamlScalar(entry.command)}`);
    lines.push(`    args:`);
    for (const a of entry.args) lines.push(`      - ${yamlScalar(a)}`);
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push(`    env:`);
      for (const [k, v] of Object.entries(entry.env)) {
        lines.push(`      ${k}: ${yamlScalar(v)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function yamlScalar(s: string): string {
  // Quote when needed (contains special chars or starts/ends with whitespace).
  if (/[:#\[\]\{\}\,&\*!\|>\'"%@`]/.test(s) || /^\s|\s$/.test(s) || /^[\-?!]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function serializeEntry(e: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { command: e.command, args: [...e.args] };
  if (e.env && Object.keys(e.env).length > 0) out["env"] = { ...e.env };
  return out;
}

export const genericAdapter: InstallAdapter = {
  target: TARGET,
  label: LABEL,

  detect(_env: InstallEnv): DetectResult {
    return {
      target: TARGET,
      status: "not-installed",
      configPath: null,
      notes: ["generic: print-only; never edits external config"],
    };
  },

  plan(_payload: McpPayload, _env: InstallEnv): InstallPlan {
    return {
      target: TARGET,
      steps: [
        {
          kind: "print",
          path: null,
          preview: "render OSB MCP payload to stdout or --out <path>",
        },
      ],
      postNotes: [
        "Copy the printed snippet into your runtime's MCP config manually.",
      ],
    };
  },

  apply(
    _plan: InstallPlan,
    payload: McpPayload,
    env: InstallEnv,
    opts: ApplyOpts,
  ): ApplyResult {
    const format = opts.format ?? "json";
    const text = format === "yaml" ? renderYaml(payload) : renderJson(payload);
    const explicitStdout = opts.outPath === "-";
    const outPath = !explicitStdout && opts.outPath ? opts.outPath : null;

    if (opts.dryRun) {
      // Dry-run: don't write file, don't touch stdout — let the CLI layer
      // surface the planned action.
    } else if (outPath !== null) {
      writeFileSync(outPath, text);
    } else {
      opts.stdout.write(text);
    }

    const manifest: ManifestEntry = {
      target: TARGET,
      applied_at: env.now.toISOString(),
      operation: "print",
      config_path: outPath,
      ...(outPath ? { owned_paths: [outPath] } : {}),
    };
    if (!opts.dryRun) recordEntry(env.vault, manifest);

    return { target: TARGET, manifest, steps_executed: opts.dryRun ? 0 : 1 };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const m = readManifest(env.vault).installs[TARGET];
    const skipped: Array<readonly [string, string]> = [];
    if (m?.owned_paths?.length) {
      for (const p of m.owned_paths) {
        skipped.push([p, "generic: file left in place; remove manually if no longer needed"]);
      }
    } else {
      skipped.push([
        "(no recorded path)",
        "generic: never wrote to disk; nothing to do",
      ]);
    }
    if (!opts.dryRun) removeEntry(env.vault, TARGET);
    return { target: TARGET, removed_keys: [], removed_paths: [], skipped };
  },

  verify(env: InstallEnv): VerifyResult {
    const m = readManifest(env.vault).installs[TARGET];
    if (!m || !m.owned_paths?.length) {
      return {
        target: TARGET,
        status: "not-installed",
        details: ["generic: no recorded output path"],
        fix_hint: null,
      };
    }
    // We don't probe the file's runtime — that's outside our scope.
    return {
      target: TARGET,
      status: "ok",
      details: [`generic: payload written to ${m.owned_paths[0]} (runtime wiring is operator-managed)`],
      fix_hint: null,
    };
  },
};

defaultRegistry.register(genericAdapter);
