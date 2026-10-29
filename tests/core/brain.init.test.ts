import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/config-template.ts";
import { runDoctor } from "../../src/core/brain/doctor.ts";
import {
  GITIGNORE_GUARD_IGNORE_LINE,
  GIT_TRACKED_DERIVED_STATE_CODE,
} from "../../src/core/brain/doctor/git-tracked-state-check.ts";
import { DEFAULT_BEGIN_MARKER, DEFAULT_END_MARKER } from "../../src/core/install/managed-block.ts";

// Shared temp scratch for both vault and machine-config directories.
// Tests that need to assert the "missing machine config" path can
// override `configPath` explicitly to point at a non-existent file.

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-brain-init-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-init-cfg-"));
  configPath = join(configHome, "config.yaml");
  // A minimal but valid plugin config: just the vault pointer. This
  // mirrors what `o2b init` writes during normal onboarding.
  mkdirSync(configHome, { recursive: true });
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Run `fn`, capturing everything it writes to stderr; restore afterwards. */
function captureStderr(fn: () => unknown): { stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return { stderr: captured };
}

describe("bootstrapBrain — empty vault", () => {
  test("creates every Brain directory and the three managed files", () => {
    const result = bootstrapBrain(vault, { configPath });

    // Directories: EVERY entry in brainDirs() must exist as a real dir.
    // Enumerated from the struct rather than from a hand-written list, so
    // a directory added to `brainDirs` cannot be declared and then left
    // uncreated — which is exactly how `pending` and `entities` went
    // missing (downstream writers made them lazily instead).
    const dirs = brainDirs(vault);
    for (const [name, dir] of Object.entries(dirs)) {
      expect(`${name}:${existsSync(dir)}`).toBe(`${name}:true`);
      expect(statSync(dir).isDirectory()).toBe(true);
    }

    // Files: _brain.yaml, _BRAIN.md. (No more AI Wiki/_OPEN_SECOND_BRAIN.md
    // in v0.11.0; the operating manual lives at Brain/_BRAIN.md only.)
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "_BRAIN.md"))).toBe(true);
    // The vault identity marker is stamped by the bootstrap path
    // (context-integrity-gates, Unit J).
    expect(existsSync(join(vault, "Brain", "vault-id.json"))).toBe(true);

    // Counts: eight created (vault-id.json, _brain.yaml, _BRAIN.md, the
    // four Brain/bases/*.base view definitions stamped at init, and the
    // seeded .gitignore guard), none overwritten, none skipped.
    expect(result.created.length).toBe(8);
    expect(result.created).toContain(".gitignore");
    expect(result.overwritten.length).toBe(0);
    expect(result.skipped.length).toBe(0);
    // The guard outcome is carried structurally, so machine readers can
    // tell a clean seed from an unresolved one without parsing stderr.
    expect(result.guard).toEqual({ status: "created" });

    // _brain.yaml byte-equals the default constant.
    expect(readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8")).toBe(
      DEFAULT_BRAIN_CONFIG_YAML,
    );

    // _BRAIN.md carries a recognisable headline so the test catches a
    // wrong-template / no-substitution regression cheaply.
    const manual = readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8");
    expect(manual).toContain("# Brain — operating manual");
  });
});

describe("bootstrapBrain — idempotent rerun", () => {
  test("second invocation without force skips both Brain/ files", () => {
    // First run sets the baseline.
    bootstrapBrain(vault, { configPath });

    // Mutate _brain.yaml and _BRAIN.md to detect any accidental
    // overwrite on the second pass.
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "user: edited\n", "utf8");
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "user manual edits\n", "utf8");

    const second = bootstrapBrain(vault, { configPath });

    // Brain-side: both files skipped, content intact.
    expect(second.skipped).toContain(posix.join("Brain", "_brain.yaml"));
    expect(second.skipped).toContain(posix.join("Brain", "_BRAIN.md"));
    expect(readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8")).toBe("user: edited\n");
    expect(readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8")).toBe("user manual edits\n");

    // Nothing newly created or overwritten on the second run.
    expect(second.created.length).toBe(0);
    expect(second.overwritten.length).toBe(0);
  });

  test("directories are recreated idempotently with no error", () => {
    bootstrapBrain(vault, { configPath });
    // Second pass must not throw even though every directory exists.
    expect(() => bootstrapBrain(vault, { configPath })).not.toThrow();
  });

  test("a directory created by hand between runs survives the second pass", () => {
    bootstrapBrain(vault, { configPath });
    const dirs = brainDirs(vault);
    // Drop a marker into each declared directory; a second bootstrap must
    // leave every one of them in place (mkdir -p, never mkdir -p after rm).
    for (const dir of Object.values(dirs)) {
      writeFileSync(join(dir, "marker.txt"), "kept\n", "utf8");
    }
    const second = bootstrapBrain(vault, { configPath });
    expect(second.created.length).toBe(0);
    expect(second.overwritten.length).toBe(0);
    for (const dir of Object.values(dirs)) {
      expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("kept\n");
    }
  });
});

