/**
 * CLI coverage for `o2b brain snapshot diff` and the new
 * `--dry-run` mode of `o2b brain rollback`.
 *
 * Both surfaces share the same diff renderer, so the assertions
 * here focus on argument handling, exit codes, and the integration
 * between `extractSnapshotToTemp`, `diffBrainTrees`, and the
 * markdown / JSON output channels.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-snapdiff-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

async function seedDream(): Promise<string> {
  for (const slug of ["a", "b", "c"]) {
    const r = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "diff-demo",
        "--signal",
        "positive",
        "--principle",
        "Take care",
        "--slug",
        `diff-demo-${slug}`,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
  }
  const d = await runCli(["brain", "dream", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(d.returncode).toBe(0);
  const list = await runCli(["brain", "rollback", "--list", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(list.returncode).toBe(0);
  const snaps = JSON.parse(list.stdout) as ReadonlyArray<{ run_id: string }>;
  expect(snaps.length).toBeGreaterThan(0);
  return snaps[0]!.run_id;
}

describe("brain rollback --dry-run", () => {
  test("prints diff without modifying Brain/", async () => {
    await bootstrap();
    const runId = await seedDream();
    // Add a fresh pref AFTER the snapshot so the diff has content
    // (the "added" side appears in live but not in the snapshot).
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-extra.md"),
      `---
kind: brain-preference
id: pref-extra
created_at: 2026-05-17T10:00:00Z
_confirmed_at: "null"
unconfirmed_until: 2026-06-17T10:00:00Z
tags: [brain, brain/preference]
topic: extra
_status: unconfirmed
principle: Added after snapshot
_evidenced_by: []
_applied_count: 0
_violated_count: 0
_last_evidence_at: "null"
_confidence: low
_confidence_value: 0
pinned: false
---
`,
      "utf8",
    );
    const r = await runCli(["brain", "rollback", runId, "--dry-run", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/^# Brain snapshot diff$/m);
    expect(r.stdout).toMatch(/^- A: live$/m);
    expect(r.stdout).toContain(`- B: ${runId}`);
    expect(r.stdout).toMatch(/^- - \[\[pref-extra\|Added after snapshot\]\] \(removed\)$/m);
    // Live tree must NOT have been touched.
    expect(existsSync(join(vault, "Brain", "preferences", "pref-extra.md"))).toBe(true);
  });

  test("--dry-run + --yes is an error", async () => {
    await bootstrap();
    const runId = await seedDream();
    const r = await runCli(["brain", "rollback", runId, "--dry-run", "--yes", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  test("--dry-run --json returns parseable JSON", async () => {
    await bootstrap();
    const runId = await seedDream();
    const r = await runCli(["brain", "rollback", runId, "--dry-run", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("added");
    expect(payload).toHaveProperty("removed");
    expect(payload).toHaveProperty("modified");
  });

  test("unknown run_id exits 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "rollback", "no-such-run", "--dry-run", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
  });
});

describe("brain snapshot diff", () => {
  test("snapshot vs live", async () => {
    await bootstrap();
    const runId = await seedDream();
    // Mutate live so the diff has content.
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-added.md"),
      `---
kind: brain-preference
id: pref-added
created_at: 2026-05-17T10:00:00Z
_confirmed_at: "null"
unconfirmed_until: 2026-06-17T10:00:00Z
tags: [brain, brain/preference]
topic: added
_status: unconfirmed
principle: Added principle
_evidenced_by: []
_applied_count: 0
_violated_count: 0
_last_evidence_at: "null"
_confidence: low
_confidence_value: 0
pinned: false
---
`,
      "utf8",
    );
    const r = await runCli(["brain", "snapshot", "diff", runId, "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/^- B: live$/m);
    expect(r.stdout).toMatch(/\[\[pref-added\|Added principle\]\]/);
  });

  test("two snapshots", async () => {
    await bootstrap();
    const first = await seedDream();
    // Add evidence and run dream again so a second snapshot is created.
    const fb = await runCli(
      [
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "again",
        "--signal",
        "positive",
        "--principle",
        "Be careful",
        "--slug",
        "again-1",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(fb.returncode).toBe(0);
    for (const s of ["2", "3"]) {
      const seed = await runCli(
        [
          "brain",
          "feedback",
          "--vault",
          vault,
          "--topic",
          "again",
          "--signal",
          "positive",
          "--principle",
          "Be careful",
          "--slug",
          `again-${s}`,
        ],
        { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
      );
      expect(seed.returncode).toBe(0);
    }
    const d2 = await runCli(["brain", "dream", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(d2.returncode).toBe(0);
    const list = await runCli(["brain", "rollback", "--list", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    const snaps = JSON.parse(list.stdout) as ReadonlyArray<{ run_id: string }>;
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    const second = snaps.find((s) => s.run_id !== first)!.run_id;
    const r = await runCli(["brain", "snapshot", "diff", first, second, "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`- A: ${first}`);
    expect(r.stdout).toContain(`- B: ${second}`);
    // Seven sequential CLI invocations legitimately exceed bun's 5s
    // default per-test timeout on a loaded machine.
  }, 20000);

  test("--json returns parseable JSON", async () => {
    await bootstrap();
    const runId = await seedDream();
    const r = await runCli(["brain", "snapshot", "diff", runId, "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty("added");
  });

  test("missing positional arg exits 1", async () => {
    await bootstrap();
    const r = await runCli(["brain", "snapshot", "diff", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
  });

  test("unknown run_id exits 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "snapshot", "diff", "no-such-run", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
  });

  test("snapshot help exits 0", async () => {
    await bootstrap();
    const r = await runCli(["brain", "snapshot", "--help", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    // Without --help arg → return 2; WITH --help → 0.
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("o2b brain snapshot");
    expect(r.stdout).toContain("diff");
  });

  test("unknown sub-verb exits 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "snapshot", "no-such-verb", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
  });
});

// Silence the unused-import warning when test fixtures change.
void readFileSync;

describe("brain rollback --dry-run outside the preference folders", () => {
  test("lists every file a restore would put back, change or remove under Brain/", async () => {
    await bootstrap();
    // Files outside preferences/ and retired/, names in several scripts and
    // one in a nested folder: a real rollback restores every one of them.
    const probe = join(vault, "Brain", "probe-names");
    const nested = join(probe, "папка-文件夹");
    mkdirSync(nested, { recursive: true });
    const names = [
      "кириллица.md",
      "中文.md",
      `${"й".repeat(100)}.md`,
      "café.md",
      "cafe\u0301-nfd.md",
      "\u0439\u043e\u0434-nfc.md",
      "\u0438\u0306\u043e\u0434-nfd.md",
      "한국어.md",
    ];
    for (const name of names) writeFileSync(join(probe, name), `${name}\n`);
    writeFileSync(join(nested, "🦦.md"), "otter\n");
    const runId = await seedDream();

    rmSync(join(probe, names[0]!));
    rmSync(join(probe, names[1]!));
    rmSync(join(probe, names[4]!));
    rmSync(join(probe, names[6]!));
    rmSync(nested, { recursive: true });
    writeFileSync(join(probe, names[2]!), "overwritten\n");
    writeFileSync(join(probe, "new-after.md"), "new\n");

    const r = await runCli(["brain", "rollback", runId, "--dry-run", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(`Brain/probe-names/${names[0]}`);
    expect(r.stdout).toContain(`Brain/probe-names/${names[1]}`);
    expect(r.stdout).toContain("Brain/probe-names/папка-文件夹/🦦.md");
    expect(r.stdout).toContain(`Brain/probe-names/${names[2]}`);
    expect(r.stdout).toContain("Brain/probe-names/new-after.md");
    expect(r.stdout).toContain(`Brain/probe-names/${names[4]}`);
    expect(r.stdout).toContain(`Brain/probe-names/${names[6]}`);
    // The unchanged file is not listed.
    expect(r.stdout).not.toContain(`Brain/probe-names/${names[3]}`);
    // What the list leaves out is said, with why: the derived store a real
    // rollback reports on its own line, the folders it leaves in place,
    // and the links the differ never reads.
    const notListed = r.stdout.slice(r.stdout.indexOf("## Not listed"));
    expect(notListed).toStartWith("## Not listed");
    expect(notListed).toContain(".snapshots/ and .artifacts/");
    expect(notListed).toContain("Symbolic links");
    expect(notListed).toMatch(/Derived store \(search index\): (included|excluded|unknown)/);

    const json = await runCli(
      ["brain", "rollback", runId, "--dry-run", "--vault", vault, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(json.returncode).toBe(0);
    const payload = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(payload).toHaveProperty("added");
    expect(payload).toHaveProperty("derived_store");
    expect(payload["not_listed"]).toEqual([".snapshots/", ".artifacts/", "symbolic links"]);
  });
});
