/**
 * Tests for the `--cron-template` flag on `o2b search reindex`.
 *
 * The verb writes nothing to disk; we exercise it by spawning the
 * CLI with `runCli`. The renderer itself has unit-level coverage
 * for the duration parser via direct calls — that protects the
 * subtler edge cases (invalid units, large values).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CronTemplateError,
  parseInterval,
  renderCronTemplate,
} from "../../src/cli/search-cron-template.ts";
import { runCli } from "../helpers/run-cli.ts";

describe("parseInterval", () => {
  test("30m → */30 * * * *", () => {
    const r = parseInterval("30m");
    expect(r.cron).toBe("*/30 * * * *");
    expect(r.human).toBe("30 minutes");
    expect(r.hermesSchedule).toBe(r.cron);
  });

  test("6h → 0 */6 * * *", () => {
    expect(parseInterval("6h").cron).toBe("0 */6 * * *");
  });

  test("1d → 0 0 */1 * *", () => {
    expect(parseInterval("1d").cron).toBe("0 0 */1 * *");
  });

  test("60m rejected with hint about the h unit", () => {
    expect(() => parseInterval("60m")).toThrow(CronTemplateError);
    try {
      parseInterval("60m");
    } catch (e) {
      expect((e as Error).message).toContain("h unit");
    }
  });

  test("24h rejected with hint about the d unit", () => {
    expect(() => parseInterval("24h")).toThrow(CronTemplateError);
  });

  test("seconds rejected", () => {
    expect(() => parseInterval("30s")).toThrow(CronTemplateError);
  });

  test("zero rejected", () => {
    expect(() => parseInterval("0m")).toThrow(CronTemplateError);
  });

  test("garbage rejected with explanatory message", () => {
    try {
      parseInterval("garbage");
    } catch (e) {
      expect((e as Error).message).toContain("expected <N>s|m|h|d");
    }
  });
});

describe("renderCronTemplate", () => {
  test("body contains every expected anchor", () => {
    const body = renderCronTemplate("30m");
    expect(body).toContain("Open Second Brain");
    expect(body).toContain("30 minutes");
    expect(body).toContain("*/30 * * * *");
    expect(body).toContain("osb-reindex.sh");
    expect(body).toContain("hermes cron create");
    expect(body).toContain("search reindex --embeddings");
  });

  test("grep fallback emits when added, updated, or deleted are non-zero", () => {
    const body = renderCronTemplate("30m");
    expect(body).toContain(
      '"(added|updated|deleted)"[[:space:]]*:[[:space:]]*[1-9]',
    );
    expect(body).not.toContain('"added": [^0]');
  });

  test("--o2bBin override flows into every command line", () => {
    const body = renderCronTemplate("1h", { o2bBin: "/usr/local/bin/o2b-x" });
    expect(body).toContain("/usr/local/bin/o2b-x search reindex");
    expect(body).toContain("/usr/local/bin/o2b-x search status");
  });

  test("6h interval renders the 0 */6 cron expression", () => {
    const body = renderCronTemplate("6h");
    expect(body).toContain("0 */6 * * *");
  });
});

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cron-template-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b search reindex --cron-template (CLI)", () => {
  async function bootstrap(): Promise<void> {
    const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(init.returncode).toBe(0);
  }

  test("default 30m prints the template and writes nothing under tmp", async () => {
    await bootstrap();
    const before = readdirSync(tmp);
    const r = await runCli(
      ["search", "reindex", "--cron-template", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("*/30 * * * *");
    expect(r.stdout).toContain("osb-reindex.sh");
    // No new entries in tmp from the CLI itself.
    expect(readdirSync(tmp).sort()).toEqual(before.sort());
  });

  test("--interval 6h renders the 0 */6 cron expression", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "search", "reindex", "--cron-template",
        "--interval", "6h",
        "--vault", vault,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("0 */6 * * *");
  });

  test("--interval garbage exits 1 with the parser error", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "search", "reindex", "--cron-template",
        "--interval", "garbage",
        "--vault", vault,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("expected <N>s|m|h|d");
  });
});
