/**
 * Generated-asset note writer.
 *
 * Saves a Markdown note for an asset (image, file, transcript, ...) produced
 * by a paid API call. Frontmatter links the note back to the originating
 * receipt; the body keeps the prompt and generated URL human-readable.
 */

import type { FrontmatterMap } from "../types.ts";
import { slugify, writeFrontmatterAtomic } from "../vault.ts";
import {
  nowIsoZ,
  NOT_PROVIDED,
  wikiLink,
} from "./_md.ts";
import { assetPath, ensureInsideVault, vaultRelative } from "./paths.ts";
import type { AssetInput, AssetOutput } from "./types.ts";

export const ASSET_FRONTMATTER_TYPE = "generated-asset";

export function writeAsset(vault: string, input: AssetInput): AssetOutput {
  if (!input.title?.trim()) throw new Error("asset requires a title");
  if (!input.service?.trim()) throw new Error("asset requires a service");
  if (!input.resultUrl?.trim()) throw new Error("asset requires a result_url");

  const slug = (input.slug && input.slug.trim()) || slugify(input.title);
  const target = assetPath(vault, slug);
  ensureInsideVault(target, vault);

  const created = nowIsoZ();
  const metadata: FrontmatterMap = {
    type: ASSET_FRONTMATTER_TYPE,
    title: input.title.trim(),
    source: input.service.trim(),
    result_url: input.resultUrl.trim(),
    created,
  };
  if (input.sourceReceipt?.trim()) {
    metadata["source_receipt"] = wikiLink(input.sourceReceipt);
  }
  if (input.usedIn?.trim()) {
    metadata["used_in"] = wikiLink(input.usedIn);
  }

  writeFrontmatterAtomic(target, metadata, renderAssetBody(input), {
    overwrite: input.overwrite,
    existsErrorKind: "asset",
    vaultForRelativePath: vault,
  });

  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    created,
  };
}

function renderAssetBody(input: AssetInput): string {
  const title = input.title.trim();
  const usedIn = input.usedIn?.trim();
  const sourceReceipt = input.sourceReceipt?.trim();
  const prompt = input.prompt?.trim();

  const lines: string[] = [`# ${title}`, ""];

  lines.push("## Purpose", "");
  if (usedIn) {
    // Run every wikilink target through the same sanitizer/extension stripper
    // — `usedIn`, `sourceReceipt`, and `resultNote` (in receipts) all become
    // `[[...]]` and a stray `[`/`]` would prematurely close the link.
    lines.push(`Used in: ${wikiLink(usedIn)}`);
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("");

  lines.push("## Prompt", "");
  if (prompt) {
    lines.push(...prompt.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")));
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("");

  lines.push("## Result", "", `${input.resultUrl.trim()}`, "");

  lines.push("## Source", "");
  lines.push(`Service: \`${input.service.trim().replace(/`/g, "ˋ")}\``);
  if (sourceReceipt) {
    lines.push(`Receipt: ${wikiLink(sourceReceipt)}`);
  } else {
    lines.push(`Receipt: ${NOT_PROVIDED}`);
  }
  lines.push("");

  lines.push(
    "## Notes",
    "",
    "Generated through a paid API call recorded in the linked receipt.",
  );
  return lines.join("\n");
}

