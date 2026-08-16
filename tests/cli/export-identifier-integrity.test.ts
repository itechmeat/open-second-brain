/**
 * An identifier is not a payload: the export boundary may refuse one, but
 * it may never rewrite one.
 *
 * ## The defects
 *
 * Four reports, one shape - redaction damaging something structural.
 *
 * 1. `okf-export` merged pages whose FILENAMES were secret-shaped. A path
 *    is a string leaf, so `Notes/sk-live-CCCC3333.md` became
 *    `concepts/***REDACTED***`; three distinct notes collapsed onto one
 *    bundle path, two page bodies were destroyed, the count was reported
 *    pre-merge and the verb exited 0. The redacted name also lost its
 *    `.md`, so a re-import would not have seen it as a page at all.
 * 2. `redactStructured` never scanned mapping KEYS, so the OKF manifest's
 *    `producer_meta` (built from `x-*` frontmatter keys) wrote a token in
 *    key position out verbatim while redacting the identical token in
 *    value position.
 * 3. `export-config` and `second_brain_status` mangled the operator's own
 *    paths: any path segment of 24+ mixed characters - a container uuid, a
 *    hashed cache directory, a git worktree - came back as the
 *    placeholder, from a verb whose entire purpose is to hand a support
 *    person the resolved paths.
 * 4. `bank-export` -> `bank-import` is a supported round trip, and the
 *    high-entropy pass replaced content-addressed identifiers inside note
 *    text (`[[Brain/artifacts/<sha256>.json]]`, a uuid alias) with the
 *    placeholder, which import then wrote into the vault as a literal.
 *
 * The rule these tests pin: an identifier (a value under an id/path key, a
 * path-shaped leaf, a mapping key) is checked and never rewritten. A
 * content-addressed run - hexadecimal, with or without dashes - is an
 * identifier wherever it appears, so digests and uuids survive as
 * themselves. When an identifier really is secret-shaped the export
 * REFUSES and names where, because merging or renaming what an identifier
 * identifies is never an acceptable answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { EGRESS_OUTCOME, redactForEgress } from "../../src/core/egress/guard.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";

/** A vendor-prefixed credential token: caught by shape, not by a word list. */
const VENDOR_TOKEN = "sk-live-9f8e7d6c5b4a32100112";
/** A content address: 64 hexadecimal characters, the shape of a digest. */
const DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** A canonical uuid - hexadecimal plus dashes, the shape of a container id. */
const UUID = "f6f02ff9-6785-4ac9-8e4c-95f95be29cb5";
/** 25 mixed characters that are NOT a content address: the old false positive. */
const BUILD_ID = "release2024buildXYZabcdef";
/** A signal id: 26 characters of the shape every OSB provenance link uses. */
const SIGNAL_ID = "sig-2026-08-16-secret-leak";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ident-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = (): { env: Record<string, string> } => ({
  env: { OPEN_SECOND_BRAIN_CONFIG: config },
});

async function bootstrap(): Promise<void> {
  expect((await runCli(["init", "--vault", vault, "--name", "Ident"], ENV())).returncode).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], ENV())).returncode).toBe(0);
}

