/**
 * `o2b brain distill` CLI (t_2e2e959f): condense a source into atomic claims
 * with block-level provenance, supplied as JSON.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nestedCommand } from "../../src/cli/command-manifest.ts";
import { readExcerptSection } from "../../src/core/brain/provenance/capture-scope.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../src/core/brain/path-constants.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-distill-"));
  vault = join(tmp, "vault");
  const config = join(tmp, "config.yaml");
  env = { OPEN_SECOND_BRAIN_CONFIG: config };
  await runCli(["init", "--vault", vault, "--name", "Test"], { env });
  await runCli(["brain", "init", "--vault", vault], { env });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "src.md"), "# Src\n\nBody.\n", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("distills a source into a citeable claims page", async () => {
  const claims = JSON.stringify([
    { text: "First atomic claim.", block: "abc" },
    { text: "Second atomic claim." },
  ]);
  const res = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", claims, "--vault", vault, "--json"],
    { env },
  );
  expect(res.returncode).toBe(0);
  const out = JSON.parse(res.stdout) as { distillation_path: string; claim_count: number };
  expect(out.claim_count).toBe(2);
  const md = readFileSync(join(vault, out.distillation_path), "utf8");
  expect(md).toContain("## Claims");
  expect(md).toContain("([[Articles/src.md#^abc]])");
  expect(existsSync(join(vault, out.distillation_path))).toBe(true);
});

test("an empty claim list is rejected (validation error, exit 1)", async () => {
  const res = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", "[]", "--vault", vault],
    { env },
  );
  expect(res.returncode).toBe(1);
});

const CLAIMS_SHAPE_HINT = "claims must be a JSON array of { text, block? } objects";

/** One `--claims` run; `runCli` swaps process env, so runs stay sequential. */
async function distillWithClaims(claims: string) {
  return runCli(["brain", "distill", "Articles/src.md", "--claims", claims, "--vault", vault], {
    env,
  });
}

test("a claims payload that is not a list names the shape the CLI accepts", async () => {
  // The operator's mistake is the WRAPPER, not an item, so the error has to
  // name the accepted payload rather than report a path inside one.
  const wrapperHoldsNoList = await distillWithClaims('{"claims": 3}');
  expect(wrapperHoldsNoList.returncode).toBe(1);
  expect(wrapperHoldsNoList.stderr).toContain(CLAIMS_SHAPE_HINT);

  const wrapperNamesAnotherKey = await distillWithClaims('{"notes": []}');
  expect(wrapperNamesAnotherKey.returncode).toBe(1);
  expect(wrapperNamesAnotherKey.stderr).toContain(CLAIMS_SHAPE_HINT);

  const notAWrapperAtAll = await distillWithClaims('"a claim"');
  expect(notAWrapperAtAll.returncode).toBe(1);
  expect(notAWrapperAtAll.stderr).toContain(CLAIMS_SHAPE_HINT);
});

test("a malformed claim item still reports its path", async () => {
  const res = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", '[{"text": 3}]', "--vault", vault],
    { env },
  );
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("$[0].text");
});

/**
 * The CLI is the SECOND entry point into `distillSource` (wiring-what-exists,
 * A1). A trust guard placed in the MCP handler alone would leave this verb
 * writing under the top authority tier for a source nothing in the vault owns,
 * which is why the classification lives in the core and both surfaces report it.
 */
test("the lane reaches the operator on both surfaces", async () => {
  const claims = JSON.stringify([{ text: "An atomic claim." }]);

  const trusted = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", claims, "--vault", vault, "--json"],
    { env },
  );
  expect(trusted.returncode).toBe(0);
  const trustedOut = JSON.parse(trusted.stdout) as { trust: string; source_hash?: string };
  expect(trustedOut.trust).toBe("trusted");
  expect(typeof trustedOut.source_hash).toBe("string");

  const untrusted = await runCli(
    ["brain", "distill", "Articles/absent.md", "--claims", claims, "--vault", vault, "--json"],
    { env },
  );
  expect(untrusted.returncode).toBe(0);
  const untrustedOut = JSON.parse(untrusted.stdout) as { trust: string; source_hash?: string };
  expect(untrustedOut.trust).toBe("untrusted");
  expect(untrustedOut.source_hash).toBeUndefined();

  // The human line says so too: an operator who never passes --json would
  // otherwise read the same success sentence for both lanes.
  const human = await runCli(
    ["brain", "distill", "Articles/absent.md", "--claims", claims, "--vault", vault],
    { env },
  );
  expect(human.returncode).toBe(0);
  expect(human.stdout).toContain("untrusted_source");
});

test("missing <source> or --claims is a usage error (exit 2)", async () => {
  const noSource = await runCli(["brain", "distill", "--claims", "[]", "--vault", vault], { env });
  expect(noSource.returncode).toBe(2);
  const noClaims = await runCli(["brain", "distill", "Articles/src.md", "--vault", vault], { env });
  expect(noClaims.returncode).toBe(2);
});

