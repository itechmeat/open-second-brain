import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  suggestContextPreset,
  type ContextPresetCurrentConfig,
} from "../../../core/brain/context-presets.ts";
import { CliError, parse } from "../helpers.ts";

export async function cmdBrainContextPresets(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "show") return showPreset(rest);
  if (subcommand === "suggest") return suggestPreset(rest);
  if (subcommand === "diff") return diffPreset(rest);
  throw new CliError("brain context-presets: expected show, suggest, or diff");
}

function showPreset(argv: string[]): number {
  const { flags, positional } = parse(argv, { json: { type: "boolean" } });
  const id = positional[0];
  const value = id === undefined ? listContextPresets() : getContextPreset(id);
  if (value === null) throw new CliError(`brain context-presets show: unknown preset ${id}`);
  writeOutput(value, flags["json"] === true);
  return 0;
}

function suggestPreset(argv: string[]): number {
  const { flags } = parse(argv, {
    json: { type: "boolean" },
    model: { type: "string" },
    "context-window": { type: "string" },
  });
  const windowRaw = trimOrUndefined(flags["context-window"]);
  const suggestion = suggestContextPreset({
    ...(trimOrUndefined(flags["model"]) !== undefined
      ? { model: trimOrUndefined(flags["model"]) }
      : {}),
    ...(windowRaw !== undefined
      ? { contextWindowTokens: positiveInteger(windowRaw, "--context-window") }
      : {}),
  });
  writeOutput(suggestion, flags["json"] === true);
  return 0;
}

function diffPreset(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    json: { type: "boolean" },
    override: { type: "string-array" },
    "context-pack-max-tokens": { type: "string" },
    "context-pack-max-chars-per-memory": { type: "string" },
    "context-pack-max-total-chars": { type: "string" },
    "pre-compress-top-k": { type: "string" },
    "pre-compress-max-chars-per-memory": { type: "string" },
    "pre-compress-max-total-chars": { type: "string" },
  });
  const id = positional[0];
  if (id === undefined) throw new CliError("brain context-presets diff: preset id is required");
  const current: ContextPresetCurrentConfig = {
    context_pack: numericSection(flags, [
      ["context-pack-max-tokens", "max_tokens"],
      ["context-pack-max-chars-per-memory", "max_chars_per_memory"],
      ["context-pack-max-total-chars", "max_total_chars"],
    ]),
    pre_compress: numericSection(flags, [
      ["pre-compress-top-k", "top_k"],
      ["pre-compress-max-chars-per-memory", "max_chars_per_memory"],
      ["pre-compress-max-total-chars", "max_total_chars"],
    ]),
    overrides: (flags["override"] as string[] | undefined) ?? [],
  };
  writeOutput(diffContextPreset(id, current), flags["json"] === true);
  return 0;
}

function numericSection(
  flags: Record<string, string | boolean | string[] | undefined>,
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [flag, key] of pairs) {
    const value = trimOrUndefined(flags[flag]);
    if (value !== undefined) out[key] = positiveInteger(value, `--${flag}`);
  }
  return out;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) throw new CliError(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${label} must be a positive integer`);
  return parsed;
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function writeOutput(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
