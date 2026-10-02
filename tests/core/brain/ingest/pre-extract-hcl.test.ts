/**
 * The Terraform family (`hcl`) of the code-structure pre-extractor.
 *
 * `.tf` and `.tfvars` sources become entity seeds in Terraform address
 * syntax (`aws_s3_bucket.logs`, `data.aws_ami.ubuntu`, `module.vpc`,
 * `var.region`, `output.id`, `provider.aws`, `local.name`), a module
 * `source` becomes a redacted `imports` seed, and `depends_on` and
 * `references` edges link block addresses. Names only, never values.
 */

import { describe, expect, test } from "bun:test";

import {
  preExtractCodeStructure,
  type PreExtractResult,
  type PreExtractSuccess,
} from "../../../../src/core/brain/ingest/pre-extract.ts";
import { HCL_BLOCK_KIND } from "../../../../src/core/brain/ingest/pre-extract-hcl.ts";
import { REDACTION_PLACEHOLDER } from "../../../../src/core/redactor.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

function asSuccess(res: PreExtractResult): PreExtractSuccess {
  if (!res.extracted) throw new Error(`expected extracted, got: ${res.reason}`);
  return res;
}

function lines(...rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

const MAIN_TF = lines(
  "terraform {",
  '  required_version = ">= 1.5"',
  "}",
  "",
  'provider "aws" {',
  "  region = var.region",
  "}",
  "",
  'variable "region" {',
  "  type    = string",
  '  default = "eu-west-1"',
  "}",
  "",
  "locals {",
  '  prefix = "app"',
  "  tags = {",
  '    team = "core"',
  "  }",
  "}",
  "",
  'data "aws_ami" "ubuntu" {',
  "  most_recent = true",
  "}",
  "",
  'resource "aws_s3_bucket" "logs" {',
  '  bucket = "logs"',
  "}",
  "",
  'module "vpc" {',
  '  source = "terraform-aws-modules/vpc/aws"',
  "}",
  "",
  'output "bucket_id" {',
  "  value = aws_s3_bucket.logs.id",
  "}",
);

describe("preExtractCodeStructure - Terraform family", () => {
  test("a .tf file is extracted as hcl with every block kind in address syntax", () => {
    const res = asSuccess(preExtractCodeStructure("infra/main.tf", MAIN_TF));
    expect(res.language).toBe("hcl");
    expect(res.entities).toEqual([
      { kind: "data", name: "data.aws_ami.ubuntu" },
      { kind: "locals", name: "local.prefix" },
      { kind: "locals", name: "local.tags" },
      { kind: "module", name: "module.vpc" },
      { kind: "output", name: "output.bucket_id" },
      { kind: "provider", name: "provider.aws" },
      { kind: "resource", name: "aws_s3_bucket.logs" },
      { kind: "variable", name: "var.region" },
    ]);
  });

  test("the block-kind vocabulary names exactly the seven extracted kinds", () => {
    expect(Object.values(HCL_BLOCK_KIND).toSorted()).toEqual([
      "data",
      "locals",
      "module",
      "output",
      "provider",
      "resource",
      "variable",
    ]);
    expect(Object.isFrozen(HCL_BLOCK_KIND)).toBe(true);
  });

  test("a module source becomes an imports seed from the file path, never resolved", () => {
    const res = asSuccess(
      preExtractCodeStructure("infra/main.tf", MAIN_TF, {
        ingestedFiles: new Set(["terraform-aws-modules/vpc/aws"]),
      }),
    );
    const imports = res.edges.filter((e) => e.kind === "imports");
    expect(imports).toEqual([
      { kind: "imports", from: "infra/main.tf", to: "terraform-aws-modules/vpc/aws" },
    ]);
  });

  test("a module source carrying URL credentials is redacted", () => {
    const userInfo = `ci:${fakeCredential("tf", "-pass-", "9a1")}`;
    const res = asSuccess(
      preExtractCodeStructure(
        "infra/main.tf",
        lines(
          'module "net" {',
          `  source = "git::https://${userInfo}@git.example.com/net.git"`,
          "}",
        ),
      ),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "infra/main.tf",
        to: `git::https://${REDACTION_PLACEHOLDER}@git.example.com/net.git`,
      },
    ]);
    expect(JSON.stringify(res)).not.toContain(userInfo);
  });

  test("a source attribute outside a module block is not a module source", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "infra/main.tf",
        lines(
          'resource "null_resource" "copy" {',
          '  provisioner "file" {',
          '    source      = "conf/app.conf"',
          '    destination = "/etc/app.conf"',
          "  }",
          "}",
          'data "archive_file" "zip" {',
          '  source = "src/handler.py"',
          "}",
        ),
      ),
    );
    expect(res.edges.filter((e) => e.kind === "imports")).toEqual([]);
    expect(res.entities).toEqual([
      { kind: "data", name: "data.archive_file.zip" },
      { kind: "resource", name: "null_resource.copy" },
    ]);
  });

  test("a single-line block still yields its entity", () => {
    const res = asSuccess(preExtractCodeStructure("vars.tf", lines('variable "zone" {}')));
    expect(res.entities).toEqual([{ kind: "variable", name: "var.zone" }]);
  });

  test("a .tf file with no blocks is an honest empty success", () => {
    const res = asSuccess(preExtractCodeStructure("empty.tf", "# nothing here\n"));
    expect(res).toEqual({ extracted: true, language: "hcl", entities: [], edges: [] });
  });

  test("the extension match is case-insensitive", () => {
    expect(asSuccess(preExtractCodeStructure("MAIN.TF", lines('variable "a" {}'))).language).toBe(
      "hcl",
    );
  });

  test(".hcl and .tf.json stay unsupported", () => {
    const hcl = preExtractCodeStructure("terragrunt.hcl", lines('include "root" {}'));
    expect(hcl.extracted).toBe(false);
    const json = preExtractCodeStructure("main.tf.json", "{}\n");
    expect(json.extracted).toBe(false);
  });

  test("a .tf file is never a TS relative-import target", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/app.ts", 'import cfg from "./main";\n', {
        ingestedFiles: new Set(["src/main.tf"]),
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/app.ts", to: "./main" }]);
  });
});

