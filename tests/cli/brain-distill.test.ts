/**
 * `o2b brain distill` CLI (t_2e2e959f): condense a source into atomic claims
 * with block-level provenance, supplied as JSON.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
