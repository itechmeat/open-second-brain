import {
  buildOkfBundle,
  OKF_MANIFEST_FILENAME,
  renderOkfManifest,
  writeOkfBundle,
  type OkfBundle,
  type OkfBundleFile,
} from "../../../core/brain/portability/okf.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain okf-export --out <dir> [--force]` — write a portable Open
 * Knowledge Format bundle (concepts / queries / references + date-grouped
 * `log.md` + `okf.json` manifest) to a directory. Read-only on the vault.
 *
 * This is the only export that carries page bodies verbatim, so it is the
 * widest leak by volume and the reason the shared egress guard exists
 * (registry entry `brain-okf-export`). The bundle is redacted in two
 * pieces because they are two kinds of document: the MANIFEST is scanned
 * as a tree and `okf.json` re-serialised from the result, since a pass
 * over serialised JSON can consume a closing quote; the markdown files
 * are scanned as text.
 *
 * A redacted bundle is no longer a lossless round-trip of the vault. The
 * verb says so on stderr rather than leaving the interchange contract to
 * imply otherwise.
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
    const built = buildOkfBundle(vault);
    const verdict = redactForEgress("brain-okf-export", {
      manifest: built.manifest,
      files: built.files.filter((file) => file.path !== OKF_MANIFEST_FILENAME),
    });
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);

    const files: OkfBundleFile[] = [
      {
        path: OKF_MANIFEST_FILENAME,
        contents: renderOkfManifest(verdict.payload.manifest),
      },
      ...verdict.payload.files,
    ];
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const bundle: OkfBundle = { manifest: verdict.payload.manifest, files };

    writeOkfBundle(out, bundle, { force: flags["force"] === true });
    process.stdout.write(
      `wrote OKF bundle to ${out} (${bundle.manifest.pages.length} page(s), ` +
        `${bundle.manifest.log_days} log day(s))\n`,
    );
    if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  } catch (exc) {
    return fail(`okf-export failed: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
