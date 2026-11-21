/**
 * The in-process tar reader every restore uses (`tar-extract.ts`).
 *
 * Windows `tar.exe` refused every pax name its ANSI code page lacks
 * ("Archive entry has empty or unreadable filename") and macOS bsdtar
 * renamed every NFC name to NFD, so the restore reads the stream itself.
 * Asserted on every platform: each name and body comes back as the archive
 * stores it; nothing is written outside the folder, through a link the
 * archive planted or for a name that climbs out; an archive the system tar
 * wrote (an older snapshot: GNU long names, hard links, symlinks) reads; a
 * pax record set reaches the member it describes and no other; an archive
 * that was cut short and an old GNU sparse member are refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTarArchive } from "../../../src/core/brain/tar-extract.ts";
import { writeTarArchive } from "../../../src/core/brain/tar-writer.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { readerOf, tarOf } from "./fixtures/tar-fixture.ts";

let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-tar-extract-"));
  out = join(root, "out");
  mkdirSync(out);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Names in several scripts and forms, no two equal after normalization. */
const NAMES = [
  "plain.md",
  "решение-формат-заметок.md",
  "决策-发布格式.md",
  "café-plan.md",
  "résumé-notes.md",
  `${"я".repeat(64)}-abcdef.md`,
];

describe("extractTarArchive", () => {
  test("every name in any script and form comes back byte for byte, with its body", () => {
    const tar = tarOf(root, [
      ["Brain", null],
      ["Brain/темы-主题", null],
      ...NAMES.map((n, i) => [`Brain/темы-主题/${n}`, `body ${i}\n`.repeat(i * 300)] as const),
    ]);
    extractTarArchive(readerOf(tar), out);
    const dir = join(out, "Brain", "темы-主题");
    expect(
      readdirSync(dir)
        .map((n) => Buffer.from(n).toString("hex"))
        .toSorted(),
    ).toEqual(NAMES.map((n) => Buffer.from(n).toString("hex")).toSorted());
    for (const [i, name] of NAMES.entries()) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(`body ${i}\n`.repeat(i * 300));
    }
  });

  test("a later member at the same path replaces the earlier one, as tar does", () => {
    const tar = tarOf(root, [
      ["Brain/note.md", "first\n"],
      ["Brain/note.md", "second\n"],
    ]);
    extractTarArchive(readerOf(tar), out);
    expect(readFileSync(join(out, "Brain", "note.md"), "utf8")).toBe("second\n");
  });

  test("a parent folder the archive does not list is created", () => {
    extractTarArchive(readerOf(tarOf(root, [["Brain/a/b/c.md", "x"]])), out);
    expect(readFileSync(join(out, "Brain", "a", "b", "c.md"), "utf8")).toBe("x");
  });

  for (const name of ["Brain/../escaped.md", "../escaped.md"]) {
    test(`a member named ${JSON.stringify(name)} is refused and nothing lands outside`, () => {
      const src = join(root, "src");
      mkdirSync(join(src, "Brain"), { recursive: true });
      writeFileSync(join(src, "escaped.md"), "x");
      writeFileSync(join(root, "escaped.md"), "outside\n");
      const archive = join(root, "e.tar");
      writeTarArchive(src, [Buffer.from(name)], archive);
      expect(() => extractTarArchive(readerOf(readFileSync(archive)), out)).toThrow(
        "leaves the extraction folder",
      );
      expect(readFileSync(join(root, "escaped.md"), "utf8")).toBe("outside\n");
      expect(existsSync(join(out, "escaped.md"))).toBe(false);
    });
  }

  test.skipIf(IS_WINDOWS)("a symbolic link keeps its target byte for byte", () => {
    const src = join(root, "src");
    mkdirSync(join(src, "Brain"), { recursive: true });
    writeFileSync(join(src, "Brain", "café-целевой.md"), "x");
    symlinkSync("café-целевой.md", join(src, "Brain", "ссылка.md"));
    const archive = join(root, "l.tar");
    writeTarArchive(
      src,
      [Buffer.from("Brain"), Buffer.from("Brain/café-целевой.md"), Buffer.from("Brain/ссылка.md")],
      archive,
    );
    extractTarArchive(readerOf(readFileSync(archive)), out);
    const link = join(out, "Brain", "ссылка.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(Buffer.from(readlinkSync(link))).toEqual(Buffer.from("café-целевой.md"));
    expect(readFileSync(link, "utf8")).toBe("x");
  });

  test.skipIf(IS_WINDOWS)("no member is written through a link the archive planted", () => {
    const src = join(root, "src");
    const outside = join(root, "outside");
    mkdirSync(join(src, "Brain"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), "outside\n");
    symlinkSync(outside, join(src, "Brain", "l"));
    const archive = join(root, "p.tar");
    // The link first, then a file "inside" it: tar would follow the link.
    writeTarArchive(src, [Buffer.from("Brain/l"), Buffer.from("Brain/l/x.md")], archive);
    expect(() => extractTarArchive(readerOf(readFileSync(archive)), out)).toThrow();
    expect(readFileSync(join(outside, "x.md"), "utf8")).toBe("outside\n");
  });

  test.skipIf(IS_WINDOWS)("deferred links cannot write through links to links", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim"), "safe\n");
    const first = join(root, "links");
    mkdirSync(join(first, "Brain"), { recursive: true });
    symlinkSync("b", join(first, "Brain", "a"));
    symlinkSync(outside, join(first, "Brain", "b"));
    const firstTar = join(root, "first.tar");
    writeTarArchive(first, [Buffer.from("Brain/a"), Buffer.from("Brain/b")], firstTar);
    const second = join(root, "nested-link");
    mkdirSync(join(second, "Brain", "a"), { recursive: true });
    symlinkSync("target", join(second, "Brain", "a", "victim"));
    const secondTar = join(root, "second.tar");
    writeTarArchive(second, [Buffer.from("Brain/a/victim")], secondTar);
    const archive = Buffer.concat([
      readFileSync(firstTar).subarray(0, -1024),
      readFileSync(secondTar).subarray(0, -1024),
      Buffer.alloc(1024),
    ]);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/symbolic link/u);
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe("safe\n");
  });

  test.skipIf(IS_WINDOWS)(
    "an archive the system tar wrote reads: long names, hard links, links, folders",
    () => {
      const src = join(root, "src");
      const long = `${"d".repeat(120)}/${"ф".repeat(80)}.md`;
      mkdirSync(join(src, "Brain", "d".repeat(120)), { recursive: true });
      writeFileSync(join(src, "Brain", long), "long\n");
      writeFileSync(join(src, "Brain", "a.md"), "linked\n");
      linkSync(join(src, "Brain", "a.md"), join(src, "Brain", "b.md"));
      symlinkSync("a.md", join(src, "Brain", "s.md"));
      const r = spawnSync("tar", ["-cf", "-", "Brain"], { cwd: src, maxBuffer: 64 << 20 });
      expect(r.status).toBe(0);
      extractTarArchive(readerOf(r.stdout), out);
      expect(readFileSync(join(out, "Brain", long), "utf8")).toBe("long\n");
      expect(readFileSync(join(out, "Brain", "a.md"), "utf8")).toBe("linked\n");
      expect(readFileSync(join(out, "Brain", "b.md"), "utf8")).toBe("linked\n");
      expect(readlinkSync(join(out, "Brain", "s.md"))).toBe("a.md");
    },
  );

  test("a file keeps its stored time", () => {
    const src = join(root, "src");
    mkdirSync(join(src, "Brain"), { recursive: true });
    writeFileSync(join(src, "Brain", "t.md"), "x");
    const archive = join(root, "t.tar");
    writeTarArchive(src, [Buffer.from("Brain/t.md")], archive);
    const stored = Math.floor(statSync(join(src, "Brain", "t.md")).mtimeMs / 1000);
    extractTarArchive(readerOf(readFileSync(archive)), out);
    expect(Math.floor(statSync(join(out, "Brain", "t.md")).mtimeMs / 1000)).toBe(stored);
  });

  test("a stream cut inside a member is refused", () => {
    const tar = tarOf(root, [["Brain/big.md", "z".repeat(5000)]]);
    expect(() => extractTarArchive(readerOf(tar.subarray(0, 2048)), out)).toThrow();
  });

  test("pax sparse metadata is refused before its payload is written as an ordinary file", () => {
    const member = tarFile("Brain/sparse-placeholder", "packed extents");
    const archive = withPaxRecord("GNU.sparse.map", "0,4", member);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/sparse pax metadata/u);
    expect(existsSync(join(out, "Brain", "sparse-placeholder"))).toBe(false);
  });

  test("unsupported FIFO members refuse instead of leaving an earlier file at the same path", () => {
    const regular = tarOf(root, [["Brain/item", "stale"]]).subarray(0, -1024);
    const fifoHeader = tarHeader("Brain/item", "6", 0);
    const archive = Buffer.concat([regular, fifoHeader, Buffer.alloc(1024)]);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/unsupported special file/u);
  });

  test("a pax record set that a GNU long name header comes between reaches no member", () => {
    const archive = Buffer.concat([
      paxHeader({ size: "4096" }),
      gnuLongName("Brain/long.md"),
      tarFile("Brain/plain.md", "hello\n"),
      Buffer.alloc(1024),
    ]);
    extractTarArchive(readerOf(archive), out);
    expect(readFileSync(join(out, "Brain", "long.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(out, "Brain", "plain.md"))).toBe(false);
  });

  test("a pax record set applies to the member that follows it and to no other", () => {
    const archive = Buffer.concat([
      paxHeader({ path: "Brain/pax.md" }),
      tarFile("Brain/a.md", "aaaaa\n"),
      tarFile("Brain/b.md", "bbbbbb\n"),
      Buffer.alloc(1024),
    ]);
    extractTarArchive(readerOf(archive), out);
    expect(readFileSync(join(out, "Brain", "pax.md"), "utf8")).toBe("aaaaa\n");
    expect(readFileSync(join(out, "Brain", "b.md"), "utf8")).toBe("bbbbbb\n");
  });

  test("a stream that ends without the end-of-archive marker is refused as truncated", () => {
    const archive = tarOf(root, [["Brain/a.md", "x"]]).subarray(0, 1024);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/truncat/u);
  });

  test("a stream with one zero block instead of the two of the end-of-archive marker is refused", () => {
    const archive = tarOf(root, [["Brain/a.md", "x"]]).subarray(0, 1536);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/truncat/u);
  });

  test("an old GNU sparse member is refused instead of extracting its sparse map as its content", () => {
    const archive = Buffer.concat([
      oldGnuSparseHeader("Brain/sparse.md"),
      Buffer.alloc(512),
      Buffer.alloc(1024),
    ]);
    expect(() => extractTarArchive(readerOf(archive), out)).toThrow(/sparse/u);
    expect(existsSync(join(out, "Brain", "sparse.md"))).toBe(false);
  });
});

