/**
 * `o2b brain session-summary` (Session Knowledge Synthesis, t_325a7e4a):
 * write or read a session-scoped structured digest over the four
 * canonical categories (request / decisions / learnings / next_steps).
 *
 *   write  --session <id> [--request <s>] [--decision <s>]...
 *          [--learning <s>]... [--next-step <s>]... [--turn <id>]... [--host <h>]
 *   get    --session <id>
 *   list   [--session <id>]
 *
 * The kernel stores agent-supplied categories verbatim; it never parses
 * prose into categories. An all-empty digest is rejected (exit 2).
 */

import {
  appendSessionSummary,
  getSessionSummaryReport,
  listSessionSummaries,
  SessionSummaryError,
  type SessionSummaryDigest,
  type SessionSummaryRecordRef,
  type SessionSummaryReport,
} from "../../../core/brain/session-summary.ts";
import { brainVerbContext, fail, parse, usageError } from "../helpers.ts";

const USAGE =
  "usage: o2b brain session-summary write --session <id> [--request <s>] " +
  "[--decision <s>]... [--learning <s>]... [--next-step <s>]... [--turn <id>]... [--host <h>] [--json]\n" +
  "       o2b brain session-summary get --session <id> [--json]\n" +
  "       o2b brain session-summary list [--session <id>] [--json]";

export async function cmdBrainSessionSummary(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "write") return writeSummary(argv.slice(1));
  if (subcommand === "get") return getSummary(argv.slice(1));
  if (subcommand === "list") return listSummaries(argv.slice(1));
  return fail(USAGE);
}

function asStringArray(value: string | boolean | string[] | undefined): ReadonlyArray<string> {
  return Array.isArray(value) ? value : [];
}

function writeSummary(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    session: { type: "string" },
    request: { type: "string" },
    decision: { type: "string-array" },
    learning: { type: "string-array" },
    "next-step": { type: "string-array" },
    turn: { type: "string-array" },
    host: { type: "string" },
    json: { type: "boolean" },
  });
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : "";
  if (session.length === 0) return usageError("brain session-summary write: --session is required");

  const vault = brainVerbContext(flags).vault;
  try {
    const digest = appendSessionSummary(vault, {
      sessionId: session,
      ...(typeof flags["request"] === "string" ? { request: flags["request"] } : {}),
      decisions: asStringArray(flags["decision"]),
      learnings: asStringArray(flags["learning"]),
      nextSteps: asStringArray(flags["next-step"]),
      sourceTurnIds: asStringArray(flags["turn"]),
      ...(typeof flags["host"] === "string" ? { host: flags["host"] } : {}),
    });
    return emit(
      flags,
      { written: true, digest: serialize(digest) },
      () => `wrote session summary ${digest.id}`,
    );
  } catch (error) {
    if (error instanceof SessionSummaryError)
      return usageError(`brain session-summary write: ${error.message}`);
    throw error;
  }
}

/**
 * The one note line text mode appends when the session holds more than one
 * content-differing digest (t_59d4c919). Token-shaped so an operator can
 * grep it; the count is the honest total, the shown digest stays the
 * sorted-latest. Divergence is reported here, never merged away.
 */
function divergenceNoteLine(count: number): string {
  return `note: digest_count=${count} divergent=true (showing the sorted-latest digest)`;
}

/** Wire shape of one divergence record: identity and hash, never a payload echo. */
function serializeRecordRef(record: SessionSummaryRecordRef): Record<string, unknown> {
  return { id: record.id, created_at: record.createdAt, content_hash: record.contentHash };
}

function getSummary(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    session: { type: "string" },
    json: { type: "boolean" },
  });
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : "";
  if (session.length === 0) return usageError("brain session-summary get: --session is required");

  const vault = brainVerbContext(flags).vault;
  const report = getSessionSummaryReport(vault, session);
  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(serializeReport(report), null, 2)}\n`);
    return 0;
  }
  if (report === null) {
    process.stdout.write(`no session summary for ${session}\n`);
    return 0;
  }
  process.stdout.write(renderDigest(report.digest));
  if (report.divergent === true) {
    process.stdout.write(`${divergenceNoteLine(report.digestCount)}\n`);
  }
  return 0;
}

/** The get envelope: additive divergence fields only when the session diverges. */
function serializeReport(report: SessionSummaryReport | null): Record<string, unknown> {
  if (report === null) return { found: false };
  return {
    found: true,
    digest: serialize(report.digest),
    digest_count: report.digestCount,
    ...(report.divergent === true
      ? {
          divergent: true,
          records: (report.records ?? []).map(serializeRecordRef),
        }
      : {}),
  };
}

function listSummaries(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    session: { type: "string" },
    json: { type: "boolean" },
  });
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : undefined;
  const vault = brainVerbContext(flags).vault;
  const digests = listSessionSummaries(
    vault,
    session !== undefined && session.length > 0 ? { sessionId: session } : {},
  );
  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify({ count: digests.length, digests: digests.map(serialize) }, null, 2)}\n`,
    );
    return 0;
  }
  if (digests.length === 0) {
    process.stdout.write("no session summaries\n");
    return 0;
  }
  process.stdout.write(`${digests.length} session summary record(s)\n`);
  for (const digest of digests) {
    process.stdout.write(
      `  ${digest.createdAt}  ${digest.sessionId}  d=${digest.decisions.length} l=${digest.learnings.length} n=${digest.nextSteps.length}\n`,
    );
  }
  return 0;
}

function serialize(digest: SessionSummaryDigest): Record<string, unknown> {
  return {
    id: digest.id,
    session_id: digest.sessionId,
    request: digest.request,
    decisions: digest.decisions,
    learnings: digest.learnings,
    next_steps: digest.nextSteps,
    created_at: digest.createdAt,
    ...(digest.host !== undefined ? { host: digest.host } : {}),
    // Same field the MCP serializer carries; dropping it here was the
    // verified CLI/MCP drift (t_59d4c919).
    ...(digest.project !== undefined ? { project: digest.project } : {}),
  };
}

function renderDigest(digest: SessionSummaryDigest): string {
  const lines = [`session ${digest.sessionId}  (${digest.createdAt})`];
  if (digest.request !== null) lines.push(`  request: ${digest.request}`);
  appendCategory(lines, "decisions", digest.decisions);
  appendCategory(lines, "learnings", digest.learnings);
  appendCategory(lines, "next_steps", digest.nextSteps);
  return `${lines.join("\n")}\n`;
}

function appendCategory(lines: string[], label: string, items: ReadonlyArray<string>): void {
  if (items.length === 0) return;
  lines.push(`  ${label}:`);
  for (const item of items) lines.push(`    - ${item}`);
}

function emit(
  flags: Record<string, string | boolean | string[] | undefined>,
  json: Record<string, unknown>,
  text: () => string,
): number {
  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${text()}\n`);
  return 0;
}
