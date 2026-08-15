/**
 * Architecture docs generator (Project History Suite, t_929da8a2).
 *
 * Renders scanProject facts into vault notes under
 * `Brain/projects/arch/<repo-key>/`: one overview plus one note per
 * detected module, all generated content inside sentinel regions.
 * Regeneration goes through mergeRegions, so operator prose outside
 * regions survives byte-for-byte, and an unchanged project regenerates
 * byte-identically (the scanner is deterministic and the renderer adds
 * no timestamps).
 *
 * Frontmatter is written ONCE at file creation and never rewritten -
 * it carries static identity (kind, repo key, path), while every fact
 * that can change between scans lives inside a region.
 *
 * Module REMOVAL keeps the old module note on disk (the operator may
 * have annotated it); the overview's module region reflects only the
 * current scan, so stale notes become unlinked rather than deleted.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { repoKey as deriveRepoKey } from "../git/identity.ts";
import { OPERATION, progressCounter, progressReasonForError } from "../progress.ts";
import type { ProgressCounter, ProgressSink } from "../progress.ts";
import { buildRegionDocument, mergeRegions } from "../regions.ts";
import type { Region } from "../regions.ts";
import type { Safeguard } from "../safeguard.ts";
import { ARCHITECT_STAGE, scanProject } from "./scan.ts";
import type { ModuleFact, ProjectFacts } from "./scan.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export interface GenerateArchDocsOptions {
  /** Where a caller watches the run. Absence means nobody asked. */
  readonly onProgress?: ProgressSink;
  /** Cooperative deadline, checked per directory read and per note. */
  readonly safeguard?: Safeguard;
}

export interface GenerateArchDocsResult {
  readonly repoKey: string;
  readonly dir: string;
  readonly overviewPath: string;
  readonly modulePaths: ReadonlyArray<string>;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /**
   * The message of the first failure of the caller's progress sink, or
   * `null` when there was none (and when no sink was supplied).
   *
   * An observer must not be able to destroy what it observes - a closed
   * pipe cannot be allowed to abort a generation that is otherwise
   * succeeding - but it must not vanish either, so the fault is carried
   * out on the result the caller already reads and the sink is detached
   * for the rest of the run. Only the first is reported: after it there
   * is no attached sink left to fail again.
   */
  readonly progressFault: string | null;
}

/**
 * Codepoint order, not `localeCompare`: ICU collation varies with the
 * runtime locale, so a collator-based tie-break renders different bytes
 * for the same tree on two hosts - and byte-identical regeneration is
 * this module's whole contract. Every other ordering in the scanner
 * already uses plain `toSorted()`; this is the one that did not.
 */
function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function languagesLine(languages: Readonly<Record<string, number>>): string {
  const entries = Object.entries(languages).toSorted(
    (a, b) => b[1] - a[1] || compareStable(a[0], b[0]),
  );
  if (entries.length === 0) return "none detected";
  return entries
    .slice(0, 8)
    .map(([ext, count]) => `${ext} (${count})`)
    .join(", ");
}

function overviewRegions(facts: ProjectFacts, key: string): ReadonlyArray<Region> {
  const summary = [
    `Project: ${facts.name}`,
    ...(facts.manifest?.version != null ? [`Version: ${facts.manifest.version}`] : []),
    ...(facts.manifest?.description != null ? [`Description: ${facts.manifest.description}`] : []),
    `Files: ${facts.totalFiles}`,
    `Languages: ${languagesLine(facts.languages)}`,
    ...(facts.testLayout !== null ? [`Test layout: ${facts.testLayout}/`] : []),
  ].join("\n");

  const modules = facts.modules
    .map(
      (module) =>
        `- [[Brain/projects/arch/${key}/modules/${module.name}|${module.name}]] ` +
        `(${module.path}, ${module.files} file(s))`,
    )
    .join("\n");

  const entryPoints =
    facts.entryPoints.length === 0
      ? "none detected"
      : facts.entryPoints.map((entry) => `- \`${entry}\``).join("\n");

  const dependencies =
    facts.manifest === null || facts.manifest.dependencies.length === 0
      ? "none declared"
      : facts.manifest.dependencies.map((dep) => `- ${dep}`).join("\n");

  return [
    { id: "summary", body: summary },
    { id: "modules", body: modules },
    { id: "entry-points", body: entryPoints },
    { id: "dependencies", body: dependencies },
  ];
}

