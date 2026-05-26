import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_PENDING_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
  PAY_MEMORY_SPENDING_JSON_REL,
  PAY_MEMORY_SPENDING_MD_REL,
} from "../../src/core/pay-memory/paths.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-cli-test-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("init-pay-memory", () => {
  test("creates the layout, policy, and reports the agent", async () => {
    const r = await runCli(
      ["init-pay-memory", "--vault", vault, "--agent", "hermes-vps-agent"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("pay-memory layout initialized:");
    expect(r.stdout).toContain("agent: hermes-vps-agent");
    expect(existsSync(join(vault, PAY_MEMORY_ROOT_REL))).toBe(true);
    for (const sub of ["policies", "assets", "drafts", "reports"]) {
      expect(existsSync(join(vault, PAY_MEMORY_ROOT_REL, sub))).toBe(true);
    }
    expect(existsSync(join(vault, PAY_MEMORY_SPENDING_MD_REL))).toBe(true);
  });

  test("re-running is idempotent and skips the policy by default", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const policy = join(vault, PAY_MEMORY_SPENDING_MD_REL);
    writeFileSync(policy, "edited\n", "utf8");
    const r = await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("skipped:");
    expect(readFileSync(policy, "utf8")).toBe("edited\n");
  });

  test("--overwrite rewrites the policy", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const policy = join(vault, PAY_MEMORY_SPENDING_MD_REL);
    writeFileSync(policy, "stale\n", "utf8");
    const r = await runCli(["init-pay-memory", "--vault", vault, "--overwrite"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("overwritten:");
    expect(readFileSync(policy, "utf8")).toContain("# Agent Spending Policy");
  });

  test("--json emits a structured payload", async () => {
    const r = await runCli(["init-pay-memory", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.vault_path).toBe(vault);
    expect(payload.policy_path).toBe(PAY_MEMORY_SPENDING_MD_REL);
    expect(payload.policy_status).toBe("created");
    expect(payload.created).toContain(PAY_MEMORY_POLICIES_REL);
  });
});

describe("append-payment-receipt", () => {
  test("writes a receipt and redacts secrets in --raw-output-file", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const rawFile = join(tmp, "raw.txt");
    writeFileSync(
      rawFile,
      [
        "request: GET /v1/quote",
        "Authorization: Bearer eyJhbGciOi.SECRET",
        '{"api_key": "sk_live_abc", "ok": true}',
      ].join("\n"),
      "utf8",
    );
    const r = await runCli(
      [
        "append-payment-receipt",
        "--vault", vault,
        "--agent", "hermes-vps-agent",
        "--service", "paysponge/fal",
        "--status", "success",
        "--reason", "Generate one original blog header image",
        "--actual-amount", "0.05",
        "--currency", "USDC",
        "--result-ref", "https://fal-cdn.example/img.png",
        "--result-note", `${PAY_MEMORY_ASSETS_REL}/blog-header.md`,
        "--raw-output-file", rawFile,
        "--date", "2026-05-10",
        "--time", "17:20",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`receipt: ${PAY_MEMORY_ROOT_REL}/2026-05-10/`);
    const receiptPath = r.stdout.match(/^receipt: (.+)$/m)![1]!.trim();
    const text = readFileSync(join(vault, receiptPath), "utf8");
    expect(text).toContain("paysponge/fal");
    expect(text).toContain("hermes-vps-agent");
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("sk_live_abc");
  });

  test("refuses to overwrite without --overwrite", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const args = [
      "append-payment-receipt",
      "--vault", vault,
      "--agent", "h",
      "--service", "x/y",
      "--status", "success",
      "--reason", "test",
      "--slug", "fixed-slug",
      "--date", "2026-05-10",
      "--time", "00:00",
    ];
    const first = await runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
    expect(first.returncode).toBe(0);
    const second = await runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
    expect(second.returncode).toBe(1);
    expect(second.stderr).toContain("already exists");
    const third = await runCli([...args, "--overwrite"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(third.returncode).toBe(0);
  });

  test("missing required flags exit with code 2", async () => {
    const r = await runCli(
      ["append-payment-receipt", "--vault", vault, "--service", "x", "--status", "success"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("missing required flag: --reason");
  });
});

describe("capture-asset", () => {
  test("writes an asset note with prompt-file and source receipt", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const promptFile = join(tmp, "prompt.txt");
    writeFileSync(promptFile, "A recursive technical illustration\nNo logos\n", "utf8");
    const r = await runCli(
      [
        "capture-asset",
        "--vault", vault,
        "--title", "Blog Header: Pay Memory",
        "--service", "paysponge/fal",
        "--result-url", "https://fal-cdn.example/img.png",
        "--source-receipt", `${PAY_MEMORY_ROOT_REL}/2026-05-10/fal-blog.md`,
        "--prompt-file", promptFile,
        "--used-in", `${PAY_MEMORY_DRAFTS_REL}/blog-post.md`,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`asset: ${PAY_MEMORY_ASSETS_REL}/`);
    const assetPath = r.stdout.match(/^asset: (.+)$/m)![1]!.trim();
    const text = readFileSync(join(vault, assetPath), "utf8");
    expect(text).toContain("# Blog Header: Pay Memory");
    expect(text).toContain("> A recursive technical illustration");
    expect(text).toContain(`source_receipt: "[[${PAY_MEMORY_ROOT_REL}/2026-05-10/fal-blog]]"`);
  });
});

describe("payment-report", () => {
  test("aggregates receipts written earlier and prints receipts_used", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    for (const slug of ["fal-1", "alpha-1"]) {
      const r = await runCli(
        [
          "append-payment-receipt",
          "--vault", vault,
          "--agent", "h",
          "--service", slug.startsWith("fal") ? "paysponge/fal" : "alpha/translate",
          "--status", "success",
          "--reason", `reason-${slug}`,
          "--actual-amount", "0.03",
          "--currency", "USDC",
          "--slug", slug,
          "--date", "2026-05-10",
          "--time", "17:20",
        ],
        { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
      );
      expect(r.returncode).toBe(0);
    }
    const report = await runCli(
      [
        "payment-report",
        "--vault", vault,
        "--date", "2026-05-10",
        "--title", "Demo Report",
        "--task", "test task",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(report.returncode).toBe(0);
    expect(report.stdout).toContain(`report: ${PAY_MEMORY_REPORTS_REL}/`);
    expect(report.stdout).toContain("receipts: 2");
    const reportPath = report.stdout.match(/^report: (.+)$/m)![1]!.trim();
    const text = readFileSync(join(vault, reportPath), "utf8");
    expect(text).toContain("### paysponge/fal");
    expect(text).toContain("### alpha/translate");
    expect(text).toContain("Demo Report");
    expect(text).toContain("test task");
  });

  test("--date must be ISO YYYY-MM-DD", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      ["payment-report", "--vault", vault, "--date", "2026.05.10"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("YYYY-MM-DD");
  });
});

describe("check-payment-policy", () => {
  test("fail-open when no policy.json exists (exit 0, has_policy=false)", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      ["check-payment-policy", "--vault", vault, "--service", "x/y", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.has_policy).toBe(false);
    expect(payload.allowed).toBe(true);
  });

  test("denies when service is not in allowed_services (exit 1)", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    writeFileSync(
      join(vault, PAY_MEMORY_SPENDING_JSON_REL),
      JSON.stringify({ allowed_services: ["paysponge/fal"] }),
      "utf8",
    );
    const r = await runCli(
      ["check-payment-policy", "--vault", vault, "--service", "alpha/translate"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("status: denied");
    expect(r.stdout).toContain("rule: allowed_services");
  });

  test("approval_required path returns exit 3", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    writeFileSync(
      join(vault, PAY_MEMORY_SPENDING_JSON_REL),
      JSON.stringify({
        allowed_services: ["x/y"],
        require_approval_above: 0.05,
      }),
      "utf8",
    );
    const r = await runCli(
      [
        "check-payment-policy",
        "--vault", vault,
        "--service", "x/y",
        "--expected-amount", "0.07",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("status: approval_required");
  });

  test("--expected-amount must be numeric (exit 2)", async () => {
    const r = await runCli(
      ["check-payment-policy", "--vault", vault, "--service", "x/y", "--expected-amount", "abc"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("must be a number");
  });

  test("whitespace-only --expected-amount is treated as missing, not as 0", async () => {
    // The bug: `Number(" ")` returns `0`. Without trimming the helper
    // would let an agent (or a stray shell-escape) bypass the
    // missing-amount guard by submitting whitespace.
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    writeFileSync(
      join(vault, PAY_MEMORY_SPENDING_JSON_REL),
      JSON.stringify({
        allowed_services: ["x/y"],
        max_single_call: 0.05,
      }),
      "utf8",
    );
    const r = await runCli(
      [
        "check-payment-policy",
        "--vault", vault,
        "--service", "x/y",
        "--expected-amount", "   ",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    // approval_required → exit 3 (missing-amount guard fires)
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("missing_expected_amount");
  });
});

describe("approval workflow (request → approve → consume)", () => {
  test("end-to-end happy path", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const req = await runCli(
      [
        "request-payment-approval",
        "--vault", vault,
        "--service", "paysponge/fal",
        "--reason", "header image",
        "--expected-amount", "0.05",
        "--currency", "USDC",
        "--slug", "demo-1",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(req.returncode).toBe(0);
    expect(req.stdout).toContain(`pending: ${PAY_MEMORY_PENDING_REL}/demo-1.md`);

    const approve = await runCli(
      [
        "approve-payment-request",
        "--vault", vault,
        "--id", "demo-1",
        "--approved-by", "sergey",
        "--note", "ok for demo",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(approve.returncode).toBe(0);
    expect(approve.stdout).toContain("status: approved");

    const consume = await runCli(
      [
        "consume-payment-request",
        "--vault", vault,
        "--id", "demo-1",
        "--receipt", `${PAY_MEMORY_ROOT_REL}/2026-05-10/fal-1.md`,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(consume.returncode).toBe(0);
    expect(consume.stdout).toContain("status: consumed");

    const text = readFileSync(
      join(vault, PAY_MEMORY_PENDING_REL, "demo-1.md"),
      "utf8",
    );
    expect(text).toContain("status: consumed");
    expect(text).toContain("approved_by: sergey");
    expect(text).toContain(`receipt: ${PAY_MEMORY_ROOT_REL}/2026-05-10/fal-1.md`);
  });

  test("reject blocks subsequent approve", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    await runCli(
      [
        "request-payment-approval",
        "--vault", vault,
        "--service", "x/y",
        "--reason", "test",
        "--slug", "rej-1",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const reject = await runCli(
      [
        "reject-payment-request",
        "--vault", vault,
        "--id", "rej-1",
        "--rejected-by", "sergey",
        "--reason", "no",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(reject.returncode).toBe(0);
    const approve = await runCli(
      ["approve-payment-request", "--vault", vault, "--id", "rej-1", "--approved-by", "x"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(approve.returncode).toBe(1);
    expect(approve.stderr).toContain("cannot transition");
  });

  test("list-pending-payments default shows only pending", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    for (const slug of ["a", "b"]) {
      await runCli(
        [
          "request-payment-approval",
          "--vault", vault,
          "--service", "x/y",
          "--reason", `r-${slug}`,
          "--slug", slug,
        ],
        { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
      );
    }
    await runCli(
      ["approve-payment-request", "--vault", vault, "--id", "a", "--approved-by", "sergey"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const listPending = await runCli(
      ["list-pending-payments", "--vault", vault, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const pending = JSON.parse(listPending.stdout);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe("b");

    const listAll = await runCli(
      ["list-pending-payments", "--vault", vault, "--status", "all", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const all = JSON.parse(listAll.stdout);
    expect(all.length).toBe(2);
    expect(all.map((s: { id: string }) => s.id).sort()).toEqual(["a", "b"]);
  });

  test("--status validates against the allowed set", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      ["list-pending-payments", "--vault", vault, "--status", "weird"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--status must be one of");
  });
});

describe("payment-digest", () => {
  test("emits [SILENT] when no receipts on the date", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      ["payment-digest", "--vault", vault, "--date", "2026-05-10"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout.trim()).toBe("[SILENT]");
  });

  test("renders 4-line digest after receipts exist", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    await runCli(
      [
        "append-payment-receipt",
        "--vault", vault,
        "--service", "paysponge/fal",
        "--status", "success",
        "--reason", "header",
        "--actual-amount", "0.05",
        "--currency", "USDC",
        "--slug", "fal-1",
        "--date", "2026-05-10",
        "--time", "12:00",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const r = await runCli(
      ["payment-digest", "--vault", vault, "--date", "2026-05-10"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("💳 Оплачено сервисов: **1**");
    expect(r.stdout).toContain("💰 Сумма: **0.05 USDC**");
    expect(r.stdout).toContain("📁 Файлы чеков: **1**");
  });

  test("--json returns structured payload", async () => {
    await runCli(["init-pay-memory", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const r = await runCli(
      ["payment-digest", "--vault", vault, "--date", "2026-05-10", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.date).toBe("2026-05-10");
    expect(payload.receipts).toBe(0);
  });

  test("--empty-mode validates", async () => {
    const r = await runCli(
      ["payment-digest", "--vault", vault, "--date", "2026-05-10", "--empty-mode", "weird"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--empty-mode must be");
  });
});

describe("HELP includes Pay Memory section", () => {
  test("`o2b` (no args) lists the new commands", async () => {
    const r = await runCli([]);
    expect(r.returncode).toBe(2);
    expect(r.stdout).toContain("Pay Memory:");
    expect(r.stdout).toContain("init-pay-memory");
    expect(r.stdout).toContain("append-payment-receipt");
    expect(r.stdout).toContain("capture-asset");
    expect(r.stdout).toContain("payment-report");
    expect(r.stdout).toContain("check-payment-policy");
  });
});
