import { statSync } from "node:fs";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { importSession, importSessionPath } from "../../../core/brain/sessions/import.ts";
import { SessionImportError } from "../../../core/brain/sessions/types.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { parse, fail, info, normalizeFlagString, ok, okJson, resolveBrainVault, ISO_8601_RE } from "../helpers.ts";

export async function cmdBrainImportSession(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    since: { type: "string" },
    "dry-run": { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain import-session requires a <path> argument");
  const sessionPath = positional[0]!;
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  if (flags["agent"] !== undefined && explicitAgent === null) {
    return fail("--agent must be a non-empty string when provided");
  }
  const agent = explicitAgent ?? resolveAgentName(config);

  const formatRaw = flags["format"] as string | undefined;
  let format: "claude" | "codex" | "hermes" | undefined;
  if (formatRaw !== undefined && formatRaw !== "auto") {
    if (formatRaw !== "claude" && formatRaw !== "codex" && formatRaw !== "hermes") return fail(`--format must be one of auto|claude|codex|hermes; got ${formatRaw}`);
    format = formatRaw;
  }

  let since: Date | undefined;
  if (flags["since"]) {
    const raw = String(flags["since"]);
    if (!ISO_8601_RE.test(raw)) return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    since = d;
  }

  let stat;
  try { stat = statSync(sessionPath); }
  catch (err) { return fail(`cannot stat ${sessionPath}: ${(err as Error).message ?? err}`); }

  try {
    const result = stat.isDirectory()
      ? await importSessionPath(vault, sessionPath, { agent, ...(format ? { format } : {}), ...(since ? { since } : {}), dryRun: Boolean(flags["dry-run"]) })
      : { files: [await importSession(vault, sessionPath, { agent, ...(format ? { format } : {}), ...(since ? { since } : {}), dryRun: Boolean(flags["dry-run"]) })], warnings: [] };

    if (!flags["dry-run"]) {
      for (const f of result.files) {
        try {
          appendLogEvent(vault, {
            timestamp: isoSecond(new Date()), eventType: BRAIN_LOG_EVENT_KIND.importSession,
            body: { agent, file: `[[${f.file}]]`, format: f.format, turns_scanned: String(f.turns_scanned), signals_created: String(f.signals_created), signals_deduped: String(f.signals_deduped), tool_replays: String(f.tool_replays), malformed: String(f.malformed) },
          });
        } catch (err) { process.stderr.write(`warning: append import-session log failed: ${(err as Error).message}\n`); }
      }
    }

    if (flags["json"]) {
      okJson({
        files: result.files.map((f) => ({ file: f.file, format: f.format, turns_scanned: f.turns_scanned, signals_created: f.signals_created, signals_deduped: f.signals_deduped, tool_replays: f.tool_replays, malformed: f.malformed, errors: f.errors })),
        warnings: result.warnings,
      });
    } else {
      for (const f of result.files) {
        ok(`file: ${f.file}`);
        ok(`  format: ${f.format}`);
        ok(`  turns_scanned: ${f.turns_scanned}`);
        ok(`  signals_created: ${f.signals_created}`);
        ok(`  signals_deduped: ${f.signals_deduped}`);
        ok(`  tool_replays: ${f.tool_replays}`);
        if (f.malformed > 0) ok(`  malformed: ${f.malformed}`);
        for (const e of f.errors) info(`  error: ${e.path}: ${e.message}`);
      }
      for (const w of result.warnings) info(`  warning: ${w.path}: ${w.message}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof SessionImportError) {
      process.stderr.write(`error: ${exc.message}\n`);
      if (exc.code === "DETECT_FAIL" || exc.code === "UNKNOWN_FORMAT") return 2;
      return 1;
    }
    return fail(`import-session failed: ${(exc as Error).message ?? exc}`);
  }
}