describe("preExtractCodeStructure - Terraform edges", () => {
  const EDGES_TF = lines(
    'variable "env" {}',
    "locals {",
    '  name = "${var.env}-app"',
    "  tags = merge(local.base, {",
    "    env = var.env",
    "  })",
    '  base = { owner = "core" }',
    "}",
    'data "aws_iam_policy_document" "assume" {}',
    'resource "aws_iam_role" "app" {',
    "  name               = local.name",
    "  assume_role_policy = data.aws_iam_policy_document.assume.json",
    "}",
    'resource "aws_lambda_function" "app" {',
    "  role       = aws_iam_role.app.arn",
    "  subnet_ids = module.vpc.private_subnets",
    "  depends_on = [aws_iam_role.app, module.vpc]",
    "}",
    'module "vpc" {',
    '  source = "./modules/vpc"',
    "  name   = local.name",
    "}",
    'output "fn" {',
    "  value = aws_lambda_function.app.arn",
    "}",
  );

  test("single-line depends_on lists become depends_on edges", () => {
    const res = asSuccess(preExtractCodeStructure("app/main.tf", EDGES_TF));
    expect(res.edges.filter((e) => e.kind === "depends_on")).toEqual([
      { kind: "depends_on", from: "aws_lambda_function.app", to: "aws_iam_role.app" },
      { kind: "depends_on", from: "aws_lambda_function.app", to: "module.vpc" },
    ]);
  });

  test("var, local, module, data and same-file resource citations become references edges", () => {
    const res = asSuccess(preExtractCodeStructure("app/main.tf", EDGES_TF));
    expect(res.edges.filter((e) => e.kind === "references")).toEqual([
      { kind: "references", from: "aws_iam_role.app", to: "data.aws_iam_policy_document.assume" },
      { kind: "references", from: "aws_iam_role.app", to: "local.name" },
      { kind: "references", from: "aws_lambda_function.app", to: "aws_iam_role.app" },
      { kind: "references", from: "aws_lambda_function.app", to: "module.vpc" },
      { kind: "references", from: "local.name", to: "var.env" },
      { kind: "references", from: "local.tags", to: "local.base" },
      { kind: "references", from: "local.tags", to: "var.env" },
      { kind: "references", from: "module.vpc", to: "local.name" },
      { kind: "references", from: "output.fn", to: "aws_lambda_function.app" },
    ]);
  });

  test("a bare type.name that is not a resource declared in the file is not a reference", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "app/main.tf",
        lines(
          'resource "aws_instance" "web" {',
          "  provider = aws.west",
          "  count    = length(var.zones)",
          "  ami      = aws_ami.other.id",
          "  index    = count.index",
          "}",
        ),
      ),
    );
    expect(res.edges).toEqual([{ kind: "references", from: "aws_instance.web", to: "var.zones" }]);
  });

  test("braces and citations inside strings and heredocs never count", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "app/main.tf",
        lines(
          'resource "aws_iam_policy" "p" {',
          '  description = "a { brace and var.not_a_ref in text"',
          "  policy = <<-EOT",
          "    {",
          '      "Resource": "${var.in_heredoc}"',
          "    }",
          "  EOT",
          '  name = "escaped \\" quote { still a string"',
          "}",
          'variable "after" {}',
        ),
      ),
    );
    expect(res.entities).toEqual([
      { kind: "resource", name: "aws_iam_policy.p" },
      { kind: "variable", name: "var.after" },
    ]);
    expect(res.edges).toEqual([]);
  });

  test("comments are skipped, including block comments and trailing comments", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "app/main.tf",
        lines(
          '/* variable "ghost" {',
          "}",
          "*/",
          '# module "ghost" {',
          '// output "ghost" {',
          'variable "real" { # a { brace in a comment',
          "  type = string // and var.commented here",
          "}",
          'output "o" {',
          "  value = var.real /* var.hidden */",
          "}",
        ),
      ),
    );
    expect(res.entities).toEqual([
      { kind: "output", name: "output.o" },
      { kind: "variable", name: "var.real" },
    ]);
    expect(res.edges).toEqual([{ kind: "references", from: "output.o", to: "var.real" }]);
  });

  test("a nested provisioner source is not a module source", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "app/main.tf",
        lines(
          'module "m" {',
          '  source = "./m"',
          '  provisioner "file" {',
          '    source = "nested/file.txt"',
          "  }",
          "}",
        ),
      ),
    );
    expect(res.edges.filter((e) => e.kind === "imports")).toEqual([
      { kind: "imports", from: "app/main.tf", to: "./m" },
    ]);
  });

  test("a .tfvars file yields variable names, never values", () => {
    const value = fakeCredential("tfvars", "-value-", "7c2e");
    const res = asSuccess(
      preExtractCodeStructure(
        "envs/prod.tfvars",
        lines(
          `db_password = "${value}"`,
          "zones = [",
          '  "a",',
          "]",
          "tags = {",
          '  owner = "core"',
          "}",
          "notes = <<EOT",
          "inner = 1",
          "EOT",
        ),
      ),
    );
    expect(res.entities).toEqual([
      { kind: "variable", name: "var.db_password" },
      { kind: "variable", name: "var.notes" },
      { kind: "variable", name: "var.tags" },
      { kind: "variable", name: "var.zones" },
    ]);
    expect(res.edges).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(value);
  });

  test("the output is deterministic", () => {
    const a = JSON.stringify(preExtractCodeStructure("app/main.tf", EDGES_TF));
    const b = JSON.stringify(preExtractCodeStructure("app/main.tf", EDGES_TF));
    expect(a).toBe(b);
  });
});

describe("pre-extract-hcl module comment", () => {
  test("names every out-of-scope construct", async () => {
    const source = await Bun.file(
      new URL("../../../../src/core/brain/ingest/pre-extract-hcl.ts", import.meta.url),
    ).text();
    const docblock = source.slice(0, source.indexOf("*/"));
    for (const construct of [
      ".hcl",
      ".tf.json",
      "attribute values",
      "lifecycle",
      "dynamic",
      "provisioner",
      "connection",
      "multi-line `depends_on`",
      "heredoc",
      "template files",
      "for_each",
      "count",
      "moved",
      "import",
      "check",
      "removed",
      "terraform {}",
      "required_providers",
      "local module `source`",
      "split across lines",
    ]) {
      expect(docblock).toContain(construct);
    }
  });
});
