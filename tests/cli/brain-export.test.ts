/**
 * CLI tests for `o2b brain export` (§28).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    // Whole tokens, not substrings: `"transcripts-jsonl".includes("json")`
    // is true, so plain containment reported `json` as offered by a
    // message that had stopped naming it.
    const offered = new Set(r.stderr.split(/[^A-Za-z0-9_-]+/).filter((t) => t.length > 0));
    for (const format of EXPORT_FORMATS) {
      expect(`${format} offered: ${offered.has(format)}`).toBe(`${format} offered: true`);
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
  interface TranscriptFixture {
    /** Turn id of the first line - the `turn_id` a record carries. */
    readonly uuid?: string;
    /** Basename of the transcript, which becomes the record's `session_id`. */
    readonly file?: string;
    /** Text of the user turn, for the cases that put something in it. */
    readonly text?: string;
  }

  /** A two-turn Claude Code transcript under a fresh directory. */
  function transcriptDir(opts: TranscriptFixture = {}): string {
    const uuid = opts.uuid ?? "u-1";
    const file = opts.file ?? "session.jsonl";
    const dir = join(tmp, `transcripts-${uuid}-${file}`);
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        parentUuid: null,
        sessionId: "sess-1",
        entrypoint: "cli",
        type: "user",
        uuid,
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: opts.text ?? "what does this verb do" },
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
    writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
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
    const dir = transcriptDir({ uuid: "sk-live-9f2ba7c1d4e8" });
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

  test("a secret-shaped FILENAME is refused without the refusal printing it", async () => {
    // The one path whose entire purpose is not letting this value out was
    // the path that wrote it to stderr - into CI logs and shell
    // scrollback - because the refusal prefixed the guard's sentence with
    // the record's `session_id`, which IS the transcript's basename. The
    // guard's own message is careful about exactly this: "(Locations, not
    // values: the identifier is the secret.)"
    const secret = "sk-live-9f2ba7c1d4e8.jsonl";
    const dir = transcriptDir({ file: secret });
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
    expect(r.stderr).toContain("session_id");
    // Neither the whole filename nor the credential inside it.
    expect(r.stderr).not.toContain(secret);
    expect(r.stderr).not.toContain("sk-live-9f2ba7c1d4e8");
    // Still locatable: the runtime and the instant it started are not
    // identifiers and are safe to name.
    expect(r.stderr).toContain("claude");
    expect(r.stderr).toContain("2026-08-01T10:00:00.000Z");
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toBe("");
  });

  test("the refusal still names the transcript when the name is not the secret", async () => {
    // The complement: withholding the name unconditionally would make
    // every ordinary refusal harder to act on for no gain.
    const dir = transcriptDir({ uuid: "sk-live-9f2ba7c1d4e8", file: "ordinary.jsonl" });
    const r = await runCli(
      ["brain", "export", "--format", EXPORT_FORMAT.transcriptsJsonl, "--transcripts", dir],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("ordinary.jsonl");
  });

  test("a BARE high-entropy filename is refused, not exported under exit 0", async () => {
    // Vendor-prefixed refused the whole run; an unprefixed 24-character
    // mixed run in the same position exported verbatim. `session_id` is a
    // foreign harness's filename, so "ids are long mixed runs by
    // construction" - an argument about ids this vault generates - does
    // not carry over to it.
    const dir = transcriptDir({ file: "Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5.jsonl" });
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
    expect(r.stderr).toContain("session_id");
    expect(r.stderr).not.toContain("Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5");
    expect(existsSync(out)).toBe(false);
  });

  test("the transcript branch REDACTS a key pasted into a turn, and says so", async () => {
    // Every existing test on this branch pinned a REFUSAL. Nothing asserted
    // that the released corpus is redacted at all, and nothing covered the
    // notice that tells the operator the copy no longer matches the source.
    // The payload is the shape a key actually takes in a transcript:
    // a prefixed environment assignment, which the key-name pass could not
    // see at all until the `\b` at the front of it was replaced.
    const dir = transcriptDir({ text: "run `export ANTHROPIC_API_KEY=hunter2secretvalue` first" });
    const r = await runCli(
      ["brain", "export", "--format", EXPORT_FORMAT.transcriptsJsonl, "--transcripts", dir],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("hunter2secretvalue");
    expect(r.stdout).toContain("***REDACTED***");
    // The variable name survives, so the line still says what was removed.
    expect(r.stdout).toContain("ANTHROPIC_API_KEY");
    expect(r.stderr).toContain("no longer matches the vault byte for byte");
  });

  test("an existing --out is refused before the corpus is read", async () => {
    // The check used to sit after the handler, so `--out` naming a file
    // that already exists read, hashed and redacted a whole machine's
    // transcripts and then refused over a flag knowable from argv alone.
    // A source that does not exist is what makes the ordering visible:
    // whichever check runs first is the one that speaks.
    const out = join(tmp, "corpus.jsonl");
    writeFileSync(out, "existing bytes\n", "utf8");
    const r = await runCli(
      [
        "brain",
        "export",
        "--format",
        EXPORT_FORMAT.transcriptsJsonl,
        "--transcripts",
        join(tmp, "no-such-transcripts"),
        "--out",
        out,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--force");
    expect(r.stderr).not.toContain("no-such-transcripts");
    expect(readFileSync(out, "utf8")).toBe("existing bytes\n");
  });

  test("a zero-byte transcript does not abort the run", async () => {
    const dir = transcriptDir();
    writeFileSync(join(dir, "flushed-nothing.jsonl"), "", "utf8");
    const r = await runCli(
      ["brain", "export", "--format", EXPORT_FORMAT.transcriptsJsonl, "--transcripts", dir],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  });

  test("--out receives the corpus and stdout stays empty", async () => {
    const dir = transcriptDir();
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
    expect(r.returncode).toBe(0);
    const written = readFileSync(out, "utf8");
    expect(written.trimEnd().split("\n").length).toBe(1);
    expect(JSON.parse(written.trimEnd()) as { session_id: string }).toMatchObject({
      session_id: "session.jsonl",
    });
    // The spool is consumed by the rename, never left beside the target.
    expect(readdirSync(tmp).filter((n) => n.includes("o2b-transcripts-"))).toEqual([]);
  });
});
