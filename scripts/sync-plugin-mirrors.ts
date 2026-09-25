#!/usr/bin/env bun
/**
 * Mirror the shared plugin assets into the Codex plugin subtree.
 *
 * Codex's marketplace source is `./plugins/codex` (`.agents/plugins/
 * marketplace.json`), and `codex plugin add` copies only that subtree into
 * `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`. The copy
 * DROPS symlinks. `plugins/codex/hooks` and `plugins/codex/skills` used to
 * be symlinks into the repo root, so every installed Codex plugin had no
 * hooks and no skills. Every Codex run also warned `failed to read plugin
 * hooks config .../hooks/hooks.json`. Symlinks are fragile on Windows too:
 * without Developer Mode or `core.symlinks`, git checks one out as a plain
 * text file that holds the target path.
 *
 * So the Codex plugin ships real files, and this script keeps them in step
 * with their source. It follows the shape of `scripts/sync-version.ts`: the
 * write form and the `--check` form are the same code path, so what CI
 * detects and what the write form produces cannot diverge.
 *
 * What is mirrored, and what is deliberately NOT:
 *   - `skills/**` -> `plugins/codex/skills/**`, every file, byte for byte.
 *   - `hooks/hooks.json` -> `plugins/codex/hooks/hooks.json`, with one
 *     Codex-specific change: SessionEnd timeouts are capped at
 *     {@link CODEX_SESSION_END_TIMEOUT_CAP_SEC}. Codex clamps them there
 *     anyway, and warns on every run while the file asks for more.
 *   - NOT `hooks/*.ts`. The hook commands run `o2b-hook <name>`, which
 *     resolves the checkout that holds `hooks/<name>.ts` (see
 *     `scripts/o2b-hook`). Codex exports `CLAUDE_PLUGIN_ROOT` as the cache
 *     dir, so a copied script there would win that resolution and then
 *     fail on its `../src` imports, which the cache does not have. Without
 *     the scripts, resolution falls through to the real checkout.
 *
 * Usage:
 *   bun run scripts/sync-plugin-mirrors.ts          # rewrite the mirrors
 *   bun run scripts/sync-plugin-mirrors.ts --check  # exit 1 on drift, no writes
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The longest SessionEnd hook timeout Codex honours, in seconds. Codex
 * 0.157.0 clamps a longer one and warns `clamping SessionEnd hook timeout
 * to 3s` on every run.
 */
export const CODEX_SESSION_END_TIMEOUT_CAP_SEC = 3;

export interface MirrorSpec {
  /** Source, relative to the repo root: a directory or a single file. */
  readonly source: string;
  /** Destination, relative to the repo root. */
  readonly target: string;
  /** Derives the mirrored bytes from the source bytes. Absent: a byte copy. */
  readonly transform?: (source: string) => string;
}

interface HookGroup {
  hooks?: Array<{ timeout?: number }>;
}

/** `hooks/hooks.json` as Codex should read it. Formatting matches the source (oxfmt). */
export function codexHooksJson(source: string): string {
  const doc = JSON.parse(source) as { hooks?: Record<string, HookGroup[]> };
  for (const group of doc.hooks?.["SessionEnd"] ?? []) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.timeout === "number" && hook.timeout > CODEX_SESSION_END_TIMEOUT_CAP_SEC) {
        hook.timeout = CODEX_SESSION_END_TIMEOUT_CAP_SEC;
      }
    }
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export const MIRRORS: ReadonlyArray<MirrorSpec> = [
  { source: "skills", target: "plugins/codex/skills" },
  {
    source: "hooks/hooks.json",
    target: "plugins/codex/hooks/hooks.json",
    transform: codexHooksJson,
  },
];

/** Directories the mirrors own outright: a file in them that no spec produces is drift. */
export const MIRROR_DIRS: ReadonlyArray<string> = ["plugins/codex/skills", "plugins/codex/hooks"];

export interface Drift {
  readonly path: string;
  readonly reason: "missing" | "differs" | "extra" | "symlink";
}