function withPaxRecord(key: string, value: string, member: Buffer): Buffer {
  return Buffer.concat([paxHeader({ [key]: value }), member, Buffer.alloc(1024)]);
}

/** A pax extended header and its body, one `<length> <key>=<value>\n` record each. */
function paxHeader(records: Readonly<Record<string, string>>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(records)) {
    const content = `${key}=${value}\n`;
    let length = content.length + 2;
    for (;;) {
      const next = String(length).length + 1 + content.length;
      if (next === length) break;
      length = next;
    }
    parts.push(Buffer.from(`${length} ${content}`));
  }
  const body = Buffer.concat(parts);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([tarHeader("PaxHeader", "x", body.length), padded]);
}

/** A GNU long name header and the name it holds. */
function gnuLongName(name: string): Buffer {
  const content = Buffer.concat([Buffer.from(name, "utf8"), Buffer.alloc(1)]);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([tarHeader("././@LongLink", "L", content.length), padded]);
}

/** A header of the old GNU sparse form: the GNU magic and the extended byte set. */
function oldGnuSparseHeader(name: string): Buffer {
  const header = tarHeader(name, "0", 512);
  header.write("ustar  \0", 257, 8, "latin1");
  header[482] = 1;
  return withChecksum(header);
}

function tarFile(name: string, body: string): Buffer {
  const content = Buffer.from(body);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([tarHeader(name, "0", content.length), padded]);
}

function tarHeader(name: string, type: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  return withChecksum(header);
}

/** The header with the checksum of the bytes it now holds. */
function withChecksum(header: Buffer): Buffer {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}
