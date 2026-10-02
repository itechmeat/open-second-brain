/**
 * Test helper: the text of every Markdown page under a vault's `Brain/`,
 * for assertions that must hold on whatever page a write produced (no page
 * records a digest of a withheld source), not only on the page named in
 * the result.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every Markdown page under `<root>/Brain/`, as text. */
export function brainPageTexts(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, "Brain"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(readFileSync(join(entry.parentPath, entry.name), "utf8"));
    }
  }
  return out;
}
