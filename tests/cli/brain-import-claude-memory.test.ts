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
  }, 20000);

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

/**
 * A temp vault plus a memory dir holding the given files, wired through one
 * config env. Shared by the digest and per-entry-disposition describes; kept
 * at module scope so the linter does not flag re-scoped helpers.
 */
function setupImport(
  tmpPrefix: string,
  memoryFiles: Record<string, string>,
): { tmp: string; vault: string; mem: string; env: Record<string, string> } {
  const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
  const vault = join(tmp, "vault");
  const config = join(tmp, "config.yaml");
  const env = { OPEN_SECOND_BRAIN_CONFIG: config };
  const mem = join(tmp, "memory");
  mkdirSync(mem, { recursive: true });
  for (const [name, bytes] of Object.entries(memoryFiles)) {
    writeFileSync(join(mem, name), bytes, "utf8");
  }
  return { tmp, vault, mem, env };
}

/** A minimal Claude feedback memory file with the given name/description. */
function feedbackMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}.\nmetadata:\n  type: feedback\n---\n\nbody.\n`;
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

describe("o2b brain import-claude-memory --approval-digest (t_18fda844)", () => {
  test("non-interactive --apply without a digest refuses by name, before any write", async () => {
    const s = setupImport("o2b-cm-cli-nodigest-", { "feedback_a.md": feedbackMd("a", "A") });
    try {
      await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
      await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
      const res = await runCli([...baseArgs(s.vault, s.mem), "--apply", "--yes"], { env: s.env });
      expect(res.returncode).toBe(2);
      expect(res.stderr).toContain("--approval-digest");
      expect(existsSync(join(s.vault, "Brain", "preferences", "pref-a.md"))).toBe(false);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  });

  test("the dry-run JSON exposes the digest and apply with it lands the plan", async () => {
    const s = setupImport("o2b-cm-cli-digest-", { "feedback_a.md": feedbackMd("a", "A") });
    try {
      await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
      await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
      const dry = await runCli([...baseArgs(s.vault, s.mem), "--dry-run", "--json"], {
        env: s.env,
      });
      expect(dry.returncode).toBe(0);
      const plan = JSON.parse(dry.stdout) as {
        digest: string;
        plans: Array<{ basename: string; prefId: string; action: string }>;
      };
      expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(plan.plans).toEqual([
        { basename: "feedback_a.md", prefId: "pref-a", action: "CREATE" },
      ]);

      const apply = await runCli(
        [...baseArgs(s.vault, s.mem), "--apply", "--yes", "--approval-digest", plan.digest],
        { env: s.env },
      );
      expect(apply.returncode).toBe(0);
      expect(existsSync(join(s.vault, "Brain", "preferences", "pref-a.md"))).toBe(true);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test("--approval-digest paired with --dry-run refuses the conflicting pairing", async () => {
    // A dry run COMPUTES a digest; it cannot consume one. Accepting and
    // dropping the value would let a mis-piped script read a successful
    // dry-run exit code as "the digest was honored".
    const s = setupImport("o2b-cm-cli-digestdryrun-", { "feedback_a.md": feedbackMd("a", "A") });
    try {
      await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
      await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
      const res = await runCli(
        [...baseArgs(s.vault, s.mem), "--dry-run", "--approval-digest", "f".repeat(64)],
        { env: s.env },
      );
      expect(res.returncode).toBe(2);
      expect(res.stderr).toContain("--approval-digest");
      expect(res.stderr).toContain("--apply");
      expect(existsSync(join(s.vault, "Brain", "preferences", "pref-a.md"))).toBe(false);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  });

  test("apply with a stale digest refuses with the re-run remedy and writes nothing", async () => {
    const s = setupImport("o2b-cm-cli-staledigest-", { "feedback_a.md": feedbackMd("a", "A") });
    try {
      await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
      await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
      const dry = await runCli([...baseArgs(s.vault, s.mem), "--dry-run", "--json"], {
        env: s.env,
      });
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
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  }, 20000);
});

describe("o2b brain import-claude-memory — per-entry disposition (t_11ee559f)", () => {
  test("a numeric memory name skips its own row with the file and rule named; the other entries land", async () => {
    // One well-named entry and one whose name slugifies to a purely numeric
    // topic - exactly the value the shared tag rule refuses.
    const s = setupImport("o2b-cm-cli-numericskip-", {
      "feedback_good.md": feedbackMd("good-feedback", "Good"),
      "feedback_2024.md": feedbackMd("2024", "Numeric"),
    });
    try {
      await runCli(["init", "--vault", s.vault, "--name", "Test"], { env: s.env });
      await runCli(["brain", "init", "--vault", s.vault], { env: s.env });
      const dry = await runCli([...baseArgs(s.vault, s.mem), "--dry-run", "--json"], {
        env: s.env,
      });
      expect(dry.returncode).toBe(0);
      const plan = JSON.parse(dry.stdout) as {
        digest: string;
        plans: Array<{ basename: string; prefId: string; action: string }>;
        skipped: Array<{ basename: string; reason: string }>;
      };
      // The good entry is planned; the numeric one is a named skip row, and
      // no contradictory plan row exists for it.
      expect(plan.plans).toEqual([
        { basename: "feedback_good.md", prefId: "pref-good-feedback", action: "CREATE" },
      ]);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0]!.basename).toBe("feedback_2024.md");
      expect(plan.skipped[0]!.reason).toContain("topic:");
      expect(plan.skipped[0]!.reason).toContain("must start with a letter or underscore");
      expect(plan.skipped[0]!.reason).toContain("never only digits");
      expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);

      const apply = await runCli(
        [...baseArgs(s.vault, s.mem), "--apply", "--yes", "--approval-digest", plan.digest],
        { env: s.env },
      );
      expect(apply.returncode).toBe(0);
      expect(existsSync(join(s.vault, "Brain", "preferences", "pref-good-feedback.md"))).toBe(true);
      expect(existsSync(join(s.vault, "Brain", "preferences", "pref-2024.md"))).toBe(false);
    } finally {
      rmSync(s.tmp, { recursive: true, force: true });
    }
  }, 20000);
});

describe("o2b brain import-claude-memory — help and not-found refusals", () => {
  test("verb help names --approval-digest and --from and states the full apply requirement", async () => {
    // S10: the usage line listed every flag the verb silently accepts
    // except the two the scripted path actually needs, and the closing
    // sentence promised --yes alone, contradicting the refusal the verb
    // itself prints in non-interactive mode.
    const res = await runCli(["brain", "import-claude-memory", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("[--from <backend>]");
    expect(res.stdout).toContain("[--approval-digest <hex>]");
    expect(res.stdout).toContain(
      "--apply requires --yes and --approval-digest in\nnon-interactive mode",
    );
  });

  test("missing --memory directory refusal names the remedy", async () => {
    // S9: the refusal stopped at the missing path, leaving the operator to
    // guess whether to create it or repoint --memory.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli-missing-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    try {
      await runCli(["init", "--vault", vault, "--name", "Test"], { env });
      await runCli(["brain", "init", "--vault", vault], { env });
      const res = await runCli(
        [
          "brain",
          "import-claude-memory",
          "--vault",
          vault,
          "--memory",
          join(tmp, "nowhere"),
          "--allow-arbitrary-memory-path",
        ],
        { env },
      );
      expect(res.returncode).toBe(1);
      expect(res.stderr).toContain("memory directory not found");
      expect(res.stderr).toContain("(pass --memory with an existing directory, or create it)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("default-discovery miss names the location home-relative, not absolute", async () => {
    // S9: the default location is derived from homedir(), so the refusal
    // must not expand the operator's home into output - the sibling
    // refusal already spells the directory as ~/.claude/projects/.
    const tmp = mkdtempSync(join(tmpdir(), "o2b-cm-cli-home-"));
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const home = mkdtempSync(join(tmpdir(), "o2b-cm-cli-home-dir-"));
    const env = { OPEN_SECOND_BRAIN_CONFIG: config, HOME: home };
    try {
      await runCli(["init", "--vault", vault, "--name", "Test"], { env });
      await runCli(["brain", "init", "--vault", vault], { env });
      const res = await runCli(["brain", "import-claude-memory", "--vault", vault], { env });
      expect(res.returncode).toBe(1);
      expect(res.stderr).toContain("memory directory not found: ~/.claude/projects/");
      expect(res.stderr).not.toContain(home);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
