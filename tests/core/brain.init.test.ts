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
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";

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

describe("bootstrapBrain — empty vault", () => {
  test("creates every Brain directory and the three managed files", () => {
    const result = bootstrapBrain(vault, { configPath });

    // Directories: every entry in brainDirs() must exist as a real dir.
    const dirs = brainDirs(vault);
    for (const dir of [
      dirs.brain,
      dirs.inbox,
      dirs.processed,
      dirs.preferences,
      dirs.retired,
      dirs.log,
      dirs.bases,
      dirs.snapshots,
    ]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }

    // Files: _brain.yaml, _BRAIN.md. (No more AI Wiki/_OPEN_SECOND_BRAIN.md
    // in v0.11.0; the operating manual lives at Brain/_BRAIN.md only.)
    expect(existsSync(join(vault, "Brain", "_brain.yaml"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "_BRAIN.md"))).toBe(true);

    // Counts: six created (_brain.yaml, _BRAIN.md, and the four
    // Brain/bases/*.base view definitions stamped at init), none
    // overwritten, none skipped.
    expect(result.created.length).toBe(6);
    expect(result.overwritten.length).toBe(0);
    expect(result.skipped.length).toBe(0);

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
    expect(second.skipped).toContain(join("Brain", "_brain.yaml"));
    expect(second.skipped).toContain(join("Brain", "_BRAIN.md"));
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
});

describe("bootstrapBrain — force overwrite", () => {
  test("force: true rewrites both managed files", () => {
    bootstrapBrain(vault, { configPath });

    // Stomp on the canonical content so we can detect the rewrite.
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "stale\n", "utf8");
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n", "utf8");

    const result = bootstrapBrain(vault, { configPath, force: true });

    expect(result.overwritten).toContain(join("Brain", "_brain.yaml"));
    expect(result.overwritten).toContain(join("Brain", "_BRAIN.md"));
    expect(result.skipped.length).toBe(0);

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
      expect(result.created).toContain(join("Brain", "bases", name));
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

    expect(second.skipped).toContain(join("Brain", "bases", "projects.base"));
    expect(readFileSync(edited, "utf8")).toBe("user: edited\n");
  });

  test("force rewrites a stomped base back to the canonical template", () => {
    bootstrapBrain(vault, { configPath });
    const stomped = join(vault, "Brain", "bases", "daily.base");
    writeFileSync(stomped, "stale\n", "utf8");

    const result = bootstrapBrain(vault, { configPath, force: true });

    expect(result.overwritten).toContain(join("Brain", "bases", "daily.base"));
    expect(readFileSync(stomped, "utf8")).toContain('file.inFolder("Brain/log")');
  });
});
