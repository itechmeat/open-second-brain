/**
 * The parked indexes beside a live index: the previous index a rebuild left
 * at `.old` or `.bak`, the rule that decides which of them a verified
 * rebuild keeps, and the words that name the one it kept.
 *
 * The rule and the report live together on purpose. A parked index that a
 * rebuild keeps is a fact an operator has to act on - it sits beside the
 * index, it occupies disk, and the next rebuild may keep it again - so the rule
 * that keeps it and the line that says so are derived from one place. Two
 * copies of the rule would be two chances for the report to name a
 * different parked index than the one that was kept.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

import { closeDatabase } from "../sqlite-close.ts";
import { SQLITE_SIBLING_SUFFIXES } from "../sqlite-file-set.ts";
import { shellWord, windowsShellWords } from "../shell-quote.ts";
import { formatEstimateBytes } from "./index-estimate.ts";
import { STORE_PARK_MARKER_SUFFIX } from "./store-family.ts";

/**
 * The parked names of the index at `dbPath`, newest first: `.old` is
 * parked over an older, embedding-richer `.bak`.
 */
export function parkedIndexPaths(dbPath: string): [string, string] {
  return [dbPath + ".old", dbPath + ".bak"];
}

/**
 * Stored vectors in the index at `dbPath`: 0 when there is no file, null
 * when the file is there and the count cannot be read (it does not open,
 * or has no readable `embeddings` table). Unknown is never zero: every
 * caller treats null as "may hold vectors", so an index whose count cannot
 * be read is neither deleted as empty nor rebuilt over as if it held none.
 * A plain read-only open with no extension loaded: the count reads the
 * embeddings table's rows, not the vectors.
 */
export function countStoredEmbeddings(dbPath: string): number | null {
  let present: boolean;
  try {
    present = pathExists(dbPath);
  } catch {
    return null;
  }
  if (!present) return 0;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM embeddings").get()?.n ?? null;
  } catch {
    return null;
  } finally {
    closeDatabase(db);
  }
}

/** Whether a path exists, distinguishing a missing file from a failed stat. */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** A parked index as the rule sees it. */
export interface ParkedIndexState {
  /** Where the parked index sits. */
  readonly path: string;
  /** What it occupies on disk: its main file and its journals. */
  readonly bytes: number;
  /** The stored embeddings it holds, null when they cannot be counted. */
  readonly vectors: number | null;
}

/** Why a verified rebuild keeps a parked index beside the live one. */
export type ParkedIndexReason =
  /** Its stored embeddings cannot be counted, so it may hold the only copy. */
  | "unreadable"
  /** It holds more stored embeddings than the live index. */
  | "richer"
  /** The live index's stored embeddings cannot be counted. */
  | "live-count-unknown"
  /** There is no live index to weigh it against. */
  | "no-live-index"
  /** The rebuild tried to remove it and the removal did not succeed. */
  | "removal-failed";

/** A parked index a verified rebuild keeps, with the step that releases it. */
export interface KeptParkedIndex extends ParkedIndexState {
  readonly reason: ParkedIndexReason;
  /** The one step that releases it. */
  readonly release: string;
}

/**
 * The index a release step must act on, and the target a plain command
 * acts on.
 *
 * The caller carries both halves; the wording module compares them and
 * never re-derives either. A report made for another index - `--db`,
 * `--vault`, a config that names another one - would otherwise print a
 * command that acts on the default index, and a copied command that
 * releases nothing.
 */
export interface ParkedIndexTarget {
  /** The index the report names. */
  readonly dbPath: string;
  /** The vault the report names; null when no vault is configured. */
  readonly vaultPath: string | null;
  /** The machine config the report was made against; null when unknown. */
  readonly configPath: string | null;
  /** The index a command without target flags acts on. */
  readonly defaultDbPath: string;
  /** The vault a command without target flags acts on; null when none. */
  readonly defaultVaultPath: string | null;
  /** The machine config a command without target flags reads; null when unknown. */
  readonly defaultConfigPath: string | null;
}

/**
 * A target that names the plain command: the index itself, no flags.
 * For a caller that has no target to carry (a rebuild run without one) -
 * the command it names is the one an operator would type.
 */
export function plainParkedTarget(dbPath: string): ParkedIndexTarget {
  return Object.freeze({
    dbPath,
    vaultPath: null,
    configPath: null,
    defaultDbPath: dbPath,
    defaultVaultPath: null,
    defaultConfigPath: null,
  });
}

