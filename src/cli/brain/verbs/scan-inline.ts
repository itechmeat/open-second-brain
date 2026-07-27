import { scanInline } from "../../../core/brain/inline-scan.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { brainVerbContext, fail, info, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

export async function cmdBrainScanInline(argv: string[]): Promise<number> {
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
    result = await scanInline(vault, {
      agent,
      dryRun: Boolean(flags["dry-run"]),
      paths: (flags["path"] as string[] | undefined) ?? [],
      exclude: (flags["exclude"] as string[] | undefined) ?? [],
    });
  } catch (exc) {
    return fail(`scan-inline failed: ${(exc as Error).message ?? exc}`);
  }

  if (!flags["dry-run"]) {
    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.scanInline,
        body: {
          agent,
          scanned: String(result.scanned),
          found: String(result.found),
          created: String(result.created),
          deduped: String(result.deduped),
          malformed: String(result.malformed),
          facts: String(result.facts),
          skills: String(result.skills),
          suppressed: String(result.suppressed),
          errors: String(result.errors.length),
        },
      });
    } catch (err) {
      process.stderr.write(`warning: append scan-inline log failed: ${(err as Error).message}\n`);
    }
  }

  if (flags["json"]) {
    okJson({
      scanned: result.scanned,
      found: result.found,
      created: result.created,
      deduped: result.deduped,
      malformed: result.malformed,
      facts: result.facts,
      skills: result.skills,
      suppressed: result.suppressed,
      errors: result.errors.map((e) => ({ path: e.path, message: e.message })),
      files_with_markers: result.filesWithMarkers.map((f) => ({
        path: f.path,
        markers: f.markers,
      })),
    });
  } else {
    ok(`scanned: ${result.scanned}`);
    ok(`found: ${result.found}`);
    ok(`created: ${result.created}`);
    ok(`deduped: ${result.deduped}`);
    if (result.malformed > 0) ok(`malformed: ${result.malformed}`);
    // Only when non-zero, matching the `malformed` line above: a vault
    // with no fact / skill markers prints exactly what it printed before.
    if (result.facts > 0) ok(`facts: ${result.facts}`);
    if (result.skills > 0) ok(`skills: ${result.skills}`);
    if (result.suppressed > 0) ok(`suppressed: ${result.suppressed}`);
    for (const e of result.errors) info(`  error: ${e.path}: ${e.message}`);
  }
  // `--strict` means "a scan that could not process everything it found
  // is a failure". A marker its destination refused printed an error and
  // still exited 0 while `malformed` was the only gate: the refusal is
  // unprocessed work exactly as a malformed marker is.
  if (flags["strict"] && (result.malformed > 0 || result.errors.length > 0)) return 2;
  return 0;
}
