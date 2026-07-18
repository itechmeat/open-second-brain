/**
 * `o2b brain forget-source <source>` (C6 / t_edde2198): find and surgically
 * remove everything derived from one EXACT source file.
 *
 * DRY-RUN BY DEFAULT — with no `--confirm` it prints the blast radius and
 * deletes nothing. `--confirm` deletes the single-purpose derived entries
 * and the ingest index artifacts (summary page + content-manifest entry);
 * shared-derivation pages and aggregate surfaces (logs, reports, MOCs) are
 * reported, never deleted. `--include-originals` additionally removes the
 * original source file(s) outside `Brain/`. Every confirmed cleanup writes
 * an auditable `source_invalidation` continuity record.
 */

import { deleteBySource } from "../../../core/brain/source-cleanup.ts";
import { CountGuardError, assertExpectedCount } from "../../../core/brain/count-guard.ts";
import { brainVerbContext, fail, info, ok, okJson, parse } from "../helpers.ts";

export async function cmdBrainForgetSource(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    confirm: { type: "boolean" },
    "include-originals": { type: "boolean" },
    expect: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
  });
  const sourceFile = positional[0];
  if (!sourceFile) {
    return fail(
      "usage: o2b brain forget-source <source> [--confirm] [--include-originals] " +
        "[--expect N] [--strict] [--json]",
    );
  }

  const expectRaw = flags["expect"] as string | undefined;
  let expect: number | null = null;
  if (expectRaw !== undefined) {
    const n = Number(expectRaw);
    if (!Number.isInteger(n) || n < 0) {
      return fail("--expect must be a non-negative integer");
    }
    expect = n;
  }
  const strict = flags["strict"] === true;
  const confirm = flags["confirm"] === true;
  const includeOriginals = flags["include-originals"] === true;

  try {
    const { vault } = brainVerbContext(flags);
    const now = new Date();
    // Preview first so the count guard asserts the blast radius before any
    // deletion; only then confirm.
    const preview = deleteBySource(vault, sourceFile, {
      confirm: false,
      includeOriginals,
      now,
    });
    assertExpectedCount({
      matched: preview.blastRadius,
      expect,
      strict,
      willMutate: confirm,
      matchList: [
        ...preview.derived.map((e) => e.match ?? e.path),
        ...preview.mentions.map((e) => e.match ?? e.path),
        ...preview.originals,
      ],
    });
    const plan = confirm
      ? deleteBySource(vault, sourceFile, { confirm: true, includeOriginals, now })
      : preview;

    if (flags["json"]) {
      okJson({
        source: plan.source,
        confirmed: plan.confirmed,
        include_originals: plan.includeOriginals,
        blast_radius: plan.blastRadius,
        matched: plan.blastRadius,
        changed: plan.deleted.length,
        derived: plan.derived.map((e) => ({
          path: e.path,
          kind: e.kind,
          match: e.match,
          is_index_artifact: e.isIndexArtifact,
        })),
        mentions: plan.mentions.map((e) => ({ path: e.path, kind: e.kind, match: e.match })),
        originals: [...plan.originals],
        deleted: [...plan.deleted],
        manifest_entry_removed: plan.manifestEntryRemoved,
        audit_record_id: plan.auditRecordId,
        snapshot_run_id: plan.snapshotRunId,
        snapshot_path: plan.snapshotPath,
      });
      return 0;
    }

    if (plan.confirmed) {
      ok(`forget-source: ${plan.source}`);
      ok(`  deleted ${plan.deleted.length} file(s)`);
      for (const p of plan.deleted) ok(`    - ${p}`);
      if (plan.manifestEntryRemoved) ok("  removed ingest manifest entry");
      if (plan.mentions.length > 0) {
        info(`  ${plan.mentions.length} protected mention(s) NOT deleted (edit by hand):`);
        for (const e of plan.mentions) info(`    - ${e.path} (${e.kind})`);
      }
      if (!plan.includeOriginals && plan.originals.length > 0) {
        info(`  ${plan.originals.length} original(s) preserved (pass --include-originals):`);
        for (const p of plan.originals) info(`    - ${p}`);
      }
      if (plan.auditRecordId) ok(`  audit: ${plan.auditRecordId}`);
      if (plan.snapshotRunId) {
        ok(`  recovery point: snapshot ${plan.snapshotRunId}`);
        if (plan.snapshotPath) info(`    ${plan.snapshotPath}`);
      }
      return 0;
    }

    // Dry-run report.
    ok(`forget-source (DRY RUN): ${plan.source}`);
    ok(`  blast radius: ${plan.blastRadius} referenced file(s) + originals`);
    ok(`  ${plan.derived.length} derived entr(y/ies) WOULD be deleted:`);
    for (const e of plan.derived) {
      ok(`    - ${e.path} (${e.kind}${e.isIndexArtifact ? ", index artifact" : ""})`);
    }
    if (plan.mentions.length > 0) {
      info(`  ${plan.mentions.length} protected mention(s) reported, NOT deleted:`);
      for (const e of plan.mentions) info(`    - ${e.path} (${e.kind})`);
    }
    if (plan.originals.length > 0) {
      info(`  ${plan.originals.length} original(s) (removed only with --include-originals):`);
      for (const p of plan.originals) info(`    - ${p}`);
    }
    info("  re-run with --confirm to delete");
    return 0;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // In `--json` mode automation expects a parseable envelope even on a
    // runtime failure; a plain-text `fail()` would break the JSON contract.
    if (flags["json"]) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
