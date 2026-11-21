/**
 * The real-home guard's watcher (`NewEntryWatcher` in
 * `tests/helpers/real-home-guard.ts`) over its whole state space, as one
 * table.
 *
 * Watched things: a configured root (`root`), a configured root nested in
 * another configured root's tree (`nested`, like `~/.claude/.o2b-backups`
 * under `~/.claude`), and a control file (`control`).
 *
 * States of the watched path: absent, a directory, a regular file, a link
 * to a directory, a link to a file, a dangling link.
 *
 * Transitions between two checks: none (`quiet`), `appears` (from absent),
 * `disappears`, `returns` (disappears, one check, comes back as it was),
 * `replaced` by another kind, `edited in place` (a new entry in a
 * directory, a same-size rewrite of a file, a link pointed elsewhere) and
 * `edited through a link` (the same change made to the link's target).
 *
 * Clocks: `fine` (the real clock, timestamps as the filesystem sets them),
 * `coarse` (every timestamp in the fixture set back to one recent second
 * after every step, so a directory's mtime never moves; the watcher's clock
 * is pinned one second later, so that second stays recent however long
 * the test takes), and `late` (every timestamp an hour old before the
 * baseline: the test runs long after the fixture was made).
 *
 * Each row names the findings of every check, `|` between checks: `-` is
 * none, `new .` a new entry at the watched path itself, `new x` one at the
 * entry `x` below it, `changed .` a content change of a control file. The
 * last check of every row follows a fixed step that proves the thing is
 * still watched in its final state: a new entry `after` in a final
 * directory (through the link for a link to a directory), an append to a
 * final file (through the link for a link to a file), nothing otherwise.
 *
 * What a row expects, in words:
 *
 *  - A root or nested root: any change of what the path is (appears,
 *    returns, replaced, a link pointed elsewhere, a dangling link whose
 *    target appears) is a new entry at the path; a new entry inside its
 *    directory (through a link too) is reported at its depth; a removal is
 *    no finding; the content of a file at a root's path is not watched.
 *  - A control file: appearing is a new entry, any other change of what
 *    the path holds (its content, through a link too, its kind, its link
 *    target) is a content change; a removal is no finding; entries inside
 *    a directory at a control file's path are not watched.
 *  - The clock never changes a finding.
 *
 * Links are not created on Windows (it needs a privilege runners may lack),
 * so the rows with a link run on POSIX only.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { type Finding, NewEntryWatcher } from "./real-home-guard.ts";
import { tempDirs } from "./temp-dir.ts";

const mkTemp = tempDirs();

type Kind = "absent" | "dir" | "file" | "linkDir" | "linkFile" | "dangling";
type Thing = "root" | "nested" | "control";
type Clock = "fine" | "coarse" | "late";
type Transition =
  | "quiet"
  | "appears"
  | "disappears"
  | "returns"
  | "replaced"
  | "edited in place"
  | "edited through a link";

interface Row {
  readonly from: Kind;
  readonly transition: Transition;
  /** The kind it ends as. */
  readonly to: Kind;
  /** Findings of each check for `root` and `nested`. */
  readonly root: string;
  /** Findings of each check for `control`. */
  readonly control: string;
}

const row = (from: Kind, transition: Transition, to: Kind, root: string, control: string): Row => ({
  from,
  transition,
  to,
  root,
  control,
});

