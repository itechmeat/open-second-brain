/**
 * Tar streams for tests, built so the host filesystem cannot merge two
 * members: each member is written from a folder of its own and the
 * single-member streams are joined. On APFS an NFC name and its NFD twin
 * are one file, so two such files written into one folder would leave one
 * body; here every member keeps its own name and body on every platform.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeTarArchive } from "../../../../src/core/brain/tar-writer.ts";

/** A member: a directory (`body` null) or a file with its body, by its path in the archive. */
export type TarFixtureMember = readonly [name: string, body: string | null];

const END = 1024;

/** The tar stream of `members`, in order, written under the scratch folder `scratch`. */
export function tarOf(scratch: string, members: ReadonlyArray<TarFixtureMember>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of members) {
    const src = mkdtempSync(join(scratch, "tar-member-"));
    try {
      const path = join(src, ...name.split("/"));
      if (body === null) {
        mkdirSync(path, { recursive: true });
      } else {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, body);
      }
      const out = join(src, "member.tar");
      writeTarArchive(src, [Buffer.from(name)], out);
      const bytes = readFileSync(out);
      parts.push(bytes.subarray(0, bytes.length - END));
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  }
  parts.push(Buffer.alloc(END));
  return Buffer.concat(parts);
}

/** A reader over `bytes` in the shape the tar readers take. */
export function readerOf(bytes: Buffer): (offset: number, length: number) => Buffer {
  return (offset, length) => bytes.subarray(offset, offset + length);
}
