/**
 * Extract a snapshot's tar stream into a folder, in process.
 *
 * Windows `tar.exe` (bsdtar in `System32`) turns the UTF-8 name of a pax
 * member into the ANSI code page before it creates the file, so a name in
 * Cyrillic, CJK or any script that code page lacks was refused ("Archive
 * entry has empty or unreadable filename") and the restore of such a
 * snapshot failed; macOS bsdtar rewrites every name it extracts, and every
 * link target, to NFD, so a restore renamed an NFC file. This reader
 * writes every member under the bytes the archive stores, on every
 * platform, through Node paths (UTF-16 on Windows).
 *
 * The archive is vault content, so its members are untrusted:
 * 1. A name that is absolute, holds a `..` component, or (on Windows) a
 *    backslash or a drive colon is refused before anything of it is
 *    written; nothing is written outside `dir`.
 * 2. Symbolic links are created last, after every other member, so no
 *    member is ever written through a link the archive planted; a later
 *    member at a link's path replaces the link, as tar would.
 * 3. A hard link copies an earlier regular member of the same archive and
 *    nothing else.
 * 4. Directories are created writable and get their stored mode and time
 *    once everything inside them is written.
 * Device, FIFO and socket members are left out, as the snapshot writer
 * leaves them out; any other kind (a sparse or multi-volume member) is
 * refused rather than written wrong. A later member at the same path
 * replaces an earlier one, as tar does.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";

import { tarEntries, type TarRead } from "./tar-names.ts";

const CHUNK = 1024 * 1024;
const SLASH = Buffer.from("/");

/** Write every member of the tar stream `read` gives under `dir`, an existing empty folder. */
export function extractTarArchive(read: TarRead, dir: string): void {
  const base = Buffer.from(dir);
  const at = (rel: Buffer): Buffer => Buffer.concat([base, SLASH, rel]);
  const links = new Map<string, { rel: Buffer; target: Buffer }>();
  const dirs: Array<{ path: Buffer; mode: number; mtime: number }> = [];
  const regularFiles = new Set<string>();
  for (const entry of tarEntries(read)) {
    const rel = memberPath(entry.name);
    if (rel === null) continue;
    const key = rel.toString("latin1");
    if (entry.type === "3" || entry.type === "4" || entry.type === "6") {
      throw new Error(`the archive member ${show(entry.name)} is an unsupported special file`);
    }
    const path = at(rel);
    if (entry.type === "5") {
      regularFiles.delete(key);
      links.delete(key);
      removeUnlessDirectory(path);
      mkdirSync(path, { recursive: true, mode: (entry.mode & 0o777) | 0o700 });
      dirs.push({ path, mode: entry.mode & 0o777, mtime: entry.mtime });
      continue;
    }
    if (entry.type === "2") {
      regularFiles.delete(key);
      links.set(key, { rel, target: entry.linkName ?? Buffer.alloc(0) });
      continue;
    }
    regularFiles.delete(key);
    links.delete(key);
    mkdirSync(at(parentOf(rel)), { recursive: true });
    removeUnlessDirectory(path);
    if (entry.type === "1") {
      const source = memberPath(entry.linkName ?? Buffer.alloc(0));
      const sourceKey = source?.toString("latin1");
      if (
        source === null ||
        sourceKey === undefined ||
        !regularFiles.has(sourceKey) ||
        !lstatSync(at(source), { throwIfNoEntry: false })?.isFile()
      ) {
        throw new Error(
          `the archive member ${show(entry.name)} links to ${show(entry.linkName)}, ` +
            "which is no file the archive wrote before it",
        );
      }
      copyFileSync(at(source), path);
      const stat = statSync(at(source));
      utimesSync(path, stat.atime, stat.mtime);
      continue;
    }
    if (entry.type !== "0" && entry.type !== "7") {
      throw new Error(
        `the archive member ${show(entry.name)} is of a kind a snapshot never holds (type ${JSON.stringify(entry.type)})`,
      );
    }
    writeFile(read, path, entry.dataOffset, entry.size, entry.mode & 0o777, entry.name);
    regularFiles.add(key);
    utimesSync(path, entry.mtime, entry.mtime);
  }
  for (const { rel, target } of links.values()) {
    assertNoSymlinkAncestors(base, rel);
    mkdirSync(at(parentOf(rel)), { recursive: true });
    const path = at(rel);
    removeUnlessDirectory(path);
    symlinkSync(target, path);
  }
  for (const { path, mode, mtime } of dirs.toReversed()) {
    if ((mode & 0o700) !== 0o700) chmodSync(path, mode);
    utimesSync(path, mtime, mtime);
  }
}

/** Refuse to traverse a path component an earlier deferred link created. */
function assertNoSymlinkAncestors(base: Buffer, rel: Buffer): void {
  const parts = rel.toString("latin1").split("/");
  let current = base;
  for (const part of parts.slice(0, -1)) {
    current = Buffer.concat([current, SLASH, Buffer.from(part, "latin1")]);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`an archive link path crosses an earlier symbolic link: ${show(rel)}`);
    }
  }
}

/**
 * The member's path relative to the extraction folder, `./` and empty
 * components dropped, or null for the folder itself. Throws for a name
 * that would leave the folder.
 */
function memberPath(name: Buffer): Buffer | null {
  const parts = name
    .toString("latin1")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const text = name.toString("latin1");
  const leaves =
    text.startsWith("/") ||
    parts.includes("..") ||
    (process.platform === "win32" && (text.includes("\\") || text.includes(":")));
  if (leaves) {
    throw new Error(`the archive member ${show(name)} leaves the extraction folder`);
  }
  if (parts.length === 0) return null;
  return Buffer.from(parts.join("/"), "latin1");
}

function parentOf(rel: Buffer): Buffer {
  const cut = rel.lastIndexOf(0x2f);
  return cut === -1 ? Buffer.alloc(0) : rel.subarray(0, cut);
}

/** Remove a file or link at `path` so a later member replaces it; a directory stays. */
function removeUnlessDirectory(path: Buffer): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isDirectory()) rmSync(path, { force: true });
}

function writeFile(
  read: TarRead,
  path: Buffer,
  offset: number,
  size: number,
  mode: number,
  name: Buffer,
): void {
  const fd = openSync(path, "wx", mode);
  try {
    let done = 0;
    while (done < size) {
      const chunk = read(offset + done, Math.min(CHUNK, size - done));
      if (chunk.length === 0) {
        throw new Error(`the archive ends inside the member ${show(name)}`);
      }
      let written = 0;
      while (written < chunk.length) {
        written += writeSync(fd, chunk, written, chunk.length - written);
      }
      done += chunk.length;
    }
  } finally {
    closeSync(fd);
  }
}

function show(name: Buffer | null): string {
  return JSON.stringify((name ?? Buffer.alloc(0)).toString("utf8"));
}
