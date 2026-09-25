/**
 * `o2b brain knowledge-pack <export|preview|install|uninstall|list>` -
 * portable, privacy-scanned subsets of Brain knowledge (upstream task
 * t_d037251c). The mechanics live in
 * `src/core/brain/portability/knowledge-pack.ts`; this verb owns the
 * operator surface and the egress boundary.
 *
 * Named `knowledge-pack`, not `pack`, because `schema` packs (the
 * `_brain.yaml` vocabulary block, `schema_inspect view=packs`) are a
 * different thing and must never share a verb.
 *
 * `export` is the only subcommand that writes outside the vault. Its
 * content goes through the shared egress guard (registry entry
 * `brain-knowledge-pack-export`) BEFORE it is sealed, so the sha256 table
 * in `knowledge-pack.json` hashes the bytes that actually left: the OKF
 * manifest and the preference rows are scanned as trees, the page files as
 * text, exactly as `okf-export` and `bank-export` scan them.
 */

import {
  installKnowledgePack,
  KnowledgePackError,
  listInstalledKnowledgePacks,
  previewKnowledgePack,
  readKnowledgePack,
  sealKnowledgePack,
  selectKnowledgePack,
  uninstallKnowledgePack,
  type KnowledgePackPreview,
} from "../../../core/brain/portability/knowledge-pack.ts";
import { writeOkfBundle } from "../../../core/brain/portability/okf.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, info, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain knowledge-pack export --name <name> --select <sel>[,<sel>…] --out <dir> [--version <v>] [--force] [--json]\n" +
  "       o2b brain knowledge-pack preview <pack-dir> [--json]\n" +
  "       o2b brain knowledge-pack install <pack-dir> [--agent <name>] [--json]\n" +
  "       o2b brain knowledge-pack uninstall <name> [--confirm] [--json]\n" +
  "       o2b brain knowledge-pack list [--json]";

export async function cmdBrainKnowledgePack(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case "export":
        return exportPack(rest);
      case "preview":
        return previewPack(rest);
      case "install":
        return installPack(rest);
      case "uninstall":
        return uninstallPack(rest);
      case "list":
        return listPacks(rest);
      default:
        return fail(USAGE);
    }
  } catch (exc) {
    if (exc instanceof KnowledgePackError) return fail(`knowledge-pack ${sub}: ${exc.message}`);
    return fail(`knowledge-pack ${sub ?? ""} failed: ${(exc as Error).message ?? exc}`);
  }
}

function exportPack(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    select: { type: "string-array" },
    out: { type: "string" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const name = flags["name"] as string | undefined;
  const out = flags["out"] as string | undefined;
  if (name === undefined || out === undefined) {
    return fail("knowledge-pack export requires --name <name> and --out <dir>");
  }
  const select = (flags["select"] as string[] | undefined) ?? [];

  const selected = selectKnowledgePack(vault, select);
  const verdict = redactForEgress("brain-knowledge-pack-export", {
    okfManifest: selected.okfManifest,
    pageFiles: selected.pageFiles,
    preferences: selected.preferences,
  });
  if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);

  const sealed = sealKnowledgePack({
    name,
    version: (flags["version"] as string | undefined) ?? "1",
    selection: selected.selection,
    okfManifest: verdict.payload.okfManifest,
    pageFiles: verdict.payload.pageFiles,
    preferences: verdict.payload.preferences,
  });
  writeOkfBundle(
    out,
    { manifest: verdict.payload.okfManifest, files: sealed.files },
    { force: flags["force"] === true },
  );

  if (flags["json"]) {
    okJson({
      out,
      name: sealed.manifest.name,
      version: sealed.manifest.version,
      digest: sealed.manifest.integrity.digest,
      preferences: verdict.payload.preferences.length,
      pages: verdict.payload.okfManifest.pages.length,
      blocked: selected.blocked,
      warnings: selected.warnings,
      redacted: verdict.redacted,
    });
  } else {
    ok(
      `wrote knowledge pack ${sealed.manifest.name}@${sealed.manifest.version} to ${out} ` +
        `(${verdict.payload.preferences.length} preference(s), ` +
        `${verdict.payload.okfManifest.pages.length} page(s)); sha256 ${sealed.manifest.integrity.digest}`,
    );
    for (const b of selected.blocked) info(`  blocked ${b.kind} ${b.id}: ${b.reason}`);
    for (const w of selected.warnings) info(`  warning ${w.kind} ${w.id}: ${w.reasons.join(", ")}`);
  }
  if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  return 0;
}

