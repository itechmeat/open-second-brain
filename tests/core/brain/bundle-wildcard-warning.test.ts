/**
 * The bundle import's wildcard-allowlist warning (PR #244 review L2).
 *
 * A bundle entry's exec allowlist is authenticated metadata - the AAD
 * binds it exactly as exported, so tampering refuses - but what the AAD
 * proves is fidelity, not wisdom: an entry exported with the open
 * allowlist `*` lets `secret run` execute ANY command, and importing
 * such a bundle used to be silent. The import now names every imported
 * or replaced entry whose allowlist is the open one, on the same stderr
 * stream the verb's other warnings use, and changes nothing else: a
 * non-wildcard bundle imports byte-identically and says nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCredential } from "../../helpers/fake-credentials.ts";
import { runCli } from "../../helpers/run-cli.ts";

let tmp: string;
let vault: string;
const BUNDLE_PASSPHRASE = fakeCredential("bundle", "-pass-", "91");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bundle-wildcard-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function setSecret(name: string, allow: string[]): Promise<void> {
  const args = ["brain", "secret", "set", name, "--vault", vault];
  for (const pattern of allow) args.push("--allow", pattern);
  const set = await runCli(args, { stdin: "sk-wildcard-fixture-1357\n" });
  expect(set.returncode).toBe(0);
}

async function exportBundle(out: string): Promise<void> {
  const exported = await runCli(["brain", "secret", "export", "--out", out, "--vault", vault], {
    stdin: `${BUNDLE_PASSPHRASE}\n`,
  });
  expect(exported.returncode).toBe(0);
}

async function importBundle(from: string): Promise<{ returncode: number; stderr: string }> {
  const imported = await runCli(["brain", "secret", "import", from, "--vault", vault], {
    stdin: `${BUNDLE_PASSPHRASE}\n`,
  });
  return { returncode: imported.returncode, stderr: imported.stderr };
}

describe("the bundle import wildcard-allowlist warning", () => {
  test("importing a bundle with an open allowlist names the entry", async () => {
    await setSecret("open-entry", ["*"]);
    await setSecret("narrow-entry", ["bun -e *"]);
    const bundle = join(tmp, "wildcard-bundle.json");
    await exportBundle(bundle);
    // Remove the store so the import RESTORES the entries rather than
    // merging into them; the warning is about what the bundle carries.
    await runCli(["brain", "secret", "rm", "open-entry", "--vault", vault], { stdin: "" });
    await runCli(["brain", "secret", "rm", "narrow-entry", "--vault", vault], { stdin: "" });

    const result = await importBundle(bundle);
    expect(result.returncode).toBe(0);
    expect(result.stderr).toContain("warning");
    expect(result.stderr).toContain('"open-entry"');
    expect(result.stderr).not.toContain('"narrow-entry"');
  });

  test("a non-wildcard bundle imports silently and works", async () => {
    await setSecret("narrow-entry", ["bun -e *"]);
    const bundle = join(tmp, "narrow-bundle.json");
    await exportBundle(bundle);
    await runCli(["brain", "secret", "rm", "narrow-entry", "--vault", vault], { stdin: "" });

    const result = await importBundle(bundle);
    expect(result.returncode).toBe(0);
    expect(result.stderr).not.toContain("allowlist");
    const list = await runCli(["brain", "secret", "list", "--vault", vault]);
    expect(list.returncode).toBe(0);
    expect(list.stdout).toContain("narrow-entry");
  });

  test("an edited (widened) bundle still refuses on its AAD, warning or not", async () => {
    await setSecret("narrow-entry", ["bun -e *"]);
    const bundle = join(tmp, "tampered-bundle.json");
    await exportBundle(bundle);
    // Widen the allowlist in the bundle's metadata tree: the AAD binds
    // the exported bytes exactly, so the import must refuse by name.
    const parsed = JSON.parse(readFileSync(bundle, "utf8")) as {
      entries: Record<string, { allow: string[] }>;
    };
    parsed.entries["narrow-entry"]!.allow = ["*"];
    writeFileSync(bundle, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const result = await importBundle(bundle);
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("refus");
  });
}, 20000);
