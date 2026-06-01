import { defaultConfigPath } from "../../../core/config.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  rejectSkillProposal,
} from "../../../core/brain/skill-proposals.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSkillProposals(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "learn") return learn(rest);
  if (sub === "list") return list(rest);
  if (sub === "accept") return accept(rest);
  if (sub === "reject") return reject(rest);
  throw new CliError("brain skill-proposals: expected learn, list, accept, or reject");
}

function learn(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "min-support": { type: "string" },
  });
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
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
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
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
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const note = trim(flags["note"]);
  const result = note
    ? acceptSkillProposal(vault, slug, { note })
    : acceptSkillProposal(vault, slug);

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
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
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
