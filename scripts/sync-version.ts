#!/usr/bin/env bun
/**
 * Propagate the version from `package.json` to the runtime manifests.
 *
 * `package.json` is the single source of truth in v0.7+. Manifests
 * consumed by external runtimes (Hermes, OpenClaw, Claude Code, Codex,
 * pip) carry a copy on disk for parity with their schemas.
 *
 * Files NOT touched (matches the legacy Python script's design):
 *   - `CHANGELOG.md` — historical record, edited by hand on release.
 *   - `install.md` / `docs/architecture.md` — install commands MUST NOT
 *     pin a specific tag; they always pull the latest.
 *   - `tests/` — fixtures may reference specific historical versions.
 *
 * Usage:
 *   bun run scripts/sync-version.ts          # write changes
 *   bun run scripts/sync-version.ts --check  # exit 1 on drift, no writes
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const YAML_TARGETS = ["plugin.yaml", "plugins/hermes/plugin.yaml"] as const;
const JSON_TARGETS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  "openclaw.plugin.json",
] as const;
const PYPROJECT = "pyproject.toml";

const YAML_RE = /^(version:\s*)"[^"]*"/m;
const JSON_RE = /("version"\s*:\s*)"[^"]*"/;
const PYPROJECT_RE = /^(version\s*=\s*)"[^"]*"/m;

interface FileSpec {
  readonly rel: string;
  readonly regex: RegExp;
}

const TARGETS: FileSpec[] = [
  ...YAML_TARGETS.map((rel) => ({ rel, regex: YAML_RE })),
  ...JSON_TARGETS.map((rel) => ({ rel, regex: JSON_RE })),
  { rel: PYPROJECT, regex: PYPROJECT_RE },
];

function canonicalVersion(): string {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json is missing a top-level 'version' field");
  }
  return pkg.version;
}

function replace(text: string, regex: RegExp, version: string): string {
  return text.replace(regex, `$1"${version}"`);
}

interface UpdateResult {
  readonly matched: boolean;
  readonly wouldChange: boolean;
}

function updateFile(rel: string, regex: RegExp, version: string, write: boolean): UpdateResult {
  const path = `${ROOT}/${rel}`;
  const text = readFileSync(path, "utf8");
  if (!regex.test(text)) return { matched: false, wouldChange: false };
  const updated = replace(text, regex, version);
  if (updated === text) return { matched: true, wouldChange: false };
  if (write) writeFileSync(path, updated, "utf8");
  return { matched: true, wouldChange: true };
}

function main(argv: ReadonlyArray<string>): number {
  const check = argv.includes("--check");
  const version = canonicalVersion();
  process.stdout.write(`canonical version: ${version}\n`);

  const drifted: string[] = [];
  const unmatched: string[] = [];
  for (const { rel, regex } of TARGETS) {
    const { matched, wouldChange } = updateFile(rel, regex, version, !check);
    if (!matched) {
      process.stderr.write(`  WARN no version line in ${rel}\n`);
      unmatched.push(rel);
      continue;
    }
    if (wouldChange) {
      drifted.push(rel);
      process.stdout.write(`  ${check ? "DRIFT" : "wrote"}: ${rel}\n`);
    } else {
      process.stdout.write(`  ok:    ${rel}\n`);
    }
  }

  if (check && (drifted.length > 0 || unmatched.length > 0)) {
    process.stderr.write(
      `\n${drifted.length} drifted, ${unmatched.length} unmatched target(s); ` +
        "run scripts/sync-version.ts and add the missing version field where needed.\n",
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
