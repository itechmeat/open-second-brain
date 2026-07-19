import { scanCitations } from "../../../core/brain/temporal/citations.ts";
import { brainVerbContext, fail, info, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

export function cmdBrainScanCitations(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    strict: { type: "boolean" },
    path: { type: "string-array" },
    exclude: { type: "string-array" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);

  let result;
  try {
    result = scanCitations(vault, {
      agent,
      dryRun: Boolean(flags["dry-run"]),
      paths: (flags["path"] as string[] | undefined) ?? [],
      exclude: (flags["exclude"] as string[] | undefined) ?? [],
    });
  } catch (exc) {
    return fail(`scan-citations failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({
      scanned: result.scanned,
      found: result.found,
      promoted: result.promoted,
      deduped: result.deduped,
      malformed: result.malformed,
      malformed_markers: result.malformedMarkers.map((m) => ({
        path: m.path,
        line: m.line,
        raw: m.raw,
        reason: m.reason,
      })),
      errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
      files_with_citations: result.filesWithCitations.map((f) => ({
        path: f.path,
        citations: f.citations,
      })),
    });
  } else {
    ok(`scanned: ${result.scanned}`);
    ok(`found: ${result.found}`);
    ok(`promoted: ${result.promoted}`);
    ok(`deduped: ${result.deduped}`);
    if (result.malformed > 0) ok(`malformed: ${result.malformed}`);
    for (const m of result.malformedMarkers) {
      info(`  malformed: ${m.path}:${m.line}: ${m.reason} (${m.raw})`);
    }
    for (const e of result.errors) info(`  error: ${e.path}: ${e.message}`);
  }
  if (flags["strict"] && result.malformed > 0) return 2;
  return 0;
}
