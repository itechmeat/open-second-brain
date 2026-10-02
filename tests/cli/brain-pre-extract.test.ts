/**
 * The `o2b brain pre-extract` CLI runs the deterministic
 * no-LLM code-structure pass over one source file and prints its JSON seeds.
 * The extraction itself is covered at the core level; this asserts the verb is
 * wired, emits deterministic JSON, and reports unknown languages as unextracted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CLI_COMMAND_MANIFEST, type CliCommandManifest } from "../../src/cli/command-manifest.ts";
import { runCli } from "../helpers/run-cli.ts";

/** The manifest entry of `o2b brain pre-extract`. */
function preExtractManifest(): CliCommandManifest {
  const brain = CLI_COMMAND_MANIFEST.commands.find((c) => c.name === "brain");
  const verb = brain?.commands?.find((c) => c.name === "pre-extract");
  if (verb === undefined) throw new Error("brain pre-extract is missing from the CLI manifest");
  return verb;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "o2b-pre-extract-cli-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("o2b brain pre-extract", () => {
  test("emits deterministic JSON seeds for a code source", async () => {
    const file = join(work, "widget.ts");
    writeFileSync(
      file,
      'import { h } from "./dom";\nexport class Widget extends Base {}\n',
      "utf8",
    );
    const res = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.extracted).toBe(true);
    expect(out.language).toBe("typescript");
    expect(out.entities).toEqual([{ kind: "class", name: "Widget" }]);
    expect(out.edges).toEqual([
      { kind: "imports", from: file, to: "./dom" },
      { kind: "inherits", from: "Widget", to: "Base" },
    ]);
  });

  test("emits Terraform seeds for a .tf source", async () => {
    const file = join(work, "main.tf");
    writeFileSync(
      file,
      [
        'variable "region" {}',
        'resource "aws_s3_bucket" "logs" {',
        "  bucket = var.region",
        "}",
        'module "vpc" {',
        '  source = "./modules/vpc"',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.extracted).toBe(true);
    expect(out.language).toBe("hcl");
    expect(out.entities).toEqual([
      { kind: "module", name: "module.vpc" },
      { kind: "resource", name: "aws_s3_bucket.logs" },
      { kind: "variable", name: "var.region" },
    ]);
    expect(out.edges.map((e: { kind: string; to: string }) => [e.kind, e.to])).toEqual([
      ["imports", "./modules/vpc"],
      ["references", "var.region"],
    ]);
  });

  test("prints each seed on one line without control characters", async () => {
    const file = join(work, "main.tf");
    const source = "./mod\u001b[31mred";
    writeFileSync(file, ['module "vpc" {', `  source = "${source}"`, "}", ""].join("\n"), "utf8");
    const text = await runCli(["brain", "pre-extract", file]);
    expect(text.returncode).toBe(0);
    expect(text.stdout).not.toContain("\u001b");
    expect(text.stdout).toContain("imports");

    const json = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(json.stdout).toContain("\\u001b");
    const out = JSON.parse(json.stdout);
    expect(out.edges.map((e: { to: string }) => e.to)).toEqual([source]);
  });

  test("the manifest description names Terraform", () => {
    expect(preExtractManifest().summary).toContain("Terraform");
  });

  test("reports an unsupported extension as unextracted rather than empty success", async () => {
    const file = join(work, "notes.txt");
    writeFileSync(file, "class NotCode {}\n", "utf8");
    const res = await runCli(["brain", "pre-extract", file, "--json"]);
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.extracted).toBe(false);
    expect(out.reason).toContain(".txt");
  });

  test("a missing file fails with a nonzero exit", async () => {
    const res = await runCli(["brain", "pre-extract", join(work, "nope.ts"), "--json"]);
    expect(res.returncode).not.toBe(0);
  });

  test("without a file argument prints usage and exits nonzero", async () => {
    const res = await runCli(["brain", "pre-extract"]);
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("usage:");
  });
});
