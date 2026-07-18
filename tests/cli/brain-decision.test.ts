/**
 * Tests for `o2b brain decision <action>` CLI verb (Belief lifecycle
 * suite, Track B anchor, t_ac03214d).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-decision-cli-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-brain-decision-cli-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const env = { OPEN_SECOND_BRAIN_CONFIG: "", VAULT_AGENT_NAME: "" } as const;

describe("o2b brain decision", () => {
  test("record captures a decision and opens a review obligation", async () => {
    const r = await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Adopt Bun runtime",
        "--chosen",
        "Bun",
        "--assumption",
        "Bun stays compatible",
        "--review-date",
        "2026-12-01",
        "--json",
      ],
      { env },
    );
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.id).toBe("decision-adopt-bun-runtime");
    expect(out.obligation_created).toBe(true);
  });

  test("outcome backfill and list", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Adopt Bun runtime",
        "--chosen",
        "Bun",
        "--assumption",
        "x",
        "--review-date",
        "2026-12-01",
      ],
      { env },
    );
    const oc = await runCli(
      [
        "brain",
        "decision",
        "outcome",
        "adopt-bun-runtime",
        "--config",
        configPath,
        "--outcome",
        "held up",
      ],
      { env },
    );
    expect(oc.returncode).toBe(0);
    const list = await runCli(["brain", "decision", "list", "--config", configPath, "--json"], {
      env,
    });
    const { decisions } = JSON.parse(list.stdout);
    expect(decisions[0].outcome).toBe("held up");
  });

  test("rate and list --rated (B2)", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Option A",
        "--chosen",
        "A",
        "--assumption",
        "x",
        "--review-date",
        "2026-12-01",
        "--rating",
        "4",
      ],
      { env },
    );
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Option B",
        "--chosen",
        "B",
        "--assumption",
        "y",
        "--review-date",
        "2026-12-01",
      ],
      { env },
    );
    const rate = await runCli(
      ["brain", "decision", "rate", "option-b", "--config", configPath, "--rating", "5", "--json"],
      { env },
    );
    expect(rate.returncode).toBe(0);
    expect(JSON.parse(rate.stdout).rating).toBe(5);

    const list = await runCli(
      ["brain", "decision", "list", "--rated", "--config", configPath, "--json"],
      { env },
    );
    const { decisions } = JSON.parse(list.stdout);
    expect(decisions.map((d: { rating: number }) => d.rating)).toEqual([5, 4]);
  });

  test("recall is disabled unless configured (B5)", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Adopt Bun runtime",
        "--chosen",
        "Bun",
        "--assumption",
        "x",
        "--review-date",
        "2026-12-01",
        "--rating",
        "5",
      ],
      { env },
    );
    const off = await runCli(
      [
        "brain",
        "decision",
        "recall",
        "--config",
        configPath,
        "--prompt",
        "adopt Bun runtime",
        "--json",
      ],
      { env },
    );
    expect(JSON.parse(off.stdout).enabled).toBe(false);

    const on = await runCli(
      [
        "brain",
        "decision",
        "recall",
        "--config",
        configPath,
        "--prompt",
        "adopt Bun runtime for the API",
        "--json",
      ],
      { env: { ...env, OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION: "3" } },
    );
    const parsed = JSON.parse(on.stdout);
    expect(parsed.enabled).toBe(true);
    expect(parsed.surfaced.slug).toBe("adopt-bun-runtime");
  });

  test("show/list surface commitment when set and omit it when unset (B3)", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Committed choice",
        "--chosen",
        "X",
        "--assumption",
        "a",
        "--review-date",
        "2026-12-01",
        "--commitment",
        "decided",
      ],
      { env },
    );
    await runCli(
      [
        "brain",
        "decision",
        "record",
        "--config",
        configPath,
        "--title",
        "Loose choice",
        "--chosen",
        "Y",
        "--assumption",
        "b",
        "--review-date",
        "2026-12-01",
      ],
      { env },
    );

    const shownSet = await runCli(
      ["brain", "decision", "show", "committed-choice", "--config", configPath, "--json"],
      { env },
    );
    expect(JSON.parse(shownSet.stdout).commitment).toBe("decided");

    const shownUnset = await runCli(
      ["brain", "decision", "show", "loose-choice", "--config", configPath, "--json"],
      { env },
    );
    expect("commitment" in JSON.parse(shownUnset.stdout)).toBe(false);

    const list = await runCli(["brain", "decision", "list", "--config", configPath, "--json"], {
      env,
    });
    const { decisions } = JSON.parse(list.stdout);
    const committed = decisions.find((d: { slug: string }) => d.slug === "committed-choice");
    const loose = decisions.find((d: { slug: string }) => d.slug === "loose-choice");
    expect(committed.commitment).toBe("decided");
    expect("commitment" in loose).toBe(false);
  });

  test("missing required flags exit non-zero", async () => {
    const r = await runCli(
      ["brain", "decision", "record", "--config", configPath, "--title", "x"],
      { env },
    );
    expect(r.returncode).not.toBe(0);
  });
});
