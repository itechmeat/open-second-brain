import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { scanInline } from "../../../core/brain/inline-scan.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { parse, fail, ok, okJson, info, resolveBrainVault } from "../helpers.ts";

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
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

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
    for (const e of result.errors) info(`  error: ${e.path}: ${e.message}`);
  }
  if (flags["strict"] && result.malformed > 0) return 2;
  return 0;
}