/**
 * The flags a copied command needs, and only those: the machine config,
 * the index and the vault, each of them when it differs from the one a
 * plain command acts on. The common case - the default index of the
 * configured vault, read from the default config - names none, so the
 * step it prints stays short.
 *
 * A path is quoted for the shell that will read the copied command: a
 * path with a space in it is one argument, not two. A path that needs
 * no quoting is printed as it is, so the common case reads the same as
 * it always did.
 */
export function parkedIndexTargetFlags(
  target: ParkedIndexTarget,
  quote: (value: string) => string = shellWord,
): ReadonlyArray<string> {
  const flags: string[] = [];
  const otherConfig = target.configPath !== null && target.configPath !== target.defaultConfigPath;
  if (otherConfig) flags.push("--config", quote(target.configPath));
  // Another config may resolve another index, so a printed --config always
  // names the index too.
  if (otherConfig || target.dbPath !== target.defaultDbPath) {
    flags.push("--db", quote(target.dbPath));
  }
  // ...and the vault: another config may name another vault, and the
  // command would read that corpus into the named index.
  if (target.vaultPath !== null && (otherConfig || target.vaultPath !== target.defaultVaultPath)) {
    flags.push("--vault", quote(target.vaultPath));
  }
  return flags;
}

/**
 * `command`, with the target flags it needs to act on the named index
 * and the flags the command itself takes. The target comes first: it
 * says WHICH index the command acts on, and the rest says what the
 * command does there.
 *
 * On Windows the shell is not known: cmd.exe and PowerShell read the
 * same line differently. One line is printed when it reads alike in both;
 * otherwise the cmd.exe line, and the PowerShell line after it, each
 * named; and only the PowerShell line, named, for a path cmd.exe would
 * expand (a `%`, or a `!` when delayed expansion is enabled).
 */
export function releaseCommand(
  target: ParkedIndexTarget,
  command: string,
  flags: ReadonlyArray<string> = [],
  platform: NodeJS.Platform = process.platform,
): string {
  const line = (quote: (value: string) => string): string => {
    const all = [...parkedIndexTargetFlags(target, quote), ...flags];
    return all.length === 0 ? command : `${command} ${all.join(" ")}`;
  };
  if (platform !== "win32") return line(shellWord);
  const powershell = line((v) => windowsShellWords(v).powershell);
  const words = parkedIndexTargetFlags(target, (v) => v).map((v) => windowsShellWords(v).cmd);
  if (words.includes(null))
    return `${powershell} (in PowerShell; cmd.exe cannot take this path literally)`;
  const cmd = line((v) => windowsShellWords(v).cmd ?? v);
  return cmd === powershell ? cmd : `${cmd} (in cmd.exe; in PowerShell: ${powershell})`;
}

/**
 * The live index a parked set is weighed against. Absent and unreadable
 * are different states: with no live index there is nothing to weigh it
 * against, and with a live index whose count cannot be read the weighing
 * itself could not be done. Both keep every parked index.
 */
export type LiveIndex =
  | { readonly present: false }
  | { readonly present: true; readonly vectors: number | null };

/**
 * The bytes a parked index occupies: its main file and the journals that
 * belong to it. A `-wal` beside a parked main file is part of that index,
 * so a size that left it out would understate what the file costs.
 */
