/**
 * `o2b search check` — pre-flight diagnostics over everything search needs
 * (vault, index directory, SQLite/FTS5, the vector extension, the
 * embedding key, the provider) plus the ABI stamp of the stored vectors.
 */

import { formatStampMismatch } from "../../../core/integrity/stamp.ts";
import { indexCheck, serializeStampMismatches } from "../../../core/search/index.ts";
import type { IndexCheckReport } from "../../../core/search/index.ts";
import { flagBoolean, parseFlags, resolveConfig, VAULT_FLAGS } from "../helpers.ts";

export async function cmdSearchCheck(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const report = await indexCheck(cfg);
  if (flagBoolean(flags, "json")) {
    process.stdout.write(JSON.stringify(jsonForCheck(report)) + "\n");
  } else {
    process.stdout.write(renderCheckHuman(report));
  }
  return report.fatal.length > 0 ? 1 : 0;
}

function jsonForCheck(r: IndexCheckReport): unknown {
  return {
    vault_readable: r.vaultReadable,
    index_dir_writable: r.indexDirWritable,
    sqlite_ok: r.sqliteOk,
    fts5_ok: r.fts5Ok,
    vec_extension: r.vecExtension,
    embedding_key_resolved: r.embeddingKeyResolved,
    provider_reachable: r.providerReachable,
    provider_reason: r.providerReason,
    // Emitted only on drift, so a matching store's JSON is byte-identical
    // to the pre-gate output (context-integrity-gates, Unit E).
    ...(r.embeddingAbi.length > 0
      ? { embedding_abi: serializeStampMismatches(r.embeddingAbi) }
      : {}),
    warnings: r.warnings,
    fatal: r.fatal,
    recommendations: r.recommendations,
  };
}

/** Render one pre-flight probe's verdict, in the wording the check has always used. */
function ok(passed: boolean): string {
  return passed ? "OK" : "MISSING";
}

function renderCheckHuman(r: IndexCheckReport): string {
  const lines: string[] = [];
  lines.push(`vault_readable:        ${ok(r.vaultReadable)}`);
  lines.push(`index_dir_writable:    ${ok(r.indexDirWritable)}`);
  lines.push(`sqlite_ok:             ${ok(r.sqliteOk)}`);
  lines.push(`fts5_ok:               ${ok(r.fts5Ok)}`);
  lines.push(`vec_extension:         ${r.vecExtension}`);
  lines.push(`embedding_key:         ${ok(r.embeddingKeyResolved)}`);
  // Only on drift: a matching store renders exactly as before.
  for (const m of r.embeddingAbi) {
    lines.push(`embedding_abi:         ${formatStampMismatch(m)}`);
  }
  if (r.providerReachable !== null) {
    lines.push(`provider_reachable:    ${r.providerReachable ? "OK" : "FAIL"}`);
    if (r.providerReason) lines.push(`provider_reason:       ${r.providerReason}`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const f of r.fatal) lines.push(`fatal:   ${f}`);
  if (r.recommendations.length > 0) {
    lines.push("");
    lines.push("recommendations:");
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  return lines.join("\n") + "\n";
}