describe("bootstrapBrain — force overwrite", () => {
  test("force: true rewrites both managed files", () => {
    bootstrapBrain(vault, { configPath });

    // Stomp on the canonical content so we can detect the rewrite.
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "stale\n", "utf8");
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n", "utf8");

    const result = bootstrapBrain(vault, { configPath, force: true });

    expect(result.overwritten).toContain(posix.join("Brain", "_brain.yaml"));
    expect(result.overwritten).toContain(posix.join("Brain", "_BRAIN.md"));
    // The gitignore guard does not take part in force: a managed block
    // merge never rewrites over the operator's file, so the second run
    // leaves it in skipped (t_206562ae) — a CLEAN skip, reflected in the
    // guard outcome.
    expect(result.skipped).toEqual([".gitignore"]);
    expect(result.guard?.status).toBe("skipped");

    expect(readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8")).toBe(
      DEFAULT_BRAIN_CONFIG_YAML,
    );
    expect(readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8")).not.toBe("stale\n");
  });
});

describe("bootstrapBrain — primary_agent option", () => {
  test("fresh init writes the supplied primary_agent into _brain.yaml", () => {
    bootstrapBrain(vault, { configPath, primaryAgent: "hermes-vps" });
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "hermes-vps"$/m);
    expect(yaml).not.toMatch(/^primary_agent: null$/m);
  });

  test("fresh init preserves comment-like primary_agent values by quoting", () => {
    bootstrapBrain(vault, {
      configPath,
      primaryAgent: "hermes lead # primary",
    });
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "hermes lead # primary"$/m);
  });

  test("default keeps primary_agent: null", () => {
    bootstrapBrain(vault, { configPath });
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: null$/m);
  });

  test("re-run without primaryAgent preserves the existing line", () => {
    bootstrapBrain(vault, { configPath, primaryAgent: "hermes-vps" });
    bootstrapBrain(vault, { configPath });
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "hermes-vps"$/m);
  });

  test("force rewrite with primaryAgent overrides the file", () => {
    bootstrapBrain(vault, { configPath });
    bootstrapBrain(vault, { configPath, force: true, primaryAgent: "claude-vps" });
    const yaml = readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
    expect(yaml).toMatch(/^primary_agent: "claude-vps"$/m);
  });

  test("empty-string primaryAgent throws (fail loud, not silent fallback)", () => {
    expect(() => bootstrapBrain(vault, { configPath, primaryAgent: "   " })).toThrow(
      /primary_agent/,
    );
  });

  test("primaryAgent with a line break is rejected instead of corrupting YAML", () => {
    expect(() => bootstrapBrain(vault, { configPath, primaryAgent: "agent\nsnapshots:" })).toThrow(
      /disallowed character/,
    );
  });
});

describe("bootstrapBrain — missing machine config", () => {
  test("throws an error naming `o2b init` when the plugin config does not exist", () => {
    const missing = join(configHome, "does-not-exist.yaml");
    expect(() => bootstrapBrain(vault, { configPath: missing })).toThrow(/o2b init/);
  });

  test("error message includes the resolved config path", () => {
    const missing = join(configHome, "phantom-cfg.yaml");
    let captured: Error | null = null;
    try {
      bootstrapBrain(vault, { configPath: missing });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured?.message).toContain(missing);
  });
});

describe("bootstrapBrain — _BRAIN.md compliance ceiling", () => {
  test("rendered Brain manual is strictly under 200 lines", () => {
    bootstrapBrain(vault, { configPath });
    const manual = readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8");
    // Count newline-terminated lines plus any trailing fragment. A file
    // ending in `\n` and one ending without it should both report the
    // user-visible line count.
    const lines = manual.split("\n");
    const lineCount = manual.endsWith("\n") && lines.length > 0 ? lines.length - 1 : lines.length;
    expect(lineCount).toBeLessThan(200);
  });
});

