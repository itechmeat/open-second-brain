import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("--apply writes files and exits 0", async () => {
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
});
