import { defaultConfigPath } from "../../../core/config.ts";
import {
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
} from "../../../core/brain/session-recall.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSessionGrep(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    query: { type: "string" },
    "session-id": { type: "string" },
    limit: { type: "string" },
    "snippet-chars": { type: "string" },
  });
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const result = searchSessionRecall(vault, {
    query: requiredString(flags["query"], "brain session-grep", "--query"),
    ...(stringOptional(flags["session-id"]) !== undefined
      ? { sessionId: stringOptional(flags["session-id"]) }
      : {}),
    ...(positiveIntegerOptional(flags["limit"], "brain session-grep", "--limit") !== undefined
      ? { limit: positiveIntegerOptional(flags["limit"], "brain session-grep", "--limit") }
      : {}),
    ...(positiveIntegerOptional(flags["snippet-chars"], "brain session-grep", "--snippet-chars") !==
    undefined
      ? {
          snippetChars: positiveIntegerOptional(
            flags["snippet-chars"],
            "brain session-grep",
            "--snippet-chars",
          ),
        }
      : {}),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

export async function cmdBrainSessionDescribe(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "session-id": { type: "string" },
  });
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const result = describeSessionRecall(vault, {
    sessionId: requiredString(flags["session-id"], "brain session-describe", "--session-id"),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

export async function cmdBrainSessionExpand(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "raw-limit": { type: "string" },
    cursor: { type: "string" },
  });
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
  const id = positional[0];
  if (id === undefined) throw new CliError("brain session-expand: record id is required");
  const result = expandSessionRecall(vault, {
    id,
    ...(positiveIntegerOptional(flags["raw-limit"], "brain session-expand", "--raw-limit") !==
    undefined
      ? {
          rawLimit: positiveIntegerOptional(
            flags["raw-limit"],
            "brain session-expand",
            "--raw-limit",
          ),
        }
      : {}),
    ...(stringOptional(flags["cursor"]) !== undefined
      ? { cursor: stringOptional(flags["cursor"]) }
      : {}),
  });
  writeOutput(result, flags["json"] === true);
  return 0;
}

function requiredString(
  value: string | boolean | string[] | undefined,
  command: string,
  flag: string,
): string {
  const parsed = stringOptional(value);
  if (parsed === undefined) throw new CliError(`${command}: ${flag} is required`);
  return parsed;
}

function stringOptional(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntegerOptional(
  value: string | boolean | string[] | undefined,
  command: string,
  flag: string,
): number | undefined {
  const parsed = stringOptional(value);
  if (parsed === undefined) return undefined;
  if (!/^[0-9]+$/.test(parsed))
    throw new CliError(`${command}: ${flag} must be a positive integer`);
  const number = Number.parseInt(parsed, 10);
  if (number < 1) throw new CliError(`${command}: ${flag} must be a positive integer`);
  return number;
}

function writeOutput(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
