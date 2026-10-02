/**
 * MCP integration test for `brain_distill_source` (t_2e2e959f). The agent
 * supplies atomic claims with optional block ids; OSB writes an idempotent
 * distillation page. Handler exercised directly with a minimal context.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { hashFile } from "../../src/core/brain/ingest/content-manifest.ts";
import {
  INTAKE_TRUST,
  SOURCE_CONTENT_HASH_FRONTMATTER_KEY,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
} from "../../src/core/brain/trust/untrusted-provenance.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";
import {
  CAPTURE_EXCERPT_MAX_BYTES,
  CAPTURE_SCOPE,
} from "../../src/core/brain/provenance/capture-scope.ts";
import { DISTILL_CLAIMS_MAX } from "../../src/core/brain/distill/distill-source.ts";
import { QUOTE_CHECK_OUTCOME } from "../../src/core/brain/distill/quote-verdict.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { PROPERTY_DESCRIPTION_MAX, TOOL_DESCRIPTION_MAX } from "../../src/mcp/registry-guard.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-distill-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "src.md"), "# Src\n\nBody.\n", "utf8");
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = DISTILL_TOOLS[0]!.handler;

describe("brain_distill_source", () => {
  test("writes a distillation page and returns its path", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "An atomic claim.", block: "^abc" }, { text: "Another claim." }],
    })) as { distillation_path: string; claim_count: number };
    expect(res.claim_count).toBe(2);
    const md = readFileSync(join(vault, res.distillation_path), "utf8");
    expect(md).toContain("kind: brain-distillation");
    expect(md).toContain("([[Articles/src.md#^abc]])");
  });

  test("a non-empty claims array is required", async () => {
    await expect(handler(ctx, { source_path: "Articles/src.md", claims: [] })).rejects.toThrow(
      MCPError,
    );
  });

  test("missing source_path is rejected", async () => {
    await expect(handler(ctx, { claims: [{ text: "x" }] })).rejects.toThrow(MCPError);
  });
});

/**
 * The lane reaches the caller (wiring-what-exists, A1). Before this unit the
 * tool wrote every distillation under `provenance: stated` and returned a
 * `source_hash` of the literal string `missing` for a source with no bytes, so
 * a caller had no way to learn that what it just wrote is quarantined from
 * ordinary reads.
 */
describe("brain_distill_source - the response names the lane it committed in", () => {
  test("a source with a real file behind it is trusted and carries its digest", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "A claim." }],
    })) as { trust: string; source_hash?: string };
    expect(res.trust).toBe(INTAKE_TRUST.trusted);
    expect(res.source_hash).toBe(hashFile(join(vault, "Articles", "src.md")));
  });

  test("a source that names no file is untrusted and reports no digest at all", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/absent.md",
      claims: [{ text: "A claim." }],
    })) as { trust: string; source_hash?: string };
    expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    expect(res.source_hash).toBeUndefined();
  });

  test("the description states the guarantee, as the intake tool's does", () => {
    // A caller choosing between tools reads the description, not this test;
    // pinning it keeps the promise and the behaviour from drifting apart.
    expect(DISTILL_TOOLS[0]!.description).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
  });
});

/** A source whose one paragraph carries the block id `^p1`. */
function seedQuotedSource(): void {
  writeFileSync(
    join(vault, "Articles", "quoted.md"),
    "# Quoted\n\nThe protocol settles every batch within one minute. ^p1\n",
    "utf8",
  );
}

/**
 * The quote check and the capture scope reach the MCP caller (distilled
 * provenance, D1). The core decides; this surface declares the two new
 * inputs, forwards them, and serialises the two new result members under
 * their snake_case names.
 */
