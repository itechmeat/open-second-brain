/**
 * The host-backup hook stays stdlib-only at load: its only static import
 * from `src/core` is the leaf of directory-name constants, so a broken
 * core build can cost the receipt but never the backup or the deny, and
 * the flag-off path loads no behaviour module.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "pretool-host-backup.ts",
);

test("the only static core import is the path-constants leaf", () => {
  const source = readFileSync(HOOK, "utf8");
  const statics = [...source.matchAll(/^import[^;]*?from\s+"(\.\.\/src\/[^"]+)";/gms)].map(
    (m) => m[1],
  );
  expect(statics).toEqual(["../src/core/brain/path-constants.ts"]);
});
