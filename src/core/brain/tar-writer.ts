/**
 * A tar (POSIX pax) writer for the snapshot of `Brain/`, in process.
 *
 * Windows `tar.exe` (bsdtar in `System32`) reads the names of a `-T` list
 * in the ANSI code page, not UTF-8. A Cyrillic, CJK or accented file name
 * (a decision or topic slug in any script) then decodes to a name that does
 * not exist, or to an empty one ("tar: : Couldn't visit directory"), and
 * the snapshot fails. Its `-C <dir>` argument goes through the same code
 * page. Names handed to this writer travel as Node paths instead (UTF-16 on
 * Windows) and are stored as pax `path` records in UTF-8, which GNU tar
 * and bsdtar both extract under the right name on every platform.
 *
 * Members are vault-relative byte names (`Brain/...`), in the order given:
 * directories (stored with a trailing `/`), regular files and symbolic
 * links; any other kind of entry is left out, as tar leaves out a socket.
 * A member that vanishes before it is read throws the `lstat` or `open`
 * error (`ENOENT`), so the caller can tell a vanished member from a
 * failure. A file is archived with the size it has when the writer opens
 * it (`fstat` on that descriptor), not when the member list was built: one
 * that grows while it is read keeps that many bytes, and one that shrinks
 * fails the archive, as a short read cannot be told from a damaged file.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  writeSync,
} from "node:fs";

const BLOCK = 512;
const CHUNK = 1024 * 1024;
/** The largest size the 11 octal digits of a ustar header hold. */
const USTAR_MAX_SIZE = 0o77777777777;
const USTAR_MAX_ID = 0o7777777;
const SLASH = Buffer.from("/");

/** Write the tar stream of `members` (relative to `root`) into `outPath`, which must not exist. */
export function writeTarArchive(
  root: string,
  members: ReadonlyArray<Buffer>,
  outPath: string,
): void {
  const out = openSync(outPath, "wx");
  try {
    const base = Buffer.from(root);
    for (const member of members) {
      writeMember(out, Buffer.concat([base, SLASH, member]), member);
    }
    writeAll(out, Buffer.alloc(BLOCK * 2));
  } finally {
    closeSync(out);
  }
}

function writeMember(out: number, abs: Buffer, rel: Buffer): void {
  const stat = lstatSync(abs);
  const common = {
    mode: stat.mode & 0o7777,
    uid: stat.uid <= USTAR_MAX_ID ? stat.uid : 0,
    gid: stat.gid <= USTAR_MAX_ID ? stat.gid : 0,
    mtime: Math.max(0, Math.floor(stat.mtimeMs / 1000)),
  };
  if (stat.isDirectory()) {
    writeHeaders(out, { ...common, name: Buffer.concat([rel, SLASH]), type: "5", size: 0 });
    return;
  }
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(abs, { encoding: "buffer" });
    writeHeaders(out, { ...common, name: rel, type: "2", size: 0, link });
    return;
  }
  if (!stat.isFile()) return;
  // The size is the opened file's: a file renamed into place between the
  // `lstat` and the `open` is archived whole under its own size, never cut
  // at the size of the one it replaced. A link put there meanwhile is not
  // followed where the platform can refuse it.
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`${rel.toString()} is no longer a regular file`);
    }
    const size = opened.size;
    writeHeaders(out, { ...common, name: rel, type: "0", size });
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    let done = 0;
    while (done < size) {
      const want = Math.min(buf.length, size - done);
      const got = readSync(fd, buf, 0, want, done);
      if (got === 0) {
        throw new Error(
          `${rel.toString()} shrank from ${size} to ${done} bytes while it was archived`,
        );
      }
      writeAll(out, buf.subarray(0, got));
      done += got;
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) writeAll(out, Buffer.alloc(pad));
  } finally {
    closeSync(fd);
  }
}

interface MemberHeader {
  readonly name: Buffer;
  readonly type: "0" | "2" | "5";
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtime: number;
  readonly link?: Buffer;
}

/** The pax extended header a member needs (none for a short ASCII one), then its ustar header. */
function writeHeaders(out: number, h: MemberHeader): void {
  const records: Buffer[] = [];
  const binary = !isUtf8(h.name) || (h.link !== undefined && !isUtf8(h.link));
  if (binary) records.push(paxRecord("hdrcharset", Buffer.from("BINARY")));
  if (!fitsUstarName(h.name)) records.push(paxRecord("path", h.name));
  if (h.link !== undefined && !fitsUstarName(h.link)) records.push(paxRecord("linkpath", h.link));
  if (h.size > USTAR_MAX_SIZE) records.push(paxRecord("size", Buffer.from(String(h.size))));
  if (records.length > 0) {
    const body = Buffer.concat(records);
    writeAll(
      out,
      ustarHeader({
        ...h,
        name: Buffer.from("././@PaxHeader"),
        type: "x",
        size: body.length,
        link: undefined,
      }),
    );
    writeAll(out, body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad > 0) writeAll(out, Buffer.alloc(pad));
  }
  writeAll(out, ustarHeader(h));
}

/** A ustar header block; a name or link the pax header carries is stored as an ASCII stand-in. */
function ustarHeader(h: Omit<MemberHeader, "type"> & { readonly type: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  asciiStandIn(h.name).copy(block, 0);
  octal(h.mode, 8).copy(block, 100);
  octal(h.uid, 8).copy(block, 108);
  octal(h.gid, 8).copy(block, 116);
  octal(h.size > USTAR_MAX_SIZE ? 0 : h.size, 12).copy(block, 124);
  octal(h.mtime, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(h.type, 156, "latin1");
  if (h.link !== undefined) asciiStandIn(h.link).copy(block, 157);
  block.write("ustar\u000000", 257, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\u0000 `, "latin1").copy(block, 148);
  return block;
}

/** One pax record, `<length> <key>=<value>\n`, its length counting its own digits. */
function paxRecord(key: string, value: Buffer): Buffer {
  const rest = Buffer.byteLength(` ${key}=`) + value.length + 1;
  const digits = String(rest).length;
  const length = String(rest + digits).length > digits ? rest + digits + 1 : rest + digits;
  return Buffer.concat([Buffer.from(`${length} ${key}=`), value, Buffer.from("\n")]);
}

function fitsUstarName(name: Buffer): boolean {
  return name.length <= 100 && name.every((b) => b >= 0x20 && b < 0x7f);
}

/** The first 100 bytes of `name` with every byte outside printable ASCII as `_`. */
function asciiStandIn(name: Buffer): Buffer {
  const cut = Buffer.from(name.subarray(0, 100));
  for (let i = 0; i < cut.length; i++) {
    if (cut[i]! < 0x20 || cut[i]! >= 0x7f) cut[i] = 0x5f;
  }
  return cut;
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\u0000`, "latin1");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function isUtf8(bytes: Buffer): boolean {
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let done = 0;
  while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done);
}