const QUOTED_SOURCE = "Articles/quoted.md";

/** A source whose one paragraph carries the block id `^p1`. */
function seedQuotedSource(): void {
  writeFileSync(
    join(vault, QUOTED_SOURCE),
    "# Quoted\n\nThe protocol settles every batch within one minute. ^p1\n",
    "utf8",
  );
}

/** Distillation pages on disk; the directory may not exist yet. */
function distillationPages(): string[] {
  const dir = join(vault, BRAIN_DISTILLATIONS_REL);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
}

/**
 * The quote check and the capture scope reach the operator (distilled
 * provenance, D2): two flags in, two suffixes and two `--json` members out.
 */
describe("o2b brain distill - quote check and capture scope", () => {
  const VERBATIM = {
    text: 'The author writes "settles every batch within one minute".',
    block: "p1",
  };
  const PARAPHRASE = { text: 'The author writes "settles all batches quickly".', block: "p1" };

  test("--strict-quotes refuses a paraphrase in quotation marks and writes nothing", async () => {
    seedQuotedSource();
    const res = await runCli(
      [
        "brain",
        "distill",
        QUOTED_SOURCE,
        "--claims",
        JSON.stringify([PARAPHRASE]),
        "--strict-quotes",
        "--vault",
        vault,
      ],
      { env },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain(
      "distill: quoted spans failed verification: claim 0: not-in-block",
    );
    expect(distillationPages()).toEqual([]);
  });

  test("--excerpt-file stores a bounded-local page for a url source", async () => {
    const excerptPath = join(tmp, "excerpt.txt");
    writeFileSync(excerptPath, "The protocol settles every batch within one minute.\n", "utf8");
    const res = await runCli(
      [
        "brain",
        "distill",
        "https://example.test/post",
        "--claims",
        JSON.stringify([{ text: "A claim." }]),
        "--excerpt-file",
        excerptPath,
        "--vault",
        vault,
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout.trimEnd()).toEndWith(" [untrusted_source] [bounded-local]");
    const [page] = distillationPages();
    const md = readFileSync(join(vault, BRAIN_DISTILLATIONS_REL, page!), "utf8");
    expect(md).toContain("capture_scope: bounded-local");
    expect(readExcerptSection(md)).toBe(readFileSync(excerptPath, "utf8"));
  });

  test("an --excerpt-file that is not valid UTF-8 is refused before any write", async () => {
    // Decoding leniently would store U+FFFD in place of the file's bytes,
    // and the stored excerpt would no longer be the captured text.
    const excerptPath = join(tmp, "latin1.txt");
    writeFileSync(excerptPath, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const res = await runCli(
      [
        "brain",
        "distill",
        "https://example.test/post",
        "--claims",
        JSON.stringify([{ text: "A claim." }]),
        "--excerpt-file",
        excerptPath,
        "--vault",
        vault,
      ],
      { env },
    );
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("distill: excerpt file is not valid UTF-8");
    expect(distillationPages()).toEqual([]);
  });

  test("a checked quote adds the quotes suffix to the human line", async () => {
    seedQuotedSource();
    const res = await runCli(
      ["brain", "distill", QUOTED_SOURCE, "--claims", JSON.stringify([VERBATIM]), "--vault", vault],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout.trimEnd()).toEndWith(" [quotes verified:1 unquoted:0]");
  });

  test("--json carries capture_scope and quotes", async () => {
    seedQuotedSource();
    const res = await runCli(
      [
        "brain",
        "distill",
        QUOTED_SOURCE,
        "--claims",
        JSON.stringify([VERBATIM, PARAPHRASE]),
        "--vault",
        vault,
        "--json",
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      capture_scope: string;
      quotes: { verified_in_block: number; unquoted: number; findings: unknown[] };
    };
    expect(out.capture_scope).toBe("full-local");
    expect(out.quotes.verified_in_block).toBe(1);
    expect(out.quotes.unquoted).toBe(1);
    expect(out.quotes.findings).toHaveLength(1);
  });

  test("a clean trusted run keeps its human line exactly", async () => {
    const res = await runCli(
      [
        "brain",
        "distill",
        "Articles/src.md",
        "--claims",
        JSON.stringify([{ text: "A claim." }]),
        "--vault",
        vault,
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout.trimEnd()).toMatch(/^distilled 1 claim\(s\) -> \S+\.md$/);
  });

  test("the manifest entry lists the two new flags", () => {
    const names = (nestedCommand("brain", "distill")?.flags ?? []).map((f) => f.name);
    expect(names).toContain("strict-quotes");
    expect(names).toContain("excerpt-file");
  });
});
