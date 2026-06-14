import {
  computeCoOccurrenceSuggestions,
  writeCoOccurrenceSuggestions,
} from "../../../core/brain/link-graph/co-occurrence.ts";
import { brainVerbContext, parse, usageError } from "../helpers.ts";

/**
 * `o2b brain co-occurrence [--min-co N] [--min-score X] [--limit N] [--write] [--json]`
 *
 * Suggest relationship edges between entities that are repeatedly
 * co-referenced from the same notes, scored by a structural PMI /
 * document-frequency metric over the wikilink graph. Read-only by
 * default; `--write` persists the suggestions artifact. Suggestions
 * never mutate notes. The derivation is language-agnostic - it reads
 * only link incidence, no natural-language word list.
 */
export async function cmdBrainCoOccurrence(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "min-co": { type: "string" },
    "min-score": { type: "string" },
    limit: { type: "string" },
    write: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const minCoDocuments = parsePositiveInt(flags["min-co"]);
  if (minCoDocuments === "invalid") {
    return usageError("brain co-occurrence: --min-co must be a positive integer");
  }
  const limit = parsePositiveInt(flags["limit"]);
  if (limit === "invalid") {
    return usageError("brain co-occurrence: --limit must be a positive integer");
  }
  let minScore: number | undefined;
  if (typeof flags["min-score"] === "string") {
    const parsed = Number(flags["min-score"]);
    if (!Number.isFinite(parsed)) {
      return usageError("brain co-occurrence: --min-score must be a finite number");
    }
    minScore = parsed;
  }

  const result = computeCoOccurrenceSuggestions(vault, {
    ...(minCoDocuments !== undefined ? { minCoDocuments } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  let writtenPath: string | undefined;
  if (flags["write"] === true) {
    writtenPath = writeCoOccurrenceSuggestions(vault, result, {
      generatedAt: new Date().toISOString(),
    });
  }

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          document_count: result.documentCount,
          suggestions: result.suggestions,
          ...(writtenPath !== undefined ? { written: writtenPath } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (result.suggestions.length === 0) {
    process.stdout.write("no co-occurrence suggestions\n");
    return 0;
  }
  process.stdout.write(
    `${result.suggestions.length} co-occurrence suggestion(s) over ${result.documentCount} note(s)\n`,
  );
  for (const s of result.suggestions) {
    process.stdout.write(
      `  ${s.score.toFixed(3)}  ${s.left} <-> ${s.right}  (co=${s.coDocumentCount})\n`,
    );
  }
  if (writtenPath !== undefined) process.stdout.write(`  written: ${writtenPath}\n`);
  return 0;
}

function parsePositiveInt(value: unknown): number | undefined | "invalid" {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!/^[0-9]+$/.test(value)) return "invalid";
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 ? parsed : "invalid";
}
