/**
 * Write-session artifact validation and target policy
 * (Agent Write Contract Suite, t_bc36a8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCorrectionPrompt,
  inspectExistingTarget,
  validateArtifact,
  validateTargetPath,
} from "../../../../src/core/brain/write-session/validate.ts";
import { resolveSchemaVocabulary } from "../../../../src/core/brain/schema-vocab.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ws-validate-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const GOOD = ["---", "kind: note", "type: note", "---", "", "# Fixture", "", "Body."].join("\n");

// ----- target policy --------------------------------------------------------

test("target must be a vault-relative markdown path under Brain/", () => {
  expect(validateTargetPath("Brain/notes/x.md")).toEqual([]);
  expect(validateTargetPath("Brain/decisions/panels/p.md")).toEqual([]);

  expect(validateTargetPath("notes/x.md")[0]!.code).toBe("target-outside-brain");
  expect(validateTargetPath("/etc/passwd")[0]!.code).toBe("target-outside-brain");
  expect(validateTargetPath("Brain/../escape.md")[0]!.code).toBe("target-traversal");
  expect(validateTargetPath("Brain/notes/..\\win.md")[0]!.code).toBe("target-traversal");
  expect(validateTargetPath("Brain/notes/x.txt")[0]!.code).toBe("target-extension");
  expect(validateTargetPath("")[0]!.code).toBe("target-outside-brain");
});

test("reserved namespaces are denied with coded errors", () => {
  for (const target of [
    "Brain/preferences/pref-x.md",
    "Brain/log/2026-06-04.md",
    "Brain/.sessions/write/ws-1.md",
    "Brain/.payloads/abc.md",
    "Brain/_brain.yaml",
  ]) {
    const errors = validateTargetPath(target);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toContain(
      target === "Brain/_brain.yaml" ? "target-reserved" : "target-reserved",
    );
  }
});

// ----- artifact validation --------------------------------------------------

test("a well-formed artifact with declared schema type validates cleanly", () => {
  const vocab = resolveSchemaVocabulary({ page_types: ["decision"] });
  const artifact = GOOD.replace("type: note", "type: decision");
  expect(validateArtifact(artifact, { schemaType: "decision", vocabulary: vocab })).toEqual([]);
});

test("empty and oversized artifacts are rejected", () => {
  expect(validateArtifact("", {})[0]!.code).toBe("artifact-empty");
  expect(validateArtifact("   \n  ", {})[0]!.code).toBe("artifact-empty");
  const big = `${GOOD}\n${"x".repeat(300_000)}`;
  expect(validateArtifact(big, {}).map((e) => e.code)).toContain("artifact-too-large");
});

test("missing or malformed frontmatter is a coded error", () => {
  expect(validateArtifact("# No frontmatter\n\nBody.", {})[0]!.code).toBe("frontmatter-missing");
  const codes = validateArtifact("---\nkind note\n---\n\nBody.", {}).map((e) => e.code);
  expect(codes.some((c) => c === "frontmatter-missing" || c === "frontmatter-malformed")).toBe(
    true,
  );
});

test("declared schema type must be known and must match the artifact", () => {
  const vocab = resolveSchemaVocabulary({ page_types: ["decision"] });
  const unknown = validateArtifact(GOOD, { schemaType: "bogus", vocabulary: vocab });
  expect(unknown.map((e) => e.code)).toContain("schema-type-unknown");

  const mismatch = validateArtifact(GOOD, { schemaType: "decision", vocabulary: vocab });
  expect(mismatch.map((e) => e.code)).toContain("schema-type-mismatch");
});

test("control characters in the body are rejected", () => {
  const sneaky = `${GOOD}\nbad: \u0000byte`;
  expect(validateArtifact(sneaky, {}).map((e) => e.code)).toContain("artifact-control-chars");
});

// ----- correction prompt ----------------------------------------------------

test("correction prompt is compact and lists every error", () => {
  const prompt = buildCorrectionPrompt([
    { code: "frontmatter-missing", path: "frontmatter", message: "artifact has no frontmatter" },
    { code: "schema-type-mismatch", path: "type", message: "expected 'decision'" },
  ]);
  expect(prompt).toContain("frontmatter-missing");
  expect(prompt).toContain("expected 'decision'");
  expect(prompt).toContain("full corrected artifact");
  expect(prompt.length).toBeLessThan(1000);
});

// ----- existing-target inspection -------------------------------------------

test("inspectExistingTarget returns null for a free path and metadata for an occupied one", () => {
  expect(inspectExistingTarget(vault, "Brain/notes/free.md")).toBeNull();
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "notes", "busy.md"), "---\nkind: note\n---\n\n# Busy note\n");
  const info = inspectExistingTarget(vault, "Brain/notes/busy.md");
  expect(info!.bytes).toBeGreaterThan(0);
  expect(info!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(info!.first_heading).toBe("Busy note");
});
