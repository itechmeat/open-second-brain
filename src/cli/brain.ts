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
  cmdBrainNote,
  cmdBrainDream,
  cmdBrainApplyEvidence,
  cmdBrainDigest,
  cmdBrainIntentReview,
  cmdBrainRetention,
  cmdBrainMonthly,
  cmdBrainQuery,
  cmdBrainAgentQuery,
  cmdBrainAgentDiff,
  cmdBrainReject,
  cmdBrainPin,
  cmdBrainUnpin,
  cmdBrainSetPrimary,
  cmdBrainProtect,
  cmdBrainUnprotect,
  cmdBrainRollback,
  cmdBrainDoctor,
  cmdBrainWatchdog,
  cmdBrainHealth,
  cmdBrainHistory,
  cmdBrainAudit,
  cmdBrainMorningBrief,
  cmdBrainCodec,
  cmdBrainSources,
  cmdBrainSchema,
  cmdBrainGraphExport,
  cmdBrainGraphImport,
  cmdBrainBacklinks,
  cmdBrainSemanticsBackfill,
  cmdBrainMcpLandscape,
  cmdBrainMerge,
  cmdBrainExplorer,
  cmdBrainExport,
  cmdBrainUpgrade,
  handleBrainSnapshotSubcommand,
  cmdBrainScanInline,
  cmdBrainEntity,
  cmdBrainImportSession,
  cmdBrainHandoff,
  cmdBrainIntention,
  cmdBrainProject,
  cmdBrainSource,
  cmdBrainSessionHook,
  cmdBrainImportClaudeMemory,
  cmdBrainPageDedup,
  cmdBrainTokenFootprint,
  cmdBrainContextPack,
  cmdBrainContextReceipts,
  cmdBrainContextPresets,
  cmdBrainPreCompactExtract,
  cmdBrainRecallTelemetry,
  cmdBrainSkillProposals,
  cmdBrainProceduralMemory,
  cmdBrainProceduralGraph,
  cmdBrainRecurrence,
  cmdBrainAttentionFlows,
  cmdBrainSessionDescribe,
  cmdBrainSessionExpand,
  cmdBrainSessionGrep,
  cmdBrainLint,
  cmdBrainActions,
  cmdBrainSummary,
  cmdBrainUnlinked,
  cmdBrainSynthesise,
  cmdBrainMocAudit,
  cmdBrainTimeline,
  cmdBrainEvolution,
  cmdBrainStale,
  cmdBrainDaily,
  cmdBrainWeekly,
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
    if (text) {
      process.stdout.write(text);
      return 0;
    }
    process.stdout.write(BRAIN_HELP);
    return 2;
  }

  try {
    switch (verb) {
      case "init":
        return await cmdBrainInit(rest);
      case "feedback":
        return await cmdBrainFeedback(rest);
      case "note":
        return await cmdBrainNote(rest);
      case "dream":
        return await cmdBrainDream(rest);
      case "apply-evidence":
        return await cmdBrainApplyEvidence(rest);
      case "digest":
        return await cmdBrainDigest(rest);
      case "intent-review":
        return await cmdBrainIntentReview(rest);
      case "retention":
        return await cmdBrainRetention(rest);
      case "monthly":
        return await cmdBrainMonthly(rest);
      case "query":
        return await cmdBrainQuery(rest);
      case "agent-query":
        return await cmdBrainAgentQuery(rest);
      case "agent-diff":
        return await cmdBrainAgentDiff(rest);
      case "reject":
        return await cmdBrainReject(rest);
      case "pin":
        return await cmdBrainPin(rest);
      case "unpin":
        return await cmdBrainUnpin(rest);
      case "set-primary":
        return await cmdBrainSetPrimary(rest);
      case "protect":
        return await cmdBrainProtect(rest);
      case "unprotect":
        return await cmdBrainUnprotect(rest);
      case "snapshot":
        return await handleBrainSnapshotSubcommand(rest);
      case "rollback":
        return await cmdBrainRollback(rest);
      case "doctor":
        return await cmdBrainDoctor(rest);
      case "watchdog":
        return await cmdBrainWatchdog(rest);
      case "health":
        return await cmdBrainHealth(rest);
      case "history":
        return await cmdBrainHistory(rest);
      case "audit":
        return await cmdBrainAudit(rest);
      case "morning-brief":
        return await cmdBrainMorningBrief(rest);
      case "codec":
        return await cmdBrainCodec(rest);
      case "sources":
        return await cmdBrainSources(rest);
      case "schema":
        return await cmdBrainSchema(rest);
      case "graph-export":
        return await cmdBrainGraphExport(rest);
      case "graph-import":
        return await cmdBrainGraphImport(rest);
      case "backlinks":
        return await cmdBrainBacklinks(rest);
      case "semantics-backfill":
        return await cmdBrainSemanticsBackfill(rest);
      case "mcp-landscape":
        return await cmdBrainMcpLandscape(rest);
      case "scan-inline":
        return await cmdBrainScanInline(rest);
      case "import-session":
        return await cmdBrainImportSession(rest);
      case "handoff":
        return await cmdBrainHandoff(rest);
      case "intention":
        return await cmdBrainIntention(rest);
      case "project":
        return await cmdBrainProject(rest);
      case "source":
        return await cmdBrainSource(rest);
      case "entity":
        return await cmdBrainEntity(rest);
      case "session-hook":
        return await cmdBrainSessionHook(rest);
      case "import-claude-memory":
        return await cmdBrainImportClaudeMemory(rest);
      case "merge":
        return await cmdBrainMerge(rest);
      case "upgrade":
        return await cmdBrainUpgrade(rest);
      case "export":
        return await cmdBrainExport(rest);
      case "explorer":
        return await cmdBrainExplorer(rest);
      case "page-dedup":
        return await cmdBrainPageDedup(rest);
      case "token-footprint":
        return await cmdBrainTokenFootprint(rest);
      case "context-pack":
        return await cmdBrainContextPack(rest);
      case "context-receipts":
        return await cmdBrainContextReceipts(rest);
      case "context-presets":
        return await cmdBrainContextPresets(rest);
      case "pre-compact-extract":
        return await cmdBrainPreCompactExtract(rest);
      case "recall-telemetry":
        return await cmdBrainRecallTelemetry(rest);
      case "skill-proposals":
        return await cmdBrainSkillProposals(rest);
      case "procedural-memory":
        return await cmdBrainProceduralMemory(rest);
      case "procedural-graph":
        return await cmdBrainProceduralGraph(rest);
      case "recurrence":
        return await cmdBrainRecurrence(rest);
      case "attention-flows":
        return await cmdBrainAttentionFlows(rest);
      case "session-grep":
        return await cmdBrainSessionGrep(rest);
      case "session-describe":
        return await cmdBrainSessionDescribe(rest);
      case "session-expand":
        return await cmdBrainSessionExpand(rest);
      case "lint":
        return await cmdBrainLint(rest);
      case "actions":
        return await cmdBrainActions(rest);
      case "summary":
        return await cmdBrainSummary(rest);
      case "unlinked":
        return await cmdBrainUnlinked(rest);
      case "synthesise":
        return await cmdBrainSynthesise(rest);
      case "moc-audit":
        return await cmdBrainMocAudit(rest);
      case "timeline":
        return await cmdBrainTimeline(rest);
      case "evolution":
        return await cmdBrainEvolution(rest);
      case "stale":
        return await cmdBrainStale(rest);
      case "daily":
        return await cmdBrainDaily(rest);
      case "weekly":
        return await cmdBrainWeekly(rest);
      default:
        process.stderr.write(`error: unknown brain verb: ${verb}\n`);
        process.stdout.write(BRAIN_HELP);
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
}