describe("brain_distill_source - quote check and capture scope", () => {
  const VERBATIM = 'The author writes "settles every batch within one minute".';
  const PARAPHRASE = 'The author writes "settles all batches quickly".';
  const QUOTE_REPORT_KEYS = [
    "checked",
    "verified_in_block",
    "verified_in_source",
    "unquoted",
    "unpaired",
    "findings",
    "total",
    "returned",
    "truncated",
  ];

  test("the two inputs are declared within the registry caps", () => {
    const tool = DISTILL_TOOLS[0]!;
    const props = tool.inputSchema["properties"] as Record<
      string,
      { type: string; description: string; maxLength?: number }
    >;
    expect(props["strict_quotes"]?.type).toBe("boolean");
    expect(props["excerpt"]?.type).toBe("string");
    expect(props["excerpt"]?.maxLength).toBe(CAPTURE_EXCERPT_MAX_BYTES);
    expect(props["claims"]?.description).toContain(String(DISTILL_CLAIMS_MAX));
    for (const name of ["strict_quotes", "excerpt"]) {
      expect(props[name]!.description.length).toBeLessThanOrEqual(PROPERTY_DESCRIPTION_MAX);
    }
    expect(tool.description.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX);
    expect(tool.description).toContain("search_trust_gate_enabled");
  });

  test("capture_scope is always present and quotes only when a claim holds a span", async () => {
    const res = (await handler(ctx, {
      source_path: "Articles/src.md",
      claims: [{ text: "A claim without quotation marks." }],
    })) as Record<string, unknown>;
    expect(res["capture_scope"]).toBe(CAPTURE_SCOPE.fullLocal);
    expect("quotes" in res).toBe(false);
  });

  test("a checked quote is reported under the contract keys verbatim", async () => {
    seedQuotedSource();
    const res = (await handler(ctx, {
      source_path: "Articles/quoted.md",
      claims: [
        { text: VERBATIM, block: "p1" },
        { text: PARAPHRASE, block: "p1" },
      ],
    })) as { quotes: Record<string, unknown>; distillation_path: string };
    expect(Object.keys(res.quotes).toSorted()).toEqual(QUOTE_REPORT_KEYS.toSorted());
    expect(res.quotes["verified_in_block"]).toBe(1);
    expect(res.quotes["unquoted"]).toBe(1);
    expect(res.quotes["findings"]).toEqual([
      {
        claim: 1,
        outcome: QUOTE_CHECK_OUTCOME.notInBlock,
        span: "settles all batches quickly",
      },
    ]);
  });

  test("a url-only source with an excerpt is bounded-local", async () => {
    const res = (await handler(ctx, {
      source_path: "https://example.test/post",
      claims: [{ text: "A claim." }],
      excerpt: "The protocol settles every batch within one minute.",
    })) as Record<string, unknown>;
    expect(res["capture_scope"]).toBe(CAPTURE_SCOPE.boundedLocal);
  });

  test("an excerpt for a source the vault holds is refused as invalid_params", async () => {
    let caught: unknown;
    try {
      await handler(ctx, {
        source_path: "Articles/src.md",
        claims: [{ text: "A claim." }],
        excerpt: "Body.",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).code).toBe(INVALID_PARAMS);
    expect((caught as MCPError).message).toStartWith("brain_distill_source: ");
    expect((caught as MCPError).message).toContain(CAPTURE_SCOPE.fullLocal);
  });

  test("a blank excerpt is refused by name, never dropped as absent", async () => {
    await expect(
      handler(ctx, {
        source_path: "https://example.test/post",
        claims: [{ text: "A claim." }],
        excerpt: "   ",
      }),
    ).rejects.toThrow("excerpt refused: the excerpt is empty");
  });
});

/**
 * A page the caller cannot read at its reach answers the quote check exactly
 * as a source with no local bytes does: every span settles `url-only` and no
 * digest is returned or recorded, so the check never tells a caller whether
 * a guessed phrase occurs in a page it may not read.
 */
describe("brain_distill_source - a page withheld at the caller's reach checks nothing", () => {
  const PRIVATE_PATH = "Notes/secret.md";
  const GUESS_RIGHT = "“The code is ZX8”";
  const GUESS_WRONG = "“The code is ZX9”";

  beforeEach(() => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, PRIVATE_PATH),
      "---\nvisibility: private\n---\nThe code is ZX8 today. ^p1\n",
      "utf8",
    );
  });

  const claims = [{ text: GUESS_RIGHT }, { text: GUESS_WRONG, block: "p1" }];

  test("by default every span is url-only and no digest is returned or written", async () => {
    const res = (await handler(ctx, { source_path: PRIVATE_PATH, claims })) as Record<
      string,
      unknown
    > & {
      quotes: { findings: Array<{ outcome: string }>; verified_in_block: number };
      distillation_path: string;
    };
    expect(res.quotes.findings.map((f) => f.outcome)).toEqual([
      QUOTE_CHECK_OUTCOME.urlOnly,
      QUOTE_CHECK_OUTCOME.urlOnly,
    ]);
    expect("source_hash" in res).toBe(false);
    const md = readFileSync(join(vault, res.distillation_path), "utf8");
    expect(md).not.toContain("source_hash");
    expect(md).not.toContain(SOURCE_CONTENT_HASH_FRONTMATTER_KEY);
  });

  test("strict mode refuses every guess alike, naming url-only only", async () => {
    let caught: unknown;
    try {
      await handler(ctx, { source_path: PRIVATE_PATH, claims, strict_quotes: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    const message = (caught as MCPError).message;
    expect(message).toContain(`claim 0: ${QUOTE_CHECK_OUTCOME.urlOnly}`);
    expect(message).toContain(`claim 1: ${QUOTE_CHECK_OUTCOME.urlOnly}`);
    for (const outcome of Object.values(QUOTE_CHECK_OUTCOME)) {
      if (outcome !== QUOTE_CHECK_OUTCOME.urlOnly) expect(message).not.toContain(outcome);
    }
  });

  test("the lane, scope and page match an absent source, and an excerpt is admitted", async () => {
    const ABSENT = "Notes/absent.md";
    const shape = (res: Record<string, unknown>) => ({
      trust: res["trust"],
      capture_scope: res["capture_scope"],
    });
    const hiddenRes = (await handler(ctx, { source_path: PRIVATE_PATH, claims })) as Record<
      string,
      unknown
    > & { distillation_path: string };
    const absentRes = (await handler(ctx, { source_path: ABSENT, claims })) as Record<
      string,
      unknown
    >;
    expect(shape(hiddenRes)).toEqual(shape(absentRes));
    expect(hiddenRes["trust"]).toBe(INTAKE_TRUST.untrusted);
    expect(hiddenRes["capture_scope"]).toBe(CAPTURE_SCOPE.urlOnly);
    const md = readFileSync(join(vault, hiddenRes.distillation_path), "utf8");
    expect(md).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);

    const withExcerpt = (await handler(ctx, {
      source_path: PRIVATE_PATH,
      claims,
      excerpt: "The code is ZX9 today.",
    })) as Record<string, unknown>;
    expect(withExcerpt["capture_scope"]).toBe(CAPTURE_SCOPE.boundedLocal);
  });

  test("at local reach the same page is checked", async () => {
    const res = (await handler(
      { ...ctx, reach: TRANSPORT_REACH.local },
      { source_path: PRIVATE_PATH, claims },
    )) as { quotes: { verified_in_source: number; findings: Array<{ outcome: string }> } };
    expect(res.quotes.verified_in_source).toBe(1);
    expect(res.quotes.findings.map((f) => f.outcome)).toEqual([QUOTE_CHECK_OUTCOME.notInBlock]);
  });
});
