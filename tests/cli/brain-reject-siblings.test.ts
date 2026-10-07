/**
 * `o2b brain reject` lists retire siblings (near-duplicate defense, A6).
 *
 * With `near_duplicate_retire_siblings_enabled` on, the verb prints every
 * active preference that resembles the one it just retired, with its score
 * and the command that would accept the pair. It retires nothing else. With
 * the key off its output is exactly what it was before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

const FLAG_ENV = "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED";
const RULE = "always run the formatter before every commit in this repository";
const PARAPHRASE = "always run the formatter before each commit in this repository";
const UNRELATED = "prefer tabs over spaces inside every makefile you touch";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-reject-siblings-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  atomicWriteFileSync(config, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: config });
  seed("old", "formatting", RULE);
  seed("paraphrase", "commit-hygiene", PARAPHRASE);
  seed("unrelated", "makefiles", UNRELATED);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(slug: string, topic: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle,
    created_at: "2026-06-01T00:00:00Z",
    confirmed_at: "2026-06-02T00:00:00Z",
    unconfirmed_until: "2026-06-15T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-06-02T00:00:00Z",
    confidence: "low",
  });
}

function reject(flagOn: boolean, extra: string[] = []) {
  const env: Record<string, string> = { OPEN_SECOND_BRAIN_CONFIG: config };
  if (flagOn) env[FLAG_ENV] = "1";
  return runCli(
    ["brain", "reject", "--vault", vault, "--id", "pref-old", "--reason", "obsolete", ...extra],
    { env },
  );
}

function names(dir: string): string[] {
  return readdirSync(join(vault, "Brain", dir))
    .filter((n) => n.endsWith(".md"))
    .toSorted();
}

describe("brain reject retire siblings", () => {
  test("with the key on, each sibling is printed with its score and the accept command", async () => {
    const r = await reject(true);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(
      "retired: ret-old (user-rejected)\n" +
        "retire siblings: 1\n" +
        "  pref-paraphrase score=0.818 method=lexical\n" +
        "    accept: o2b brain reject --id pref-paraphrase --reason <text>\n",
    );
  });

  test("with the key on, --json carries retire_siblings", async () => {
    const r = await reject(true, ["--json"]);
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      id: "ret-old",
      reason: "user-rejected",
      retire_siblings: [
        { retiring_id: "pref-old", sibling_id: "pref-paraphrase", score: 0.818, method: "lexical" },
      ],
    });
  });

  test("with the key off, the output is exactly the pre-existing line", async () => {
    const text = await reject(false);
    expect(text.stdout).toBe("retired: ret-old (user-rejected)\n");
    seed("old", "formatting", RULE);
    rmSync(join(vault, "Brain", "retired", "ret-old.md"));
    const json = await reject(false, ["--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, id: "ret-old", reason: "user-rejected" });
  });

  test("a sibling scan that fails after the retire is a warning, not a failed reject", async () => {
    // A file where the archived-signal directory belongs makes the scan throw.
    const archived = join(vault, "Brain", "inbox", "archived");
    rmSync(archived, { recursive: true, force: true });
    writeFileSync(archived, "not a directory");
    const r = await reject(true);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe("retired: ret-old (user-rejected)\n");
    expect(r.stderr).toContain("warning: retire siblings scan failed");
    expect(names("retired")).toEqual(["ret-old.md"]);
  });

  test("nothing besides the rejected preference is retired", async () => {
    await reject(true);
    expect(names("preferences")).toEqual(["pref-paraphrase.md", "pref-unrelated.md"]);
    expect(names("retired")).toEqual(["ret-old.md"]);
  });
});
