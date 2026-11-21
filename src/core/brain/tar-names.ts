/**
 * The members of a tar stream, read from its headers.
 *
 * One walker serves both readers of a snapshot archive: the check a
 * restore runs before anything is written (whether two members would land
 * on one path of the extraction folder) and the extraction itself
 * (`tar-extract.ts`). It reads ustar names and prefixes, pax `path`,
 * `linkpath`, `size` and `mtime` records and GNU long names and long link
 * names, checks every header's checksum, and skips the data; it writes
 * nothing. Names are kept as the bytes the archive stores, so a name that
 * is not UTF-8 (a pax `hdrcharset=BINARY` member) is extracted byte for
 * byte where the filesystem takes bytes.
 *
 * A pax extended header describes the header that follows it and no other:
 * a GNU long name or long link header in between spends those records, so a
 * member never takes a size or a path from records meant for another header.
 * An archive ends with the two zero blocks of the end-of-archive marker; a
 * stream that ends without them is cut short and refused. The old GNU
 * sparse forms are refused, as the pax sparse records are.
 */

const BLOCK = 512;

/** The end of an archive is marked by two zero blocks; a stream without them is cut short. */
const TRUNCATED = "the tar stream is truncated: it ends without the end-of-archive marker";

/** One member: its name as stored, and whether it is a directory. */
export interface TarMemberName {
  readonly name: string;
  readonly directory: boolean;
}

/** One member header, with where its data starts. */
export interface TarEntry {
  /** The member's name, as the archive stores it. */
  readonly name: Buffer;
  /** The ustar type flag (`0` file, `1` hard link, `2` symlink, `5` directory, ...). */
  readonly type: string;
  /** Bytes of data that follow the header. */
  readonly size: number;
  /** Offset of the data in the stream. */
  readonly dataOffset: number;
  readonly mode: number;
  /** Seconds since the epoch. */
  readonly mtime: number;
  /** The target of a link member, else null. */
  readonly linkName: Buffer | null;
}

/** `read(offset, length)` returns at most `length` bytes at `offset`, fewer at the end. */
export type TarRead = (offset: number, length: number) => Buffer;

/**
 * Every member of the tar stream `read` gives, in order; the pax and GNU
 * meta headers are folded into the member they describe. Throws on a
 * header whose checksum does not hold, a size that cannot be read, a
 * stream that ends inside a member, and a stream that ends without the
 * end-of-archive marker.
 */
export function* tarEntries(read: TarRead): Generator<TarEntry> {
  let offset = 0;
  let pax = new Map<string, Buffer>();
  let longName: Buffer | null = null;
  let longLink: Buffer | null = null;
  for (;;) {
    const header = read(offset, BLOCK);
    if (header.length < BLOCK) {
      if (header.some((b) => b !== 0))
        throw new Error("the tar stream is truncated inside a header");
      throw new Error(TRUNCATED);
    }
    if (isZeroBlock(header)) {
      // The end of an archive is marked by two zero blocks. A stream that
      // ends before the second one is cut short; a lone zero block in the
      // middle is the archive going on after it, as the system tar reads it.
      const marker = read(offset + BLOCK, BLOCK);
      if (marker.length < BLOCK) throw new Error(TRUNCATED);
      if (isZeroBlock(marker)) return;
      offset += BLOCK;
      continue;
    }
    if (!checksumHolds(header)) throw new Error(`a tar header at byte ${offset} is damaged`);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const paxSize = pax.get("size");
    const size =
      paxSize !== undefined && !isMeta(type)
        ? Number(paxSize.toString("latin1"))
        : readNumber(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`a tar header at byte ${offset} has no readable size`);
    }
    const dataOffset = offset + BLOCK;
    const next = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    if (isMeta(type)) {
      if (type === "x" || type === "L" || type === "K") {
        const data = read(dataOffset, size);
        if (data.length < size) throw new Error("the tar stream ends inside a member");
        if (type === "x") {
          pax = paxRecords(data);
          refuseSparsePax(pax);
        } else {
          // A GNU long name or long link header describes the member itself,
          // so the pax records before it are spent on it: they reach no
          // member after it.
          pax = new Map();
          if (type === "L") longName = cBytes(data);
          else longLink = cBytes(data);
        }
      } else if (type === "g") {
        const data = read(dataOffset, size);
        if (data.length < size) throw new Error("the tar stream ends inside a member");
        const records = paxRecords(data);
        refuseSparsePax(records);
        throw new Error("global pax metadata is not supported by the snapshot reader");
      }
      offset = next;
      continue;
    }
    if (isOldGnuSparse(header, type)) {
      throw new Error(`unsupported old GNU sparse member at byte ${offset}`);
    }
    const paxMtime = pax.get("mtime");
    yield {
      name: pax.get("path") ?? longName ?? ustarName(header),
      type,
      size,
      dataOffset,
      mode: readNumber(header.subarray(100, 108)),
      mtime:
        paxMtime !== undefined
          ? Math.floor(Number(paxMtime.toString("latin1")))
          : readNumber(header.subarray(136, 148)),
      linkName:
        type === "1" || type === "2"
          ? (pax.get("linkpath") ?? longLink ?? cBytes(header.subarray(157, 257)))
          : null,
    };
    pax = new Map();
    longName = null;
    longLink = null;
    offset = next;
  }
}

