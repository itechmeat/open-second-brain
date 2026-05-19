/**
 * `o2b brain` subcommand dispatcher.
 *
 * Routes Brain verbs to thin wrappers over `src/core/brain/*`.
 * Each verb handler lives in `./verbs/<name>.ts`; this file only
 * dispatches and prints help.
 */

import { CliError } from "./argparse.ts";
import { BRAIN_HELP, VERB_HELP } from "./brain/helpers.ts";
import {
  cmdBrainInit,
  cmdBrainFeedback,
  cmdBrainDream,
  cmdBrainApplyEvidence,
  cmdBrainDigest,
  cmdBrainQuery,
  cmdBrainReject,
  cmdBrainPin,
  cmdBrainUnpin,
  cmdBrainSetPrimary,
  cmdBrainProtect,
  cmdBrainUnprotect,
  cmdBrainRollback,
  cmdBrainDoctor,
  cmdBrainBacklinks,
  cmdBrainMerge,
  cmdBrainExplorer,
  cmdBrainExport,
  cmdBrainUpgrade,
  handleBrainSnapshotSubcommand,
  cmdBrainMigrateFrontmatter,
  cmdBrainScanInline,
  cmdBrainImportSession,
  cmdBrainImportClaudeMemory,
} from "./brain/verbs/index.ts";

export async function handleBrainSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(BRAIN_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
    const text = VERB_HELP[verb];
    if (text) { process.stdout.write(text); return 0; }
    process.stdout.write(BRAIN_HELP);
    return 2;
  }

  try {
    switch (verb) {
      case "init": return await cmdBrainInit(rest);
      case "feedback": return await cmdBrainFeedback(rest);
      case "dream": return await cmdBrainDream(rest);
      case "apply-evidence": return await cmdBrainApplyEvidence(rest);
      case "digest": return await cmdBrainDigest(rest);
      case "query": return await cmdBrainQuery(rest);
      case "reject": return await cmdBrainReject(rest);
      case "pin": return await cmdBrainPin(rest);
      case "unpin": return await cmdBrainUnpin(rest);
      case "set-primary": return await cmdBrainSetPrimary(rest);
      case "protect": return await cmdBrainProtect(rest);
      case "unprotect": return await cmdBrainUnprotect(rest);
      case "snapshot": return await handleBrainSnapshotSubcommand(rest);
      case "rollback": return await cmdBrainRollback(rest);
      case "doctor": return await cmdBrainDoctor(rest);
      case "backlinks": return await cmdBrainBacklinks(rest);
      case "migrate-frontmatter": return await cmdBrainMigrateFrontmatter(rest);
      case "scan-inline": return await cmdBrainScanInline(rest);
      case "import-session": return await cmdBrainImportSession(rest);
      case "import-claude-memory": return await cmdBrainImportClaudeMemory(rest);
      case "merge": return await cmdBrainMerge(rest);
      case "upgrade": return await cmdBrainUpgrade(rest);
      case "export": return await cmdBrainExport(rest);
      case "explorer": return await cmdBrainExplorer(rest);
      default:
        process.stderr.write(`error: unknown brain verb: ${verb}\n`);
        process.stdout.write(BRAIN_HELP);
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) { process.stderr.write(`error: ${exc.message}\n`); return 1; }
    throw exc;
  }
}
