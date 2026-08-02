/**
 * The config-declared write binding over caller-named write paths
 * (provenance-at-the-boundary, unit B).
 *
 * Three properties are under test, and the third is the one that makes
 * the other two mean anything:
 *
 *   1. ABSENT IS INERT. No `write_binding:` block - and a block that
 *      declares no `path_prefixes` - leaves every write path exactly as
 *      it was. Proved by running the three caller-named writes against a
 *      vault with no config at all and against a vault whose config
 *      omits the block, and comparing both against the PRE-FEATURE bytes
 *      in {@link GOLDEN_ABSENT_BINDING_BYTES}. The two runs are also
 *      compared to each other, but that comparison is the weaker of the
 *      two: both are the same inert path, so a change to the shared write
 *      envelope shows up in both and only the golden catches it.
 *   2. DECLARED REFUSES OUTSIDE, ADMITS INSIDE, on all four caller-named
 *      surfaces (`createNote`, and the update / append / batch arms that
 *      share its envelope).
 *   3. THE AUTHORITY IS THE CONFIG FILE, NOT THE CALLER'S CLAIM. This
 *      system has no credential: agent identity is an environment
 *      variable, else a config key, else the literal `agent`, and
 *      twenty-two MCP tool schemas across fifteen modules accept a
 *      caller-supplied `agent` string that
 *      overrides it verbatim. A fence keyed to that would be bypassed by
 *      passing a different string, so the binding never reads it - and
 *      that is asserted here by passing a different one and by moving
 *      the environment variable underneath the same call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WRITE_BINDING_REFUSED_CODE,
  checkWriteBinding,
  normaliseWriteBindingPrefix,
  resolveWriteBinding,
  writeBindingAdmits,
  writeBindingPrefixCovers,
} from "../../src/core/write-binding/index.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { CreateNoteError, createNote } from "../../src/core/brain/notes/create-note.ts";
import { WriteBatchError, applyWriteBatch } from "../../src/core/brain/write-batch.ts";
import { BrainConfigError } from "../../src/core/brain/policy.ts";
import { validateBrainConfig } from "../../src/core/brain/policy.ts";
import { parseBrainYaml } from "../../src/core/brain/yaml-parse.ts";
import { runCli } from "../helpers/run-cli.ts";

/** A caller-named note path that no declared prefix in these tests admits. */
const OUTSIDE_PATH = "Elsewhere/Note.md";
/** A caller-named note path under the prefix the tests declare. */
const INSIDE_PATH = "Projects/Note.md";
/** The single prefix the declared-binding fixtures use. */
const PREFIX = "Projects";

/**
 * The exact bytes the three caller-named write arms left behind BEFORE
 * this unit existed, captured by running the same sequence against the
 * store as it stood at HEAD~ of the binding.
 *
 * Pinned as literals on purpose. Comparing one absent-binding run against
 * another absent-binding run - which is what "no config file" versus "a
 * config without the block" are, both of them the same inert path - can
 * only show the two agree; a change to the shared write envelope every
 * caller-named write funnels through moves BOTH arms identically and the
 * comparison stays green. Only a fixed pre-feature reference can see it.
 */
const GOLDEN_ABSENT_BINDING_BYTES: Readonly<Record<string, string>> = Object.freeze({
  /** `createNote`, then the batch `update_note` and `append_note` arms. */
  outside: "---\ntitle: T\ntag: x\n---\n\nbody\n\nmore\n",
  /** The batch `create_note` arm. */
  inside: "---\n---\n\ninside\n",
});

const AGENT_ENV = "VAULT_AGENT_NAME";

let vault: string;

function writeBrainConfig(root: string, yaml: string): void {
  mkdirSync(join(root, "Brain"), { recursive: true });
  writeFileSync(join(root, "Brain", "_brain.yaml"), yaml, "utf8");
}