describe("bootstrapBrain — Bases view definitions", () => {
  const BASE_FILES = ["projects.base", "people.base", "tasks.base", "daily.base"] as const;

  test("stamps all four .base files into Brain/bases/ on a fresh vault", () => {
    const result = bootstrapBrain(vault, { configPath });

    for (const name of BASE_FILES) {
      const path = join(vault, "Brain", "bases", name);
      expect(existsSync(path)).toBe(true);
      expect(result.created).toContain(posix.join("Brain", "bases", name));
    }
  });

  test("each stamped base targets the matching Brain collection", () => {
    bootstrapBrain(vault, { configPath });
    const read = (name: string) => readFileSync(join(vault, "Brain", "bases", name), "utf8");

    expect(read("projects.base")).toContain('file.inFolder("Brain/entities/project")');
    expect(read("people.base")).toContain('file.inFolder("Brain/entities/person")');
    expect(read("tasks.base")).toContain('file.inFolder("Brain/obligations")');
    expect(read("daily.base")).toContain('file.inFolder("Brain/log")');
  });

  test("rerun without force leaves operator edits to a base intact", () => {
    bootstrapBrain(vault, { configPath });
    const edited = join(vault, "Brain", "bases", "projects.base");
    writeFileSync(edited, "user: edited\n", "utf8");

    const second = bootstrapBrain(vault, { configPath });

    expect(second.skipped).toContain(posix.join("Brain", "bases", "projects.base"));
    expect(readFileSync(edited, "utf8")).toBe("user: edited\n");
  });

  test("force rewrites a stomped base back to the canonical template", () => {
    bootstrapBrain(vault, { configPath });
    const stomped = join(vault, "Brain", "bases", "daily.base");
    writeFileSync(stomped, "stale\n", "utf8");

    const result = bootstrapBrain(vault, { configPath, force: true });

    expect(result.overwritten).toContain(posix.join("Brain", "bases", "daily.base"));
    expect(readFileSync(stomped, "utf8")).toContain('file.inFolder("Brain/log")');
  });
});

describe("bootstrapBrain — gitignore guard (t_206562ae)", () => {
  /** `git` in the vault; git is on PATH everywhere this suite runs. */
  function git(...args: string[]): void {
    Bun.spawnSync(["git", ...args], { cwd: vault, stdout: "ignore", stderr: "ignore" });
  }

  function porcelain(): string {
    return Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: vault,
      stdout: "pipe",
      stderr: "ignore",
    })
      .stdout.toString()
      .replace(/\r\n/g, "\n");
  }

  test("fresh init seeds the guard block beside the identity stamp", () => {
    const result = bootstrapBrain(vault, { configPath });
    const content = readFileSync(join(vault, ".gitignore"), "utf8");
    expect(result.created).toContain(".gitignore");
    expect(content).toContain(DEFAULT_BEGIN_MARKER);
    expect(content).toContain("/.open-second-brain/");
    expect(content).toContain(DEFAULT_END_MARKER);
  });

  test("derived runtime state created after init never shows as git dirt", () => {
    // A real repository: init, then commit the vault as the operator
    // would, then let the runtime create the derived store. Without the
    // seeded guard the store shows as untracked dirt here.
    bootstrapBrain(vault, { configPath });
    git("init");
    git("add", "-A");
    git("-c", "user.email=o2b@example.com", "-c", "user.name=o2b", "commit", "-m", "vault");
    expect(porcelain()).toBe("");

    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "bytes", "utf8");
    expect(porcelain()).toBe("");
    expect(existsSync(join(vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
  });

  test("a second init reports no creations and stays byte-identical on .gitignore", () => {
    bootstrapBrain(vault, { configPath });
    const before = readFileSync(join(vault, ".gitignore"), "utf8");
    const second = bootstrapBrain(vault, { configPath });
    expect(second.created).not.toContain(".gitignore");
    expect(second.created.length).toBe(0);
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe(before);
  });

  test("a pre-existing user .gitignore survives init byte-preserved outside the block", () => {
    const user = "# my patterns\n*.tmp\n.obsidian/workspace.json\n";
    writeFileSync(join(vault, ".gitignore"), user, "utf8");
    const result = bootstrapBrain(vault, { configPath });
    const content = readFileSync(join(vault, ".gitignore"), "utf8");
    expect(content.startsWith(user)).toBe(true);
    expect(content).toContain(DEFAULT_BEGIN_MARKER);
    expect(result.created).not.toContain(".gitignore");
  });

  test("init into a non-git folder succeeds identically — no git dependency at init", () => {
    // The default fixtures here are plain temp dirs (no git), so this is
    // the non-git path: the seeder runs, git is never consulted, and the
    // result reports the created .gitignore like any other step.
    const result = bootstrapBrain(vault, { configPath });
    expect(result.created).toContain(".gitignore");
    expect(existsSync(join(vault, ".gitignore"))).toBe(true);
  });
});