// prettier-ignore
const TABLE: ReadonlyArray<Row> = [
  row("absent",   "quiet",                 "absent",   "- | -",                   "- | -"),
  row("dir",      "quiet",                 "dir",      "- | new after",           "- | -"),
  row("file",     "quiet",                 "file",     "- | -",                   "- | changed ."),
  row("linkDir",  "quiet",                 "linkDir",  "- | new after",           "- | -"),
  row("linkFile", "quiet",                 "linkFile", "- | -",                   "- | changed ."),
  row("dangling", "quiet",                 "dangling", "- | -",                   "- | -"),

  row("absent",   "appears",               "dir",      "new . | new after",       "new . | -"),
  row("absent",   "appears",               "file",     "new . | -",               "new . | changed ."),
  row("absent",   "appears",               "linkDir",  "new . | new after",       "new . | -"),
  row("absent",   "appears",               "linkFile", "new . | -",               "new . | changed ."),
  row("absent",   "appears",               "dangling", "new . | -",               "new . | -"),

  row("dir",      "disappears",            "absent",   "- | -",                   "- | -"),
  row("file",     "disappears",            "absent",   "- | -",                   "- | -"),
  row("linkDir",  "disappears",            "absent",   "- | -",                   "- | -"),
  row("linkFile", "disappears",            "absent",   "- | -",                   "- | -"),
  row("dangling", "disappears",            "absent",   "- | -",                   "- | -"),

  row("dir",      "returns",               "dir",      "- | new . | new after",   "- | new . | -"),
  row("file",     "returns",               "file",     "- | new . | -",           "- | new . | changed ."),
  row("linkDir",  "returns",               "linkDir",  "- | new . | new after",   "- | new . | -"),
  row("linkFile", "returns",               "linkFile", "- | new . | -",           "- | new . | changed ."),
  row("dangling", "returns",               "dangling", "- | new . | -",           "- | new . | -"),

  row("dir",      "replaced",              "file",     "new . | -",               "changed . | changed ."),
  row("dir",      "replaced",              "linkDir",  "new . | new after",       "changed . | -"),
  row("dir",      "replaced",              "linkFile", "new . | -",               "changed . | changed ."),
  row("dir",      "replaced",              "dangling", "new . | -",               "changed . | -"),
  row("file",     "replaced",              "dir",      "new . | new after",       "changed . | -"),
  row("file",     "replaced",              "linkDir",  "new . | new after",       "changed . | -"),
  row("file",     "replaced",              "linkFile", "new . | -",               "changed . | changed ."),
  row("file",     "replaced",              "dangling", "new . | -",               "changed . | -"),
  row("linkDir",  "replaced",              "dir",      "new . | new after",       "changed . | -"),
  row("linkDir",  "replaced",              "file",     "new . | -",               "changed . | changed ."),
  row("linkDir",  "replaced",              "linkFile", "new . | -",               "changed . | changed ."),
  row("linkDir",  "replaced",              "dangling", "new . | -",               "changed . | -"),
  row("linkFile", "replaced",              "dir",      "new . | new after",       "changed . | -"),
  row("linkFile", "replaced",              "file",     "new . | -",               "changed . | changed ."),
  row("linkFile", "replaced",              "linkDir",  "new . | new after",       "changed . | -"),
  row("linkFile", "replaced",              "dangling", "new . | -",               "changed . | -"),
  row("dangling", "replaced",              "dir",      "new . | new after",       "changed . | -"),
  row("dangling", "replaced",              "file",     "new . | -",               "changed . | changed ."),
  row("dangling", "replaced",              "linkDir",  "new . | new after",       "changed . | -"),
  row("dangling", "replaced",              "linkFile", "new . | -",               "changed . | changed ."),

  row("dir",      "edited in place",       "dir",      "new x | new after",       "- | -"),
  row("file",     "edited in place",       "file",     "- | -",                   "changed . | changed ."),
  row("linkDir",  "edited in place",       "linkDir",  "new . | new after",       "changed . | -"),
  row("linkFile", "edited in place",       "linkFile", "new . | -",               "changed . | changed ."),
  row("dangling", "edited in place",       "dangling", "new . | -",               "changed . | -"),

  row("linkDir",  "edited through a link", "linkDir",  "new x | new after",       "- | -"),
  row("linkFile", "edited through a link", "linkFile", "- | -",                   "changed . | changed ."),
  row("dangling", "edited through a link", "linkFile", "new . | -",               "changed . | changed ."),
];

const LINKS: ReadonlySet<Kind> = new Set(["linkDir", "linkFile", "dangling"]);
const CLOCKS: ReadonlyArray<Clock> = ["fine", "coarse", "late"];
const CONTENT = "a = 1\n";

/** One fixture: the watched path, the targets its links point at, and the clock. */
class Cell {
  readonly base: string;
  readonly path: string;
  private readonly frozenS: number | null;

  constructor(
    thing: Thing,
    private readonly clock: Clock,
  ) {
    this.base = mkTemp("osb-guard-state-");
    mkdirSync(join(this.base, "t"));
    mkdirSync(join(this.base, "p"));
    this.path =
      thing === "root"
        ? join(this.base, "r")
        : thing === "nested"
          ? join(this.base, "p", "n")
          : join(this.base, "p", "config.toml");
    // Captured here, per cell: never at module load.
    this.frozenS = clock === "coarse" ? Math.floor(Date.now() / 1000) : null;
  }

  watcher(thing: Thing): NewEntryWatcher {
    const now = this.frozenS === null ? undefined : () => (this.frozenS as number) * 1000 + 1000;
    if (thing === "control") return new NewEntryWatcher([], [this.path], { now });
    const roots =
      thing === "root"
        ? [{ path: this.path, depth: 2 }]
        : [
            { path: join(this.base, "p"), depth: 1 },
            { path: this.path, depth: 2 },
          ];
    return new NewEntryWatcher(roots, [], { now });
  }

  private target(kind: "dir" | "file" | "missing", variant: number): string {
    return join(this.base, "t", `${kind}${variant}`);
  }

