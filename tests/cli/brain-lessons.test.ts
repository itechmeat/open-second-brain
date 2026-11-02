/**
 * Tests for `o2b brain lessons` (t_1e952e43, task C2).
 *
 * Drives the operator verb family over the promotion kernel:
 *   - `candidates` is read-only and reports promotable plus
 *     blocked-with-reason, including the disabled state;
 *   - `approve` follows the install consent ladder: plan-only by default,
 *     headless `--apply` without `--yes` refuses with exit 6, the ledger
 *     row is recorded only after the rules-block write landed, and the
 *     approval event joins the shared log chain;
 *   - `deny` records without touching any rules file and suppresses the
 *     lesson from every later listing;
 *   - `refresh-blocks` is a dry run by default, is a named no-op when no
 *     block exists under management, never CREATES a block, drops a stale
 *     lesson by name, and stamps `lastPromotedAt` on what it wrote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { computeContentHash } from "../../src/core/brain/content-hash.ts";
import { listLogDates, readLogDay } from "../../src/core/brain/log-jsonl.ts";
import {
  LESSONS_APPROVALS_FILE,
  lessonsApprovalsPath,
  readLessonApprovals,
  recordLessonApproval,
} from "../../src/core/brain/lessons-promotion.ts";
import { RULES_BLOCK_MARKERS } from "../../src/core/install/rules-block.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

const SCOPE_ENV = "OPEN_SECOND_BRAIN_LESSONS_PROMOTION_SCOPES";
const PRINCIPLE = "Always run the full test suite before pushing to main";

let tmp: string;
let vault: string;
let configPath: string;
let savedScopeEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-lessons-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  savedScopeEnv = process.env[SCOPE_ENV];
  process.env[SCOPE_ENV] = "backend";
});

afterEach(() => {
  if (savedScopeEnv === undefined) delete process.env[SCOPE_ENV];
  else process.env[SCOPE_ENV] = savedScopeEnv;
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath, [SCOPE_ENV]: "backend" });

function seedPreferredLesson(
  slug: string,
  overrides: { scope?: string; confidence?: string; principle?: string } = {},
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: overrides.principle ?? PRINCIPLE,
    scope: overrides.scope ?? "backend",
    created_at: "2026-05-01T00:00:00Z",
    confirmed_at: "2026-05-02T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-05-10T00:00:00Z",
    confidence: overrides.confidence ?? "high",
  } as Parameters<typeof writePreference>[1]);
  appendLogEvent(
    vault,
    {
      timestamp: "2026-05-09T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: `[[pref-${slug}]]`, artifact: "[[a.ts]]", agent: "t", result: "applied" },
    },
    { deviceId: "" },
  );
  appendLogEvent(
    vault,
    {
      timestamp: "2026-05-10T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: `[[pref-${slug}]]`, artifact: "[[b.ts]]", agent: "t", result: "applied" },
    },
    { deviceId: "" },
  );
}

const NOW_FIXTURE_MS = Date.parse("2026-05-20T00:00:00Z");

function ledgerEvents(): ReadonlyArray<string> {
  const dates = listLogDates(vault);
  const kinds: string[] = [];
  for (const date of dates) {
    for (const entry of readLogDay(vault, date).entries) kinds.push(entry.eventType);
  }
  return kinds;
}

describe("o2b brain lessons candidates", () => {
  test("lists promotable and blocked with reasons, read-only", async () => {
    seedPreferredLesson("approved-lesson");
    seedPreferredLesson("norow-lesson");
    recordLessonApproval(vault, {
      prefId: "pref-approved-lesson",
      decision: "approved",
      decidedAt: "2026-05-15T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash(PRINCIPLE, "backend"),
      targets: ["AGENTS.md"],
      blockId: "lessons",
      lastPromotedAt: null,
    });
    const rulesBefore = existsSync(join(vault, "AGENTS.md"));
    const ledgerBefore = existsSync(lessonsApprovalsPath(vault))
      ? readFileSync(lessonsApprovalsPath(vault), "utf8")
      : null;

    const out = await runCli(["brain", "lessons", "candidates", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      promotable: Array<{ prefId: string }>;
      blocked: Array<{ prefId: string; reason: string }>;
      scopes: { count: number };
    };
    expect(payload.promotable.map((c) => c.prefId)).toEqual(["pref-approved-lesson"]);
    expect(payload.blocked).toEqual([{ prefId: "pref-norow-lesson", reason: "not_approved" }]);
    expect(payload.scopes.count).toBe(1);

    // Read-only: no rules file appeared, the ledger is byte-identical.
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(rulesBefore);
    expect(
      existsSync(lessonsApprovalsPath(vault))
        ? readFileSync(lessonsApprovalsPath(vault), "utf8")
        : null,
    ).toBe(ledgerBefore);
  });

  test("promotion disabled is a named count of zero with every lesson scope-blocked", async () => {
    seedPreferredLesson("disabled-lesson");
    recordLessonApproval(vault, {
      prefId: "pref-disabled-lesson",
      decision: "approved",
      decidedAt: "2026-05-15T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash(PRINCIPLE, "backend"),
      targets: ["AGENTS.md"],
      blockId: "lessons",
      lastPromotedAt: null,
    });
    const out = await runCli(["brain", "lessons", "candidates", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      promotable: unknown[];
      blocked: Array<{ reason: string }>;
      scopes: { count: number };
    };
    expect(payload.scopes.count).toBe(0);
    expect(payload.promotable).toEqual([]);
    expect(payload.blocked[0]?.reason).toBe("scope_not_enabled");
  });
});

describe("o2b brain lessons approve", () => {
  test("plan-only default renders targets and writes nothing", async () => {
    seedPreferredLesson("plan-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n\nbe careful.\n");
    const before = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const out = await runCli(["brain", "lessons", "approve", "pref-plan-lesson"], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("AGENTS.md");
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(before);
    expect(existsSync(lessonsApprovalsPath(vault))).toBe(false);
  });

  test("headless --apply without --yes refuses with exit 6 and writes nothing", async () => {
    seedPreferredLesson("gate-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n\nbe careful.\n");
    const out = await runCli(
      ["brain", "lessons", "approve", "pref-gate-lesson", "--apply", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(6);
    const payload = JSON.parse(out.stdout) as { consent: string; written: boolean };
    expect(payload.consent).toBe("headless-refused");
    expect(payload.written).toBe(false);
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).not.toContain(
      RULES_BLOCK_MARKERS.lessons.begin,
    );
    expect(existsSync(lessonsApprovalsPath(vault))).toBe(false);
  });

  test("--apply --yes writes the block, records the row, and appends the event", async () => {
    seedPreferredLesson("ok-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n\nbe careful.\n");
    const out = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-ok-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const rules = readFileSync(join(vault, "AGENTS.md"), "utf8");
    expect(rules).toContain(RULES_BLOCK_MARKERS.lessons.begin);
    expect(rules).toContain(PRINCIPLE);
    expect(rules).toContain("# house rules");
    const rows = readLessonApprovals(vault);
    expect(rows.length).toBe(1);
    expect(rows[0]?.decision).toBe("approved");
    expect(rows[0]?.prefId).toBe("pref-ok-lesson");
    expect(rows[0]?.targets).toEqual(["AGENTS.md"]);
    expect(rows[0]?.approvedContentHash).toBe(computeContentHash(PRINCIPLE, "backend"));
    expect(ledgerEvents()).toContain(BRAIN_LOG_EVENT_KIND.lessonsApproved);
    // A rerun of candidates shows the lesson promotable.
    const list = await runCli(["brain", "lessons", "candidates", "--json"], { env: env() });
    const payload = JSON.parse(list.stdout) as { promotable: Array<{ prefId: string }> };
    expect(payload.promotable.map((c) => c.prefId)).toEqual(["pref-ok-lesson"]);
  });

  test("an unknown pref id is a named error, exit 2", async () => {
    const out = await runCli(["brain", "lessons", "approve", "pref-absent", "--apply", "--yes"], {
      env: env(),
    });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("pref-absent");
  });

  test("a lesson whose scope could forge a block marker refuses the approve by name", async () => {
    // The enabled-scope twin carries the marker-shaped scope, so the
    // lesson QUALIFIES - and the render must still refuse it, before any
    // consent, write or ledger row. writePreference refuses a marker-
    // shaped scope at write time, so the fixture seeds a normal file and
    // then edits the persisted frontmatter directly: the preference file
    // is vault state that can arrive by other means than this build's
    // writer, which is exactly the shape the render must refuse.
    const forgedScope = RULES_BLOCK_MARKERS.lessons.end;
    seedPreferredLesson("forge-lesson");
    const prefPath = join(vault, "Brain", "preferences", "pref-forge-lesson.md");
    const persisted = readFileSync(prefPath, "utf8");
    expect(persisted).toContain("scope:");
    writeFileSync(prefPath, persisted.replace(/scope:.*/, `scope: "${forgedScope}"`));
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n\nbe careful.\n");
    const rulesBefore = readFileSync(join(vault, "AGENTS.md"), "utf8");

    const planned = await runCli(["brain", "lessons", "approve", "pref-forge-lesson"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, [SCOPE_ENV]: forgedScope },
    });
    expect(planned.returncode).toBe(1);
    expect(planned.stderr).toContain("pref-forge-lesson");
    expect(planned.stderr).toContain("scope");

    const applied = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-forge-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath, [SCOPE_ENV]: forgedScope } },
    );
    expect(applied.returncode).toBe(1);
    expect(applied.stderr).toContain("pref-forge-lesson");
    // Nothing was written: no block, no ledger row.
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(rulesBefore);
    expect(existsSync(lessonsApprovalsPath(vault))).toBe(false);
  });

  test("a refusal on the second target refuses the whole approve before any write", async () => {
    // The multi-target approve must compute the plan for ALL targets
    // first (the installer's dry-pass discipline): a refusal on the
    // second target must not leave the first written and unmanaged.
    seedPreferredLesson("multi-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# rules\n");
    writeFileSync(
      join(vault, "CLAUDE.md"),
      [
        "# claude rules",
        "",
        RULES_BLOCK_MARKERS.lessons.begin,
        "hand-written lessons content",
        RULES_BLOCK_MARKERS.lessons.end,
        "",
      ].join("\n"),
    );
    const out = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-multi-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
        "--target",
        "CLAUDE.md",
      ],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("CLAUDE.md");
    expect(out.stderr).toContain("user-modified-block");
    expect(out.stderr).toContain("nothing was written");
    // Neither target moved and no approval row was recorded.
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe("# rules\n");
    expect(readFileSync(join(vault, "CLAUDE.md"), "utf8")).toContain(
      "hand-written lessons content",
    );
    expect(existsSync(lessonsApprovalsPath(vault))).toBe(false);
  });
});