function parkedIndexBytes(path: string): number {
  let bytes = 0;
  for (const file of [path, ...SQLITE_SIBLING_SUFFIXES.map((suffix) => path + suffix)]) {
    try {
      bytes += statSync(file).size;
    } catch (err) {
      // gone between the listing and the stat
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return bytes;
}

/** The parked indexes that exist beside the live index at `dbPath`. */
export function parkedIndexStates(dbPath: string): ReadonlyArray<ParkedIndexState> {
  return parkedIndexPaths(dbPath)
    .filter(pathExists)
    .map((path) => ({
      path,
      bytes: parkedIndexBytes(path),
      vectors: countStoredEmbeddings(path),
    }));
}

/**
 * The parked indexes a verified rebuild KEEPS, given the parked set and
 * the live index: the ones whose count cannot be read, every one of them
 * while the live count cannot be read, and the one holding more stored
 * embeddings than the live index. Every other parked index is removed,
 * which frees its name.
 *
 * The keep is deliberate in every arm. A rebuild without `embeddings`
 * computes none, so the vectors of the index it replaces are gone from
 * the live one; a parked index that may still hold them is the only copy
 * of them, and removing it would spend the price of embedding them again.
 *
 * `target` is the index the release step must act on; it is carried in,
 * never derived here.
 */
export function keptParkedIndexes(
  parked: ReadonlyArray<ParkedIndexState>,
  live: LiveIndex,
  target: ParkedIndexTarget,
): ReadonlyArray<KeptParkedIndex> {
  const reasons = keptParkedReasons(parked, live);
  return parked
    .filter((p) => reasons.has(p.path))
    .map((p) => keep(p, reasons.get(p.path) ?? "unreadable", target, parked));
}

/**
 * The reason each parked index is kept, by path. The rule itself, with
 * no words in it: the callers that only need to know WHICH parked index
 * survives ask for this.
 */
export function keptParkedReasons(
  parked: ReadonlyArray<ParkedIndexState>,
  live: LiveIndex,
): ReadonlyMap<string, ParkedIndexReason> {
  const kept = new Map<string, ParkedIndexReason>();
  if (!live.present) {
    for (const p of parked) kept.set(p.path, "no-live-index");
    return kept;
  }
  if (live.vectors === null) {
    for (const p of parked) kept.set(p.path, "live-count-unknown");
    return kept;
  }
  for (const p of parked) {
    if (p.vectors === null) kept.set(p.path, "unreadable");
  }
  let richest: { path: string; vectors: number } | null = null;
  for (const p of parked) {
    if (p.vectors !== null && (richest === null || p.vectors > richest.vectors)) {
      richest = { path: p.path, vectors: p.vectors };
    }
  }
  if (richest !== null && richest.vectors > live.vectors) {
    kept.set(richest.path, "richer");
  }
  return kept;
}

/**
 * The parked index whose unreadability holds a parked name against the
 * rebuild, or null when a name is free.
 *
 * A rebuild never removes a parked index it cannot read, so an unreadable
 * one holds its name: with both names held that way the next rebuild
 * refuses before it builds. Any advice that needs the rebuild to start
 * therefore has to free that name first.
 */
function blockingUnreadable(
  parked: ReadonlyArray<ParkedIndexState>,
  subject: string,
): string | null {
  for (const p of parked) {
    if (p.path === subject) continue;
    if (p.vectors === null) return p.path;
  }
  return null;
}

/** The kept parked index, with the reason and the step that releases it. */
function keep(
  p: ParkedIndexState,
  reason: ParkedIndexReason,
  target: ParkedIndexTarget,
  parked: ReadonlyArray<ParkedIndexState>,
): KeptParkedIndex {
  return {
    ...p,
    reason,
    release: parkedIndexReleaseStep(
      {
        path: p.path,
        reason,
        vectors: p.vectors,
        swapInterrupted:
          !pathExists(target.dbPath) &&
          (pathExists(target.dbPath + STORE_PARK_MARKER_SUFFIX) ||
            SQLITE_SIBLING_SUFFIXES.some((suffix) => pathExists(target.dbPath + suffix))),
      },
      target,
      // A parked index whose unreadability holds a name blocks the rebuild
      // the step names - but only while a live index is there. With no live
      // index the rebuild restores one first, which frees a name itself.
      reason === "no-live-index" ? null : blockingUnreadable(parked, p.path),
    ),
  };
}

/** Why a parked index is kept, in the words the report uses. */
export function parkedIndexReasonText(p: KeptParkedIndex): string {
  switch (p.reason) {
    case "unreadable":
      return (
        "its stored embeddings could not be counted, so a rebuild never removes a parked " +
        "index it cannot read"
      );
    case "richer":
      return (
        `it holds ${p.vectors ?? 0} stored embeddings, more than the live index holds, and a ` +
        "keyword-only rebuild cannot compute them again"
      );
    case "live-count-unknown":
      return (
        "the live index's stored embeddings could not be counted, so no parked index can be " +
        "weighed against it"
      );
    case "no-live-index":
      return "there is no live index beside it, so no rebuild can weigh it against one";
    case "removal-failed":
      return "the rebuild tried to remove it and the removal did not succeed";
  }
}

/**
 * A parked index as the release step sees it: why it is kept, and what
 * it holds. The two together decide the step - an index that holds
 * stored embeddings is released by a rebuild that computes them again,
 * an empty one by an ordinary rebuild, and one whose count cannot be
 * read by `o2b search set-aside`.
 */
export interface ParkedIndexVerdict {
  /** Where it sits: its parked name, which the set-aside step names. */
  readonly path: string;
  /** Why a verified rebuild keeps it. */
  readonly reason: ParkedIndexReason;
  /** The stored embeddings it holds, null when they cannot be counted. */
  readonly vectors: number | null;
  /**
   * A rebuild stopped part way through its swap: no live index, and the
   * swap's record or journals still at the live path. A set-aside refuses
   * then, so the step restores the index first.
   */
  readonly swapInterrupted?: boolean;
}

/**
 * The one step that releases a kept parked index.
 *
 * `verdict` is the parked index as the rule sees it: why it is kept and
 * what it holds. The step follows from both. An index that holds stored
 * embeddings is released by the rebuild that computes them again - a
 * keyword-only rebuild cannot, and would leave the file parked as the
 * richer one, which is no release at all. An index that holds none is
 * released by an ordinary rebuild. An index whose count cannot be read
 * is released by `o2b search set-aside`, because no rebuild removes a
 * parked index it cannot read; so is one richer than the notes left in
 * the vault can produce again, which the embeddings step names too.
 *
 * `target` is the index the command must act on, carried in by the
 * caller: the command names the index the report names, with only the
 * flags that differ from the default. `blockedBy` is the parked index
 * whose unreadability holds a parked name, when there is one: the rebuild
 * such a step names cannot start before that name is free, so the step
 * frees it first.
 */
export function parkedIndexReleaseStep(
  verdict: ParkedIndexVerdict,
  target: ParkedIndexTarget,
  blockedBy: string | null = null,
  platform: NodeJS.Platform = process.platform,
): string {
  const { path, reason, vectors } = verdict;
  const reindex = (flags: ReadonlyArray<string> = []): string =>
    releaseCommand(target, "o2b search reindex", flags, platform);
  switch (reason) {
    case "unreadable":
      return setAsideStep(path, target, platform);
    case "richer":
      return embeddingsReleaseStep(verdict, target, blockedBy, platform);
    case "live-count-unknown":
    case "no-live-index": {
      // Nothing can be weighed against the parked index here: the live
      // index is absent, or its own count cannot be read. The advice
      // follows the parked index itself, whose count says which rebuild
      // releases it.
      if (vectors === null && reason === "no-live-index" && verdict.swapInterrupted === true) {
        return (
          "a rebuild stopped part way through its swap, and a set-aside refuses until the index " +
          `is back; run: ${reindex()}, which puts a parked index back first, then follow what ` +
          `${releaseCommand(target, "o2b search status", [], platform)} prints for the parked ` +
          "indexes left"
        );
      }
      if (vectors === null) {
        // With no live index, the set-aside leaves none at all: the rebuild
        // after it makes one.
        const step = setAsideStep(path, target, platform);
        return reason === "no-live-index" ? `${step}, then run: ${reindex()}` : step;
      }
      if (vectors > 0) return embeddingsReleaseStep(verdict, target, blockedBy, platform);
      if (reason === "no-live-index") return `run: ${reindex()}`;
      // Every parked name stays held while the live count is unknown, so an
      // unreadable one has to go first.
      return withBlockedName(`run again: ${reindex()}`, blockedBy, target, platform);
    }
    case "removal-failed": {
      const command = vectors !== null && vectors > 0 ? reindex(["--embeddings"]) : reindex();
      return withBlockedName(
        `close whatever holds it and run: ${command}`,
        blockedBy,
        target,
        platform,
      );
    }
  }
}

/** The parked name of `path` as `o2b search set-aside` takes it. */
function parkedKind(path: string): string {
  return path.endsWith(".old") ? "old" : "bak";
}

/**
 * `o2b search set-aside`, for the parked index at `path`: the product's own
 * move of the whole file set into the set-aside folder, which deletes
 * nothing. A move by hand that left the `-wal` behind would lose what only
 * the log held.
 */
export function setAsideCommand(
  path: string,
  target: ParkedIndexTarget,
  platform: NodeJS.Platform = process.platform,
): string {
  return releaseCommand(target, "o2b search set-aside", [parkedKind(path), "--apply"], platform);
}

function setAsideStep(path: string, target: ParkedIndexTarget, platform: NodeJS.Platform): string {
  return (
    `set it aside with: ${setAsideCommand(path, target, platform)} (it moves the file with its ` +
    "-wal, -shm and -journal files into the set-aside folder of the index folder, under the " +
    "writer lock, and deletes nothing)"
  );
}

/**
 * The step that releases a parked index holding stored embeddings: the
 * rebuild that computes them again, so the live index holds as many of
 * them as the parked one and the prune removes the file. That rebuild can
 * only embed the notes the vault still has; when the notes behind the
 * parked embeddings are gone it never reaches the parked count, and the
 * set-aside is what releases the file then.
 */
function embeddingsReleaseStep(
  verdict: ParkedIndexVerdict,
  target: ParkedIndexTarget,
  blockedBy: string | null,
  platform: NodeJS.Platform,
): string {
  const direct =
    "restore them with: " +
    releaseCommand(target, "o2b search reindex", ["--embeddings"], platform) +
    `; that rebuild removes the parked file once the live index holds as many ` +
    `(${verdict.vectors ?? 0}); if the notes that produced them are gone, no rebuild reaches ` +
    `that count, so set it aside instead with: ${setAsideCommand(verdict.path, target, platform)}`;
  return withBlockedName(direct, blockedBy, target, platform);
}

/**
 * The step with the parked name that has to be free first in front of
 * it: a rebuild never removes a parked index it cannot read, so it
 * cannot start while that name is held.
 */
function withBlockedName(
  step: string,
  blockedBy: string | null,
  target: ParkedIndexTarget,
  platform: NodeJS.Platform,
): string {
  if (blockedBy === null) return step;
  return (
    `set the parked index at ${blockedBy} aside first with: ` +
    `${setAsideCommand(blockedBy, target, platform)} (a rebuild never removes a parked index ` +
    `it cannot read, so it cannot start while that name is held), then ${step}`
  );
}

/**
 * Why a rebuild refused with both parked names held by indexes it cannot
 * read, worded as the step that frees one: the set-aside of either.
 */
export function unreadableParkedRefusal(
  unreadable: ReadonlyArray<string>,
  target: ParkedIndexTarget,
  platform: NodeJS.Platform = process.platform,
): string {
  const commands = unreadable.map((p) => setAsideCommand(p, target, platform));
  return (
    `${unreadable.join(" and ")} could not be read, and a rebuild never removes a parked ` +
    `index it cannot read; set ${unreadable.length > 1 ? "either of them" : "it"} aside with: ` +
    `${commands.join(" (or: ")}${commands.length > 1 ? ")" : ""}, which moves it with its ` +
    "-wal, -shm and -journal files and deletes nothing, and run the rebuild again"
  );
}

/**
 * One line naming a parked index a rebuild kept: where it is, what it
 * occupies, why it is there and the step that releases it.
 */
export function describeKeptParkedIndex(p: KeptParkedIndex): string {
  return (
    `a parked index is kept at ${p.path} (${formatEstimateBytes(p.bytes)}): ` +
    `${parkedIndexReasonText(p)}; ${p.release}`
  );
}

/**
 * A parked index as `o2b search status` reports it: every parked file
 * beside the index, whether a rebuild keeps it, and why.
 */
export interface ParkedIndexStatus {
  readonly path: string;
  readonly bytes: number;
  /** The stored embeddings it holds, null when they cannot be counted. */
  readonly vectors: number | null;
  /** Whether a verified rebuild keeps it beside the live index. */
  readonly kept: boolean;
  /** Why it is kept, or when a rebuild removes it. */
  readonly reason: string;
  /** The one step that releases it; null when the rule does not keep it. */
  readonly release: string | null;
}

/**
 * The parked indexes beside the index at `dbPath`, each with what it holds,
 * whether a rebuild keeps it, and the step that releases it.
 *
 * `target` is the index the release step must act on, carried in by the
 * caller.
 */
export function parkedIndexStatus(
  dbPath: string,
  live: LiveIndex,
  target: ParkedIndexTarget,
): ReadonlyArray<ParkedIndexStatus> {
  const parked = parkedIndexStates(dbPath);
  const kept = new Map<string, KeptParkedIndex>(
    keptParkedIndexes(parked, live, target).map((p) => [p.path, p]),
  );
  return parked.map((p) => {
    const k = kept.get(p.path);
    if (k !== undefined) {
      return {
        path: p.path,
        bytes: p.bytes,
        vectors: p.vectors,
        kept: true,
        reason: parkedIndexReasonText(k),
        release: k.release,
      };
    }
    return {
      path: p.path,
      bytes: p.bytes,
      vectors: p.vectors,
      kept: false,
      reason:
        p.vectors === null || p.vectors === 0
          ? "a verified rebuild removes it"
          : live.present && live.vectors !== null && live.vectors >= p.vectors
            ? "the live index holds at least as many stored embeddings, so the rule does not keep " +
              "it; a verified rebuild removes it unless the index it builds holds fewer than " +
              `${p.vectors} (a keyword-only rebuild builds none, and then may keep it)`
            : "another parked index holds more stored embeddings, so the rule does not keep it; " +
              "a verified rebuild removes it unless the index it builds holds fewer than " +
              `${p.vectors} (a keyword-only rebuild builds none, and then may keep it)`,
      release: null,
    };
  });
}
