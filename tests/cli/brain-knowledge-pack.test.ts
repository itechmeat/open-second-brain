/**
 * CLI surface of `o2b brain knowledge-pack`: the export verb redacts BEFORE
 * sealing (so a recipient verifies the redacted bytes), names what it
 * blocked, and the preview / install / list / uninstall loop works across
 * two vaults with the exit codes an operator scripts against. Core
 * behaviour is covered in `tests/core/brain/portability/knowledge-pack.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

/** A GitHub personal-access-token shape the pack must never carry. */
const GITHUB_PAT = fakeCredential("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789");

let tmp: string;
let src: string;
let dest: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-kpack-cli-"));
  src = join(tmp, "src");
  dest = join(tmp, "dest");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function o2b(args: ReadonlyArray<string>) {
  return runCli([...args], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
}

async function bootstrap(): Promise<void> {
  expect((await o2b(["init", "--vault", src, "--name", "T"])).returncode).toBe(0);
  expect((await o2b(["brain", "init", "--vault", src])).returncode).toBe(0);
  expect((await o2b(["brain", "init", "--vault", dest])).returncode).toBe(0);
}

describe("o2b brain knowledge-pack", () => {
  test("export redacts before sealing; preview, install, list, uninstall round-trip", async () => {
    await bootstrap();
    mkdirSync(join(src, "Runbooks"), { recursive: true });
    writeFileSync(
      join(src, "Runbooks", "deploy.md"),
      `---\ntags: [ops]\n---\nDeploy with token: ${GITHUB_PAT} set.\n`,
    );
    writeFileSync(
      join(src, "Runbooks", "incident.md"),
      "---\ntags: [ops]\nvisibility: private\n---\nPrivate incident log.\n",
    );
    const packDir = join(tmp, "pack");

    const exp = await o2b([
      "brain",
      "knowledge-pack",
      "export",
      "--vault",
      src,
      "--name",
      "ops",
      "--select",
      "tag:ops",
      "--out",
      packDir,
      "--json",
    ]);
    expect(exp.returncode).toBe(0);
    const exported = JSON.parse(exp.stdout);
    expect(exported.pages).toBe(1);
    expect(exported.blocked).toEqual([
      { kind: "page", id: "Runbooks/incident.md", reason: "visibility" },
    ]);
    expect(exported.redacted).toBe(true);
    const carried = readFileSync(join(packDir, "concepts", "deploy.md"), "utf8");
    expect(carried).not.toContain(GITHUB_PAT);
    expect(existsSync(join(packDir, "concepts", "incident.md"))).toBe(false);

    const preview = await o2b([
      "brain",
      "knowledge-pack",
      "preview",
      packDir,
      "--vault",
      dest,
      "--json",
    ]);
    expect(preview.returncode).toBe(0);
    const shown = JSON.parse(preview.stdout);
    expect(shown.integrity.verified).toBe(true);
    expect(shown.count).toBe(1);

    const install = await o2b(["brain", "knowledge-pack", "install", packDir, "--vault", dest]);
    expect(install.returncode).toBe(0);
    expect(existsSync(join(dest, "OKF Review", "Runbooks", "deploy.md"))).toBe(true);

    const list = await o2b(["brain", "knowledge-pack", "list", "--vault", dest, "--json"]);
    expect(JSON.parse(list.stdout).packs.map((p: { name: string }) => p.name)).toEqual(["ops"]);

    const dry = await o2b(["brain", "knowledge-pack", "uninstall", "ops", "--vault", dest]);
    expect(dry.returncode).toBe(0);
    expect(dry.stdout).toContain("DRY RUN");
    expect(existsSync(join(dest, "OKF Review", "Runbooks", "deploy.md"))).toBe(true);

    const confirmed = await o2b([
      "brain",
      "knowledge-pack",
      "uninstall",
      "ops",
      "--vault",
      dest,
      "--confirm",
    ]);
    expect(confirmed.returncode).toBe(0);
    expect(existsSync(join(dest, "OKF Review", "Runbooks", "deploy.md"))).toBe(false);
  });

  test("preview exits 1 and install refuses when the pack was modified", async () => {
    await bootstrap();
    writeFileSync(join(src, "Guide.md"), "---\ntags: [guide]\n---\nWrite tests first.\n");
    const packDir = join(tmp, "pack");
    const exp = await o2b([
      "brain",
      "knowledge-pack",
      "export",
      "--vault",
      src,
      "--name",
      "guide",
      "--select",
      "Guide",
      "--out",
      packDir,
    ]);
    expect(exp.returncode).toBe(0);
    writeFileSync(join(packDir, "concepts", "Guide.md"), "---\n---\nSkip the tests.\n");

    const preview = await o2b(["brain", "knowledge-pack", "preview", packDir, "--vault", dest]);
    expect(preview.returncode).toBe(1);
    expect(preview.stdout).toContain("FAILED");
    const install = await o2b(["brain", "knowledge-pack", "install", packDir, "--vault", dest]);
    expect(install.returncode).toBe(1);
    expect(install.stderr).toContain("integrity check failed");
    expect(existsSync(join(dest, "OKF Review"))).toBe(false);
  });
});
