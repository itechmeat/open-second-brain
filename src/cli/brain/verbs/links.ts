/**
 * `o2b brain links normalize` (Workspace Insight Suite, t_5f31b5f1):
 * rewrite wikilink targets across Brain-owned notes to the configured
 * path format. Dry-run by default; `--write` applies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfigPath, resolveWikiLinkFormat } from "../../../core/config.ts";
import {
  isWikiLinkFormat,
  normalizeWikilinks,
  WIKI_LINK_FORMATS,
  type WikiLinkFormat,
} from "../../../core/brain/link-graph/format-wikilink.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { walkVault } from "../../../core/search/walker.ts";
import { fail, normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

interface FileChange {
  readonly path: string;
  readonly changed: number;
  readonly ambiguous: ReadonlyArray<string>;
}

export async function cmdBrainLinks(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action !== "normalize") {
    return fail(
      "usage: o2b brain links normalize [path-prefix] [--mode preserve|full|short] [--write] [--json]",
    );
  }
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    mode: { type: "string" },
    write: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;
  const write = flags["write"] === true;

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const modeFlag = normalizeFlagString(flags["mode"]);
    let mode: WikiLinkFormat;
    if (modeFlag !== null) {
      if (!isWikiLinkFormat(modeFlag)) {
        return fail(`--mode must be one of ${WIKI_LINK_FORMATS.join(", ")}; got '${modeFlag}'`);
      }
      mode = modeFlag;
    } else {
      mode = resolveWikiLinkFormat(config);
    }

    const pathPrefix = positional[0] ?? "Brain/";
    const searchConfig = resolveSearchConfig({ vault, configPath: config });

    // Known pages: every .md in the vault (ignore-rule aware), as
    // vault-relative paths without the extension.
    const files: Array<{ absPath: string; relPath: string }> = [];
    for (const file of walkVault(searchConfig)) {
      files.push({ absPath: file.absPath, relPath: file.relPath });
    }
    const knownPaths = files.map((f) =>
      f.relPath.endsWith(".md") ? f.relPath.slice(0, -".md".length) : f.relPath,
    );

    const changes: FileChange[] = [];
    let totalChanged = 0;
    for (const file of files) {
      if (!file.relPath.startsWith(pathPrefix)) continue;
      const before = readFileSync(file.absPath, "utf8");
      const result = normalizeWikilinks(before, mode, knownPaths);
      if (result.changed === 0 && result.ambiguous.length === 0) continue;
      changes.push({
        path: file.relPath,
        changed: result.changed,
        ambiguous: result.ambiguous,
      });
      totalChanged += result.changed;
      if (write && result.changed > 0) {
        writeFileSync(join(vault, file.relPath), result.content);
      }
    }

    if (json) {
      okJson({
        ok: true,
        mode,
        applied: write,
        total_changed: totalChanged,
        files: changes.map((c) => ({
          path: c.path,
          changed: c.changed,
          ambiguous: c.ambiguous,
        })),
      });
      return 0;
    }
    ok(`mode: ${mode} (${write ? "applied" : "dry-run"})`);
    if (changes.length === 0) {
      ok("no links to rewrite");
      return 0;
    }
    for (const c of changes) {
      ok(`${c.path}: ${c.changed} link(s)`);
      for (const a of c.ambiguous) ok(`  ambiguous: ${a}`);
    }
    ok(`total: ${totalChanged} link(s)${write ? "" : " (re-run with --write to apply)"}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
