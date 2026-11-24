/**
 * Census: the brain store's reserved vault folder (`STORE_VAULT_DIR`,
 * `.open-second-brain-store/`) is hidden from every note tool, walker,
 * indexer and the view writer the product controls (patch 2.0.1).
 *
 * The store moved into the vault so it travels with the vault's sync. Its
 * files are machine records: a note walk, the search index, wikilink
 * resolution or the view writer that entered the folder would surface
 * store files as notes, or move them.
 *
 * Two halves:
 *
 *  - behaviour: a Markdown file planted inside the folder is never seen
 *    by the page list, the basename and path walks (wikilink resolution
 *    reads the basenames), the search scope (with the defaults and with
 *    an operator's own `ignore_paths`, which replaces the defaults), the
 *    index admission, nor listed as a view companion;
 *  - structure: every vault-walk skip list in `src/` (a literal naming
 *    `.stversions` or `.obsidian` beside other skipped folders) also names
 *    `STORE_VAULT_DIR`, or is listed below with the reason it may not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { listVaultBasenames, listVaultNotePaths, listVaultPages } from "../../../src/core/vault.ts";
import { admitToIndex } from "../../../src/core/vault-scope/index-admission.ts";
import {
  matchRules,
  resolveVaultScope,
  walkVaultScopePaths,
} from "../../../src/core/vault-scope/index.ts";
import { listCompanions } from "../../../src/core/view/page-io.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-store-dir-census-"));
  writeFileSync(join(vault, "visible.md"), "---\ntitle: Visible\n---\nA note.\n");
  const inside = join(vault, STORE_VAULT_DIR, "shared");
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, "hidden-store-page.md"), "---\ntitle: Hidden\n---\nNot a note.\n");
  writeFileSync(join(vault, STORE_VAULT_DIR, "FORMAT.md"), "# Format\n");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const leaks = (paths: Iterable<string>): string[] =>
  [...paths].filter((p) => p.includes(STORE_VAULT_DIR) || p.includes("hidden-store-page"));

describe("nothing the product walks enters the store folder", () => {
  test("the page list", () => {
    const pages = listVaultPages(vault, { reach: TRANSPORT_REACH.local });
    expect(pages.map((p) => p.title)).toEqual(["Visible"]);
    expect(leaks(pages.map((p) => p.path))).toEqual([]);
  });

  test("the basename walk wikilinks resolve against, and the path walk", () => {
    expect([...listVaultBasenames(vault)]).toEqual(["visible"]);
    expect(leaks(listVaultNotePaths(vault))).toEqual([]);
  });

  test("the search scope, with the defaults and with an operator's own ignore list", () => {
    expect(leaks(walkVaultScopePaths(vault, resolveVaultScope(vault)))).toEqual([]);
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nvault:\n  ignore_paths:\n    - Private\n",
    );
    const scope = resolveVaultScope(vault);
    expect(scope.ignorePaths).toContain(STORE_VAULT_DIR);
    expect(matchRules(`${STORE_VAULT_DIR}/shared/x.md`, scope.rules.ignore).matched).toBe(true);
  });

  test("the index admission", () => {
    expect(admitToIndex(`${STORE_VAULT_DIR}/shared/hidden-store-page.md`).admit).toBe(false);
    expect(admitToIndex("visible.md").admit).toBe(true);
  });

  test("the view writer's companion list", () => {
    expect(listCompanions(vault, new Set())).not.toContain(STORE_VAULT_DIR);
  });
});

/** Skip lists that may leave the folder out, each with its reason. */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "src/core/brain/payload-inventory.ts",
    "a reference scan, not a note walk: a store record that names a payload keeps it alive",
  ],
  ["src/cli/install/init-interactive.ts", "looks for `.obsidian` to find vaults; not a skip list"],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("every vault-walk skip list names the store folder", () => {
  test("census over src/", () => {
    const missing: string[] = [];
    for (const path of sources(join(REPO, "src"))) {
      const rel = relative(REPO, path).split(sep).join("/");
      const text = readFileSync(path, "utf8");
      if (!/"\.stversions"|"\.obsidian"/.test(text)) continue;
      if (EXEMPT.has(rel)) continue;
      if (!text.includes("STORE_VAULT_DIR")) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  test("every exemption still matches a file that has a skip list", () => {
    for (const rel of EXEMPT.keys()) {
      expect(readFileSync(join(REPO, rel), "utf8")).toMatch(/"\.stversions"|"\.obsidian"/);
    }
  });
});