interface Pair {
  readonly source: string;
  readonly target: string;
  readonly transform?: (source: string) => string;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every regular file under `dir`, relative to it, sorted. Symlinks are collected, not followed. */
function listFiles(dir: string, symlinks: string[], base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) symlinks.push(full);
    else if (st.isDirectory()) out.push(...listFiles(full, symlinks, base));
    else if (st.isFile()) out.push(toPosix(relative(base, full)));
  }
  return out;
}

/** The (source, target) file pairs every mirror spec expands to. */
function expectedPairs(root: string): Pair[] {
  const pairs: Pair[] = [];
  for (const spec of MIRRORS) {
    const src = join(root, spec.source);
    if (!lstatSync(src).isDirectory()) {
      pairs.push(spec);
      continue;
    }
    const symlinks: string[] = [];
    for (const rel of listFiles(src, symlinks)) {
      pairs.push({ source: `${spec.source}/${rel}`, target: `${spec.target}/${rel}` });
    }
    if (symlinks.length > 0) {
      const names = symlinks.map((s) => toPosix(relative(root, s))).join(", ");
      throw new Error(
        `mirror source ${spec.source} contains symlinks (${names}); Codex drops them`,
      );
    }
  }
  return pairs;
}

/** The bytes a mirrored file must hold. */
function expectedBytes(root: string, pair: Pair): Buffer {
  const raw = readFileSync(join(root, pair.source));
  return pair.transform === undefined
    ? raw
    : Buffer.from(pair.transform(raw.toString("utf8")), "utf8");
}

/** Compare the mirrors against their sources without writing. */
export function findDrift(root: string = ROOT): Drift[] {
  const drift: Drift[] = [];
  const pairs = expectedPairs(root);
  const expectedTargets = new Set(pairs.map((p) => p.target));
  const linkedDirs: string[] = [];

  for (const dir of MIRROR_DIRS) {
    const full = join(root, dir);
    if (isSymlink(full)) {
      drift.push({ path: dir, reason: "symlink" });
      linkedDirs.push(dir);
      continue;
    }
    if (!existsSync(full)) continue;
    const symlinks: string[] = [];
    for (const rel of listFiles(full, symlinks)) {
      const path = `${dir}/${rel}`;
      if (!expectedTargets.has(path)) drift.push({ path, reason: "extra" });
    }
    for (const s of symlinks) drift.push({ path: toPosix(relative(root, s)), reason: "symlink" });
  }

  for (const pair of pairs) {
    if (linkedDirs.some((d) => pair.target.startsWith(`${d}/`))) continue;
    const dst = join(root, pair.target);
    if (!existsSync(dst)) drift.push({ path: pair.target, reason: "missing" });
    else if (!expectedBytes(root, pair).equals(readFileSync(dst))) {
      drift.push({ path: pair.target, reason: "differs" });
    }
  }
  return drift;
}

/** Rebuild every mirror from its source. Returns the number of files written. */
export function writeMirrors(root: string = ROOT): number {
  const pairs = expectedPairs(root);
  const contents = pairs.map((pair) => expectedBytes(root, pair));
  for (const dir of MIRROR_DIRS) rmSync(join(root, dir), { recursive: true, force: true });
  pairs.forEach((pair, i) => {
    const dst = join(root, pair.target);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, contents[i]!);
  });
  return pairs.length;
}

function main(argv: ReadonlyArray<string>): number {
  if (!argv.includes("--check")) {
    const n = writeMirrors();
    process.stdout.write(`wrote ${n} mirrored file(s) into plugins/codex\n`);
    return 0;
  }
  const drift = findDrift();
  if (drift.length === 0) {
    process.stdout.write("plugin mirrors: ok\n");
    return 0;
  }
  for (const d of drift) process.stderr.write(`  DRIFT (${d.reason}): ${d.path}\n`);
  process.stderr.write(`\n${drift.length} drifted path(s); run: bun run sync-plugin-mirrors\n`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
