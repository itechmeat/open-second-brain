/**
 * `adoptFolder` loses no byte: a file the target holds with other bytes is
 * kept aside (an earlier kept copy is never replaced), a source file is
 * removed only once it is safe, and an entry that is not a regular file
 * stays where it is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptFolder } from "../../../src/core/state/state-moves.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-state-moves-"));
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("adoptFolder", () => {
  test("moves what the target lacks and keeps aside what differs, never replacing a kept copy", () => {
    const from = join(parent, "fresh", "k");
    const to = join(parent, "local");
    put(join(from, "a.json"), "new a");
    put(join(from, "b.json"), "same b");
    put(join(to, "a.json"), "live a");
    put(join(to, "b.json"), "same b");
    put(join(parent, "adopt-conflicts", "k", "a.json"), "older kept a");
    expect(adoptFolder(from, to)).toBe(true);
    expect(readFileSync(join(to, "a.json"), "utf8")).toBe("live a");
    expect(readFileSync(join(parent, "adopt-conflicts", "k", "a.json"), "utf8")).toBe(
      "older kept a",
    );
    expect(readFileSync(join(parent, "adopt-conflicts", "k", "a.json.1"), "utf8")).toBe("new a");
    expect(existsSync(from)).toBe(false);
  });

  test.skipIf(IS_WINDOWS)("leaves a symbolic link where it is", () => {
    const from = join(parent, "fresh", "k");
    const to = join(parent, "local");
    put(join(from, "a.json"), "a");
    symlinkSync(join(parent, "elsewhere"), join(from, "link"));
    expect(adoptFolder(from, to)).toBe(true);
    expect(readFileSync(join(to, "a.json"), "utf8")).toBe("a");
    expect(lstatSync(join(from, "link")).isSymbolicLink()).toBe(true);
  });

  test.skipIf(IS_WINDOWS)("moves secrets owner-only: folders 0700, files 0600", () => {
    const from = join(parent, "vault-state");
    const to = join(parent, "local", "state");
    put(join(from, "secrets", "key"), "secret");
    expect(adoptFolder(from, to)).toBe(true);
    expect(statSync(join(parent, "local")).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, "secrets", "key")).mode & 0o777).toBe(0o600);
  });

  test("never takes the temp file of an unfinished copy for state", () => {
    const from = join(parent, "fresh", "k");
    const to = join(parent, "local");
    put(join(from, "a.json"), "a");
    put(join(from, ".b.json.adopt-0123456789ab"), "half of b");
    adoptFolder(from, to);
    expect(readFileSync(join(to, "a.json"), "utf8")).toBe("a");
    expect(existsSync(join(to, ".b.json.adopt-0123456789ab"))).toBe(false);
  });
});