/** `_brain.yaml` declaring exactly one write-binding prefix. */
function declaredBindingYaml(...prefixes: ReadonlyArray<string>): string {
  return `schema_version: 1\nwrite_binding:\n  path_prefixes:\n${prefixes
    .map((p) => `    - ${p}\n`)
    .join("")}`;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-binding-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("the binding is absent unless the operator declares it", () => {
  test("a vault with no Brain config has no binding", () => {
    expect(resolveWriteBinding(vault)).toBeNull();
    expect(checkWriteBinding(vault, OUTSIDE_PATH)).toBeNull();
  });

  test("a config without the block has no binding", () => {
    writeBrainConfig(vault, "schema_version: 1\n");
    expect(resolveWriteBinding(vault)).toBeNull();
    expect(checkWriteBinding(vault, OUTSIDE_PATH)).toBeNull();
  });

  test("a block that declares no path_prefixes has no binding", () => {
    // Present-but-empty BLOCK is not a declaration of anything: the key
    // the binding is made of is absent, exactly as `vault:` treats a
    // missing `ignore_paths`.
    writeBrainConfig(vault, "schema_version: 1\nwrite_binding:\n  other_key: 1\n");
    expect(resolveWriteBinding(vault)).toBeNull();
    expect(checkWriteBinding(vault, OUTSIDE_PATH)).toBeNull();
  });

  test("an empty prefix list is refused at load rather than silently admitting nothing", () => {
    // A list that admits no path is an off switch wearing a binding's
    // clothes; the operator turns the binding off by removing the block.
    expect(() =>
      validateBrainConfig(
        parseBrainYaml("schema_version: 1\nwrite_binding:\n  path_prefixes: []\n"),
        "<test>",
      ),
    ).toThrow(BrainConfigError);
  });
});

describe("absent binding is byte-identical on every caller-named write path", () => {
  /** Run the three caller-named write arms and return what landed. */
  function runAllWritePaths(root: string): Record<string, string> {
    createNote(root, { path: OUTSIDE_PATH, frontmatter: { title: "T" }, content: "body" });
    applyWriteBatch(root, [
      { kind: "update_note", path: OUTSIDE_PATH, frontmatter: { tag: "x" } },
      { kind: "create_note", path: INSIDE_PATH, content: "inside" },
    ]);
    applyWriteBatch(root, [{ kind: "append_note", path: OUTSIDE_PATH, content: "more" }]);
    return {
      outside: readFileSync(join(root, OUTSIDE_PATH), "utf8"),
      inside: readFileSync(join(root, INSIDE_PATH), "utf8"),
    };
  }

  test("a vault with no config at all writes the pre-feature bytes", () => {
    expect(runAllWritePaths(vault)).toEqual({ ...GOLDEN_ABSENT_BINDING_BYTES });
  });

  test("a config without the block writes the same pre-feature bytes", () => {
    const withConfig = mkdtempSync(join(tmpdir(), "o2b-write-binding-cfg-"));
    try {
      writeBrainConfig(withConfig, "schema_version: 1\n");
      const written = runAllWritePaths(withConfig);
      expect(written).toEqual({ ...GOLDEN_ABSENT_BINDING_BYTES });
      // And the two inert arms still agree with each other, which is the
      // property the golden alone does not state.
      expect(written).toEqual(runAllWritePaths(vault));
    } finally {
      rmSync(withConfig, { recursive: true, force: true });
    }
  });
});

describe("a declared binding is rooted and segment-wise", () => {
  test("the prefix admits itself and its descendants", () => {
    const binding = { pathPrefixes: [PREFIX] };
    expect(writeBindingAdmits(binding, "Projects")).toBe(true);
    expect(writeBindingAdmits(binding, "Projects/Note.md")).toBe(true);
    expect(writeBindingAdmits(binding, "Projects/deep/nested/Note.md")).toBe(true);
  });

  test("a longer sibling name is not a descendant", () => {
    // Character-prefix matching would admit `ProjectsArchive/`; segment
    // matching is what makes the declaration mean the folder.
    expect(writeBindingAdmits({ pathPrefixes: [PREFIX] }, "ProjectsArchive/Note.md")).toBe(false);
  });

  test("a path under no declared prefix is refused", () => {
    expect(writeBindingAdmits({ pathPrefixes: [PREFIX] }, OUTSIDE_PATH)).toBe(false);
  });

  test("any one of several prefixes admits", () => {
    const binding = { pathPrefixes: ["Projects", "Journal/Weekly"] };
    expect(writeBindingAdmits(binding, "Journal/Weekly/W1.md")).toBe(true);
    expect(writeBindingAdmits(binding, "Journal/Daily/D1.md")).toBe(false);
  });
});

describe("a declared binding refuses caller-named writes outside it", () => {
  beforeEach(() => writeBrainConfig(vault, declaredBindingYaml(PREFIX)));

  test("createNote refuses outside and admits inside", () => {
    expect(() => createNote(vault, { path: OUTSIDE_PATH, content: "x" })).toThrow(CreateNoteError);
    const res = createNote(vault, { path: INSIDE_PATH, content: "x" });
    expect(res.created).toBe(true);
  });

  test("the refusal carries the registered code and names the declared prefixes", () => {
    let caught: CreateNoteError | null = null;
    try {
      createNote(vault, { path: OUTSIDE_PATH, content: "x" });
    } catch (err) {
      caught = err as CreateNoteError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("write_binding");
    expect(caught!.message).toContain(PREFIX);
    expect(caught!.message).toContain(OUTSIDE_PATH);
  });

  test("the refusal names the exit its registered code resolves to", () => {
    const step = resolveNextStep(WRITE_BINDING_REFUSED_CODE);
    expect(step).not.toBeNull();
    const refusal = checkWriteBinding(vault, OUTSIDE_PATH);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe(WRITE_BINDING_REFUSED_CODE);
    expect(refusal!.nextCommand).toBe(step!.nextCommand);
    expect(refusal!.message).toContain(step!.nextCommand);
  });

  test("the batch update and append arms are refused before any write", () => {
    createNote(vault, { path: INSIDE_PATH, content: "x" });
    // Seed a target outside the binding by hand, so the refusal cannot be
    // mistaken for a missing-target error.
    mkdirSync(join(vault, "Elsewhere"), { recursive: true });
    writeFileSync(join(vault, OUTSIDE_PATH), "---\n---\n\nseed\n", "utf8");

    for (const op of [
      { kind: "update_note", path: OUTSIDE_PATH, body: "replaced" },
      { kind: "append_note", path: OUTSIDE_PATH, content: "appended" },
      { kind: "create_note", path: "Elsewhere/Fresh.md", content: "x" },
    ] as const) {
      let caught: WriteBatchError | null = null;
      try {
        applyWriteBatch(vault, [op]);
      } catch (err) {
        caught = err as WriteBatchError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("write_binding");
    }
    // Nothing landed: the seeded file is untouched and no new file exists.
    expect(readFileSync(join(vault, OUTSIDE_PATH), "utf8")).toBe("---\n---\n\nseed\n");
  });

  test("a batch aborts entirely when one operation lands outside the binding", () => {
    expect(() =>
      applyWriteBatch(vault, [
        { kind: "create_note", path: INSIDE_PATH, content: "inside" },
        { kind: "create_note", path: OUTSIDE_PATH, content: "outside" },
      ]),
    ).toThrow(WriteBatchError);
    // Validate-all-then-commit: the admitted operation must not have run.
    expect(() => readFileSync(join(vault, INSIDE_PATH), "utf8")).toThrow();
  });
});

describe("the caller's claimed identity cannot widen the binding", () => {
  beforeEach(() => writeBrainConfig(vault, declaredBindingYaml(PREFIX)));

  test("a caller-supplied agent string on the same batch does not widen it", () => {
    // `brain_write_batch` accepts a caller-supplied `agent` on its
    // evidence and log-line operations, and it is taken verbatim. The
    // binding never reads it, so an operation outside the binding is
    // refused with the same code whichever name rides along.
    const codes = ["agent", "someone-else", ""].map((agent) => {
      try {
        applyWriteBatch(vault, [
          { kind: "append_log_line", input: { text: "note", agent } },
          { kind: "create_note", path: OUTSIDE_PATH, content: "x" },
        ]);
        return "not-refused";
      } catch (err) {
        return (err as WriteBatchError).code;
      }
    });
    expect(codes).toEqual(["write_binding", "write_binding", "write_binding"]);
  });

  test("moving the identity environment variable does not widen it", () => {
    const before = process.env[AGENT_ENV];
    try {
      for (const name of ["agent", "operator", "root"]) {
        process.env[AGENT_ENV] = name;
        const refusal = checkWriteBinding(vault, OUTSIDE_PATH);
        expect(refusal?.code).toBe(WRITE_BINDING_REFUSED_CODE);
      }
    } finally {
      if (before === undefined) delete process.env[AGENT_ENV];
      else process.env[AGENT_ENV] = before;
    }
  });
});

describe("the registered exit answers the question the refusal raises", () => {
  // The rail forbids inventing a command, and a command that does not
  // report the binding would be an invented one in all but name. So the
  // exit this code resolves to is driven here, end to end, against a
  // path the binding refuses.
  test("`o2b vault inspect` reports the binding verdict and the declared prefixes", async () => {
    writeBrainConfig(vault, declaredBindingYaml(PREFIX));
    const configPath = join(vault, "cli-config.yaml");
    const run = await runCli(["vault", "inspect", OUTSIDE_PATH, "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(run.returncode).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      write_binding: { declared: boolean; admits: boolean; path_prefixes: string[] };
    };
    expect(payload.write_binding).toEqual({
      declared: true,
      admits: false,
      path_prefixes: [PREFIX],
    });
  });

  test("an undeclared binding reads as undeclared, not as admitted", () => {
    // The third state. Reporting `admits: true` for a vault that never
    // declared a binding would tell an operator a boundary is holding
    // when none exists.
    expect(resolveWriteBinding(vault)).toBeNull();
  });
});

describe("prefix declarations are validated at load", () => {
  for (const [label, raw] of [
    ["a leading slash", "/Projects"],
    ["a traversal segment", "Projects/../etc"],
    ["an empty entry", '""'],
  ] as const) {
    test(`${label} is refused`, () => {
      expect(() =>
        validateBrainConfig(
          parseBrainYaml(`schema_version: 1\nwrite_binding:\n  path_prefixes:\n    - ${raw}\n`),
          "<test>",
        ),
      ).toThrow(BrainConfigError);
    });
  }

  test("a declared prefix normalises to its POSIX vault-relative form", () => {
    writeBrainConfig(vault, declaredBindingYaml("./Projects/"));
    expect(resolveWriteBinding(vault)?.pathPrefixes).toEqual(["Projects"]);
  });
});

describe("the binding is checked against where the bytes land, not the name given", () => {
  // Defect 1 of the v1.43.0 security review. `checkWriteBinding` used to
  // compare the LEXICAL relative path, so one symlink under a declared
  // prefix turned the binding into "may write anywhere in the vault" and
  // the success payload named a path that did not hold the bytes.
  const LINK_PATH = "Projects/link/escaped.md";

  /** `<vault>/Projects/link` -> `<vault>/Journal`, both inside the vault. */
  function linkProjectsToJournal(root: string): void {
    mkdirSync(join(root, "Projects"), { recursive: true });
    mkdirSync(join(root, "Journal"), { recursive: true });
    symlinkSync(join(root, "Journal"), join(root, "Projects", "link"));
  }

  test("a symlinked directory under a declared prefix does not widen it", () => {
    writeBrainConfig(vault, declaredBindingYaml(PREFIX));
    linkProjectsToJournal(vault);
    let caught: CreateNoteError | null = null;
    try {
      createNote(vault, { path: LINK_PATH, content: "x" });
    } catch (err) {
      caught = err as CreateNoteError;
    }
    expect(caught?.code).toBe("write_binding");
    expect(readdirSync(join(vault, "Journal"))).toEqual([]);
  });

  test("the refusal names the destination the bytes would have reached", () => {
    writeBrainConfig(vault, declaredBindingYaml(PREFIX));
    linkProjectsToJournal(vault);
    const refusal = checkWriteBinding(vault, LINK_PATH);
    expect(refusal).not.toBeNull();
    expect(refusal!.resolvedRelPath).toBe("Journal/escaped.md");
    expect(refusal!.message).toContain("Journal/escaped.md");
    expect(refusal!.message).toContain(LINK_PATH);
  });

  test("a symlink that stays inside the declared prefix is still admitted", () => {
    writeBrainConfig(vault, declaredBindingYaml(PREFIX));
    mkdirSync(join(vault, "Projects", "real"), { recursive: true });
    symlinkSync(join(vault, "Projects", "real"), join(vault, "Projects", "alias"));
    expect(checkWriteBinding(vault, "Projects/alias/Note.md")).toBeNull();
  });

  test("with no binding declared the same symlink write is untouched", () => {
    // Absent stays byte-identical: the realpath comparison is reached
    // only once a binding exists, so an unbound vault behaves exactly as
    // it did before the key existed.
    linkProjectsToJournal(vault);
    const res = createNote(vault, { path: LINK_PATH, content: "x" });
    expect(res.path).toBe(LINK_PATH);
    expect(readdirSync(join(vault, "Journal"))).toEqual(["escaped.md"]);
  });
});

describe("a backslash is a filename character on POSIX, not a separator", () => {
  // Defect 2 of the v1.43.0 security review. The matcher split on
  // `[\\/]`, so a binding on `Projects` admitted `Projects\evil.md` -
  // which on Linux is one filename that lands at the VAULT ROOT.
  test("the matcher does not read a backslash as a segment boundary", () => {
    expect(writeBindingPrefixCovers(PREFIX, "Projects\\evil.md")).toBe(false);
    expect(writeBindingPrefixCovers(PREFIX, "Projects/evil.md")).toBe(true);
  });

  test("a declared prefix keeps its POSIX segments", () => {
    expect(normaliseWriteBindingPrefix("./Projects//Sub/")).toBe("Projects/Sub");
  });
});

describe("a config that does not load is a typed refusal, not a server fault", () => {
  // Defect 3 of the v1.43.0 security review. A `_brain.yaml` that fails
  // validation made every caller-named write throw a raw BrainConfigError
  // carrying an ABSOLUTE host path, with no registered next step.
  const MALFORMED = "schema_version: 99\n";

  test("createNote refuses with a typed code, a vault-relative source, and a registered exit", () => {
    writeBrainConfig(vault, MALFORMED);
    let caught: CreateNoteError | null = null;
    try {
      createNote(vault, { path: INSIDE_PATH, content: "x" });
    } catch (err) {
      caught = err as CreateNoteError;
    }
    expect(caught).toBeInstanceOf(CreateNoteError);
    expect(caught!.code).toBe("config_invalid");
    expect(caught!.message).toContain("Brain/_brain.yaml");
    expect(caught!.message).not.toContain(vault);
    const step = resolveNextStep("config-invalid");
    expect(step).not.toBeNull();
    expect(caught!.message).toContain(step!.nextCommand);
  });

  test("the batch arms carry the same typed code", () => {
    writeBrainConfig(vault, MALFORMED);
    let caught: WriteBatchError | null = null;
    try {
      applyWriteBatch(vault, [{ kind: "create_note", path: INSIDE_PATH, content: "x" }]);
    } catch (err) {
      caught = err as WriteBatchError;
    }
    expect(caught).toBeInstanceOf(WriteBatchError);
    expect(caught!.code).toBe("config_invalid");
    expect(caught!.message).not.toContain(vault);
  });
});

describe("a re-declared binding takes effect on the next call", () => {
  test("rewriting the prefix list changes what is admitted", () => {
    // Guards the per-vault memo that keeps a batch from re-reading and
    // re-validating the whole config once per operation: the cached
    // answer must never outlive the file it was read from.
    writeBrainConfig(vault, declaredBindingYaml(PREFIX));
    expect(checkWriteBinding(vault, INSIDE_PATH)).toBeNull();
    expect(checkWriteBinding(vault, OUTSIDE_PATH)).not.toBeNull();
    writeBrainConfig(vault, declaredBindingYaml("Elsewhere"));
    expect(checkWriteBinding(vault, OUTSIDE_PATH)).toBeNull();
    expect(checkWriteBinding(vault, INSIDE_PATH)).not.toBeNull();
  });
});
