/**
 * The member list a snapshot hands to tar (`--no-recursion --null -T`).
 *
 * Three properties, each of which the list is the only thing standing
 * behind, because tar is told not to walk the tree itself:
 *
 *  - ORDER: depth-first, siblings in byte order, whatever order the
 *    filesystem's `readdir` returns them in. This is what "the member order
 *    is deterministic" means; the bytes are not (tar headers carry mtimes).
 *  - COMPLETENESS: a directory the walk cannot read fails the snapshot. A
 *    swallowed error here archived the directory EMPTY, and bsdtar (macOS,
 *    Windows `tar.exe`) reported success for that.
 *  - EXACT NAMES: a POSIX file name need not be UTF-8. Decoded to a string,
 *    `caf\xe9.md` came back as `caf�.md`, a name that does not exist,
 *    and GNU tar refused the whole archive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import {
  BrainSnapshotError,
  bufferEntryName,
  createSnapshot,
  isSnapshotExcludedEntry,
  sortedMembers,
} from "../../../src/core/brain/snapshot.ts";
import { system32Tool } from "../../../src/core/brain/secrets/owner-acl.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";
import { extractSnapshotArchive, listSnapshotArchive } from "../../helpers/snapshot-archive.ts";

const DREAM = BRAIN_SNAPSHOT_REASON.dream;

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-members-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-members-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const names = (members: ReadonlyArray<Buffer>): string[] => members.map((m) => m.toString());

describe("sortedMembers", () => {
  test("depth-first, siblings in byte order, whatever order they were created in", () => {
    const root = join(brainDirs(vault).inbox, "order");
    mkdirSync(root);
    // Created out of order on purpose; ext4 and NTFS list them differently.
    for (const n of ["b.md", "a", "C.md", "a.md"]) {
      if (n === "a") mkdirSync(join(root, n));
      else writeFileSync(join(root, n), n);
    }
    writeFileSync(join(root, "a", "z.md"), "z");
    writeFileSync(join(root, "a", "y.md"), "y");

    expect(names(sortedMembers(vault, Buffer.from("Brain/inbox/order"), "t"))).toEqual([
      "Brain/inbox/order",
      "Brain/inbox/order/C.md",
      "Brain/inbox/order/a",
      "Brain/inbox/order/a/y.md",
      "Brain/inbox/order/a/z.md",
      "Brain/inbox/order/a.md",
      "Brain/inbox/order/b.md",
    ]);
  });

  test("the archive carries its members in exactly that order", () => {
    const inbox = brainDirs(vault).inbox;
    for (const n of ["b.md", "C.md", "a.md"]) writeFileSync(join(inbox, n), n);
    const res = createSnapshot(vault, "dream-order", { reason: DREAM });
    const inArchive = listSnapshotArchive(res.path)
      .split(/\r?\n/)
      .map((l) => l.replace(/\/$/, ""))
      .filter((l) => l.startsWith("Brain/inbox"));
    expect(inArchive).toEqual(names(sortedMembers(vault, Buffer.from("Brain/inbox"), "t")));
  });

  test("an entry that vanished mid-walk is left out, not archived as a ghost", () => {
    expect(sortedMembers(vault, Buffer.from("Brain/inbox/gone.md"), "t")).toEqual([]);
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable directory fails the snapshot (POSIX)", () => {
    const locked = join(brainDirs(vault).inbox, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.md"), "x");
    chmodSync(locked, 0o000);
    try {
      expect(() => sortedMembers(vault, Buffer.from("Brain/inbox"), "t")).toThrow(
        BrainSnapshotError,
      );
      expect(() => createSnapshot(vault, "dream-locked", { reason: DREAM })).toThrow(
        /cannot read Brain\/inbox\/locked/,
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test.skipIf(!IS_WINDOWS)("an unreadable directory fails the snapshot (Windows ACL)", () => {
    const locked = join(brainDirs(vault).inbox, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.md"), "x");
    const icacls = system32Tool("icacls.exe");
    const who = spawnSync(system32Tool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    }).stdout;
    const sid = /"(S-1-[\d-]+)"/.exec(who)?.[1];
    expect(sid).toBeDefined();
    const deny = spawnSync(icacls, [locked, "/deny", `*${sid}:(RD)`], { encoding: "utf8" });
    expect(deny.status).toBe(0);
    try {
      expect(() => createSnapshot(vault, "dream-locked", { reason: DREAM })).toThrow(
        /cannot read Brain\/inbox\/locked/,
      );
    } finally {
      spawnSync(icacls, [locked, "/remove:d", `*${sid}`]);
    }
  });

  // APFS refuses a name that is not valid UTF-8, and Windows names are
  // UTF-16: only Linux (and the BSDs) can hold the fixture.
  test.skipIf(process.platform !== "linux")(
    "a non-UTF-8 file name is archived under its exact bytes",
    () => {
      const deep = join(brainDirs(vault).inbox, "deep", "er");
      mkdirSync(deep, { recursive: true });
      const latin1 = Buffer.concat([
        Buffer.from(`${deep}/caf`),
        Buffer.from([0xe9]),
        Buffer.from(".md"),
      ]);
      writeFileSync(latin1, "bytes");

      const res = createSnapshot(vault, "dream-latin1", { reason: DREAM });
      const out = mkdtempSync(join(tmpdir(), "o2b-snap-latin1-"));
      try {
        extractSnapshotArchive(res.path, out);
        const extracted = readdirSync(join(out, "Brain", "inbox", "deep", "er"), {
          encoding: "buffer",
        });
        expect(extracted.map((b) => b.toString("hex"))).toEqual([
          Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6d, 0x64]).toString("hex"),
        ]);
        expect(existsSync(join(out, "Brain", "inbox", "deep", "er"))).toBe(true);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );
});

describe("the entries the snapshot family never touches", () => {
  /**
   * `.snapshots` and `.artifacts` are documented as never archived: the first
   * because archiving the archive home makes every snapshot carry its
   * predecessors and grow without bound, the second because it is ephemeral
   * cache nobody wants restored. The exclusion is a string comparison against
   * `readdirSync`'s buffer entries - which Bun returns as `Uint8Array`, whose
   * `.toString()` is comma-joined byte values, not the name. Decoded that way
   * nothing ever matched and the archive carried its own directory.
   */
  test("the archive carries neither .snapshots nor .artifacts", () => {
    const dirs = brainDirs(vault);
    const snapshots = join(dirs.brain, ".snapshots");
    const artifacts = join(dirs.brain, ".artifacts");
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, "dream-prior.tar.zst"), "a prior archive");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "cache.json"), "{}");
    writeFileSync(join(dirs.brain, "kept.md"), "kept");

    const res = createSnapshot(vault, "dream-excluded", { reason: DREAM });
    const members = listSnapshotArchive(res.path)
      .split(/\r?\n/)
      .map((l) => l.replace(/\/$/, ""))
      .filter(Boolean);

    expect(members).toContain("Brain/kept.md");
    expect(members.filter((m) => m.includes(".snapshots"))).toEqual([]);
    expect(members.filter((m) => m.includes(".artifacts"))).toEqual([]);
  });

  /**
   * Bun's `readdirSync(..., { encoding: "buffer" })` hands back `Buffer`
   * instances, so the archive test above only ever reaches the
   * `Buffer.isBuffer(e)` arm. The `Uint8Array` arm - the one that actually
   * exists to decode byte values instead of comma-joined numbers - would
   * stay untested, and reverting the fix to `e.toString()` would leave that
   * test green. These two feed a bare `Uint8Array` straight to the decoders
   * so the arm is pinned rather than merely assumed.
   */
  test("a bare Uint8Array entry decodes to its name, not to byte values", () => {
    const excluded = new Uint8Array(new TextEncoder().encode(".snapshots"));
    expect(Buffer.isBuffer(excluded)).toBe(false);
    expect(bufferEntryName(excluded)).toBe(".snapshots");
    expect(isSnapshotExcludedEntry(bufferEntryName(excluded))).toBe(true);

    const kept = new Uint8Array(new TextEncoder().encode("kept.md"));
    expect(bufferEntryName(kept)).toBe("kept.md");
    expect(isSnapshotExcludedEntry(bufferEntryName(kept))).toBe(false);
  });

  test("a bare Uint8Array holding multibyte UTF-8 decodes whole", () => {
    const name = "笔记-2026.md";
    const arr = new Uint8Array(new TextEncoder().encode(name));
    expect(bufferEntryName(arr)).toBe(name);
    expect(isSnapshotExcludedEntry(bufferEntryName(arr))).toBe(false);
  });
});
