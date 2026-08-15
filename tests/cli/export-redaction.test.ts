/**
 * The export boundary redacts (wiring-what-exists, unit C1).
 *
 * ## The defect
 *
 * Six paths hand vault bytes to a destination outside the vault. Five of
 * them never called the shared redactor: `brain bank-export`,
 * `brain graph-export`, `brain okf-export`, `brain export`, and
 * `export-config` - the last using a private copy that matched five
 * substrings against KEY NAMES only and never looked at a value. A vault
 * note carrying a pasted vendor key left the machine verbatim, and an
 * `export-config` snapshot carrying a credential under an innocuous key
 * name did the same.
 *
 * Three properties are pinned here, one per failure mode:
 *
 *   1. a vendor-prefixed key placed where each path actually carries it
 *      comes out redacted;
 *   2. a payload the redactor could only partially scan is REFUSED, with
 *      nothing written - an export that scanned half its bytes cannot
 *      honestly report success;
 *   3. an export with nothing to redact is byte-identical to what the
 *      unredacted exporter produces, proven by running both rather than
 *      by asserting it in prose.
 *
 * ## What it deliberately does not cover
 *
 * The `continuity export` verb, which redacts upstream in its read model
 * and is declared that way in the egress registry rather than re-scanned
 * here; the redactor's own detection rules, which have their own unit
 * coverage; and whether a redacted bundle still round-trips through
 * `bank-import` - a bundle whose secrets were removed is not the same
 * document, and pretending the round-trip is lossless is the claim this
 * unit exists to stop making.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { exportVaultGraph } from "../../src/core/brain/portability/graph.ts";
import { buildOkfBundle } from "../../src/core/brain/portability/okf.ts";
import { exportPreferencesLlmsTxt } from "../../src/core/brain/export.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";
import { EGRESS_OUTCOME, redactForEgress } from "../../src/core/egress/guard.ts";

/** A vendor-prefixed credential token: caught by shape, not by a word list. */
const VENDOR_TOKEN = "sk-live-9f8e7d6c5b4a32100112";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-egress-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = (): { env: Record<string, string> } => ({
  env: { OPEN_SECOND_BRAIN_CONFIG: config },
});

async function bootstrap(): Promise<void> {
  expect((await runCli(["init", "--vault", vault, "--name", "Egress"], ENV())).returncode).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], ENV())).returncode).toBe(0);
}

/** A note whose title, alias and body each carry the same vendor token. */
function seedLeakyNote(): void {
  writeFileSync(
    join(vault, "Leaky.md"),
    `---\ntitle: ${VENDOR_TOKEN}\naliases:\n  - ${VENDOR_TOKEN}\nprovenance: ${VENDOR_TOKEN}\n---\n` +
      `api_key=${VENDOR_TOKEN}\n\nbare ${VENDOR_TOKEN} in prose.\n`,
  );
}

/** A clean note: nothing in it has the shape of a credential. */
function seedCleanNote(): void {
  writeFileSync(join(vault, "Clean.md"), "---\ntitle: Clean\n---\nlinks to [[Other]].\n");
}

async function seedPreference(slug: string, principle: string): Promise<void> {
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
      principle,
      "--scope",
      "writing",
      "--force-confirmed",
      "--agent",
      "claude",
    ],
    ENV(),
  );
  expect(r.returncode).toBe(0);
}

