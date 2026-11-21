/**
 * The in-process tar writer the Windows snapshot uses (`tar-writer.ts`).
 *
 * Two guarantees:
 * 1. The archive stores every name exactly as given, NFC and NFD twins as
 *    two members with their own bodies: read back from the headers
 *    (`tar-names.ts`), which does not depend on any tar or filesystem.
 * 2. Linux and macOS system tar independently extract every file under its
 *    name with its bytes. Windows verifies the archive with the product
 *    reader and checks its raw pax and ustar headers, because Windows tar
 *    does not accept these UTF-8 names.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTarMemberNames, tarEntries } from "../../../src/core/brain/tar-names.ts";
import { extractTarArchive } from "../../../src/core/brain/tar-extract.ts";
import { writeTarArchive } from "../../../src/core/brain/tar-writer.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { readerOf, tarOf } from "./fixtures/tar-fixture.ts";

let root: string;
let src: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-tar-writer-"));
  src = join(root, "src");
  out = join(root, "out");
  mkdirSync(join(src, "Brain"), { recursive: true });
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
  "cafe\u0301-plan.md",
  "résumé-notes.md",
  `${"я".repeat(64)}-abcdef.md`,
];

/** Extract `archive` with the system tar into `out`, from inside it (no `-C`). */
function extract(archive: string): void {
  const r = spawnSync("tar", ["-x", "-f", "-"], { cwd: out, input: readFileSync(archive) });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr.toString()}`);
}

/** The member names of `archive`, read from its headers. */
function storedNames(archive: string): string[] {
  const bytes = readFileSync(archive);
  return readTarMemberNames((offset, length) => bytes.subarray(offset, offset + length)).map(
    (m) => m.name,
  );
}

/** Check raw pax path records and the following ustar member headers. */
function expectRawStructure(
  archive: string,
  expected: ReadonlyArray<{ name: string; size: number; type: string }>,
): void {
  const bytes = readFileSync(archive);
  let offset = 0;
  const actual: Array<{ name: string; size: number; type: string }> = [];
  while (offset < bytes.length && !bytes.subarray(offset, offset + 512).every((b) => b === 0)) {
    const header = bytes.subarray(offset, offset + 512);
    const type = String.fromCharCode(header[156]!);
    const size =
      parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0;
    if (type === "x") {
      const pax = bytes.subarray(offset + 512, offset + 512 + size);
      const nextOffset = offset + 512 + Math.ceil(size / 512) * 512;
      const memberHeader = bytes.subarray(nextOffset, nextOffset + 512);
      const memberType = String.fromCharCode(memberHeader[156]!);
      const memberSize =
        parseInt(
          memberHeader.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(),
          8,
        ) || 0;
      const record = pax
        .toString("utf8")
        .split("\n")
        .find((line) => line.includes(" path="));
      expect(record).toBeDefined();
      const name = record!.slice(record!.indexOf(" path=") + 6);
      expect(pax.includes(Buffer.from(`path=${name}\n`, "utf8"))).toBe(true);
      actual.push({ name, size: memberSize, type: memberType });
      offset = nextOffset + 512 + Math.ceil(memberSize / 512) * 512;
    } else {
      const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
      actual.push({ name, size, type });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  expect(actual).toEqual([...expected]);
}

describe("writeTarArchive", () => {
  test("names in any script and form, a long name, a directory and an empty file come back", () => {
    mkdirSync(join(src, "Brain", "темы"));
    const members = [Buffer.from("Brain"), Buffer.from("Brain/темы")];
    for (const [i, name] of NAMES.entries()) {
      writeFileSync(join(src, "Brain", "темы", name), `body ${i}\n`.repeat(i * 300));
      members.push(Buffer.from(`Brain/темы/${name}`));
    }
    const archive = join(root, "a.tar");
    writeTarArchive(src, members, archive);
    expect(storedNames(archive)).toEqual([
      "Brain/",
      "Brain/темы/",
      ...NAMES.map((n) => `Brain/темы/${n}`),
    ]);
    const expected = [
      { name: "Brain/", size: 0, type: "5" },
      { name: "Brain/темы/", size: 0, type: "5" },
      ...NAMES.map((name, i) => ({
        name: `Brain/темы/${name}`,
        size: Buffer.byteLength(`body ${i}\n`.repeat(i * 300)),
        type: "0",
      })),
    ];
    expectRawStructure(archive, expected);
    if (IS_WINDOWS) {
      extractTarArchive(readerOf(readFileSync(archive)), out);
    } else {
      extract(archive);
    }
    for (const [i, name] of NAMES.entries()) {
      expect(readFileSync(join(out, "Brain", "темы", name), "utf8")).toBe(
        `body ${i}\n`.repeat(i * 300),
      );
    }
  });

  test("NFC and NFD twins are stored as two members, byte for byte, each with its body", () => {
    const nfc = "café-plan.md";
    const nfd = "cafe\u0301-plan.md";
    // Each twin is written from a folder of its own: on APFS two files
    // with these names in one folder are one file.
    const bytes = tarOf(root, [
      [`Brain/${nfc}`, "one\n"],
      [`Brain/${nfd}`, "two\n"],
    ]);
    const read = readerOf(bytes);
    const members = [...tarEntries(read)].map((e) => ({
      name: e.name.toString("hex"),
      body: read(e.dataOffset, e.size).toString("utf8"),
    }));
    expect(members).toEqual([
      { name: Buffer.from(`Brain/${nfc}`).toString("hex"), body: "one\n" },
      { name: Buffer.from(`Brain/${nfd}`).toString("hex"), body: "two\n" },
    ]);
  });

  test.skipIf(IS_WINDOWS)("a symbolic link keeps its target", () => {
    writeFileSync(join(src, "Brain", "целевой.md"), "x");
    symlinkSync("целевой.md", join(src, "Brain", "ссылка.md"));
    const archive = join(root, "l.tar");
    writeTarArchive(
      src,
      [Buffer.from("Brain"), Buffer.from("Brain/целевой.md"), Buffer.from("Brain/ссылка.md")],
      archive,
    );
    extract(archive);
    expect(lstatSync(join(out, "Brain", "ссылка.md")).isSymbolicLink()).toBe(true);
    // macOS bsdtar writes the target in NFD; the name it names is the same.
    expect(readlinkSync(join(out, "Brain", "ссылка.md")).normalize("NFC")).toBe("целевой.md");
    expect(readFileSync(join(out, "Brain", "ссылка.md"), "utf8")).toBe("x");
  });

  test("a member that vanished throws ENOENT and leaves the caller to decide", () => {
    let code: string | undefined;
    try {
      writeTarArchive(
        src,
        [Buffer.from("Brain"), Buffer.from("Brain/gone.md")],
        join(root, "v.tar"),
      );
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ENOENT");
  });
});
