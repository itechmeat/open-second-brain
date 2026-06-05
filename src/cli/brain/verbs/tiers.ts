/**
 * `o2b brain tiers <check|restore|accept>` (t_3f92d3f1): the staged
 * repair surface for identity-tier frontmatter hand-edits the index
 * post-pass detected. `check` lists open findings (read-only),
 * `restore <path> --apply` writes the expected value back into the
 * file, `accept <path>` adopts the hand-edit as the new truth -
 * nothing auto-resolves, the operator stays the judge.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

import { resolveSearchConfig } from "../../../core/search/index.ts";
import { Store } from "../../../core/search/store.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../../core/vault.ts";
import { defaultConfigPath } from "../../../core/config.ts";
import type { FrontmatterMap } from "../../../core/types.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE =
  "usage: o2b brain tiers check | " +
  "o2b brain tiers restore <path> [--field F] --apply | " +
  "o2b brain tiers accept <path> [--field F]  [--vault <path>] [--json]";

export async function cmdBrainTiers(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    field: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  if (op !== "check" && op !== "restore" && op !== "accept") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const relPath = positional[1];
  if ((op === "restore" || op === "accept") && !relPath) {
    process.stderr.write(`brain tiers ${op}: a vault-relative path is required\n${USAGE}\n`);
    return 2;
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
  const field = (flags["field"] as string | undefined)?.trim();

  try {
    if (op === "check") {
      // Fail-soft: a vault that was never indexed has no snapshots
      // and therefore no drift - not an error.
      if (!existsSync(searchConfig.dbPath)) {
        if (asJson) okJson({ findings: [] });
        else ok("tier drift: 0 open finding(s)");
        return 0;
      }
      const store = await Store.open(searchConfig, { mode: "read" });
      try {
        const findings = store.listTierDrift();
        if (asJson) {
          okJson({ findings });
        } else {
          ok(`tier drift: ${findings.length} open finding(s)`);
          for (const f of findings) {
            ok(
              `  ${f.path}  ${f.field}: expected ${render(f.expected)}, actual ${render(f.actual)}`,
            );
          }
          if (findings.length > 0) {
            ok("resolve with: o2b brain tiers restore <path> --apply  (or accept <path>)");
          }
        }
        return 0;
      } finally {
        await store.close();
      }
    }

    const store = await Store.open(searchConfig, { mode: "write" });
    try {
      const docId = store.getDocumentIdByPath(relPath!);
      if (docId === null) return fail(`tiers ${op}: not indexed: ${relPath}`);
      const rows = store
        .listTierDrift()
        .filter((r) => r.documentId === docId && (field === undefined || r.field === field));
      if (rows.length === 0) {
        return fail(`tiers ${op}: no open drift for ${relPath}${field ? ` field ${field}` : ""}`);
      }

      if (op === "restore") {
        if (flags["apply"] !== true) {
          if (asJson) okJson({ would_restore: rows, applied: false });
          else {
            for (const r of rows) {
              ok(
                `would restore ${r.path} ${r.field}: ${render(r.actual)} -> ${render(r.expected)}`,
              );
            }
            ok("re-run with --apply to write");
          }
          return 0;
        }
        const path = join(vault, relPath!);
        const [metadata, body] = parseFrontmatter(path);
        const next: FrontmatterMap = { ...metadata };
        for (const r of rows) {
          next[r.field] = asFrontmatterValue(r.expected, r.field);
        }
        writeFrontmatterAtomic(path, next, body, { overwrite: true });
        for (const r of rows) store.clearTierDrift(docId, r.field);
        if (asJson) okJson({ restored: rows.map((r) => r.field), path: relPath });
        else ok(`restored ${rows.length} field(s) in ${relPath}`);
        return 0;
      }

      // accept: the hand-edit becomes the new snapshot truth.
      const snapshot: Record<string, unknown> = { ...store.getTierSnapshot(docId) };
      for (const r of rows) {
        snapshot[r.field] = r.actual;
        store.clearTierDrift(docId, r.field);
      }
      store.setTierSnapshot(docId, snapshot);
      if (asJson) okJson({ accepted: rows.map((r) => r.field), path: relPath });
      else ok(`accepted ${rows.length} field(s) as the new baseline in ${relPath}`);
      return 0;
    } finally {
      await store.close();
    }
  } catch (exc) {
    const message = `tiers ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function render(value: unknown): string {
  return JSON.stringify(value);
}

/** Narrow a snapshot value to the shapes frontmatter can carry. */
function asFrontmatterValue(value: unknown, field: string): FrontmatterMap[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
    return value;
  }
  throw new Error(`snapshot value for "${field}" is not a frontmatter scalar or string array`);
}
