/**
 * The generator-owned `depends_on` frontmatter key on module notes.
 *
 * It is the one frontmatter key the architect rewrites after creation:
 * written when a module declares a dependency on another module, rewritten
 * when the edges change, removed when they vanish, and every other
 * frontmatter key and every byte of operator prose stays as it was. The
 * indexer turns it into typed `depends_on` links.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArchFrontmatterError,
  generateArchDocs,
} from "../../../src/core/brain/architect/generate.ts";
import type { GenerateArchDocsResult } from "../../../src/core/brain/architect/generate.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

let tmp: string;
let project: string;
let vault: string;

function put(relPath: string, content: string): void {
  const abs = join(project, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function pkg(name: string, dependencies: Record<string, string> = {}): string {
  return JSON.stringify({ name, dependencies });
}

function notePath(res: GenerateArchDocsResult, name: string): string {
  return res.modulePaths.find((p) => p.endsWith(`${name}.md`))!;
}

function link(res: GenerateArchDocsResult, name: string): string {
  return `  - "[[Brain/projects/arch/${res.repoKey}/modules/${name}|${name}]]"`;
}

/** The frontmatter block of a note, fences included. */
function frontmatterOf(text: string): string {
  const end = text.indexOf("\n---\n", 4);
  return text.slice(0, end + 5);
}

/** The frontmatter block of a CRLF note, fences included. */
function crlfFrontmatterOf(text: string): string {
  return text.slice(0, text.indexOf("\r\n---\r\n", 4) + 7);
}

