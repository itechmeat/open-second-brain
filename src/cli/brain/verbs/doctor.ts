import { defaultConfigPath } from "../../../core/config.ts";
import { runDoctor } from "../../../core/brain/doctor.ts";
import { parse, fail, ok, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainDoctor(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let result;
  try { result = runDoctor(vault, { strict: Boolean(flags["strict"]) }); }
  catch (exc) { return fail(`doctor failed: ${(exc as Error).message ?? exc}`); }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ warnings: result.warnings, errors: result.errors }, null, 2) + "\n");
  } else {
    for (const e of result.errors) process.stdout.write(`[ERROR] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}\n`);
    for (const w of result.warnings) process.stdout.write(`[WARN]  ${w.code}: ${w.message}${w.path ? ` (${w.path})` : ""}\n`);
    if (result.errors.length === 0 && result.warnings.length === 0) ok("brain doctor: clean");
  }

  if (result.errors.length > 0) return 1;
  if (result.warnings.length > 0 && flags["strict"]) return 2;
  return 0;
}
