/**
 * CLI tests for `o2b brain export` (§28).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPORT_FORMAT, EXPORT_FORMATS } from "../../src/core/brain/export.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-export-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "TestExport"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

async function seedPreference(slug: string): Promise<void> {
  const r = await runCli(
    [
      "brain",
      "feedback",
      "--vault",
      vault,
      "--topic",
      slug,
      "--signal",
      "positive",
      "--principle",
      `principle ${slug}`,
      "--scope",
      "writing",
      "--force-confirmed",
      "--agent",
      "claude",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(r.returncode).toBe(0);
}

describe("brain export", () => {
  test("missing --format → exit 2", async () => {
    await bootstrap();
    const r = await runCli(["brain", "export", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--format");
  });

  test("--format json on empty vault → schema envelope, empty list", async () => {
    await bootstrap();
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      schema: number;
      generated_at: string;
      vault_basename: string;
      preferences: ReadonlyArray<{ id: string }>;
    };
    expect(payload.schema).toBe(1);
    expect(payload.preferences).toEqual([]);
    expect(payload.vault_basename.length).toBeGreaterThan(0);
  });

  test("--format json carries seeded preference rows", async () => {
    await bootstrap();
    await seedPreference("alpha");
    await seedPreference("beta");
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      preferences: Array<{ id: string; topic: string; principle: string }>;
    };
    expect(payload.preferences.map((p) => p.id).toSorted()).toEqual(["pref-alpha", "pref-beta"]);
  });

  test("a preference that cannot be parsed refuses the export by name", async () => {
    // An export that omits a rule reads identically to a vault that never
    // had it, so a row that cannot be read stops the whole export rather
    // than shrinking the list under a success exit.
    await bootstrap();
    await seedPreference("alpha");
    writeFileSync(join(vault, "Brain", "preferences", "pref-broken.md"), "no frontmatter here\n");
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("pref-broken.md");
    expect(r.stdout).toBe("");
  });

  test("--format llms-txt emits H1 + section + bullet", async () => {
    await bootstrap();
    await seedPreference("alpha");
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "llms-txt"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/^# .*Brain preferences/);
    expect(r.stdout).toContain("## Confirmed");
    expect(r.stdout).toContain("- pref-alpha (topic: alpha, scope: writing): principle alpha");
  });

  test("--out writes a file (and refuses to overwrite without --force)", async () => {
    await bootstrap();
    await seedPreference("alpha");
    const out = join(tmp, "out.json");
    const r1 = await runCli(
      ["brain", "export", "--vault", vault, "--format", "json", "--out", out],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r1.returncode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      preferences: ReadonlyArray<unknown>;
    };
    expect(parsed.preferences.length).toBe(1);

    // Second call without --force should refuse.
    const r2 = await runCli(
      ["brain", "export", "--vault", vault, "--format", "json", "--out", out],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r2.returncode).toBe(1);
    expect(r2.stderr).toContain("--force");

    // With --force the overwrite goes through.
    writeFileSync(out, "stale");
    const r3 = await runCli(
      ["brain", "export", "--vault", vault, "--format", "json", "--out", out, "--force"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r3.returncode).toBe(0);
    expect(readFileSync(out, "utf8")).not.toBe("stale");
  });

  test("help text mentions export", async () => {
    const r = await runCli(["brain", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("export");
  });

  test("an unknown --format names every format the vocabulary declares", async () => {
    await bootstrap();
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "yaml"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    for (const format of EXPORT_FORMATS) {
      expect(`${format} offered: ${r.stderr.includes(format)}`).toBe(`${format} offered: true`);
    }
  });
});

describe("the format vocabulary is the only dispatch", () => {
  test("the verb inlines no format literal of its own", () => {
    // The type existed and nothing imported it: the guard was a pair of
    // inline string comparisons, which is a contract declared with nothing
    // behind it. A literal reappearing here is that defect coming back.
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "cli", "brain", "verbs", "export.ts"),
      "utf8",
    );
    const inlined = EXPORT_FORMATS.filter((format) => source.includes(`"${format}"`));
    expect(inlined).toEqual([]);
  });
});

describe("brain export --format transcripts-jsonl", () => {
  /** A two-turn Claude Code transcript under a fresh directory. */
  function transcriptDir(uuid = "u-1"): string {
    const dir = join(tmp, `transcripts-${uuid}`);
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        parentUuid: null,
        sessionId: "sess-1",
        entrypoint: "cli",
        type: "user",
        uuid,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: "what does this verb do" },
      },
      {
        parentUuid: uuid,
        sessionId: "sess-1",
        entrypoint: "cli",
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: { role: "assistant", content: "it exports the corpus" },
      },
    ];
    writeFileSync(
      join(dir, "session.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
    return dir;
  }

  test("emits one JSONL conversation record per transcript, with no vault involved", async () => {
    // The corpus is on the machine, not in the vault, so this format asks
    // for no vault - a format that never reads one must not refuse for the
    // want of one.
    const dir = transcriptDir();
    const r = await runCli(
      ["brain", "export", "--format", EXPORT_FORMAT.transcriptsJsonl, "--transcripts", dir],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!) as {
      runtime: string;
      session_id: string;
      messages: ReadonlyArray<{ role: string; text: string }>;
    };
    expect(record.runtime).toBe("claude");
    expect(record.session_id).toBe("session.jsonl");
    expect(record.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("without --transcripts the format refuses and names the flag", async () => {
    const r = await runCli(["brain", "export", "--format", EXPORT_FORMAT.transcriptsJsonl], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--transcripts");
  });

  test("a record with a secret-shaped identifier is refused and nothing is written", async () => {
    // Transcripts are the highest-risk corpus in the vault's orbit: a key
    // pasted into a prompt is recorded verbatim, and an identifier cannot
    // be redacted without renaming what it identifies. So the export stops.
    const dir = transcriptDir("sk-live-9f2ba7c1d4e8");
    const out = join(tmp, "corpus.jsonl");
    const r = await runCli(
      [
        "brain",
        "export",
        "--format",
        EXPORT_FORMAT.transcriptsJsonl,
        "--transcripts",
        dir,
        "--out",
        out,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("refused to write");
    expect(r.stderr).toContain("turn_id");
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toBe("");
  });

  test("an empty result says how much it looked at rather than writing nothing", async () => {
    const dir = transcriptDir();
    const r = await runCli(
      [
        "brain",
        "export",
        "--format",
        EXPORT_FORMAT.transcriptsJsonl,
        "--transcripts",
        dir,
        "--since",
        "2027-01-01T00:00:00Z",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("1 transcript");
  });
});
