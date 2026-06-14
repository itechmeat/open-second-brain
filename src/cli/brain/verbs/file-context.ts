import { resolveSearchConfig } from "../../../core/search/index.ts";
import { fileContextRecall } from "../../../core/brain/file-recall.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain file-context <file-path> [--limit N] [--min-bytes N] [--vault PATH] [--json]`
 *
 * Surface prior vault work that mentions a file (decisions, bug notes,
 * refactor history) by querying the existing index with terms derived
 * structurally from the path. A size gate skips trivial files.
 * Read-only; no LLM.
 */
export async function cmdBrainFileContext(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, {
    vault: { type: "string" },
    limit: { type: "string" },
    "min-bytes": { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  const filePath = positional[0];
  if (!filePath) {
    return fail("brain file-context requires a file path (e.g. src/foo.ts)");
  }
  const limit = parsePositiveInt(flags["limit"]);
  if (limit === "invalid") {
    return fail("brain file-context: --limit must be a positive integer");
  }
  const minBytes = parseNonNegativeInt(flags["min-bytes"]);
  if (minBytes === "invalid") {
    return fail("brain file-context: --min-bytes must be a non-negative integer");
  }

  const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
  const result = await fileContextRecall(searchConfig, {
    filePath,
    ...(limit !== undefined ? { limit } : {}),
    ...(minBytes !== undefined ? { minBytes } : {}),
  });

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file_path: result.filePath,
          skipped: result.skipped,
          reason: result.reason,
          query: result.query,
          results: result.results.map((r) => ({ path: r.path, title: r.title, score: r.score })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (result.skipped) {
    process.stdout.write(`skipped (${result.reason}): ${result.filePath}\n`);
    return 0;
  }
  if (result.results.length === 0) {
    process.stdout.write(`no prior work found for ${result.filePath}\n`);
    return 0;
  }
  process.stdout.write(`${result.results.length} prior-work hit(s) for ${result.filePath}\n`);
  for (const r of result.results) {
    process.stdout.write(`  ${r.score.toFixed(3)}  ${r.path}\n`);
  }
  return 0;
}

function parsePositiveInt(value: unknown): number | undefined | "invalid" {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!/^[0-9]+$/.test(value)) return "invalid";
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 ? parsed : "invalid";
}

function parseNonNegativeInt(value: unknown): number | undefined | "invalid" {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!/^[0-9]+$/.test(value)) return "invalid";
  return Number.parseInt(value, 10);
}
