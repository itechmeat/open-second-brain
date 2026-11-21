/**
 * Guard against tests that write into the developer's real per-user
 * directories (registered by `tests/setup.ts`).
 *
 * The preload points `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
 * the config file, the store root and the Windows app-data roots at
 * directories of the run, but that reaches only this process and children
 * spawned with an explicit `env: { ...process.env }`: `Bun.spawn` and
 * `Bun.spawnSync` without an `env` hand the child the environment the
 * process STARTED with, so such a child resolves every default to the real
 * home. And Bun fixes `os.homedir()` at process start: a test that sets
 * `process.env.HOME` does not move it, so in-process code that falls back
 * to the home (a cleared `XDG_CONFIG_HOME`, a cleared config path) reaches
 * the real one.
 *
 * What the guard sees. It resolves the real locations from the
 * environment the process started with (captured by the preload before it
 * overrides anything), each exported base AND the home fallback beside it,
 * since a test that clears the variable falls back to the home, under
 * every home the product can fall back to (`HOME`, `os.homedir()`, on
 * Windows `USERPROFILE` first, `realHomes`):
 *
 *  - new entries in Open Second Brain's own directories under the config,
 *    data, state and cache bases (`src/core/platform-dirs.ts`), on Windows
 *    the ones under `%LOCALAPPDATA%` and `%APPDATA%`, and an exported
 *    `OPEN_SECOND_BRAIN_STORE_ROOT`, down to `OWN_DEPTH` levels;
 *  - new entries at the top level of the host agents' homes (`~/.claude`,
 *    `$CLAUDE_CONFIG_DIR`, `~/.codex`, `$CODEX_HOME` and the other hosts
 *    `o2b install` registers with, `real-home-locations.ts`), and one
 *    level into the few folders the product writes into below that top
 *    level (`skills/`, `hooks/`, `plugins/`, `cron/`, `.o2b-backups/`,
 *    `hostWriteDirs`) and in `~/.local/bin`;
 *  - any change to the content of the few small control files the product
 *    edits in place (the machine config and its profiles, each host's
 *    config file, `realControlFiles`): an append or a rewrite of
 *    an existing real file is the worst form of this leak.
 *
 * A watched location is followed through a link: a host home that is a
 * link to a directory is watched as that directory, and a control file
 * that is a link is hashed through it. Any change of what a watched path
 * is (it appears, returns, becomes another kind, its link is pointed
 * elsewhere, its dangling link's target appears) is a finding. A link
 * inside a watched tree is an entry, never walked. The table in
 * `real-home-guard-states.test.ts` states the finding for every kind of
 * watched path, state, transition and clock.
 *
 * What it does not see: a read; a change to any other existing file (the
 * content of a file at a watched root's path included); an entry deeper
 * than the depths above (a live agent writes there all the time); entries
 * inside a directory that sits where a control file belongs; an entry
 * created and removed within one test; anything outside these locations.
 *
 * Who wrote it. A live agent session, the real install's hooks, a host
 * agent upgrade or a second `bun test` run can create entries in the same
 * directories while a test runs. So every finding is attributed: a new
 * file, a new folder's files (a bounded walk) and a changed control file
 * are searched for the names of this process's own temp roots (random
 * `mkdtemp` names the preload hands to {@link RealHomeGuard.attributeTo});
 * a finding that names one was written by this suite's process tree.
 *
 *  - An attributed finding fails the test it was seen after, everywhere.
 *  - An unattributed finding fails the test on CI (`CI` set and not
 *    `false`/`0`), where nothing else writes into the runner's home, or
 *    when `O2B_TEST_REAL_HOME_GUARD=strict`. Otherwise (a developer
 *    machine) it is collected and printed once, as one summary at the end
 *    of the run, which says another process may be its creator.
 *
 * Cost and the clock. Every check takes the form of every configured
 * root (one `lstat`, and a `readlink` and a `stat` for a link), stats
 * every tracked directory and
 * compares its names with the recorded ones whenever its mtime moved or
 * was still recent (under {@link SETTLE_MS}) when recorded: on a coarse
 * clock a write inside the tick of the recorded mtime leaves it unchanged
 * (seen on Windows runners), so a recent mtime is never trusted, and a
 * settled one cannot be matched by a later write's. It reads and hashes
 * every control file up to {@link CONTROL_HASH_LIMIT} bytes on every
 * check, so a same-size rewrite inside one tick is seen too (a larger one
 * is compared by its size, mtime and inode, so a same-size rewrite of it
 * inside one tick is not seen). A clock set back, or a
 * network home whose server clock lags this machine's by more than
 * {@link SETTLE_MS}, can hide a new entry in a settled directory.
 *
 * The guard never removes anything from the real home: the message names
 * the entries so the developer can remove them. `O2B_TEST_REAL_HOME_GUARD=0`
 * switches it off.
 */
