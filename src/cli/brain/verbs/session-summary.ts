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
  getSessionSummary,
  listSessionSummaries,
  SessionSummaryError,
  type SessionSummaryDigest,
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

function getSummary(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    session: { type: "string" },
    json: { type: "boolean" },
  });
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : "";
  if (session.length === 0) return usageError("brain session-summary get: --session is required");

  const vault = brainVerbContext(flags).vault;
  const digest = getSessionSummary(vault, session);
  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(digest === null ? { found: false } : { found: true, digest: serialize(digest) }, null, 2)}\n`,
    );
    return 0;
  }
  if (digest === null) {
    process.stdout.write(`no session summary for ${session}\n`);
    return 0;
  }
  process.stdout.write(renderDigest(digest));
  return 0;
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