/** Every file under `dir`, recursively, as absolute paths. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

describe("a secret-shaped filename is refused, never merged", () => {
  test("okf-export writes nothing rather than collapsing three pages onto one path", async () => {
    await bootstrap();
    for (const [name, body] of [
      ["sk-live-AAAA1111", "ONEBODY"],
      ["sk-live-BBBB2222", "TWOBODY"],
      ["sk-live-CCCC3333", "THREEBODY"],
    ] as const) {
      writeFileSync(join(vault, `${name}.md`), `---\ntitle: ${name}\n---\n${body}\n`);
    }
    const out = join(tmp, "okf-secret-names");
    const r = await runCli(["brain", "okf-export", "--vault", vault, "--out", out], ENV());

    expect(r.returncode).not.toBe(0);
    // The refusal names WHERE, so the operator can rename or exclude.
    expect(r.stderr).toContain("bundle_path");
    expect(existsSync(join(out, "okf.json"))).toBe(false);
    // Nothing written at all - not one body, not a merged page.
    if (existsSync(out)) {
      for (const file of walkFiles(out)) {
        const text = readFileSync(file, "utf8");
        expect(`${file}: ${text.includes("ONEBODY") || text.includes("TWOBODY")}`).toBe(
          `${file}: false`,
        );
      }
    }
  });

  test("ordinary filenames still export, so the refusal is not a blanket one", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Alpha.md"), "---\ntitle: Alpha\n---\nONEBODY\n");
    writeFileSync(join(vault, `${BUILD_ID}.md`), `---\ntitle: Beta\n---\nTWOBODY\n`);
    const out = join(tmp, "okf-clean-names");
    const r = await runCli(["brain", "okf-export", "--vault", vault, "--out", out], ENV());

    expect(r.returncode).toBe(0);
    // The 25-character mixed run in the filename is an identifier, not a
    // token: the page keeps its own name.
    expect(existsSync(join(out, "concepts", `${BUILD_ID}.md`))).toBe(true);
    expect(readFileSync(join(out, "concepts", `${BUILD_ID}.md`), "utf8")).toContain("TWOBODY");
  });
});

describe("the guard never rewrites an identifier", () => {
  test("a path leaf carrying a long mixed run comes back verbatim", () => {
    const verdict = redactForEgress("brain-okf-export", {
      files: [{ path: `concepts/${BUILD_ID}.md`, contents: "body" }],
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.files[0]!.path).toBe(`concepts/${BUILD_ID}.md`);
    expect(verdict.redacted).toBe(false);
  });

  test("a record id under an `id` key is not a token", () => {
    const verdict = redactForEgress("brain-continuity-export", {
      id: "ctn_20260815120000_a1b2c3d4e5f6a7b8",
      session_id: "sess-2026-08-15-alpha7",
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.id).toBe("ctn_20260815120000_a1b2c3d4e5f6a7b8");
    expect(verdict.payload.session_id).toBe("sess-2026-08-15-alpha7");
  });

  test("a content address inside note text survives the round trip", () => {
    // The export -> import path this branch built: a false positive here
    // is not a mangled copy, it is a corrupted restore.
    const body = `see [[Brain/artifacts/${DIGEST}.json]] and container ${UUID}`;
    const verdict = redactForEgress("brain-bank-export", { body, alias: UUID, digest: DIGEST });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.body).toBe(body);
    expect(verdict.payload.alias).toBe(UUID);
    expect(verdict.payload.digest).toBe(DIGEST);
    expect(verdict.redacted).toBe(false);
  });

  test("a signal id survives, because a placeholder is a shared target", () => {
    // `sig-<date>-<slug>` crosses the 24-character entropy gate as soon as
    // the slug reaches nine characters, which is routine. Replacing it
    // wrote `[[***REDACTED***]]` into `_evidenced_by`, and the import
    // reported a full success while landing every preference that lost a
    // signal id on one dangling wikilink - the merge the identifier rule
    // exists to prevent, arriving through the payload pass instead.
    const body = `evidence: [[${SIGNAL_ID}]]`;
    const verdict = redactForEgress("brain-bank-export", {
      body,
      evidenced_by: [`[[${SIGNAL_ID}]]`],
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.body).toBe(body);
    expect(verdict.payload.evidenced_by[0]).toBe(`[[${SIGNAL_ID}]]`);
    expect(verdict.redacted).toBe(false);
  });

  test("a token wearing a signal prefix is still redacted", () => {
    // The carve-out is the signal-id SHAPE, not the prefix: a date and a
    // lowercase slug. A vendor token behind `sig-` matches neither.
    const verdict = redactForEgress("brain-bank-export", {
      body: `sig-${VENDOR_TOKEN} and sig-2026-08-16-Zq7Xb2Kd9Lm4Np6Rt8Vw1Yc9`,
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.body).not.toContain(VENDOR_TOKEN);
    expect(verdict.payload.body).not.toContain("Zq7Xb2Kd9Lm4Np6Rt8Vw1Yc9");
  });

  test("a URL credential under an identifier key is still scrubbed", () => {
    // The one thing removed from an identifier, and not a collapse: the
    // authority is not part of what the identifier identifies, so the
    // reference still resolves to the same resource afterwards.
    const verdict = redactForEgress("brain-continuity-export", {
      source_path: "https://admin:hunter2@db.example.com/x",
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.source_path).toBe(`https://${REDACTION_PLACEHOLDER}@db.example.com/x`);
  });

  test("a real token in a value position is still redacted", () => {
    // The complement: identifier handling must not become a hole.
    const verdict = redactForEgress("brain-bank-export", { body: `paste ${VENDOR_TOKEN} here` });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.body).toBe(`paste ${REDACTION_PLACEHOLDER} here`);
  });
});

describe("a mapping key is scanned, and reported rather than rewritten", () => {
  test("a vendor-prefixed key name refuses the export", () => {
    const verdict = redactForEgress("brain-okf-export", {
      manifest: { pages: [{ producer_meta: { [`x-${VENDOR_TOKEN}`]: "harmless" } }] },
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedSecretIdentifier);
    if (verdict.outcome === EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.detail).toContain("producer_meta");
  });

  test("a high-entropy key name refuses too - the value pass caught only one half", () => {
    const verdict = redactForEgress("brain-okf-export", {
      producer_meta: { "x-Zq7Xb2Kd9Lm4Np6Rt8Vw1Yc9": "harmless" },
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedSecretIdentifier);
  });

  test("an ordinary key name is untouched", () => {
    const verdict = redactForEgress("brain-okf-export", {
      producer_meta: { "x-notion-id": UUID, "x-source": "import" },
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(Object.keys(verdict.payload.producer_meta)).toEqual(["x-notion-id", "x-source"]);
  });
});

describe("export-config hands back the operator's own paths", () => {
  test("a uuid and a long build id in a path are not redacted", async () => {
    const deepVault = join(tmp, UUID, BUILD_ID, "vault");
    expect((await runCli(["init", "--vault", deepVault, "--name", "Deep"], ENV())).returncode).toBe(
      0,
    );
    const out = join(tmp, "config.json");
    const r = await runCli(["export-config", "--config", config, "--output", out], ENV());
    expect(r.returncode).toBe(0);

    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      config_path: string;
      config: Record<string, unknown>;
    };
    expect(parsed.config_path).toBe(config);
    expect(JSON.stringify(parsed.config)).toContain(UUID);
    expect(JSON.stringify(parsed.config)).toContain(BUILD_ID);
    expect(JSON.stringify(parsed)).not.toContain(REDACTION_PLACEHOLDER);
  });

  test("a credential under an innocuous key name is still redacted", async () => {
    await bootstrap();
    writeFileSync(config, `vault_dir: ${vault}\nnotes_scratch: ${VENDOR_TOKEN}\n`);
    const out = join(tmp, "config2.json");
    const r = await runCli(["export-config", "--config", config, "--output", out], ENV());
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(readFileSync(out, "utf8")) as { config: Record<string, string> };
    expect(parsed.config["notes_scratch"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed.config["vault_dir"]).toBe(vault);
  });
});
