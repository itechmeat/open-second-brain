import { extractPreCompactRecords } from "../../../core/brain/pre-compact-extract.ts";
import { CliError, parse } from "../helpers.ts";

export async function cmdBrainPreCompactExtract(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    json: { type: "boolean" },
    vault: { type: "string" },
    "session-id": { type: "string" },
    "turn-start": { type: "string" },
    "turn-end": { type: "string" },
    text: { type: "string" },
    host: { type: "string" },
    "max-chars": { type: "string" },
  });
  const vault = stringRequired(flags["vault"], "--vault");
  const sessionId = stringRequired(flags["session-id"], "--session-id");
  const turnStart = stringRequired(flags["turn-start"], "--turn-start");
  const turnEnd = stringRequired(flags["turn-end"], "--turn-end");
  const text = stringRequired(flags["text"], "--text");
  const maxChars = stringOptional(flags["max-chars"]);
  const result = extractPreCompactRecords(vault, {
    sessionId,
    turnStart,
    turnEnd,
    text,
    ...(stringOptional(flags["host"]) !== undefined ? { host: stringOptional(flags["host"]) } : {}),
    ...(maxChars !== undefined ? { maxChars: positiveInteger(maxChars, "--max-chars") } : {}),
  });
  writeOutput({ count: result.records.length, ...result }, flags["json"] === true);
  return 0;
}

function stringRequired(value: string | boolean | string[] | undefined, label: string): string {
  const parsed = stringOptional(value);
  if (parsed === undefined) throw new CliError(`brain pre-compact-extract: ${label} is required`);
  return parsed;
}

function stringOptional(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) throw new CliError(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${label} must be a positive integer`);
  return parsed;
}

function writeOutput(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
