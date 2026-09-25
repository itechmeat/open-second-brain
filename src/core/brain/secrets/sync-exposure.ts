/**
 * Does a Syncthing folder carry the secrets directory to its peers?
 *
 * The `.gitignore` marker `crypto.ts` drops into the secrets directory
 * keeps the keyfile and the ciphertext out of a git commit. Syncthing
 * does not read `.gitignore` files: its only exclusion list is the
 * `.stignore` at the root of the synced folder (plus the files that one
 * `#include`s). A vault inside a Syncthing folder therefore ships the
 * keyfile AND the ciphertext it decrypts to every peer unless that
 * `.stignore` names the directory.
 *
 * This module only DETECTS the gap. It never edits `.stignore`: that file
 * belongs to the operator's sync setup, and a peer-shared ignore list
 * changed behind their back is a sync-topology decision this project does
 * not get to make. The finding names the exact line to add.
 *
 * The matcher is a deliberately small subset of Syncthing's pattern
 * language - `(?i)` / `(?d)` prefixes, `!` negation with first-match-wins,
 * a leading `/` anchoring to the folder root, `*`, `**`, `?`, and one level
 * of `#include` - so an unusual spelling can read as uncovered. That is the
 * safe direction for a warning: a false alarm costs one line in `.stignore`,
 * a false all-clear costs the key.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { secretsDir } from "./store.ts";

/** The marker Syncthing keeps at the root of every synced folder. */
const STFOLDER_MARKER = ".stfolder";
/** The folder-root ignore list, the only one Syncthing reads. */
const STIGNORE_FILE = ".stignore";

export interface SecretsSyncExposure {
  /** Root of the Syncthing folder the vault sits in. */
  readonly folderRoot: string;
  /** The `.stignore` that should cover the secrets directory (may not exist). */
  readonly stignorePath: string;
  /** The line to add to it, anchored at the folder root. */
  readonly suggestedPattern: string;
}

/**
 * The Syncthing folder root at or above `vault`, or null. Walks up
 * because a vault is often one subdirectory of a larger synced folder.
 */
function syncthingFolderRoot(vault: string): string | null {
  let dir = resolve(vault);
  for (;;) {
    if (existsSync(join(dir, STFOLDER_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface IgnorePattern {
  readonly negated: boolean;
  readonly regex: RegExp;
  readonly anchored: boolean;
}

function globToRegex(glob: string, caseInsensitive: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, caseInsensitive ? "i" : "");
}

function readPatterns(file: string, root: string, depth: number): IgnorePattern[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: IgnorePattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("#include ")) {
      if (depth === 0) {
        out.push(...readPatterns(join(root, line.slice("#include ".length).trim()), root, 1));
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    let negated = false;
    let caseInsensitive = false;
    for (;;) {
      if (line.startsWith("!")) {
        negated = true;
        line = line.slice(1);
      } else if (line.startsWith("(?i)")) {
        caseInsensitive = true;
        line = line.slice(4);
      } else if (line.startsWith("(?d)")) {
        line = line.slice(4);
      } else break;
    }
    const anchored = line.startsWith("/");
    const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (body === "") continue;
    out.push({ negated, anchored, regex: globToRegex(body, caseInsensitive) });
  }
  return out;
}

/** Syncthing's verdict on one folder-relative path: first match wins. */
function isIgnored(patterns: ReadonlyArray<IgnorePattern>, relPath: string): boolean {
  const segments = relPath.split("/");
  for (const p of patterns) {
    // An unanchored pattern matches at any depth, so it is tried against
    // every trailing run of segments.
    const candidates = p.anchored ? [relPath] : segments.map((_, i) => segments.slice(i).join("/"));
    if (candidates.some((c) => p.regex.test(c))) return !p.negated;
  }
  return false;
}

/**
 * The exposure, or null when there is none to report: no secrets
 * directory, no Syncthing folder around the vault, or a `.stignore` that
 * already ignores the directory or one of its ancestors.
 */
export function secretsSyncExposure(vault: string): SecretsSyncExposure | null {
  const dir = secretsDir(vault);
  if (!existsSync(dir)) return null;
  // Syncthing walks real directories and does not follow symbolic links,
  // so the question is asked of the real paths: a vault reached through a
  // link (`~/vault -> ~/Sync/notes/vault`) sits in the synced folder its
  // target sits in, and a secrets directory that links out of the folder
  // is not carried by it.
  const realDir = realPathOrResolved(dir);
  const root = syncthingFolderRoot(realPathOrResolved(vault));
  if (root === null) return null;
  const relNative = relative(root, realDir);
  if (relNative === "" || relNative === ".." || relNative.startsWith(`..${sep}`)) return null;
  const rel = relNative.split(sep).join("/");
  const stignorePath = join(root, STIGNORE_FILE);
  const patterns = readPatterns(stignorePath, root, 0);
  // Ignoring any ancestor inside the folder ignores the directory too.
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (isIgnored(patterns, parts.slice(0, i).join("/"))) return null;
  }
  return { folderRoot: root, stignorePath, suggestedPattern: `/${rel}` };
}

/**
 * The real path of an existing `path`, or its resolved form when the real
 * path cannot be read. Falling back keeps the check running, and the
 * lexical answer is the one this module gave before it read real paths.
 */
function realPathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** One sentence naming the gap and the operator's fix. */
export function formatSecretsSyncExposure(exposure: SecretsSyncExposure): string {
  return (
    `the secrets directory sits inside a Syncthing folder (${exposure.folderRoot}) whose ` +
    `${STIGNORE_FILE} does not ignore it, so the keyfile and the ciphertext it decrypts sync ` +
    `to every peer (Syncthing does not read .gitignore). Add this line to ` +
    `${exposure.stignorePath}: ${exposure.suggestedPattern}`
  );
}
