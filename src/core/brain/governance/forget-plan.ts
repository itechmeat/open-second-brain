import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs, vaultRelative } from "../paths.ts";

export interface ForgetPlanEntry {
  readonly id: string;
  readonly path: string;
  readonly kind: "inbox" | "processed" | "preference" | "retired" | "log" | "other";
  readonly action: "would-remove-source-support";
  readonly sha256: string;
}

export interface ForgetPlan {
  readonly mode: "dry-run";
  readonly source: string;
  readonly entries: ReadonlyArray<ForgetPlanEntry>;
  readonly audit: {
    readonly contentIncluded: false;
    readonly entryCount: number;
  };
}

export function buildForgetPlan(vault: string, opts: { readonly source: string }): ForgetPlan {
  const source = opts.source.trim();
  if (!source) {
    return Object.freeze({
      mode: "dry-run",
      source,
      entries: Object.freeze([]),
      audit: Object.freeze({ contentIncluded: false, entryCount: 0 }),
    });
  }

  const entries: ForgetPlanEntry[] = [];
  for (const path of walkBrainMarkdown(vault)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(source)) continue;
    entries.push({
      id: readId(path),
      path: vaultRelative(vault, path),
      kind: classify(vault, path),
      action: "would-remove-source-support",
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return Object.freeze({
    mode: "dry-run",
    source,
    entries: Object.freeze(entries),
    audit: Object.freeze({
      contentIncluded: false,
      entryCount: entries.length,
    }),
  });
}

function walkBrainMarkdown(vault: string): string[] {
  const root = brainDirs(vault).brain;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (st.isFile() && name.endsWith(".md")) out.push(full);
    }
  };
  visit(root);
  out.sort();
  return out;
}

function readId(path: string): string {
  try {
    const [meta] = parseFrontmatter(path);
    if (typeof meta["id"] === "string" && meta["id"].trim()) return meta["id"];
  } catch {
    // Fall back to the basename below.
  }
  return basename(path, ".md");
}

function classify(vault: string, path: string): ForgetPlanEntry["kind"] {
  const dirs = brainDirs(vault);
  if (path.startsWith(dirs.processed)) return "processed";
  if (path.startsWith(dirs.inbox)) return "inbox";
  if (path.startsWith(dirs.preferences)) return "preference";
  if (path.startsWith(dirs.retired)) return "retired";
  if (path.startsWith(dirs.log)) return "log";
  return "other";
}
