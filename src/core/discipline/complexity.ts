import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface ComplexityFactor {
  readonly name: string;
  readonly value: number;
  readonly weight: number;
}

export interface ComplexityReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly score: number;
  readonly ratio: number;
  readonly thinking_activity: number;
  readonly structural_complexity: number;
  readonly warning: boolean;
  readonly factors: ReadonlyArray<ComplexityFactor>;
}

export interface BuildComplexityReportInput {
  readonly thinkingActivity: number;
  readonly structuralFilesChanged: number;
  readonly maxFolderDepth?: number;
  readonly templateChanges?: number;
  readonly configChanges?: number;
  readonly tagProliferation?: number;
}

export interface BuildComplexityReportOptions {
  readonly now?: Date;
}

export interface ComplexityChangedPath {
  readonly root: string;
  readonly relativePath: string;
}

export interface ComplexityPathFactors {
  readonly maxFolderDepth: number;
  readonly templateChanges: number;
  readonly configChanges: number;
  readonly tagProliferation: number;
}

const WARNING_RATIO = 4;
const WARNING_SCORE = 8;

export function buildComplexityReport(
  input: BuildComplexityReportInput,
  options: BuildComplexityReportOptions = {},
): ComplexityReport {
  const now = options.now ?? new Date();
  const factors: ComplexityFactor[] = [
    {
      name: "structural_files_changed",
      value: input.structuralFilesChanged,
      weight: 1,
    },
    { name: "max_folder_depth", value: input.maxFolderDepth ?? 0, weight: 1 },
    { name: "template_changes", value: input.templateChanges ?? 0, weight: 2 },
    { name: "config_changes", value: input.configChanges ?? 0, weight: 2 },
    {
      name: "tag_proliferation",
      value: input.tagProliferation ?? 0,
      weight: 1,
    },
  ].filter((factor) => factor.value > 0);
  const structuralComplexity = factors.reduce(
    (total, factor) => total + factor.value * factor.weight,
    0,
  );
  const thinkingActivity = Math.max(0, input.thinkingActivity);
  const ratio = structuralComplexity / Math.max(1, thinkingActivity);
  const warning = structuralComplexity >= WARNING_SCORE && ratio >= WARNING_RATIO;

  return Object.freeze({
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    score: structuralComplexity,
    ratio,
    thinking_activity: thinkingActivity,
    structural_complexity: structuralComplexity,
    warning,
    factors: Object.freeze(factors),
  });
}

export function complexityPathFactors(
  changedPaths: ReadonlyArray<ComplexityChangedPath>,
): ComplexityPathFactors {
  let maxFolderDepth = 0;
  let templateChanges = 0;
  let configChanges = 0;
  const tags = new Set<string>();

  for (const changedPath of changedPaths) {
    const relativePath = normaliseRelativePath(changedPath.relativePath);
    maxFolderDepth = Math.max(maxFolderDepth, folderDepth(relativePath));
    if (isTemplatePath(relativePath)) templateChanges += 1;
    if (isConfigPath(relativePath)) configChanges += 1;
    for (const tag of tagsInChangedMarkdown(changedPath.root, relativePath)) {
      tags.add(tag);
    }
  }

  return {
    maxFolderDepth,
    templateChanges,
    configChanges,
    tagProliferation: tags.size,
  };
}

function normaliseRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

function folderDepth(relativePath: string): number {
  const parts = relativePath.split("/").filter(Boolean);
  return Math.max(0, parts.length - 1);
}

function isTemplatePath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.toLowerCase().includes("template"));
}

function isConfigPath(relativePath: string): boolean {
  const lowerPath = relativePath.toLowerCase();
  const fileName = basename(lowerPath);
  return (
    lowerPath.startsWith(".") ||
    lowerPath.includes("/.") ||
    lowerPath.includes(".obsidian/") ||
    fileName === "_brain.yaml" ||
    fileName === "package.json" ||
    fileName === "pyproject.toml" ||
    fileName.endsWith(".config.js") ||
    fileName.endsWith(".config.ts") ||
    fileName.endsWith(".config.json") ||
    fileName.endsWith(".toml") ||
    fileName.endsWith(".yaml") ||
    fileName.endsWith(".yml")
  );
}

function tagsInChangedMarkdown(root: string, relativePath: string): string[] {
  if (!relativePath.toLowerCase().endsWith(".md")) return [];
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  try {
    if (!statSync(absolutePath).isFile()) return [];
    return extractTags(readFileSync(absolutePath, "utf8"));
  } catch {
    return [];
  }
}

function extractTags(text: string): string[] {
  const tags = new Set<string>();
  const lines = text.split(/\r?\n/);
  collectFrontmatterTags(lines, tags);
  const inlineTag = /(^|\s)#([A-Za-z0-9][A-Za-z0-9_/-]*)/g;
  for (const match of text.matchAll(inlineTag)) {
    tags.add(match[2]!.toLowerCase());
  }
  return [...tags].toSorted();
}

function collectFrontmatterTags(lines: string[], tags: Set<string>): void {
  if (lines[0] !== "---") return;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "---") return;
    const inline = line.match(/^tags:\s*\[(.*)]\s*$/i);
    if (inline) {
      for (const tag of inline[1]!.split(",")) addTag(tags, tag);
      continue;
    }
    if (/^tags:\s*$/i.test(line)) {
      collectFrontmatterTagList(lines, index + 1, tags);
      return;
    }
    const scalar = line.match(/^tags:\s*(\S.*)$/i);
    if (scalar) addTag(tags, scalar[1]!);
  }
}

function collectFrontmatterTagList(lines: string[], startIndex: number, tags: Set<string>): void {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "---" || /^\S/.test(line)) return;
    const item = line.match(/^\s*-\s*(\S.*)$/);
    if (item) addTag(tags, item[1]!);
  }
}

function addTag(tags: Set<string>, raw: string): void {
  const tag = raw
    .trim()
    .replace(/^#/, "")
    .replace(/^['"]|['"]$/g, "");
  if (tag.length > 0) tags.add(tag.toLowerCase());
}
