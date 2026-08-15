/**
 * What the distillation quarantine is actually worth on a default install.
 *
 * ## The defect
 *
 * `brain_distill_source`'s shipped description asserted, unconditionally:
 * "The page is marked `untrusted_source` and excluded from ordinary reads
 * unless `source_path` names a file that exists." The CLI verb said the
 * same in its own words - "one of which no ordinary read will ever
 * return".
 *
 * Both are false by default. The exclusion is performed by
 * `trustGateAdjuster`, which `post-rank.ts` mounts only when
 * `config.recall.retrievalTrustGateEnabled` is set, and that flag's
 * fallback is `false`. The marker is written correctly and
 * `classifyRetrievalTrust` reads it correctly; the gate is simply not
 * mounted unless the operator opts in. On a default install the untrusted
 * distillation ranks beside the operator's own notes.
 *
 * The asymmetry that makes this sharp: entity intake quarantines through
 * `status: quarantine` plus the entity page-status scope, which is NOT
 * flag-gated, so its guarantee holds by default. A distillation page has
 * only the flag-gated retrieval trust gate, so the same words mean less.
 *
 * These tests pin all three facts at once: the default resolves the gate
 * off, an ordinary search DOES return the untrusted page with that
 * default, and the same search stops returning it once the setting is on.
 * The description is then required to name that setting - so if the
 * default is ever flipped to true, the last test fails and the wording
 * gets revisited rather than silently becoming understated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { UNTRUSTED_SOURCE_FRONTMATTER_KEY } from "../../src/core/brain/trust/untrusted-provenance.ts";

/** The config key an operator sets to mount the retrieval trust gate. */
const TRUST_GATE_CONFIG_KEY = "search_trust_gate_enabled";
/** A term that appears only in the distilled claim. */
const CLAIM_TERM = "zorbulan";
/** Not a file in this vault, so intake classifies the source as untrusted. */
const UNTRUSTED_SOURCE = "https://example.com/whitepaper";

let tmp: string;
let vault: string;
let configPath: string;

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-distill-trust-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface QueryJson {
  readonly results: ReadonlyArray<{ readonly path: string }>;
}

async function seedDistillation(configBody: string): Promise<string> {
  expect(
    (await runCli(["init", "--vault", vault, "--name", "Trust"], { env: env() })).returncode,
  ).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], { env: env() })).returncode).toBe(0);
  writeFileSync(configPath, `vault: ${vault}\n${configBody}`);

  const distilled = await runCli(
    [
      "brain",
      "distill",
      UNTRUSTED_SOURCE,
      "--claims",
      JSON.stringify([{ text: `the ${CLAIM_TERM} process runs weekly` }]),
      "--vault",
      vault,
      "--json",
    ],
    { env: env() },
  );
  expect(distilled.returncode).toBe(0);
  const res = JSON.parse(distilled.stdout) as { distillation_path: string; trust: string };
  expect(res.trust).toBe("untrusted");

  const indexed = await runCli(["search", "index"], { env: env() });
  expect(indexed.returncode).toBe(0);
  return res.distillation_path;
}

async function queryPaths(): Promise<string[]> {
  const r = await runCli(["search", "query", CLAIM_TERM, "--json", "--limit", "20"], {
    env: env(),
  });
  expect(r.returncode).toBe(0);
  return (JSON.parse(r.stdout) as QueryJson).results.map((x) => x.path);
}

describe("the quarantine is real, and it is opt-in", () => {
  test("the resolved default leaves the retrieval trust gate off", () => {
    expect(resolveSearchConfig({ vault: tmp }).recall.retrievalTrustGateEnabled).toBe(false);
  });

  test("with the default, an ordinary search DOES return the untrusted page", async () => {
    const path = await seedDistillation("");
    const paths = await queryPaths();
    expect(paths.some((p) => p.endsWith(path) || path.endsWith(p))).toBe(true);
  });

  test("with the gate enabled, the same search stops returning it", async () => {
    const path = await seedDistillation(`${TRUST_GATE_CONFIG_KEY}: true\n`);
    const paths = await queryPaths();
    expect(paths.some((p) => p.endsWith(path) || path.endsWith(p))).toBe(false);
  });
});

describe("no surface claims more than that", () => {
  const description = DISTILL_TOOLS[0]!.description;

  test("the tool description names the setting the guarantee depends on", () => {
    // Coupled to the resolved default deliberately: a release that turns
    // the gate on by default fails here and revisits the wording, rather
    // than shipping a description that has quietly become understated.
    expect(resolveSearchConfig({ vault: tmp }).recall.retrievalTrustGateEnabled).toBe(false);
    expect(description).toContain(TRUST_GATE_CONFIG_KEY);
    expect(description).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
  });

  test("it does not claim an unconditional exclusion", () => {
    expect(description).not.toContain("excluded from ordinary reads unless");
  });
});
