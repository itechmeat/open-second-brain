import { defaultConfigPath } from "../../../core/config.ts";
import {
  applyRecurrenceEvidence,
  getRecurrenceEntry,
  listRecurrenceEntries,
  purgeRecurrenceSource,
} from "../../../core/brain/recurrence.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainRecurrence(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return list(rest);
  if (sub === "show") return show(rest);
  if (sub === "learn") return mutate(rest, "learn");
  if (sub === "forget") return mutate(rest, "forget");
  if (sub === "purge-source") return purgeSource(rest);
  throw new CliError("brain recurrence: expected list, show, learn, forget, or purge-source");
}

function list(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const entries = listRecurrenceEntries(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: entries.length, entries }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${entries.length} recurrence entr(y/ies):\n`);
  for (const entry of entries) {
    process.stdout.write(
      `  ${entry.contentHash} support=${entry.supportCount} recurrence=${entry.recurrenceCount} commitment=${entry.commitment}\n`,
    );
  }
  return 0;
}

function show(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const hash = trim(positional[0]);
  if (!hash) throw new CliError("brain recurrence show: content hash is required");
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const entry = getRecurrenceEntry(vault, hash);
  if (!entry) throw new CliError(`brain recurrence show: not found: ${hash}`);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `${entry.contentHash} support=${entry.supportCount} recurrence=${entry.recurrenceCount} commitment=${entry.commitment}\n`,
  );
  return 0;
}

function mutate(argv: string[], action: "learn" | "forget"): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    hash: { type: "string", required: true },
    scope: { type: "string", required: true },
    source: { type: "string", required: true },
  });

  const hash = trim(flags["hash"]);
  const scope = trim(flags["scope"]);
  const source = trim(flags["source"]);
  if (!hash || !scope || !source) {
    throw new CliError(`brain recurrence ${action}: --hash, --scope, and --source are required`);
  }

  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const entry = applyRecurrenceEvidence(vault, {
    contentHash: hash,
    scope,
    sourceId: source,
    action,
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${action} ${hash}\n`);
  return 0;
}

function purgeSource(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    source: { type: "string", required: true },
  });
  const source = trim(flags["source"]);
  if (!source) throw new CliError("brain recurrence purge-source: --source is required");
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  purgeRecurrenceSource(vault, source);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ ok: true, source }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`purged source: ${source}\n`);
  return 0;
}

function trim(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}
