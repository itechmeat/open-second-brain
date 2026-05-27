import { existsSync } from "node:fs";
import { defaultConfigPath } from "../../../core/config.ts";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { exportPreferencesJson, exportPreferencesLlmsTxt } from "../../../core/brain/export.ts";
import { parse, fail, ok, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const format = flags["format"] as string | undefined;
  if (format !== "json" && format !== "llms-txt") {
    process.stderr.write("error: --format is required and must be one of json|llms-txt\n");
    return 2;
  }

  let body: string;
  try {
    body =
      format === "json"
        ? JSON.stringify(exportPreferencesJson(vault)) + "\n"
        : exportPreferencesLlmsTxt(vault);
  } catch (exc) {
    return fail(`export failed: ${(exc as Error).message ?? exc}`);
  }

  const outPath = flags["out"] as string | undefined;
  if (outPath === undefined) {
    process.stdout.write(body);
    return 0;
  }
  if (existsSync(outPath) && !flags["force"])
    return fail(`${outPath} exists; pass --force to overwrite`);
  try {
    atomicWriteFileSync(outPath, body);
  } catch (exc) {
    return fail(`failed to write ${outPath}: ${(exc as Error).message ?? exc}`);
  }
  ok(`wrote ${outPath}`);
  return 0;
}
