/**
 * Every place Open Second Brain starts its own code as a child goes
 * through one helper (`src/core/maintenance/o2b-command.ts`), which runs
 * the child under the runtime of this process by its absolute path
 * (`process.execPath`) and never looks Bun up on PATH. A start launched
 * without Bun on PATH (an ssh session, a macOS GUI agent) once spawned
 * the automatic store migration worker through the launcher, which died
 * at once and without a word.
 *
 * The census: the source files that build a self-command are exactly the
 * listed sites, none of them spawns a process except through the helper,
 * and no other file names the runtime's path or the launcher. A new site
 * that bypasses the helper fails here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

/** The helper itself. */
const HELPER = "src/core/maintenance/o2b-command.ts";

/**
 * The helper's companion: it installs a missing dependency tree with the
 * runtime of its process, as the launcher's precheck runs `bun install`.
 */
const DEPENDENCY_TREE = "src/core/maintenance/dependency-tree.ts";

/** Every self-spawn site, with what it starts. */
const SITES: Readonly<Record<string, string>> = Object.freeze({
  "src/core/maintenance/ensure-current.ts":
    "the automatic store migration worker, the self-heal upgrade and the self-heal reindex",
  "src/core/search/freshen.ts": "freshen on read (a background incremental index run)",
  "hooks/session-capture.ts": "the deferred session capture worker",
});

/**
 * Files that name the runtime's path for another reason than a spawn,
 * with that reason.
 */
const EXEC_PATH_ELSEWHERE: Readonly<Record<string, string>> = Object.freeze({
  "src/core/install/grok-asset.ts":
    "writes the absolute command grok runs into its host config; nothing is spawned",
  "src/core/install/payload.ts":
    "writes the absolute command registered in an agent host config; nothing is spawned",
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const FILES = [...sourceFiles("src"), ...sourceFiles("hooks")].map((f) =>
  relative(REPO, join(REPO, f)).split(sep).join("/"),
);

function text(file: string): string {
  return readFileSync(join(REPO, file), "utf8");
}

/** A self-command is built here. */
const BUILDS_SELF_COMMAND = /\b(?:o2bCommand|selfCommand)\(/;
/** A process is spawned here other than through the helper. */
const RAW_SPAWN = /\bBun\.spawn(?:Sync)?\(|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(/;

describe("the self-spawn census", () => {
  test("the files that build a self-command are exactly the listed sites", () => {
    const found = FILES.filter((f) => f !== HELPER && BUILDS_SELF_COMMAND.test(text(f)));
    expect(found.toSorted()).toEqual(Object.keys(SITES).toSorted());
  });

  test("no listed site spawns a process except through the helper", () => {
    const offenders = Object.keys(SITES).filter((f) => RAW_SPAWN.test(text(f)));
    expect(offenders).toEqual([]);
  });

  test("only the helper names the runtime's path or the launcher", () => {
    const offenders = FILES.filter((f) => {
      if (f === HELPER || f === DEPENDENCY_TREE || f in EXEC_PATH_ELSEWHERE) return false;
      const t = text(f);
      return (
        /process\.execPath/.test(t) || /["']scripts["'],\s*["']o2b["']|scripts\/o2b["'`]/.test(t)
      );
    });
    expect(offenders).toEqual([]);
  });

  test("the census pattern catches every spawn spelling", () => {
    for (const call of [
      "Bun.spawn([",
      "Bun.spawnSync({",
      "spawn(cmd",
      "spawnSync(cmd",
      "execFile(cmd",
      "execFileSync(cmd",
      "fork(path",
    ]) {
      expect(RAW_SPAWN.test(call)).toBe(true);
    }
  });
});
