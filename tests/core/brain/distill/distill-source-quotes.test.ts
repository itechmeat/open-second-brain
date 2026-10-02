/**
 * The quote check inside `distillSource`: a quoted span in a claim is
 * compared with the source bytes the page's digest covers. A failed span is
 * unquoted on the page and named in the result; `strictQuotes` refuses the
 * whole write instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  distillSource,
  type DistillClaim,
  type DistillSourceResult,
} from "../../../../src/core/brain/distill/distill-source.ts";
import {
  QUOTE_CHECK_OUTCOME,
  QUOTE_UNVERIFIED_CODE,
  QUOTES_UNQUOTED_KEY,
  QUOTES_VERIFIED_KEY,
  QuoteCheckError,
} from "../../../../src/core/brain/distill/quote-verdict.ts";
import { hashFile } from "../../../../src/core/brain/ingest/content-manifest.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../../../src/core/brain/paths.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";

let vault: string;
const NOW = new Date("2026-07-10T08:00:00Z");
const LATER = new Date("2026-07-11T09:00:00Z");
const SOURCE = "Articles/restaking.md";
const SOURCE_BYTES =
  "# Restaking\n\nRestaking reuses staked capital to secure more services. ^abc\n";

const VERBATIM: DistillClaim = { text: "It “reuses staked capital” for more.", block: "abc" };
const PARAPHRASE: DistillClaim = { text: "It “recycles staked capital” for more.", block: "abc" };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-quotes-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, SOURCE), SOURCE_BYTES, "utf8");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function distill(
  claims: ReadonlyArray<DistillClaim>,
  opts: { now?: Date; strictQuotes?: boolean } = {},
): DistillSourceResult {
  return distillSource(
    vault,
    { sourcePath: SOURCE, claims },
    {
      agent: "claude",
      now: opts.now ?? NOW,
      ...(opts.strictQuotes !== undefined ? { strictQuotes: opts.strictQuotes } : {}),
    },
  );
}

function page(res: DistillSourceResult): string {
  return readFileSync(join(vault, res.distillationPath), "utf8");
}

function meta(res: DistillSourceResult): Record<string, unknown> {
  return parseFrontmatter(join(vault, res.distillationPath))[0];
}

describe("distillSource - quote check", () => {
  test("a block-cited verbatim quote keeps its marks and is counted as verified", () => {
    const res = distill([VERBATIM, { text: "No quote here." }]);
    expect(page(res)).toContain(
      "- It “reuses staked capital” for more. ([[Articles/restaking.md#^abc]])",
    );
    expect(page(res)).toContain(`${QUOTES_VERIFIED_KEY}: 1\n`);
    expect(page(res)).toContain(`${QUOTES_UNQUOTED_KEY}: 0\n`);
    expect(res.quotes?.verified_in_block).toBe(1);
    expect(res.quotes?.unquoted).toBe(0);
  });

  test("a paraphrase in quotation marks is written without the marks and named", () => {
    const res = distill([PARAPHRASE]);
    const md = page(res);
    expect(md).toContain("- It recycles staked capital for more. ([[Articles/restaking.md#^abc]])");
    expect(md).not.toContain("“recycles");
    expect(page(res)).toContain(`${QUOTES_VERIFIED_KEY}: 0\n`);
    expect(page(res)).toContain(`${QUOTES_UNQUOTED_KEY}: 1\n`);
    expect(res.quotes?.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.notInBlock, span: "recycles staked capital" },
    ]);
  });

  test("strictQuotes refuses a paraphrase with QuoteCheckError and writes nothing", () => {
    const dir = join(vault, BRAIN_DISTILLATIONS_REL);
    const dirBefore = existsSync(dir);
    let thrown: unknown;
    try {
      distill([PARAPHRASE], { strictQuotes: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuoteCheckError);
    expect((thrown as QuoteCheckError).code).toBe(QUOTE_UNVERIFIED_CODE);
    expect((thrown as Error).message).toContain("claim 0: not-in-block");
    expect(existsSync(dir)).toBe(dirBefore);
    if (dirBefore) expect(readdirSync(dir)).toEqual([]);
  });

  test("strictQuotes lets a fully verified page through", () => {
    const res = distill([VERBATIM], { strictQuotes: true });
    expect(res.quotes?.verified_in_block).toBe(1);
  });

  test("re-running the same input is inert, unquoted page included", () => {
    const first = distill([PARAPHRASE]);
    const before = page(first);
    expect(before).toContain("- It recycles staked capital for more.");
    const second = distill([PARAPHRASE], { now: LATER });
    expect(second.quotes?.unquoted).toBe(1);
    expect(second.created).toBe(false);
    expect(page(second)).toBe(before);
  });

  test("a page with no quoted spans carries no quote keys and no quotes result", () => {
    const res = distill([{ text: "Plain claim.", block: "abc" }]);
    expect(res.quotes).toBeUndefined();
    expect(meta(res)[QUOTES_VERIFIED_KEY]).toBeUndefined();
    expect(meta(res)[QUOTES_UNQUOTED_KEY]).toBeUndefined();
  });

  test("the verdict follows the bytes whose digest is on the page", () => {
    const first = distill([VERBATIM]);
    expect(first.quotes?.verified_in_block).toBe(1);

    writeFileSync(join(vault, SOURCE), "# Restaking\n\nSomething else entirely. ^abc\n", "utf8");
    const second = distill([VERBATIM], { now: LATER });
    expect(second.quotes?.unquoted).toBe(1);
    expect(second.sourceHash).toBe(hashFile(join(vault, SOURCE)));
    expect(meta(second)["source_hash"]).toBe(second.sourceHash);
    expect(page(second)).toContain("- It reuses staked capital for more.");
  });

  test("a source that is not valid UTF-8 gives every span source-not-text", () => {
    writeFileSync(join(vault, SOURCE), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const res = distill([VERBATIM]);
    expect(res.quotes?.findings.map((f) => f.outcome)).toEqual([QUOTE_CHECK_OUTCOME.sourceNotText]);
  });
});