describe("bootstrapBrain — gitignore guard degradation (warn-and-continue)", () => {
  /** `git` in the vault; git is on PATH everywhere this suite runs. */
  function git(...args: string[]): void {
    const run = Bun.spawnSync(["git", ...args], { cwd: vault, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
    }
  }

  test("a directory .gitignore cannot abort the bootstrap: warn, report skipped, continue", () => {
    // A chmod-denied, mandatory-locked or directory .gitignore used to
    // kill init midway — after the Brain dirs and the identity stamp
    // were written, before _brain.yaml existed: a half-bootstrapped
    // vault, taken down by a hygiene write the doctor reports anyway.
    mkdirSync(join(vault, ".gitignore"), { recursive: true });

    let result!: ReturnType<typeof bootstrapBrain>;
    const { stderr } = captureStderr(() => {
      result = bootstrapBrain(vault, { configPath });
    });

    // The bootstrap completed: the managed files below the guard exist.
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "_BRAIN.md"))).toBe(true);

    // The result names the guard failure: the file is skipped and the
    // guard outcome is "failed" with a detail, not a clean skip.
    expect(result.skipped).toContain(".gitignore");
    expect(result.created).not.toContain(".gitignore");
    expect(result.guard?.status).toBe("failed");
    expect(typeof result.guard?.detail).toBe("string");
    expect((result.guard?.detail ?? "").length).toBeGreaterThan(0);

    // ...and the degradation is visible on stderr, named.
    expect(stderr).toMatch(/warning:/);
    expect(stderr).toContain(".gitignore");
  });

  test("a malformed managed block reports a named conflict, not a plain skip", () => {
    // Nothing is written and the seeder warns, but the result used to
    // say plain `skipped` — indistinguishable from "already covered".
    const broken = "# mine\n# >>> open-second-brain managed >>>\n*.tmp\n";
    writeFileSync(join(vault, ".gitignore"), broken, "utf8");

    let result!: ReturnType<typeof bootstrapBrain>;
    const { stderr } = captureStderr(() => {
      result = bootstrapBrain(vault, { configPath });
    });

    // Bootstrap continued past the guard.
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    // The file is exactly as the operator left it and reports as skipped...
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe(broken);
    expect(result.skipped).toContain(".gitignore");
    expect(result.created).not.toContain(".gitignore");
    expect(result.overwritten).not.toContain(".gitignore");
    // ...but the guard outcome distinguishes the conflict from a clean
    // skip, for stderr readers and machine readers alike.
    expect(result.guard?.status).toBe("conflict");
    expect(typeof result.guard?.detail).toBe("string");
    expect((result.guard?.detail ?? "").length).toBeGreaterThan(0);
    expect(stderr).toMatch(/warning:/);
    expect(stderr).toContain("derived-brain-state");
  });

  test("a hostile .gitignore that negates the entry after it is a conflict, not a clean skip", () => {
    // git last-match-wins: the entry is present, so the seeder's
    // exact-line check used to report a clean skip while the store was
    // NOT ignored. The init report carries the conflict instead.
    const hostile = "/.open-second-brain/\n*.tmp\n!.open-second-brain\n";
    writeFileSync(join(vault, ".gitignore"), hostile, "utf8");

    let result!: ReturnType<typeof bootstrapBrain>;
    captureStderr(() => {
      result = bootstrapBrain(vault, { configPath });
    });

    // Bootstrap continued; nothing was written to the operator's file.
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe(hostile);
    expect(result.skipped).toContain(".gitignore");
    expect(result.created).not.toContain(".gitignore");
    expect(result.overwritten).not.toContain(".gitignore");
    expect(result.guard?.status).toBe("conflict");
    expect(result.guard?.detail).toContain("!.open-second-brain");
  });

  test("the doctor's tracked-state row reports the state a failed guard left behind", () => {
    // Init degraded past the unwritable guard; the protection the guard
    // would have seeded is genuinely absent, and the doctor's row is the
    // thing that says so — exactly what the step's docblock claims.
    mkdirSync(join(vault, ".gitignore"), { recursive: true });
    captureStderr(() => bootstrapBrain(vault, { configPath }));

    git("init");
    git(
      "-c",
      "user.email=o2b@example.com",
      "-c",
      "user.name=o2b",
      "-c",
      "commit.gpgsign=false",
      "add",
      "-A",
    );
    git(
      "-c",
      "user.email=o2b@example.com",
      "-c",
      "user.name=o2b",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "vault",
    );
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "bytes", "utf8");

    const report = runDoctor(vault);
    const rows = report.warnings.filter((i) => i.code === GIT_TRACKED_DERIVED_STATE_CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain(GITIGNORE_GUARD_IGNORE_LINE);
  }, 20000);
});
