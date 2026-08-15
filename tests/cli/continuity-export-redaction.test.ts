/**
 * `continuity export` leaked exactly what the export boundary exists to
 * catch, and the census locked the gap in.
 *
 * ## The defect
 *
 * The egress registry declared `brain-continuity-export` as
 * `upstream_read_model` - "the one path that already redacted". The
 * upstream call is `redactRawOutput(stripped)` with NO options, so
 * `redactTokens` and `redactUrlCredentials` are both off: the two flags
 * `EGRESS_REDACTION_OPTIONS` turns on precisely because at an egress
 * boundary a false negative is unrecoverable, the bytes being gone. A
 * vendor-prefixed key, a bare high-entropy token and a `user:pass@host`
 * URL all survived verbatim into the written export file, while every
 * other export verb redacted them.
 *
 * The census made the fix impossible to apply: "no entry understates what
 * its module does" failed the moment `continuity.ts` called
 * `redactForEgress`. The declaration was the thing to change.
 *
 * Second half, same finding: the upstream redaction runs at WRITE time
 * only, and the read model never re-scans. A record already on disk, or
 * appended by another writer, was never scanned at all - which is what
 * this test seeds, deliberately, by writing the store file directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { REDACTION_PLACEHOLDER, MAX_REDACTOR_INPUT } from "../../src/core/redactor.ts";

const VENDOR_TOKEN = "sk-live-CONTINUITY1111";
const BARE_TOKEN = "Zq7Xb2Kd9Lm4Np6Rt8Vw1Yc7";
const URL_CREDENTIAL = "https://admin:hunter2@db.example.com/x";
const RECORD_ID = "ctn_20260801120000_a1b2c3d4e5f6a7b8";
const MONTH = "2026-08";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-continuity-egress-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = (): { env: Record<string, string> } => ({
  env: { OPEN_SECOND_BRAIN_CONFIG: config },
});

async function bootstrap(): Promise<void> {
  expect((await runCli(["init", "--vault", vault, "--name", "Cont"], ENV())).returncode).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], ENV())).returncode).toBe(0);
}

/**
 * Append a record straight to the store file - the "written by another
 * writer, or already on disk" case the write-time pass never sees.
 */
function seedRecord(payload: Readonly<Record<string, unknown>>): void {
  const dir = join(vault, "Brain", "log", "continuity");
  mkdirSync(dir, { recursive: true });
  const record = {
    schema: "1",
    id: RECORD_ID,
    kind: "session_summary",
    createdAt: `${MONTH}-01T12:00:00.000Z`,
    sourceRefs: [],
    payload: { session_id: "sess-alpha-1", ...payload },
    private: false,
    redacted: false,
  };
  writeFileSync(join(dir, `${MONTH}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

function exportedText(outDir: string): string {
  return readdirSync(outDir)
    .map((name) => readFileSync(join(outDir, name), "utf8"))
    .join("\n");
}

describe("a record already on disk is scanned at export time", () => {
  test("atof: none of the three shapes reach the written file", async () => {
    await bootstrap();
    seedRecord({ note: `key ${VENDOR_TOKEN} token ${BARE_TOKEN} url ${URL_CREDENTIAL}` });
    const out = join(tmp, "atof");
    const r = await runCli(
      [
        "brain",
        "continuity",
        "export",
        "--format",
        "atof",
        "--month",
        MONTH,
        "--out",
        out,
        "--vault",
        vault,
      ],
      ENV(),
    );
    expect(r.returncode).toBe(0);

    const text = exportedText(out);
    expect(text).not.toContain(VENDOR_TOKEN);
    expect(text).not.toContain(BARE_TOKEN);
    expect(text).not.toContain("hunter2");
    expect(text).toContain(REDACTION_PLACEHOLDER);
  });

  test("atif: the same three shapes, the same answer", async () => {
    await bootstrap();
    seedRecord({ note: `key ${VENDOR_TOKEN} token ${BARE_TOKEN} url ${URL_CREDENTIAL}` });
    const out = join(tmp, "atif");
    const r = await runCli(
      [
        "brain",
        "continuity",
        "export",
        "--format",
        "atif",
        "--month",
        MONTH,
        "--out",
        out,
        "--vault",
        vault,
      ],
      ENV(),
    );
    expect(r.returncode).toBe(0);

    const text = exportedText(out);
    expect(text).not.toContain(VENDOR_TOKEN);
    expect(text).not.toContain(BARE_TOKEN);
    expect(text).not.toContain("hunter2");
  });

  test("the record id is an identifier and survives", async () => {
    await bootstrap();
    seedRecord({ note: "nothing to redact here" });
    const out = join(tmp, "atof-clean");
    const r = await runCli(
      [
        "brain",
        "continuity",
        "export",
        "--format",
        "atof",
        "--month",
        MONTH,
        "--out",
        out,
        "--vault",
        vault,
      ],
      ENV(),
    );
    expect(r.returncode).toBe(0);
    // The export derives its event uuid from the record id, so mangling
    // the id would mangle every correlation the format carries.
    expect(exportedText(out)).not.toContain(REDACTION_PLACEHOLDER);
  });
});

describe("continuity export gains the refusal the other five have", () => {
  test("a field past the scan window refuses and writes nothing", async () => {
    await bootstrap();
    seedRecord({ note: "x".repeat(MAX_REDACTOR_INPUT + 16) });
    const out = join(tmp, "atof-huge");
    const r = await runCli(
      [
        "brain",
        "continuity",
        "export",
        "--format",
        "atof",
        "--month",
        MONTH,
        "--out",
        out,
        "--vault",
        vault,
      ],
      ENV(),
    );
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("scan window");
    if (existsSync(out)) expect(readdirSync(out)).toEqual([]);
  });
});
