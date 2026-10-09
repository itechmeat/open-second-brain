import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/run-cli.ts";

describe("o2b brain import-claude-memory CLI", () => {
  test("dry-run prints plan summary, exit 0, no writes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    await runCli(["init", "--vault", vault, "--name", "Test"], { env });
    await runCli(["brain", "init", "--vault", vault], { env });
    const mem = mkdtempSync(join(tmpdir(), "o2b-cm-cli-mem-"));
    writeFileSync(
      join(mem, "feedback_a.md"),
      "---\nname: a\ndescription: A.\nmetadata:\n  type: feedback\n---\n\nb.\n",
      "utf8",
    );
    const res = await runCli(
      [
        "brain",
        "import-claude-memory",
        "--vault",
        vault,
        "--memory",
        mem,
        "--dry-run",
        "--allow-arbitrary-memory-path",
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("plan:");
    expect(res.stdout).toContain("CREATE pref-a");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-a.md"))).toBe(false);
    rmSync(tmp, { recursive: true });
    rmSync(mem, { recursive: true });
  });

  test("--apply with the approved digest writes files and exits 0", async () => {
    // t_18fda844: non-interactive apply carries the digest a prior
    // --dry-run printed, so what lands is what was approved.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli2-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    await runCli(["init", "--vault", vault, "--name", "Test"], { env });
    await runCli(["brain", "init", "--vault", vault], { env });
    const mem = mkdtempSync(join(tmpdir(), "o2b-cm-cli2-mem-"));
    writeFileSync(
      join(mem, "feedback_a.md"),
      "---\nname: a\ndescription: A.\nmetadata:\n  type: feedback\n---\n\nb.\n",
      "utf8",
    );
    const dry = await runCli(
      [
        "brain",
        "import-claude-memory",
        "--vault",
        vault,
        "--memory",
        mem,
        "--dry-run",
        "--json",
        "--allow-arbitrary-memory-path",
      ],
      { env },
    );
    expect(dry.returncode).toBe(0);
    const digest = (JSON.parse(dry.stdout) as { digest: string }).digest;
    const res = await runCli(
      [
        "brain",
        "import-claude-memory",
        "--vault",
        vault,
        "--memory",
        mem,
        "--apply",
        "--yes",
        "--approval-digest",
        digest,
        "--allow-arbitrary-memory-path",
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-a.md"))).toBe(true);
    rmSync(tmp, { recursive: true });
    rmSync(mem, { recursive: true });
  });

  test("--apply + --dry-run is rejected", async () => {
    const res = await runCli([
      "brain",
      "import-claude-memory",
      "--vault",
      "/tmp",
      "--apply",
      "--dry-run",
    ]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toMatch(/--apply.*--dry-run|--dry-run.*--apply/);
  });

  test("--from mem0 imports a mem0 export (t_ac9d2588)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli-mem0-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    await runCli(["init", "--vault", vault, "--name", "Test"], { env });
    await runCli(["brain", "init", "--vault", vault], { env });
    const exportFile = join(tmp, "mem0-export.json");
    writeFileSync(
      exportFile,
      JSON.stringify([{ name: "from-mem0", memory: "Imported from mem0." }]),
      "utf8",
    );
    const res = await runCli(
      [
        "brain",
        "import-claude-memory",
        "--vault",
        vault,
        "--from",
        "mem0",
        "--memory",
        exportFile,
        "--dry-run",
        "--allow-arbitrary-memory-path",
      ],
      { env },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("CREATE pref-from-mem0");
    rmSync(tmp, { recursive: true });
  });

  test("--from with an unknown backend fails loudly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli-badbackend-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    await runCli(["init", "--vault", vault, "--name", "Test"], { env });
    await runCli(["brain", "init", "--vault", vault], { env });
    const res = await runCli(
      ["brain", "import-claude-memory", "--vault", vault, "--from", "nope"],
      { env },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toMatch(/unknown memory backend 'nope'/);
    rmSync(tmp, { recursive: true });
  });
});

describe("o2b brain import-claude-memory --approval-digest (t_18fda844)", () => {
  function setup(tmpPrefix: string): {
    tmp: string;
    vault: string;
    mem: string;
    env: Record<string, string>;
  } {
    const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    const mem = join(tmp, "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(
      join(mem, "feedback_a.md"),
      "---\nname: a\ndescription: A.\nmetadata:\n  type: feedback\n---\n\nb.\n",
      "utf8",
    );
    return { tmp, vault, mem, env };
  }

  const baseArgs = (vault: string, mem: string): string[] => [
    "brain",
    "import-claude-memory",
    "--vault",
    vault,
    "--memory",
    mem,
    "--allow-arbitrary-memory-path",
  ];

  test("non-interactive --apply without a digest refuses by name, before any write", async () => {
    const s = setup("o2b-cm-cli-nodigest-");
    await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
    await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
    const res = await runCli([...baseArgs(s.vault, s.mem), "--apply", "--yes"], { env: s.env });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--approval-digest");
    expect(existsSync(join(s.vault, "Brain", "preferences", "pref-a.md"))).toBe(false);
    rmSync(s.tmp, { recursive: true });
  });

  test("the dry-run JSON exposes the digest and apply with it lands the plan", async () => {
    const s = setup("o2b-cm-cli-digest-");
    await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
    await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
    const dry = await runCli([...baseArgs(s.vault, s.mem), "--dry-run", "--json"], { env: s.env });
    expect(dry.returncode).toBe(0);
    const plan = JSON.parse(dry.stdout) as {
      digest: string;
      plans: Array<{ basename: string; prefId: string; action: string }>;
    };
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.plans).toEqual([{ basename: "feedback_a.md", prefId: "pref-a", action: "CREATE" }]);

    const apply = await runCli(
      [...baseArgs(s.vault, s.mem), "--apply", "--yes", "--approval-digest", plan.digest],
      { env: s.env },
    );
    expect(apply.returncode).toBe(0);
    expect(existsSync(join(s.vault, "Brain", "preferences", "pref-a.md"))).toBe(true);
    rmSync(s.tmp, { recursive: true });
  });

  test("apply with a stale digest refuses with the re-run remedy and writes nothing", async () => {
    const s = setup("o2b-cm-cli-staledigest-");
    await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
    await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
    const dry = await runCli([...baseArgs(s.vault, s.mem), "--dry-run", "--json"], { env: s.env });
    const plan = JSON.parse(dry.stdout) as { digest: string };
    // The approved plan goes stale: the target preference appears.
    writeFileSync(join(s.vault, "Brain", "preferences", "pref-a.md"), "hand-made\n", "utf8");
    const apply = await runCli(
      [...baseArgs(s.vault, s.mem), "--apply", "--yes", "--approval-digest", plan.digest],
      { env: s.env },
    );
    expect(apply.returncode).toBe(1);
    expect(apply.stderr).toContain("approval digest mismatch");
    expect(apply.stderr).toContain("o2b brain import-claude-memory --dry-run");
    expect(readFileSync(join(s.vault, "Brain", "preferences", "pref-a.md"), "utf8")).toBe(
      "hand-made\n",
    );
    rmSync(s.tmp, { recursive: true });
  });
});