import { afterAll, afterEach } from "bun:test";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

import {
  dedupeRoots,
  type Env,
  type GuardRoot,
  nonEmpty,
  realControlFiles,
  realHomeRoots,
  realHomes,
} from "./real-home-locations.ts";

export {
  type GuardRoot,
  HOST_DEPTH,
  hostWriteDirs,
  OWN_DEPTH,
  realControlFiles,
  realHomeRoots,
  realHomes,
} from "./real-home-locations.ts";

/**
 * How old a directory's mtime must be, when recorded, before an unchanged
 * mtime is trusted: far above the coarsest timestamp tick of a local
 * filesystem (2 s on FAT, 1 s on HFS+ and ext3, about 16 ms for the
 * Windows system clock).
 */
export const SETTLE_MS = 10_000;
/** Control files up to this size are hashed on every check. */
export const CONTROL_HASH_LIMIT = 256 * 1024;
/** Bytes of one file searched for a marker. */
const ATTRIBUTION_READ_LIMIT = 1024 * 1024;
/** Files of one new folder searched for a marker. */
const ATTRIBUTION_WALK_LIMIT = 200;

interface DirState {
  mtimeMs: number;
  names: Set<string>;
  depth: number;
  /**
   * The recorded mtime was already more than {@link SETTLE_MS} old when it
   * was recorded, so any later write gives the directory another mtime.
   */
  settled: boolean;
}

/**
 * What a watched path is, as its watch tells two observations apart:
 * `key` is `null` when nothing is there; otherwise it names the kind (a
 * directory, a file, anything else), the link target when the path is a
 * link, and whether that link dangles. `dir` is true when the path is a
 * directory or a link to one.
 */
interface Form {
  readonly key: string | null;
  readonly dir: boolean;
  /** The directory's mtime when `dir`, taken with the form (no second stat). */
  readonly mtimeMs: number;
}

const ABSENT: Form = { key: null, dir: false, mtimeMs: 0 };

/** One configured root and what its watch has recorded. */
interface RootWatch {
  readonly root: GuardRoot;
  form: Form;
  /** The directories of its tree, when the root is a directory. */
  readonly dirs: Map<string, DirState>;
}

/** Options of a {@link NewEntryWatcher}. */
export interface WatcherOptions {
  /** The clock a recorded mtime is judged settled by (default `Date.now`). */
  readonly now?: () => number;
}

function kindOf(st: Stats): "dir" | "file" | "special" {
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : "special";
}

/**
 * The link part of a form key and the stat of what the path resolves to,
 * or `null` stat for a dangling link; `undefined` when nothing is there.
 */
function resolve(path: string): { link: string; st: Stats | null } | undefined {
  let l: Stats;
  try {
    l = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!l.isSymbolicLink()) return { link: "", st: l };
  let target = "?";
  try {
    target = readlinkSync(path);
  } catch {
    // Unreadable target: the key still says it is a link.
  }
  try {
    return { link: `link:${target}:`, st: statSync(path) };
  } catch {
    return { link: `link:${target}:`, st: null };
  }
}

/**
 * The form of a configured root. A root is followed through a link (a
 * host's home is often a link into a dotfiles checkout), so a link to a
 * directory is watched as that directory; the content of a file at a
 * root's path is not watched, only what the path is.
 */
function rootForm(path: string): Form {
  const r = resolve(path);
  if (r === undefined) return ABSENT;
  if (r.st === null) return { key: `${r.link}dangling`, dir: false, mtimeMs: 0 };
  const kind = kindOf(r.st);
  return { key: r.link + kind, dir: kind === "dir", mtimeMs: r.st.mtimeMs };
}

/**
 * The form key of a control file: what the path is, through a link too,
 * and for a regular file its content (hashed up to
 * {@link CONTROL_HASH_LIMIT} bytes, else its size, mtime and inode), so an
 * edit through a link changes the key like an edit in place.
 */
function controlKey(path: string): string | null {
  const r = resolve(path);
  if (r === undefined) return null;
  if (r.st === null) return `${r.link}dangling`;
  const st = r.st;
  if (!st.isFile()) return r.link + kindOf(st);
  if (st.size > CONTROL_HASH_LIMIT) return `${r.link}file:${st.size}:${st.mtimeMs}:${st.ino}`;
  const bytes = readHead(path, Math.max(st.size, 1));
  return `${r.link}file:${st.size}:${bytes === null ? "unreadable" : String(Bun.hash(bytes))}`;
}