/** A note with its `depends_on` key removed, for comparing everything else. */
function withoutKey(text: string): string {
  return text.replace(/^depends_on:\n(?: {2}- .*\n)*/m, "");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-depends-on-"));
  project = join(tmp, "mono");
  mkdirSync(project, { recursive: true });
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });

  put("packages/core/package.json", pkg("core"));
  put("packages/util/package.json", pkg("util"));
  put("packages/web/package.json", pkg("web", { core: "*" }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("the key is written on creation, sorted, and absent when there is no edge", () => {
  put("packages/web/package.json", pkg("web", { util: "*", core: "*" }));
  const res = generateArchDocs(vault, project);
  const web = frontmatterOf(readFileSync(notePath(res, "web"), "utf8"));
  expect(web).toContain(`depends_on:\n${link(res, "core")}\n${link(res, "util")}\n`);
  expect(frontmatterOf(readFileSync(notePath(res, "core"), "utf8"))).not.toContain("depends_on");
});

test("the key is rewritten and removed while other keys and prose stay byte-identical", () => {
  const first = generateArchDocs(vault, project);
  const webPath = notePath(first, "web");
  // The operator adds a key of their own and prose outside the regions.
  const annotated = readFileSync(webPath, "utf8")
    .replace("module: web\n", "module: web\nowner: platform-team\n")
    .concat("\nOperator: web renders, core decides.\n");
  writeFileSync(webPath, annotated);

  put("packages/web/package.json", pkg("web", { core: "*", util: "*" }));
  const second = generateArchDocs(vault, project);
  const rewritten = readFileSync(webPath, "utf8");
  expect(rewritten).toContain(`depends_on:\n${link(second, "core")}\n${link(second, "util")}\n`);
  expect(rewritten).toContain("owner: platform-team\n");
  expect(rewritten).toContain("Operator: web renders, core decides.");

  put("packages/web/package.json", pkg("web"));
  generateArchDocs(vault, project);
  const removed = readFileSync(webPath, "utf8");
  expect(frontmatterOf(removed)).not.toContain("depends_on");
  // Everything outside the key and the regions is what the operator left.
  expect(frontmatterOf(removed)).toBe(frontmatterOf(withoutKey(annotated)));
  expect(removed.endsWith("\nOperator: web renders, core decides.\n")).toBe(true);
});

test("on a CRLF note a blank line after the key ends the key and is kept", () => {
  const first = generateArchDocs(vault, project);
  const webPath = notePath(first, "web");
  const crlf = readFileSync(webPath, "utf8")
    .replace(`${link(first, "core")}\n`, `${link(first, "core")}\n\nnote: kept\n`)
    .replaceAll("\n", "\r\n");
  writeFileSync(webPath, crlf);

  put("packages/web/package.json", pkg("web", { core: "*", util: "*" }));
  const second = generateArchDocs(vault, project);
  const rewritten = readFileSync(webPath, "utf8");
  const keyLines = (res: GenerateArchDocsResult, names: ReadonlyArray<string>): string =>
    ["depends_on:", ...names.map((name) => link(res, name))].map((l) => `${l}\r\n`).join("");
  expect(rewritten).toContain(`${keyLines(second, ["core", "util"])}\r\nnote: kept\r\n`);
  // Outside the key, the frontmatter is byte-identical to what the operator left.
  expect(crlfFrontmatterOf(rewritten).replace(keyLines(second, ["core", "util"]), "")).toBe(
    crlfFrontmatterOf(crlf).replace(keyLines(first, ["core"]), ""),
  );
});

test("an unchanged project leaves every note unchanged", () => {
  const first = generateArchDocs(vault, project);
  const before = readFileSync(notePath(first, "web"), "utf8");
  const second = generateArchDocs(vault, project);
  expect(second.updated).toBe(0);
  expect(second.created).toBe(0);
  expect(readFileSync(notePath(second, "web"), "utf8")).toBe(before);
});

test("indexing the vault yields a typed depends_on link between the module notes", async () => {
  const res = generateArchDocs(vault, project);
  const config = makeConfig({ vault, dbPath: join(tmp, "index.sqlite") });
  await indexVault(config);

  const store = await Store.open(config, { mode: "read" });
  try {
    // Same private-db introspection idiom as indexer-aliases.test.ts, for
    // the document ids only; the edges come through the store's own API,
    // which resolves a target the way every graph reader does.
    const db = (store as any).db;
    const idOf = (path: string): number =>
      (db.query("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
    const notes = `Brain/projects/arch/${res.repoKey}/modules`;
    const edges = store.typedRelationEdgesForDocuments([idOf(`${notes}/web.md`)]);
    expect(edges.map((edge) => [edge.relation, edge.target, edge.targetDocumentId])).toEqual([
      ["depends_on", `${notes}/core`, idOf(`${notes}/core.md`)],
    ]);
  } finally {
    await store.close();
  }
});

test("a note whose frontmatter was removed gets the key in a frontmatter of its own", () => {
  const first = generateArchDocs(vault, project);
  const webPath = notePath(first, "web");
  const body = readFileSync(webPath, "utf8").slice(
    frontmatterOf(readFileSync(webPath, "utf8")).length,
  );
  writeFileSync(webPath, body);

  const second = generateArchDocs(vault, project);
  expect(readFileSync(webPath, "utf8")).toBe(
    `---\ndepends_on:\n${link(second, "core")}\n---\n${body}`,
  );
});

test("a frontmatter block that never closes is refused before any note is written", () => {
  const first = generateArchDocs(vault, project);
  const webPath = notePath(first, "web");
  const broken = readFileSync(webPath, "utf8").replace("\n---\n", "\n");
  writeFileSync(webPath, broken);
  const overviewBefore = readFileSync(first.overviewPath, "utf8");
  put("packages/web/package.json", pkg("web", { core: "*", util: "*" }));

  expect(() => generateArchDocs(vault, project)).toThrow(ArchFrontmatterError);
  expect(readFileSync(webPath, "utf8")).toBe(broken);
  expect(readFileSync(first.overviewPath, "utf8")).toBe(overviewBefore);
});

// Windows refuses a control character in a directory name.
test.skipIf(IS_WINDOWS)(
  "a control character in a module name stays inside its quoted scalar",
  () => {
    put("packages/tab\tbed/package.json", pkg("tabbed"));
    const res = generateArchDocs(vault, project);
    const note = readFileSync(notePath(res, "tab\tbed"), "utf8");
    expect(frontmatterOf(note)).toContain('module: "tab\\tbed"\n');
  },
);