function renderPreview(preview: KnowledgePackPreview): void {
  ok(`knowledge pack ${preview.name}@${preview.version} (stamp ${preview.stamp})`);
  ok(
    `  integrity: ${preview.integrity.verified ? "verified" : "FAILED"} (sha256 ${preview.integrity.declared})`,
  );
  for (const p of preview.integrity.problems) info(`    - ${p}`);
  ok(
    `  ${preview.count} entr${preview.count === 1 ? "y" : "ies"}: ` +
      `${preview.counts.preferences} preference(s), ${preview.counts.pages} page(s)`,
  );
  for (const e of preview.entries) {
    const status = e.status !== null ? ` [source status: ${e.status}]` : "";
    info(`  - ${e.kind} ${e.id} -> ${e.target}${status}`);
    info(`      ${e.sample.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  if (preview.conflicts.length > 0) {
    ok(`  conflicts: ${preview.conflicts.length}`);
    for (const c of preview.conflicts) info(`    - ${c.kind} ${c.id}: ${c.reason} (${c.detail})`);
  }
  if (preview.privacyWarnings.length > 0) {
    ok(`  privacy warnings: ${preview.privacyWarnings.length}`);
    for (const w of preview.privacyWarnings) {
      info(`    - ${w.kind} ${w.id}: ${w.reasons.join(", ")}`);
    }
  }
  info("  preferences install unconfirmed (fresh trial window); pages stage under OKF Review/");
}

function previewPack(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const dir = positional[0];
  if (dir === undefined) return fail("usage: o2b brain knowledge-pack preview <pack-dir> [--json]");
  const { vault } = brainVerbContext(flags);
  const preview = previewKnowledgePack(vault, readKnowledgePack(dir));
  if (flags["json"]) okJson({ ...preview });
  else renderPreview(preview);
  // A pack that fails its own integrity check is not something to install;
  // the preview still prints so the operator can see why.
  return preview.integrity.verified ? 0 : 1;
}

function installPack(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const dir = positional[0];
  if (dir === undefined) return fail("usage: o2b brain knowledge-pack install <pack-dir>");
  const { vault, config } = brainVerbContext(flags);
  const result = installKnowledgePack(vault, readKnowledgePack(dir), {
    agent: resolveBrainAgent(flags, config),
  });
  const failures = result.preferences.failed.length + result.pages.errors.length;
  if (flags["json"]) {
    okJson({ ...result });
  } else {
    ok(`installed knowledge pack ${result.name}@${result.version} (stamp ${result.stamp})`);
    ok(
      `  preferences: ${result.preferences.installed.length} of ${result.preferences.carried} ` +
        `installed unconfirmed, ${result.preferences.conflicts.length} conflict(s), ` +
        `${result.preferences.failed.length} failed`,
    );
    for (const c of result.preferences.conflicts) info(`    - ${c.id}: ${c.reason} (${c.detail})`);
    for (const f of result.preferences.failed) {
      info(`    - ${f.id ?? `#${f.index}`}: ${f.reason} (${f.detail})`);
    }
    for (const c of result.preferences.topicKeyCollisions) {
      info(`    - topic key '${c.key}' is claimed by ${c.prefIds.join(", ")}`);
    }
    ok(
      `  pages: ${result.pages.written.length} staged for review, ` +
        `${result.pages.skipped.length} skipped, ${result.pages.errors.length} error(s)`,
    );
    for (const e of result.pages.errors) info(`    - ${e.path}: ${e.message}`);
    for (const w of result.privacyWarnings) {
      info(`  warning ${w.kind} ${w.id}: ${w.reasons.join(", ")}`);
    }
  }
  return failures > 0 ? 1 : 0;
}

function uninstallPack(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    confirm: { type: "boolean" },
    json: { type: "boolean" },
  });
  const name = positional[0];
  if (name === undefined)
    return fail("usage: o2b brain knowledge-pack uninstall <name> [--confirm]");
  const { vault, config } = brainVerbContext(flags);
  const plan = uninstallKnowledgePack(vault, name, {
    confirm: flags["confirm"] === true,
    agent: resolveBrainAgent(flags, config),
  });
  if (flags["json"]) {
    okJson({ ...plan });
    return 0;
  }
  ok(`knowledge-pack uninstall${plan.confirmed ? "" : " (DRY RUN)"}: ${plan.name}`);
  ok(
    `  ${plan.remove.length} entr${plan.remove.length === 1 ? "y" : "ies"} ${plan.confirmed ? "removed" : "WOULD be removed"}:`,
  );
  for (const e of plan.remove) ok(`    - ${e.path} (${e.kind}, ${e.stamp})`);
  if (plan.kept.length > 0) {
    info(`  ${plan.kept.length} entr${plan.kept.length === 1 ? "y" : "ies"} kept:`);
    for (const k of plan.kept) info(`    - ${k.entry.path} (${k.reason})`);
  }
  if (plan.snapshotRunId !== null) {
    ok(`  recovery point: snapshot ${plan.snapshotRunId}`);
    if (plan.recoverability.blockers.length > 0) {
      info(
        `    coverage: ${plan.recoverability.state} ` +
          `(not covered: ${plan.recoverability.blockers.join(", ")}; re-install the pack to restore staged pages)`,
      );
    }
  }
  if (plan.auditRecordId !== null) ok(`  audit: ${plan.auditRecordId}`);
  if (!plan.confirmed) info("  re-run with --confirm to remove");
  return 0;
}

function listPacks(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const packs = listInstalledKnowledgePacks(vault);
  if (flags["json"]) {
    okJson({ packs });
    return 0;
  }
  if (packs.length === 0) {
    ok("no knowledge packs installed");
    return 0;
  }
  for (const pack of packs) {
    ok(
      `${pack.name} (${pack.stamps.join(", ")}): ${pack.entries.length} entr${pack.entries.length === 1 ? "y" : "ies"}`,
    );
    for (const e of pack.entries) info(`  - ${e.kind} ${e.path} [${e.state}]`);
  }
  return 0;
}