function listDir(path: string): Set<string> | null {
  try {
    return new Set(readdirSync(path));
  } catch {
    return null;
  }
}

/**
 * A directory's mtime, or `null` when it is no directory. Only a root is
 * followed through a link (`follow`): a link inside a tree is an entry,
 * never walked, so a tree cannot lead into a vault or loop.
 */
function dirMtime(path: string, follow: boolean): number | null {
  try {
    const st = follow ? statSync(path) : lstatSync(path);
    return st.isDirectory() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Up to `limit` bytes of a regular file, or `null`. */
function readHead(path: string, limit: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * True for the `-wal`, `-shm` or `-journal` file SQLite keeps next to a
 * database that was already there: a live process on the machine (a host
 * agent's own database, `~/.hermes/kanban.db`) opening its database makes
 * them come and go, which says nothing about the test that ran meanwhile.
 */
function isSqliteSidecarOf(name: string, existing: ReadonlySet<string>): boolean {
  const match = /^(.+)-(wal|shm|journal)$/.exec(name);
  return match !== null && existing.has(match[1] as string);
}

/** What one check found. */
export interface Finding {
  readonly kind: "new" | "changed";
  readonly path: string;
}

/**
 * Watches a set of trees for new entries and a set of files for content
 * changes. `check()` returns what appeared or changed since the previous
 * call (or since construction) and takes it into the baseline, so each
 * finding is reported once.
 *
 * Each configured root has a watch of its own, so a root inside another
 * root's tree (`~/.claude/.o2b-backups` under `~/.claude`) keeps its own
 * depth whatever the outer tree does; a path both report is reported once.
 * What each kind of watched path reports, for every state and transition,
 * is the table in `real-home-guard-states.test.ts`.
 */
export class NewEntryWatcher {
  private readonly watches: RootWatch[];
  private readonly roots: ReadonlyArray<GuardRoot>;
  private readonly files = new Map<string, string | null>();
  private readonly now: () => number;

  constructor(
    roots: ReadonlyArray<GuardRoot>,
    controlFiles: ReadonlyArray<string> = [],
    options: WatcherOptions = {},
  ) {
    this.roots = roots;
    this.now = options.now ?? Date.now;
    this.watches = roots.map((root) => {
      const watch: RootWatch = { root, form: rootForm(root.path), dirs: new Map() };
      if (watch.form.dir) this.track(watch, root.path, root.depth);
      return watch;
    });
    for (const file of controlFiles) this.files.set(file, controlKey(file));
  }

  /** The trees watched. */
  get watched(): ReadonlyArray<GuardRoot> {
    return this.roots;
  }

  /** The number of directories tracked now. */
  get trackedDirs(): number {
    let n = 0;
    for (const watch of this.watches) n += watch.dirs.size;
    return n;
  }

  private isSettled(mtimeMs: number): boolean {
    return this.now() - mtimeMs > SETTLE_MS;
  }

  private track(watch: RootWatch, path: string, depth: number): boolean {
    // stat before listing: a write between the two moves the mtime past
    // the recorded one.
    const mtimeMs = dirMtime(path, path === watch.root.path);
    if (mtimeMs === null) return false;
    const names = listDir(path);
    if (names === null) return false;
    watch.dirs.set(path, { mtimeMs, names, depth, settled: this.isSettled(mtimeMs) });
    if (depth > 1) {
      for (const name of names) this.track(watch, join(path, name), depth - 1);
    }
    return true;
  }

  private untrack(watch: RootWatch, path: string): void {
    const prefix = path + sep;
    for (const key of watch.dirs.keys()) {
      if (key === path || key.startsWith(prefix)) watch.dirs.delete(key);
    }
  }

  /** New entries since the last call, absolute paths (no content changes). */
  check(): string[] {
    return this.checkAll()
      .filter((f) => f.kind === "new")
      .map((f) => f.path);
  }

  /** New entries and changed control files since the last call. */
  checkAll(): Finding[] {
    const found: Finding[] = [];
    const seen = new Set<string>();
    const add = (kind: Finding["kind"], path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      found.push({ kind, path });
    };
    for (const watch of this.watches) this.checkRoot(watch, add);
    for (const [path, before] of this.files) {
      const now = controlKey(path);
      if (now === before) continue;
      this.files.set(path, now);
      // A removal is not a leak; a file that appears is also a new entry.
      if (now !== null) add(before === null ? "new" : "changed", path);
    }
    return found;
  }

  private checkRoot(watch: RootWatch, add: (kind: Finding["kind"], path: string) => void): void {
    const rootPath = watch.root.path;
    const form = rootForm(rootPath);
    if (form.key !== watch.form.key) {
      // The root appeared, returned, or is now something else (another
      // kind, another link target): the path holds a new entry, and its
      // tree is watched afresh. A removal is no leak.
      watch.form = form;
      watch.dirs.clear();
      if (form.key !== null) add("new", rootPath);
      if (form.dir) this.track(watch, rootPath, watch.root.depth);
      return;
    }
    if (!form.dir) return;
    if (!watch.dirs.has(rootPath)) {
      // A directory that could not be listed (no permission): its content
      // is taken as the baseline once it can be, with no finding.
      this.track(watch, rootPath, watch.root.depth);
      return;
    }
    for (const [path, state] of watch.dirs) {
      if (!watch.dirs.has(path)) continue;
      const gone = (): void => {
        // Removed: removal is not a leak. A root gone between its form and
        // its listing is judged again by its form on the next check.
        this.untrack(watch, path);
        if (path === rootPath) watch.form = ABSENT;
      };
      // An unchanged mtime is trusted only when it was settled when
      // recorded. On a coarse clock a write inside the tick of the recorded
      // mtime leaves the mtime as it was (seen on Windows runners), but
      // such a mtime is recent, so the names are compared on every check
      // until it settles; once it has, a later write cannot land in its
      // tick. This keeps the cost of a quiet tree at one stat per directory.
      const mtimeMs = path === rootPath ? form.mtimeMs : dirMtime(path, false);
      if (mtimeMs === null) {
        gone();
        continue;
      }
      if (state.settled && mtimeMs === state.mtimeMs) continue;
      state.mtimeMs = mtimeMs;
      state.settled = this.isSettled(mtimeMs);
      let list: string[];
      try {
        list = readdirSync(path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") gone();
        continue;
      }
      // The common case, nothing changed: no new set, no join.
      if (list.length === state.names.size && list.every((n) => state.names.has(n))) continue;
      const names = new Set(list);
      for (const name of names) {
        if (state.names.has(name)) continue;
        if (isSqliteSidecarOf(name, state.names)) continue;
        add("new", join(path, name));
        if (state.depth > 1) this.track(watch, join(path, name), state.depth - 1);
      }
      for (const name of state.names) {
        if (!names.has(name)) this.untrack(watch, join(path, name));
      }
      state.names = names;
    }
  }
}

/** How long a new entry must survive to count as left behind. */
const TRANSIENT_GRACE_MS = 100;

/** Keeps the entries of `found` that still exist after a short grace. */
export function persistentEntries(found: ReadonlyArray<string>): string[] {
  if (found.length === 0) return [];
  Bun.sleepSync(TRANSIENT_GRACE_MS);
  return found.filter(exists);
}

function containsMarker(bytes: Buffer | string, markers: ReadonlyArray<string>): boolean {
  const text = typeof bytes === "string" ? bytes : bytes.toString("latin1");
  return markers.some((m) => text.includes(m));
}

/**
 * Whether `path` carries one of `markers` (the names of this process's own
 * temp roots): in its name, a link target, a file's first
 * {@link ATTRIBUTION_READ_LIMIT} bytes, or, for a folder, in the names and
 * files of a bounded walk of it.
 */
export function carriesMarker(path: string, markers: ReadonlyArray<string>): boolean {
  if (markers.length === 0) return false;
  let budget = ATTRIBUTION_WALK_LIMIT;
  const visit = (p: string): boolean => {
    if (budget-- <= 0) return false;
    if (containsMarker(basename(p), markers)) return true;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      try {
        return containsMarker(readlinkSync(p), markers);
      } catch {
        return false;
      }
    }
    if (st.isFile()) {
      const head = readHead(p, Math.min(Math.max(st.size, 1), ATTRIBUTION_READ_LIMIT));
      return head !== null && containsMarker(head, markers);
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(p);
      } catch {
        return false;
      }
      for (const name of names) if (visit(join(p, name))) return true;
    }
    return false;
  };
  return visit(path);
}

/** A finding, with whether this process is proven to be its writer. */
export interface AttributedFinding extends Finding {
  readonly attributed: boolean;
}

function describeFinding(f: AttributedFinding): string {
  const what = f.kind === "new" ? "new entry" : "content changed";
  return `${f.path} (${what}; ${f.attributed ? "names a temp root of this test run" : "names no temp root of this run"})`;
}

/** The message a test that left findings in the real home fails with. */
export function leakMessage(findings: ReadonlyArray<AttributedFinding>): string {
  const unattributed = findings.some((f) => !f.attributed);
  return (
    `the real per-user directories changed during this test: ${findings.map(describeFinding).join(", ")}. ` +
    (unattributed
      ? "A finding that names no temp root of this run may have been written by another " +
        "process on the machine (a live agent session, the real install's hooks, another test " +
        "run); this one fails because the guard is strict here (CI, or O2B_TEST_REAL_HOME_GUARD=strict). "
      : "") +
    `Two usual causes: a child spawned with Bun.spawn or Bun.spawnSync without an explicit ` +
    `\`env: { ...process.env }\` gets the environment the process started with, not the ` +
    `preload's sandbox; and in-process code falls back to os.homedir(), which Bun fixes at ` +
    `process start, so setting HOME in a test does not move it (set the XDG base or the ` +
    `product's own variable instead). See tests/helpers/real-home-guard.ts; restore or remove ` +
    `the entries by hand once the test is fixed.`
  );
}

/** One unattributed finding a non-strict run collects for its summary. */
export interface CollectedFinding extends AttributedFinding {
  /** Ordinal of the test it was seen after (1-based, this process). */
  readonly afterTest: number;
  readonly at: string;
}

/** The end-of-run summary of the findings a non-strict run did not fail on. */
export function summaryMessage(collected: ReadonlyArray<CollectedFinding>): string {
  const lines = collected.map(
    (f) =>
      `  - ${f.path} (${f.kind === "new" ? "new entry" : "content changed"}), seen after test ` +
      `#${f.afterTest} at ${f.at}`,
  );
  return (
    `real-home guard: ${collected.length} change${collected.length === 1 ? "" : "s"} in the real ` +
    `per-user directories during this run that name no temp root of this run, so another process ` +
    `on the machine (a live agent session, the real install's hooks, a host agent upgrade, another ` +
    `test run) may be the creator; not failed outside CI:\n${lines.join("\n")}\n` +
    `To find the test, if any, rerun with O2B_TEST_REAL_HOME_GUARD=strict, which fails the test ` +
    `each change is seen after.`
  );
}

/** Whether the environment is known clean, so an unattributed finding fails. */
export function guardIsStrict(env: Env): boolean {
  const mode = env["O2B_TEST_REAL_HOME_GUARD"];
  if (mode === "strict") return true;
  const ci = nonEmpty(env["CI"]);
  return ci !== null && ci !== "false" && ci !== "0";
}

/** The installed guard. */
export interface RealHomeGuard {
  /**
   * Names this process's own temp roots: a finding that carries one of
   * their base names (random `mkdtemp` names) was written by this run.
   */
  attributeTo(paths: ReadonlyArray<string>): void;
}

/**
 * Installs the guard. `startEnv` is the environment the test process
 * started with, captured before the preload overrides anything.
 */
export function installRealHomeGuard(startEnv: Env): RealHomeGuard {
  const markers: string[] = [];
  const handle: RealHomeGuard = {
    attributeTo(paths) {
      for (const p of paths) {
        const name = basename(p);
        if (name.length >= 8 && !markers.includes(name)) markers.push(name);
      }
    },
  };
  if (startEnv["O2B_TEST_REAL_HOME_GUARD"] === "0") return handle;
  const platform = process.platform;
  const homes = realHomes(startEnv, platform, homedir());
  const watcher = new NewEntryWatcher(
    dedupeRoots(homes.flatMap((home) => realHomeRoots(startEnv, home, platform))),
    [...new Set(homes.flatMap((home) => realControlFiles(startEnv, home, platform)))],
  );
  const strict = guardIsStrict(startEnv);
  const collected: CollectedFinding[] = [];
  let tests = 0;
  const verify = (): void => {
    tests += 1;
    const raw = watcher.checkAll();
    if (raw.length === 0) return;
    const alive = new Set(persistentEntries(raw.map((f) => f.path)));
    const findings: AttributedFinding[] = raw
      .filter((f) => alive.has(f.path))
      .map((f) => ({ ...f, attributed: carriesMarker(f.path, markers) }));
    const failing = findings.filter((f) => strict || f.attributed);
    for (const f of findings) {
      if (!strict && !f.attributed) {
        collected.push({ ...f, afterTest: tests, at: new Date().toISOString() });
      }
    }
    if (failing.length > 0) throw new Error(leakMessage(failing));
  };
  afterEach(verify);
  // Children that finish after the last test of the run, then the summary.
  afterAll(() => {
    try {
      verify();
    } finally {
      if (collected.length > 0) console.warn(summaryMessage(collected));
    }
  });
  return handle;
}
