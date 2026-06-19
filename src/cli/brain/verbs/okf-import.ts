import { importOkfBundle, readOkfBundle } from "../../../core/brain/portability/okf.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain okf-import <dir> [--trusted]` — read an Open Knowledge
 * Format bundle directory and import its pages. By default pages are
 * staged under `OKF Review/` with `okf_review: pending` (review
 * candidates); `--trusted` writes each page directly to its recorded
 * vault-relative path. Foreign-producer bundles get producer + raw type
 * provenance stamped, with producer-specific (`x-*`) frontmatter
 * preserved.
 */
export async function cmdBrainOkfImport(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    trusted: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const dir = positional[0];
  if (dir === undefined) {
    return fail("usage: o2b brain okf-import <bundle-dir> [--trusted]");
  }

  try {
    const parsed = readOkfBundle(dir);
    const result = importOkfBundle(vault, parsed, { trusted: flags["trusted"] === true });
    const provenance = result.foreign ? " (foreign producer; provenance stamped)" : "";
    process.stdout.write(
      `imported ${result.written.length} page(s) in ${result.mode} mode${provenance}; ` +
        `${result.skipped.length} skipped, ${result.errors.length} error(s)\n`,
    );
    for (const err of result.errors) {
      process.stderr.write(`  error: ${err.path}: ${err.message}\n`);
    }
    return result.errors.length > 0 ? 1 : 0;
  } catch (exc) {
    return fail(`okf-import failed: ${(exc as Error).message ?? exc}`);
  }
}