  /** Puts `kind` at the watched path, its link targets numbered `variant`. */
  place(kind: Kind, variant = 0): void {
    switch (kind) {
      case "absent":
        return;
      case "dir":
        mkdirSync(this.path);
        writeFileSync(join(this.path, "old"), "");
        return;
      case "file":
        writeFileSync(this.path, CONTENT);
        return;
      case "linkDir": {
        const target = this.target("dir", variant);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "old"), "");
        symlinkSync(target, this.path, "dir");
        return;
      }
      case "linkFile": {
        const target = this.target("file", variant);
        writeFileSync(target, CONTENT);
        symlinkSync(target, this.path, "file");
        return;
      }
      case "dangling":
        symlinkSync(this.target("missing", variant), this.path, "file");
        return;
    }
  }

  remove(): void {
    let link = false;
    try {
      link = lstatSync(this.path).isSymbolicLink();
    } catch {
      return;
    }
    if (link) unlinkSync(this.path);
    else rmSync(this.path, { recursive: true, force: true });
  }

  /** The change `transition` makes to a path of kind `from`. */
  edit(from: Kind, transition: "edited in place" | "edited through a link"): void {
    if (transition === "edited in place") {
      if (from === "dir") writeFileSync(join(this.path, "x"), "");
      else if (from === "file") writeFileSync(this.path, CONTENT.replace("1", "2"));
      else {
        // A link pointed at another target of the same kind.
        this.remove();
        this.place(from, 1);
      }
      return;
    }
    if (from === "linkDir") writeFileSync(join(this.path, "x"), "");
    else if (from === "linkFile") writeFileSync(this.path, CONTENT.replace("1", "2"));
    else writeFileSync(this.target("missing", 0), CONTENT);
  }

  /** The step before the last check: a change any watch of `kind` must see. */
  probe(kind: Kind): void {
    if (kind === "dir" || kind === "linkDir") writeFileSync(join(this.path, "after"), "");
    if (kind === "file" || kind === "linkFile") appendFileSync(this.path, "b = 2\n");
  }

  /** Applies the clock: called after the fixture is placed and after every step. */
  tick(step: "setup" | "step"): void {
    if (this.clock === "coarse") this.setTimes(this.frozenS as number);
    if (this.clock === "late" && step === "setup") {
      this.setTimes(Math.floor(Date.now() / 1000) - 3600);
    }
  }

  private setTimes(seconds: number): void {
    const walk = (dir: string): void => {
      utimesSync(dir, seconds, seconds);
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(p);
        else utimesSync(p, seconds, seconds);
      }
    };
    walk(this.base);
  }
}

/** Findings of one check in the table's notation, relative to the watched path. */
function notation(found: ReadonlyArray<Finding>, path: string): string {
  if (found.length === 0) return "-";
  return found
    .map((f) => `${f.kind} ${f.path === path ? "." : relative(path, f.path)}`)
    .toSorted()
    .join(", ");
}

/** Runs one row for one thing on one clock: the findings of each check, in the table's notation. */
function runCell(thing: Thing, clock: Clock, r: Row): string {
  const cell = new Cell(thing, clock);
  cell.place(r.from);
  cell.tick("setup");
  const watcher = cell.watcher(thing);
  const seen: string[] = [];
  const check = (): void => {
    cell.tick("step");
    seen.push(notation(watcher.checkAll(), cell.path));
  };
  switch (r.transition) {
    case "quiet":
      break;
    case "appears":
      cell.place(r.to);
      break;
    case "disappears":
      cell.remove();
      break;
    case "returns":
      cell.remove();
      check();
      cell.place(r.to);
      break;
    case "replaced":
      cell.remove();
      cell.place(r.to, 1);
      break;
    case "edited in place":
    case "edited through a link":
      cell.edit(r.from, r.transition);
      break;
  }
  check();
  cell.probe(r.to);
  check();
  return seen.join(" | ");
}

describe("NewEntryWatcher over its state space", () => {
  for (const r of TABLE) {
    const linked = LINKS.has(r.from) || LINKS.has(r.to);
    for (const thing of ["root", "nested", "control"] as const) {
      const spec = thing === "control" ? r.control : r.root;
      test.skipIf(linked && process.platform === "win32")(
        `${thing}: ${r.from} ${r.transition}${r.to === r.from ? "" : ` to ${r.to}`}: ${spec}`,
        () => {
          const got = CLOCKS.map((clock) => `${clock}: ${runCell(thing, clock, r)}`);
          expect(got).toEqual(CLOCKS.map((clock) => `${clock}: ${spec}`));
        },
      );
    }
  }
});
