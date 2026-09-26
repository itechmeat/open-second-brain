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
 *   - `hooks/hooks.json` -> `plugins/codex/hooks/hooks.json`, with two
 *     Codex-specific changes. SessionEnd timeouts are capped at
 *     {@link CODEX_SESSION_END_TIMEOUT_CAP_SEC}: Codex clamps them there
 *     anyway, and warns on every run while the file asks for more. And every
 *     hook gets a `commandWindows` ({@link codexWindowsHookCommand}): on
 *     Windows Codex runs a hook as `%COMSPEC% /C "<command>"`, where the
 *     POSIX `command` cannot parse.
 *   - `LICENSE` and `.codexignore` -> the same names under `plugins/codex/`,
 *     byte for byte, so the subtree Codex installs carries its own license
 *     and ignore list.
 *   - `README.md` and `SECURITY.md` -> the same names under `plugins/codex/`,
 *     with relative links made absolute ({@link withAbsoluteLinks}): the
 *     mirror sits two levels down, where the root's relative links resolve
 *     to nothing.
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
  hooks?: Array<{ command?: string; commandWindows?: string; timeout?: number }>;
}

/**
 * The POSIX hook command, which ends by running the PATH `o2b-hook` shim
 * with the hook's name. The name is the one thing the Windows form needs.
 */
const POSIX_HOOK_COMMAND =
  /command -v o2b-hook >\/dev\/null 2>&1 && exec o2b-hook ([a-z][a-z0-9-]*); exit 0$/;

/**
 * The `commandWindows` form of a hook, which Codex runs through cmd.exe.
 *
 * It calls the PATH `o2b-hook` shim only, the same fallback the POSIX command
 * reaches under Codex (`CLAUDE_PLUGIN_ROOT` is Codex's cache dir, which holds
 * no scripts). `o2b install-cli` writes that shim as `o2b-hook.cmd`.
 *   - `NoDefaultCurrentDirectoryInExePath` is set first: cmd.exe otherwise
 *     looks for `where` and `o2b-hook` in the current directory before PATH,
 *     and Codex runs hooks in the project it opened, so a repository could
 *     ship its own `o2b-hook.cmd`.
 *   - `where /q $PATH:o2b-hook` keeps a missing shim silent. The `$PATH:`
 *     scope matters: a bare `where` searches the current directory too, and
 *     would pass for a planted file that cmd.exe then refuses to run.
 *   - `exit /b 0` keeps any outcome non-blocking, as `exit 0` does in the
 *     POSIX form.
 *   - No double quotes: cmd.exe then strips only the pair Codex wraps the
 *     line in.
 */
export function codexWindowsHookCommand(hook: string): string {
  return `set NoDefaultCurrentDirectoryInExePath=1& where /q $PATH:o2b-hook && o2b-hook ${hook} & exit /b 0`;
}

/** `hooks/hooks.json` as Codex should read it. Formatting matches the source (oxfmt). */
export function codexHooksJson(source: string): string {
  const doc = JSON.parse(source) as { hooks?: Record<string, HookGroup[]> };
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    for (const group of groups) {
      group.hooks = (group.hooks ?? []).map((hook) => {
        if (
          event === "SessionEnd" &&
          typeof hook.timeout === "number" &&
          hook.timeout > CODEX_SESSION_END_TIMEOUT_CAP_SEC
        ) {
          hook.timeout = CODEX_SESSION_END_TIMEOUT_CAP_SEC;
        }
        if (hook.command === undefined) return hook;
        const name = POSIX_HOOK_COMMAND.exec(hook.command)?.[1];
        if (name === undefined) {
          // Fail the sync rather than ship a hook that cmd.exe cannot run.
          throw new Error(
            `${event} hook command does not end in the o2b-hook fallback; ` +
              `cannot derive its Windows form: ${hook.command}`,
          );
        }
        // Rebuilt key by key, so that commandWindows sits right after command.
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(hook)) {
          if (key === "commandWindows") continue;
          out[key] = value;
          if (key === "command") out["commandWindows"] = codexWindowsHookCommand(name);
        }
        return out;
      });
    }
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Where a root document's relative links point once it is mirrored. */
export const REPO_BLOB_URL = "https://github.com/itechmeat/open-second-brain/blob/main";
/** Where its relative images point: `raw`, so GitHub serves the file rather than a page. */
export const REPO_RAW_URL = "https://github.com/itechmeat/open-second-brain/raw/main";

/** A Markdown link or image whose target is repo-relative: not a URL, an anchor or mail. */
const RELATIVE_MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi;

/** A root Markdown document as the Codex subtree carries it: every relative link made absolute. */
export function withAbsoluteLinks(source: string): string {
  return source.replace(
    RELATIVE_MARKDOWN_LINK,
    (_match, bang: string, text: string, target: string) =>
      `${bang}[${text}](${bang === "!" ? REPO_RAW_URL : REPO_BLOB_URL}/${target.replace(/^\.\//, "")})`,
  );
}

export const MIRRORS: ReadonlyArray<MirrorSpec> = [
  { source: "skills", target: "plugins/codex/skills" },
  {
    source: "hooks/hooks.json",
    target: "plugins/codex/hooks/hooks.json",
    transform: codexHooksJson,
  },
  { source: "LICENSE", target: "plugins/codex/LICENSE" },
  { source: ".codexignore", target: "plugins/codex/.codexignore" },
  { source: "README.md", target: "plugins/codex/README.md", transform: withAbsoluteLinks },
  { source: "SECURITY.md", target: "plugins/codex/SECURITY.md", transform: withAbsoluteLinks },
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
    // A symlinked single file reads as identical here, yet Codex drops it.
    if (isSymlink(dst)) drift.push({ path: pair.target, reason: "symlink" });
    else if (!existsSync(dst)) drift.push({ path: pair.target, reason: "missing" });
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
    // Writing through a symlink would leave the link in place.
    if (isSymlink(dst)) rmSync(dst);
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