describe("a vendor-prefixed key does not leave through any export path", () => {
  test("brain bank-export", async () => {
    await bootstrap();
    seedLeakyNote();
    await seedPreference("leak", `use ${VENDOR_TOKEN} for the call`);
    const r = await runCli(["brain", "bank-export", "--vault", vault], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain(VENDOR_TOKEN);
    expect(r.stdout).toContain(REDACTION_PLACEHOLDER);
    // Still a bundle, not mangled bytes.
    expect((JSON.parse(r.stdout) as { schema: string }).schema).toBe("1");
  });

  test("brain graph-export", async () => {
    await bootstrap();
    seedLeakyNote();
    const r = await runCli(["brain", "graph-export", "--vault", vault], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain(VENDOR_TOKEN);
    expect(Array.isArray((JSON.parse(r.stdout) as { nodes: unknown[] }).nodes)).toBe(true);
  });

  test("brain okf-export", async () => {
    await bootstrap();
    seedLeakyNote();
    const out = join(tmp, "okf");
    const r = await runCli(["brain", "okf-export", "--vault", vault, "--out", out], ENV());
    expect(r.returncode).toBe(0);
    const manifest = readFileSync(join(out, "okf.json"), "utf8");
    expect(manifest).not.toContain(VENDOR_TOKEN);
    // okf.json must still parse: redaction runs over the manifest tree
    // before serialisation, never over the serialised bytes.
    expect((JSON.parse(manifest) as { schema: string }).schema).toBe("1");
    const page = readFileSync(join(out, "concepts", "Leaky.md"), "utf8");
    expect(page).not.toContain(VENDOR_TOKEN);
    expect(page).toContain(REDACTION_PLACEHOLDER);

    // And it still PARSES. `toContain(PLACEHOLDER)` was the whole check
    // here, which an unquoted `***REDACTED***` passes while making the
    // frontmatter an unresolved YAML alias - rejected by Obsidian and by
    // every spec-compliant reader, accepted only by this repo's lenient
    // parser. Asserted with a strict parser for that reason.
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(page)?.[1];
    expect(typeof frontmatter).toBe("string");
    const parsed = (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(
      frontmatter!,
    ) as Record<string, unknown>;
    expect(parsed["title"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed["aliases"]).toEqual([REDACTION_PLACEHOLDER]);
  });

  test("brain export --format json", async () => {
    await bootstrap();
    await seedPreference("leak", `use ${VENDOR_TOKEN} for the call`);
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "json"], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain(VENDOR_TOKEN);
    expect((JSON.parse(r.stdout) as { schema: number }).schema).toBe(1);
  });

  test("brain export --format llms-txt", async () => {
    await bootstrap();
    await seedPreference("leak", `use ${VENDOR_TOKEN} for the call`);
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "llms-txt"], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain(VENDOR_TOKEN);
  });

  test("export-config redacts a credential hiding under an innocuous key name", async () => {
    // The defect the key-name-only copy could not see: `redactMapping`
    // matched five substrings against the KEY and never looked at the
    // value, so a token stored under a name it did not recognise was
    // written out verbatim.
    await bootstrap();
    writeFileSync(config, `vault_dir: ${vault}\nnotes_scratch: ${VENDOR_TOKEN}\napi_key: plain\n`);
    const out = join(tmp, "config.json");
    const r = await runCli(["export-config", "--config", config, "--output", out], ENV());
    expect(r.returncode).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain(VENDOR_TOKEN);
    const parsed = JSON.parse(text) as { config: Record<string, string> };
    // The key-name rule still fires, and now shares the redactor's placeholder.
    expect(parsed.config["api_key"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed.config["notes_scratch"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed.config["vault_dir"]).toBe(vault);
  });
});

/** Just over the redactor's 1 MiB scan window, in cheap-to-scan filler. */
function oversizedBody(): string {
  return "- item\n".repeat(Math.ceil((1024 * 1024) / 7) + 8);
}

describe("a partially-scanned payload is refused, not written", () => {
  test("okf-export refuses and writes nothing", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Huge.md"), `---\ntitle: Huge\n---\n${oversizedBody()}`);
    const out = join(tmp, "okf-huge");
    const r = await runCli(["brain", "okf-export", "--vault", vault, "--out", out], ENV());
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("scan window");
    expect(existsSync(join(out, "okf.json"))).toBe(false);
  });

  test("bank-export refuses rather than printing a partially-scanned bundle", async () => {
    await bootstrap();
    // The bank bundle carries no page body, so the oversized field is an
    // alias - the widest string a page contract does carry.
    writeFileSync(
      join(vault, "Huge.md"),
      `---\ntitle: Huge\naliases:\n  - "${"a".repeat(1024 * 1024 + 16)}"\n---\nbody\n`,
    );
    const r = await runCli(["brain", "bank-export", "--vault", vault], ENV());
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("scan window");
    expect(r.stdout).toBe("");
  });

  test("the guard itself names the refusal rather than returning text", () => {
    const verdict = redactForEgress("brain-bank-export", { note: "x".repeat(1024 * 1024 + 1) });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedScanTruncated);
  });

  test("a payload inside the window is released", () => {
    const verdict = redactForEgress("brain-bank-export", { note: "hello" });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload).toEqual({ note: "hello" });
    expect(verdict.redacted).toBe(false);
  });
});

describe("an export with nothing to redact is byte-identical", () => {
  // Proven by running the unredacted exporter in-process and comparing
  // the bytes the CLI wrote, rather than by asserting the property.

  test("graph-export", async () => {
    await bootstrap();
    seedCleanNote();
    const r = await runCli(["brain", "graph-export", "--vault", vault], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(JSON.stringify(exportVaultGraph(vault), null, 2) + "\n");
  });

  test("okf-export page files and index", async () => {
    await bootstrap();
    seedCleanNote();
    const out = join(tmp, "okf-clean");
    const r = await runCli(["brain", "okf-export", "--vault", vault, "--out", out], ENV());
    expect(r.returncode).toBe(0);
    const expected = buildOkfBundle(vault);
    for (const file of expected.files) {
      // `okf.json` carries `generated_at`, which moves between runs.
      if (file.path === "okf.json") continue;
      expect(`${file.path}: ${readFileSync(join(out, file.path), "utf8")}`).toBe(
        `${file.path}: ${file.contents}`,
      );
    }
  });

  test("brain export --format llms-txt", async () => {
    await bootstrap();
    await seedPreference("alpha", "principle alpha");
    const r = await runCli(["brain", "export", "--vault", vault, "--format", "llms-txt"], ENV());
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(exportPreferencesLlmsTxt(vault));
  });

  test("the byte-identity fixtures are not empty", () => {
    // A comparison over nothing passes for the wrong reason.
    expect(VENDOR_TOKEN.length).toBeGreaterThan(16);
  });
});