function moduleRegions(module: ModuleFact): ReadonlyArray<Region> {
  const facts = [
    `Path: ${module.path}`,
    `Files: ${module.files}`,
    `Languages: ${languagesLine(module.languages)}`,
  ].join("\n");
  const files =
    module.topFiles.length === 0
      ? "empty module"
      : module.topFiles.map((file) => `- \`${file}\``).join("\n");
  return [
    { id: "facts", body: facts },
    { id: "files", body: files },
  ];
}

function frontmatter(kind: string, key: string, extra: ReadonlyArray<string>): string {
  return ["---", `kind: ${kind}`, `repo_key: ${key}`, ...extra, "---", ""].join("\n");
}

/**
 * Write or refresh one region-bearing note. Returns its disposition.
 * Throws RegionError (fail-closed) when the existing file's sentinels
 * are corrupted - the file is never partially rewritten.
 */
function upsertNote(
  path: string,
  head: string,
  regions: ReadonlyArray<Region>,
): "created" | "updated" | "unchanged" {
  if (!existsSync(path)) {
    atomicWriteFileSync(path, `${head}\n${buildRegionDocument(regions)}`);
    return "created";
  }
  const existing = readFileSync(path, "utf8");
  const merged = mergeRegions(existing, regions);
  if (merged === existing) return "unchanged";
  atomicWriteFileSync(path, merged);
  return "updated";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Generate or refresh architecture notes for one project tree. */
export function generateArchDocs(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions = {},
): GenerateArchDocsResult {
  const progressFaults: string[] = [];
  const progress = progressCounter(OPERATION.architect, opts.onProgress, {
    onSinkError: (error) => progressFaults.push(errorMessage(error)),
  });
  try {
    return generateRun(vault, projectRoot, opts, progress, progressFaults);
  } catch (error) {
    // A stop the operator asked for, or a deadline that elapsed, is a
    // fact about the run - reported on the stream before the error
    // travels on. Anything else is a failure, and a failure is its own
    // report.
    const reason = progressReasonForError(error);
    if (reason !== null) progress.stop(reason);
    throw error;
  }
}

function generateRun(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions,
  progress: ProgressCounter,
  progressFaults: ReadonlyArray<string>,
): GenerateArchDocsResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const facts = scanProject(projectRoot, { progress, safeguard: opts.safeguard });
  const key = deriveRepoKey(facts.root);
  const dir = join(vault, "Brain", "projects", "arch", key);
  mkdirSync(join(dir, "modules"), { recursive: true });

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const tally = (outcome: "created" | "updated" | "unchanged"): void => {
    if (outcome === "created") created += 1;
    else if (outcome === "updated") updated += 1;
    else unchanged += 1;
  };

  // The note count is known only now, and it is known exactly: one
  // overview plus one note per detected module. Unlike the walk, this
  // stage has a denominator.
  progress.start(ARCHITECT_STAGE.render, 1 + facts.modules.length);

  const overviewPath = join(dir, "overview.md");
  opts.safeguard?.checkpoint();
  tally(
    upsertNote(
      overviewPath,
      frontmatter("arch-overview", key, [`repo_path: ${facts.root}`]),
      overviewRegions(facts, key),
    ),
  );
  progress.advance(ARCHITECT_STAGE.render);

  const modulePaths: string[] = [];
  for (const module of facts.modules) {
    const path = join(dir, "modules", `${module.name}.md`);
    modulePaths.push(path);
    opts.safeguard?.checkpoint();
    tally(
      upsertNote(
        path,
        frontmatter("arch-module", key, [`module: ${module.name}`]),
        moduleRegions(module),
      ),
    );
    progress.advance(ARCHITECT_STAGE.render);
  }
  progress.finish();

  return Object.freeze({
    repoKey: key,
    dir,
    overviewPath,
    modulePaths: Object.freeze(modulePaths),
    created,
    updated,
    unchanged,
    progressFault: progressFaults[0] ?? null,
  });
}
