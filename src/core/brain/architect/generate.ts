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
import { buildRegionDocument, mergeRegions } from "../regions.ts";
import type { Region } from "../regions.ts";
import { scanProject } from "./scan.ts";
import type { ModuleFact, ProjectFacts } from "./scan.ts";

export interface GenerateArchDocsResult {
  readonly repoKey: string;
  readonly dir: string;
  readonly overviewPath: string;
  readonly modulePaths: ReadonlyArray<string>;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

function languagesLine(languages: Readonly<Record<string, number>>): string {
  const entries = Object.entries(languages).toSorted(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
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

/** Generate or refresh architecture notes for one project tree. */
export function generateArchDocs(vault: string, projectRoot: string): GenerateArchDocsResult {
  const facts = scanProject(projectRoot);
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

  const overviewPath = join(dir, "overview.md");
  tally(
    upsertNote(
      overviewPath,
      frontmatter("arch-overview", key, [`repo_path: ${facts.root}`]),
      overviewRegions(facts, key),
    ),
  );

  const modulePaths: string[] = [];
  for (const module of facts.modules) {
    const path = join(dir, "modules", `${module.name}.md`);
    modulePaths.push(path);
    tally(
      upsertNote(
        path,
        frontmatter("arch-module", key, [`module: ${module.name}`]),
        moduleRegions(module),
      ),
    );
  }

  return Object.freeze({
    repoKey: key,
    dir,
    overviewPath,
    modulePaths: Object.freeze(modulePaths),
    created,
    updated,
    unchanged,
  });
}
