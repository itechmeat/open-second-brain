import {
  buildOkfBundleFromPages,
  collectOkfPages,
  OKF_INDEX_FILENAME,
  OKF_MANIFEST_FILENAME,
  renderIndex,
  renderOkfManifest,
  writeOkfBundle,
  type OkfBundle,
  type OkfBundleFile,
} from "../../../core/brain/portability/okf.ts";
import { readContentClass } from "../../../core/brain/provenance/content-class.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_CONTENT_CLASS_INCLUDE_NOTICE,
  EGRESS_REDACTION_NOTICE,
  contentClassOmissionNotice,
  egressContentClassSplit,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import { brainVerbContext, fail, parse } from "../helpers.ts";

/**
 * `o2b brain okf-export --out <dir> [--force] [--include-prompt-derived]`
 * — write a portable Open Knowledge Format bundle (concepts / queries /
 * references + date-grouped `log.md` + `okf.json` manifest) to a
 * directory. Read-only on the vault.
 *
 * This is the only export that carries page bodies verbatim, so it is the
 * widest leak by volume and the reason the shared egress guard exists
 * (registry entry `brain-okf-export`). The bundle is redacted in two
 * pieces because they are two kinds of document: the MANIFEST is scanned
 * as a tree and `okf.json` re-serialised from the result, since a pass
 * over serialised JSON can consume a closing quote; the markdown files
 * are scanned as text.
 *
 * Pages whose `content_class` frontmatter carries the reserved
 * `prompt-derived` value are left out of the bundle BEFORE it is composed
 * - they are absent from the manifest and no file is written for them -
 * and every omission is named on stderr. `--include-prompt-derived` is
 * the operator override; it carries the pages back in and says so. The
 * bundle is composed FROM the kept pages rather than by re-walking the
 * vault, so the walk that fed the split is the walk the bundle is built
 * from: a page appearing or changing between two walks could otherwise
 * re-admit what the policy just left out.
 *
 * The reserved bundle-root files ride every bundle: `index.md` is
 * re-rendered from the REDACTED manifest by the same renderer the
 * builder uses - the pre-redaction index named the excluded pages, and
 * an index that lists pages or values the shipped `okf.json` does not
 * carry would make the bundle disagree with itself - and `log.md` is
 * kept whole, because its entries are day-keyed events (a timestamp, a
 * kind, body bullets), not page content; it still rides the same
 * redaction scan as the page files.
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
    "include-prompt-derived": { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const out = flags["out"] as string | undefined;
  if (out === undefined) {
    return fail("--out <dir> is required for okf-export");
  }
  const classPolicy = { contentClass: { include: flags["include-prompt-derived"] === true } };

  try {
    // The split runs over the pages the walk collected, and the bundle
    // below is composed FROM the kept pages: a marked page is absent
    // from the manifest and its bundle file is never composed - not
    // redacted after the fact. Composing from `split.kept` (the
    // `buildOkfBundleFromPages` entry point) is also the honest choice
    // about the walk: the alternative re-walk in `buildOkfBundle` could
    // disagree with the very split that decided what may leave.
    const split = egressContentClassSplit(collectOkfPages(vault), classPolicy, {
      name: (page) => page.path,
      isPromptDerived: (page) => readContentClass(page.frontmatter) !== null,
    });

    const built = buildOkfBundleFromPages(vault, split.kept);
    const verdict = redactForEgress("brain-okf-export", {
      manifest: built.manifest,
      // The two reserved files rendered FROM the manifest are re-rendered
      // after redaction below, so only the per-page files and the log are
      // scanned as text here. The log stays whole - its entries name days
      // and events, not page bodies - but it is scanned like any other
      // markdown the bundle carries.
      files: built.files.filter(
        (file) => file.path !== OKF_MANIFEST_FILENAME && file.path !== OKF_INDEX_FILENAME,
      ),
    });
    if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);

    const files: OkfBundleFile[] = [
      {
        path: OKF_MANIFEST_FILENAME,
        contents: renderOkfManifest(verdict.payload.manifest),
      },
      // Same renderer the builder uses, redacted manifest in: the index
      // can never list a page the manifest left out (the pre-redaction
      // index did) nor name a value the guard replaced.
      { path: OKF_INDEX_FILENAME, contents: renderIndex(verdict.payload.manifest) },
      ...verdict.payload.files,
    ];
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const bundle: OkfBundle = { manifest: verdict.payload.manifest, files };

    writeOkfBundle(out, bundle, { force: flags["force"] === true });
    process.stdout.write(
      `wrote OKF bundle to ${out} (${bundle.manifest.pages.length} page(s), ` +
        `${bundle.manifest.log_days} log day(s))\n`,
    );
    if (flags["include-prompt-derived"] === true) {
      process.stderr.write(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
    } else if (split.omitted.length > 0) {
      process.stderr.write(contentClassOmissionNotice(split.omitted));
    }
    if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
  } catch (exc) {
    return fail(`okf-export failed: ${(exc as Error).message ?? exc}`);
  }
  return 0;
}
