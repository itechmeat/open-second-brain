import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectExplorerData,
  renderExportedHtml,
  __resetExplorerTemplateCacheForTests,
} from "../../../src/core/brain/explorer.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-explorer-dl-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  __resetExplorerTemplateCacheForTests();
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
});

describe("explorer deep-link", () => {
  test("renderExportedHtml substitutes vault path", () => {
    const graph = collectExplorerData(vault);
    const html = renderExportedHtml(graph, "/my/vault");
    expect(html).toContain("\\/my\\/vault");
    expect(html).not.toContain("__VAULT_PATH__");
  });

  test("renderExportedHtml with no vault path renders empty", () => {
    const graph = collectExplorerData(vault);
    const html = renderExportedHtml(graph);
    expect(html).not.toContain("__VAULT_PATH__");
  });
});