describe("o2b brain lessons deny", () => {
  test("deny records the decision without writing any rules file", async () => {
    seedPreferredLesson("deny-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n\nbe careful.\n");
    const before = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const out = await runCli(["brain", "lessons", "deny", "pref-deny-lesson", "--apply", "--yes"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const rows = readLessonApprovals(vault);
    expect(rows.length).toBe(1);
    expect(rows[0]?.decision).toBe("denied");
    expect(rows[0]?.targets).toEqual([]);
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(before);
    expect(ledgerEvents()).toContain(BRAIN_LOG_EVENT_KIND.lessonsDenied);
    const list = await runCli(["brain", "lessons", "candidates", "--json"], { env: env() });
    const payload = JSON.parse(list.stdout) as {
      blocked: Array<{ prefId: string; reason: string }>;
    };
    expect(payload.blocked).toEqual([{ prefId: "pref-deny-lesson", reason: "denied" }]);
  });

  test("headless deny without --yes refuses with exit 6", async () => {
    seedPreferredLesson("deny-gate");
    const out = await runCli(["brain", "lessons", "deny", "pref-deny-gate", "--apply", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(6);
    expect(existsSync(lessonsApprovalsPath(vault))).toBe(false);
  });
});

describe("o2b brain lessons refresh-blocks", () => {
  test("is a named no-op when no block exists under management", async () => {
    seedPreferredLesson("lonely-lesson");
    recordLessonApproval(vault, {
      prefId: "pref-lonely-lesson",
      decision: "approved",
      decidedAt: "2026-05-15T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash(PRINCIPLE, "backend"),
      targets: ["AGENTS.md"],
      blockId: "lessons",
      lastPromotedAt: null,
    });
    const out = await runCli(["brain", "lessons", "refresh-blocks", "--apply", "--yes"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toMatch(/no lessons block under management/i);
    expect(existsSync(join(vault, "AGENTS.md"))).toBe(false);
  });

  test("updates an existing block, drops a stale lesson by name, and stamps lastPromotedAt", async () => {
    seedPreferredLesson("stale-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# house rules\n");
    const approval = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-stale-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(approval.returncode).toBe(0);
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toContain(PRINCIPLE);

    // The operator edits the approved preference: the pinned hash goes stale.
    const prefPath = join(vault, "Brain", "preferences", "pref-stale-lesson.md");
    const prefBytes = readFileSync(prefPath, "utf8");
    writeFileSync(prefPath, prefBytes.replace(PRINCIPLE, `${PRINCIPLE}, amended`));

    const refresh = await runCli(["brain", "lessons", "refresh-blocks", "--apply", "--yes"], {
      env: env(),
    });
    expect(refresh.returncode).toBe(0);
    expect(refresh.stdout).toContain("pref-stale-lesson");
    const rules = readFileSync(join(vault, "AGENTS.md"), "utf8");
    expect(rules).not.toContain(PRINCIPLE);
    const rows = readLessonApprovals(vault);
    expect(rows[0]?.lastPromotedAt).not.toBeNull();
    expect(ledgerEvents()).toContain(BRAIN_LOG_EVENT_KIND.lessonsPromoted);
  });

  test("skips a target whose block is absent by name and never creates it", async () => {
    seedPreferredLesson("two-file-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# rules\n");
    const approval = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-two-file-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(approval.returncode).toBe(0);
    // Widen the row's targets to a file that carries no block.
    const rows = readLessonApprovals(vault);
    recordLessonApproval(vault, { ...rows[0]!, targets: ["AGENTS.md", "CLAUDE.md"] });
    const claudePath = join(vault, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(false);

    const refresh = await runCli(["brain", "lessons", "refresh-blocks", "--apply", "--yes"], {
      env: env(),
    });
    expect(refresh.returncode).toBe(0);
    expect(refresh.stdout).toContain("CLAUDE.md");
    expect(existsSync(claudePath)).toBe(false);
  });

  test("the default run is a dry preview that writes nothing", async () => {
    seedPreferredLesson("dry-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# rules\n");
    const approval = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-dry-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(approval.returncode).toBe(0);
    const prefPath = join(vault, "Brain", "preferences", "pref-dry-lesson.md");
    writeFileSync(
      prefPath,
      readFileSync(prefPath, "utf8").replace(PRINCIPLE, `${PRINCIPLE} with edits`),
    );
    const before = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const ledgerBefore = readFileSync(lessonsApprovalsPath(vault), "utf8");
    const dry = await runCli(["brain", "lessons", "refresh-blocks"], { env: env() });
    expect(dry.returncode).toBe(0);
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(before);
    expect(readFileSync(lessonsApprovalsPath(vault), "utf8")).toBe(ledgerBefore);
  });

  test("a future-stamped lastPromotedAt is untrusted: the hand-edited block refuses without --force", async () => {
    // The promotion stamp lives in agent-writable ledger state. Stamping
    // it into the future would make every later operator hand-edit read
    // as a canonical move under an untouched file, so the gate must
    // treat it as no record - which refuses the removal path too.
    seedPreferredLesson("future-stamp-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# rules\n");
    const approval = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-future-stamp-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(approval.returncode).toBe(0);
    // Re-stamp the row into the future, far past the clock-skew allowance.
    const rows = readLessonApprovals(vault);
    recordLessonApproval(vault, {
      ...rows[0]!,
      lastPromotedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    // The approved text moves, so nothing qualifies any more and the
    // refresh would REMOVE the block; a hand edit makes the file the
    // operator's, not the writer's.
    const rulesPath = join(vault, "AGENTS.md");
    writeFileSync(
      rulesPath,
      readFileSync(rulesPath, "utf8").replace(PRINCIPLE, "HAND EDITED LINE"),
    );
    const refused = await runCli(["brain", "lessons", "refresh-blocks", "--apply", "--yes"], {
      env: env(),
    });
    expect(refused.returncode).toBe(1);
    expect(refused.stderr).toContain("user-modified-block");
    expect(readFileSync(rulesPath, "utf8")).toContain("HAND EDITED LINE");
    // --force stays the documented override.
    const forced = await runCli(
      ["brain", "lessons", "refresh-blocks", "--apply", "--yes", "--force"],
      { env: env() },
    );
    expect(forced.returncode).toBe(0);
    expect(existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "").not.toContain(
      "HAND EDITED LINE",
    );
  });

  test("a hand-edited block refuses the refresh by name; --force overrides", async () => {
    seedPreferredLesson("hand-lesson");
    writeFileSync(join(vault, "AGENTS.md"), "# rules\n");
    const approval = await runCli(
      [
        "brain",
        "lessons",
        "approve",
        "pref-hand-lesson",
        "--apply",
        "--yes",
        "--target",
        "AGENTS.md",
      ],
      { env: env() },
    );
    expect(approval.returncode).toBe(0);
    // A second approved lesson changes the canonical body; a hand edit to
    // the block makes the file NEWER than the promotion stamp.
    seedPreferredLesson("hand-lesson-2");
    recordLessonApproval(vault, {
      prefId: "pref-hand-lesson-2",
      decision: "approved",
      decidedAt: "2026-05-16T00:00:00Z",
      decidedBy: "yes-flag",
      approvedContentHash: computeContentHash(
        "Always run the full test suite before pushing to main",
        "backend",
      ),
      targets: ["AGENTS.md"],
      blockId: "lessons",
      lastPromotedAt: null,
    });
    const rulesPath = join(vault, "AGENTS.md");
    // The shared writer grants hand edits a 1 s mtime slack over the
    // recorded promotion stamp, and the stamp itself truncates to the
    // second, so an immediate edit would be indistinguishable from the
    // writer's own write. Sleep past stamp rounding (up to 999 ms) plus
    // the writer slack (1000 ms) so this edit is decided by intent, not
    // by where the second boundary happened to fall.
    await Bun.sleep(2_200);
    writeFileSync(
      rulesPath,
      readFileSync(rulesPath, "utf8").replace(PRINCIPLE, "HAND EDITED LINE"),
    );
    const refused = await runCli(["brain", "lessons", "refresh-blocks", "--apply", "--yes"], {
      env: env(),
    });
    expect(refused.returncode).not.toBe(0);
    expect(refused.stderr).toContain("user-modified-block");
    const forced = await runCli(
      ["brain", "lessons", "refresh-blocks", "--apply", "--yes", "--force"],
      { env: env() },
    );
    expect(forced.returncode).toBe(0);
    const rules = readFileSync(rulesPath, "utf8");
    expect(rules).toContain("pref-hand-lesson");
    expect(rules).not.toContain("HAND EDITED LINE");
  });
});

describe("o2b brain lessons usage", () => {
  test("a missing subcommand is a usage error", async () => {
    const out = await runCli(["brain", "lessons"], { env: env() });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("candidates");
  });
});

describe("the docs name the lane (docs drift fails a test)", () => {
  const repoRoot = join(import.meta.dir, "..", "..");
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

  test("the cli reference names the verb family, the approval tier and the trust boundary", () => {
    const cli = read("docs/cli-reference.md");
    expect(cli).toContain("o2b brain lessons");
    for (const verb of ["candidates", "approve", "deny", "refresh-blocks"]) {
      expect(`${verb} documented: ${cli.includes(verb)}`).toBe(`${verb} documented: true`);
    }
    expect(cli).toContain("operator-approved lesson promotion");
    // The trust boundary is stated in the docs, not only in the docblocks.
    expect(cli).toContain("no MCP tool exposes this verb family");
  });

  test("the observability guide names the audit events and the trust boundary", () => {
    const obs = read("docs/observability.md");
    for (const kind of ["lessons-approved", "lessons-denied", "lessons-promoted"]) {
      expect(`${kind} documented: ${obs.includes(kind)}`).toBe(`${kind} documented: true`);
    }
    expect(obs).toContain("Operator CLI only");
    expect(obs).toContain("no agent-facing surface can mint these events");
    expect(obs).toContain("stale-lessons");
  });
});

describe("surface registrations", () => {
  test("the ledger fixture name and the NOW fixture stay honest", () => {
    expect(LESSONS_APPROVALS_FILE).toBe("lessons-approvals.json");
    expect(Number.isFinite(NOW_FIXTURE_MS)).toBe(true);
  });
});
