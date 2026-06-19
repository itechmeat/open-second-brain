import { buildOkfBundle, writeOkfBundle } from "../../../core/brain/portability/okf.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain okf-export --out <dir> [--force]` — write a portable Open
 * Knowledge Format bundle (concepts / queries / references + date-grouped
 * `log.md` + `okf.json` manifest) to a directory. Read-only on the vault.
 */
export async function cmdBrainOkfExport(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const out = flags["out"] as string | undefined;
  if (out === undefined) {
    return fail("--out <dir> is required for okf-export");
  }

  try {
    const bundle = buildOkfBundle(vault);
    writeOkfBundle(out, bundle, { force: flags["force"] === true });
    process.stdout.write(
      `wrote OKF bundle to ${out} (${bundle.manifest.pages.length} page(s), ` +
        `${bundle.manifest.log_days} log day(s))\n`,
    );
  } catch (exc) {
    return fail(`okf-export failed: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