/** Sparse pax data changes how the payload maps to file offsets; this reader does not implement it. */
function refuseSparsePax(records: ReadonlyMap<string, Buffer>): void {
  const sparse = [...records.keys()].find(
    (key) => key.startsWith("GNU.sparse.") || key === "SCHILY.realsize",
  );
  if (sparse !== undefined) throw new Error(`unsupported sparse pax metadata: ${sparse}`);
}

/** The members of the tar stream `read` gives ({@link tarEntries}), by name. */
export function readTarMemberNames(read: TarRead): TarMemberName[] {
  const out: TarMemberName[] = [];
  for (const entry of tarEntries(read)) {
    const name = entry.name.toString("utf8");
    out.push({ name, directory: entry.type === "5" || name.endsWith("/") });
  }
  return out;
}

/** A pax extended or global header, or a GNU long name or long link name. */
function isMeta(type: string): boolean {
  return type === "x" || type === "g" || type === "L" || type === "K";
}

/** A block of nothing, as the end-of-archive marker holds. */
function isZeroBlock(block: Buffer): boolean {
  return block.every((b) => b === 0);
}

/**
 * The old GNU sparse form: the GNU magic (`ustar  `) and the extended
 * header byte set. Its payload is a sparse map, not the member's content,
 * so it is refused like the pax sparse records are.
 */
function isOldGnuSparse(header: Buffer, type: string): boolean {
  if (type !== "0" && type !== "S") return false;
  if (header.subarray(257, 264).toString("latin1") !== "ustar  ") return false;
  return header[482] !== 0;
}

function ustarName(header: Buffer): Buffer {
  const name = cBytes(header.subarray(0, 100));
  // Only a POSIX header (`ustar\0`) has a prefix field; a GNU one
  // (`ustar  `) keeps other fields there.
  const posix = header.subarray(257, 263).toString("latin1") === "ustar\u0000";
  const prefix = posix ? cBytes(header.subarray(345, 500)) : Buffer.alloc(0);
  return prefix.length > 0 ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
}

function cBytes(field: Buffer): Buffer {
  const end = field.indexOf(0);
  return Buffer.from(field.subarray(0, end === -1 ? field.length : end));
}

function readNumber(field: Buffer): number {
  // GNU base-256: the high bit of the first byte set.
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = octalDigits(field);
  return text.length === 0 ? 0 : parseInt(text, 8);
}

/** The octal digits of a numeric header field, its NUL and space padding dropped. */
function octalDigits(field: Buffer): string {
  let text = "";
  for (const byte of field) {
    if (byte >= 0x30 && byte <= 0x37) text += String.fromCharCode(byte);
    else if (text.length > 0) break;
  }
  return text;
}

function checksumHolds(header: Buffer): boolean {
  const stored = parseInt(
    header
      .subarray(148, 156)
      .toString("latin1")
      .split("")
      .filter((c) => c >= "0" && c <= "7")
      .join(""),
    8,
  );
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return stored === sum;
}

/** The records of a pax extended header, `<length> <key>=<value>\n` each; values kept as bytes. */
function paxRecords(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = parseInt(data.subarray(at, space).toString("latin1"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1);
    const eq = record.indexOf(0x3d);
    if (eq !== -1) {
      out.set(record.subarray(0, eq).toString("utf8"), Buffer.from(record.subarray(eq + 1)));
    }
    at += length;
  }
  return out;
}
