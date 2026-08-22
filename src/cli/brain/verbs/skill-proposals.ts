import { readFileSync } from "node:fs";

import { resolveSkillsDir } from "../../../core/config.ts";
import {
  commitSkillPageDraft,
  planSkillPageDrafts,
} from "../../../core/brain/skill-page-drafts.ts";
import {
  acceptSkillProposal,
  discardUnreadableSkillAcceptJournals,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
} from "../../../core/brain/skill-proposals.ts";
import { deriveSkillUsage } from "../../../core/brain/skill-usage.ts";
import { CliError, brainVerbContext, failWith, parse } from "../helpers.ts";

export async function cmdBrainSkillProposals(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "learn") return learn(rest);
  if (sub === "list") return list(rest);
  if (sub === "accept") return accept(rest);
  if (sub === "reject") return reject(rest);
  if (sub === "recover") return recover(rest);
  if (sub === "usage") return usage(rest);
  if (sub === "page-candidates") return pageCandidates(rest);
  if (sub === "page-draft") return pageDraft(rest);
  throw new CliError(
    "brain skill-proposals: expected learn, list, accept, reject, recover, usage, " +
      "page-candidates, or page-draft",
  );
}

/**
 * Which mature vault pages deserve a skill, and the envelope for each.
 *
 * Read-only. Every page the walk turned down is listed with the reason -
 * a report that showed only the winners could not be told apart from a
 * vault nobody has tagged.
 */
function pageCandidates(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const skillsDir = resolveSkillsDir(config);
  const report = planSkillPageDrafts(vault, {
    now: new Date(),
    ...(skillsDir !== null ? { skillsDir } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          generated_at: report.generatedAt,
          pages_scanned: report.pagesScanned,
          admitted: report.admitted.map((c) => ({
            path: c.path,
            title: c.title,
            tier: c.tier,
            lifecycle: c.lifecycle,
            confidence: c.confidence,
            reuse_score: c.reuseScore,
            reuse_observations: c.reuseObservations,
            llm_step: c.llmStep,
          })),
          skipped: report.skipped.map((s) => ({
            path: s.path,
            title: s.title,
            reason: s.reason,
            detail: s.detail,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `skill-proposals page-candidates: scanned=${report.pagesScanned} ` +
      `admitted=${report.admitted.length} skipped=${report.skipped.length}\n`,
  );
  for (const c of report.admitted) {
    process.stdout.write(`  admit ${c.path}  needs-llm-step: ${c.llmStep.step}\n`);
  }
  for (const s of report.skipped) {
    process.stdout.write(`  skip  ${s.path}  ${s.reason}: ${s.detail}\n`);
  }
  return 0;
}

/**
 * Stage one returned draft as a pending proposal. Writes inside the vault
 * only - the SKILL.md is materialized by `accept`, never here.
 */
function pageDraft(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    payload: { type: "string" },
    "payload-file": { type: "string" },
  });
  const page = trim(positional[0]);
  if (!page) throw new CliError("brain skill-proposals page-draft: page path is required");
  const raw =
    typeof flags["payload"] === "string"
      ? (flags["payload"] as string)
      : typeof flags["payload-file"] === "string"
        ? readFileSync(flags["payload-file"] as string, "utf8")
        : null;
  if (raw === null) {
    throw new CliError("brain skill-proposals page-draft: --payload or --payload-file is required");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new CliError("brain skill-proposals page-draft: payload must be valid JSON");
  }
  const vault = brainVerbContext(flags).vault;
  const result = commitSkillPageDraft(vault, page, payload, { now: new Date() });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    `${result.outcome} ${result.id}` + ("reason" in result ? ` (${result.reason})` : "") + `\n`,
  );
  return 0;
}

/**
 * Resolve the accept sequences a crash abandoned.
 *
 * The accept transaction's write-ahead journal was recoverable in the
 * library and reachable from nowhere: an operator whose accept broke had
 * no command to run. This is that command.
 *
 * Both hazards it can meet refuse rather than guess, and the refusal
 * carries the message the core error composed - naming the exact file and
 * the exit - so the two surfaces cannot word it differently. `--discard-
 * unreadable` is the only destructive part and it is opt-in for the reason
 * stated on `discardUnreadableSkillAcceptJournals`: an unparseable marker
 * names no phase, so removing it unblocks accepting without claiming the
 * sequence it marked was resolved.
 */
function recover(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "discard-unreadable": { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;

  let discarded: ReadonlyArray<string>;
  let recovered: ReadonlyArray<{ slug: string; action: string }>;
  try {
    discarded = flags["discard-unreadable"] ? discardUnreadableSkillAcceptJournals(vault) : [];
    recovered = recoverSkillProposalAccepts(vault);
  } catch (exc) {
    return failWith("recover skill-proposal accepts", exc);
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ discarded, recovered, total: recovered.length }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `skill-proposals recover: ${recovered.length} sequence(s) resolved, ` +
      `${discarded.length} unreadable marker(s) discarded\n`,
  );
  for (const path of discarded) process.stdout.write(`  discarded ${path}\n`);
  for (const item of recovered) process.stdout.write(`  ${item.action} ${item.slug}\n`);
  return 0;
}

function usage(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const rows = deriveSkillUsage(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: rows.length, usage: rows }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${rows.length} skill(s) with recorded invocations:\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${row.skill}  invocations=${row.invocationCount}  from_offer=${row.offerAttributedCount}\n`,
    );
  }
  return 0;
}

function learn(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "min-support": { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  const minSupportRaw = trim(flags["min-support"]);
  const minSupport = minSupportRaw
    ? parsePositiveInteger(minSupportRaw, "--min-support")
    : undefined;

  const result =
    minSupport !== undefined
      ? learnSkillProposals(vault, { minSupport })
      : learnSkillProposals(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `skill-proposals learn: scanned=${result.scanned} created=${result.created.length} suppressed=${result.suppressed.length}\n`,
  );
  return 0;
}

function list(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const pending = listPendingSkillProposals(vault);

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: pending.length, proposals: pending }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(`${pending.length} pending skill proposal(s):\n`);
  for (const item of pending) {
    process.stdout.write(`  ${item.id}  ${item.patternKind}  status=${item.status}\n`);
  }
  return 0;
}

function accept(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string" },
  });
  const slug = trim(positional[0]);
  if (!slug) throw new CliError("brain skill-proposals accept: slug is required");
  const { config, vault } = brainVerbContext(flags);
  const note = trim(flags["note"]);
  // Resolved HERE rather than inside the core: the surface knows which
  // config chain this invocation is running against, and a `mature_page`
  // accept materializes into whichever skills root that chain names.
  const skillsRoot = resolveSkillsDir(config);
  const result = acceptSkillProposal(vault, slug, {
    ...(note ? { note } : {}),
    ...(skillsRoot !== null ? { skillsRoot } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`accepted ${result.id}\n`);
  return 0;
}

function reject(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string", required: true },
  });
  const slug = trim(positional[0]);
  if (!slug) throw new CliError("brain skill-proposals reject: slug is required");
  const note = trim(flags["note"]);
  if (!note) throw new CliError("brain skill-proposals reject: --note is required");
  const vault = brainVerbContext(flags).vault;
  const result = rejectSkillProposal(vault, slug, { note });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`rejected ${result.id}\n`);
  return 0;
}

function trim(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) throw new CliError(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${label} must be a positive integer`);
  return parsed;
}
