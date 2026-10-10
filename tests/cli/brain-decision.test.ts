/**
 * Tests for `o2b brain decision <action>` CLI verb (Belief lifecycle
 * suite, Track B anchor, t_ac03214d).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("recall threads governor cap and surfaced-id state from CLI flags (B5)", async () => {
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
    const recallEnv = { ...env, OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION: "3" };

    // Fresh state surfaces the matching rated decision.
    const first = await runCli(
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
      { env: recallEnv },
    );
    expect(JSON.parse(first.stdout).surfaced.slug).toBe("adopt-bun-runtime");

    // --count at the cap gates recall (cap passthrough).
    const capped = await runCli(
      [
        "brain",
        "decision",
        "recall",
        "--config",
        configPath,
        "--prompt",
        "adopt Bun runtime for the API",
        "--count",
        "3",
        "--json",
      ],
      { env: recallEnv },
    );
    const cappedOut = JSON.parse(capped.stdout);
    expect(cappedOut.enabled).toBe(true);
    expect(cappedOut.surfaced).toBeNull();

    // --surfaced-ids marks the only match already seen, so it is not re-surfaced.
    const seen = await runCli(
      [
        "brain",
        "decision",
        "recall",
        "--config",
        configPath,
        "--prompt",
        "adopt Bun runtime for the API",
        "--surfaced-ids",
        "decision-adopt-bun-runtime",
        "--json",
      ],
      { env: recallEnv },
    );
    const seenOut = JSON.parse(seen.stdout);
    expect(seenOut.surfaced).toBeNull();
    expect(seenOut.state.surfaced_ids).toContain("decision-adopt-bun-runtime");
  });

  test("missing required flags exit non-zero", async () => {
    const r = await runCli(
      ["brain", "decision", "record", "--config", configPath, "--title", "x"],
      { env },
    );
    expect(r.returncode).not.toBe(0);
  });

  test("open parks a question, list_open/show_open read it, resolve mints the decision page", async () => {
    const opened = await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Which HTTP client for ingest",
        "--question",
        "Which HTTP client should the ingest lane adopt?",
        "--option",
        "bun fetch",
        "--option",
        "undici",
        "--context",
        "Needs pooling.",
        "--json",
      ],
      { env },
    );
    expect(opened.returncode).toBe(0);
    const openedOut = JSON.parse(opened.stdout);
    expect(openedOut.id).toBe("open-which-http-client-for-ingest");
    expect(openedOut.status).toBe("open");

    const shown = await runCli(
      ["brain", "decision", "show_open", openedOut.id, "--config", configPath, "--json"],
      { env },
    );
    expect(shown.returncode).toBe(0);
    const shownOut = JSON.parse(shown.stdout);
    expect(shownOut.question).toBe("Which HTTP client should the ingest lane adopt?");
    expect(shownOut.options).toEqual(["bun fetch", "undici"]);

    const resolved = await runCli(
      [
        "brain",
        "decision",
        "resolve",
        openedOut.id,
        "--config",
        configPath,
        "--choice",
        "bun fetch",
        "--rationale",
        "zero extra dependency",
        "--json",
      ],
      { env },
    );
    expect(resolved.returncode).toBe(0);
    expect(JSON.parse(resolved.stdout).decision).toBe("decision-which-http-client-for-ingest");

    // The minted page is a real decision record.
    const page = await runCli(
      [
        "brain",
        "decision",
        "show",
        "which-http-client-for-ingest",
        "--config",
        configPath,
        "--json",
      ],
      { env },
    );
    expect(page.returncode).toBe(0);
    expect(JSON.parse(page.stdout).chosen).toBe("bun fetch");

    const remaining = await runCli(
      ["brain", "decision", "list_open", "--config", configPath, "--status", "open"],
      { env },
    );
    expect(remaining.returncode).toBe(0);
    expect(remaining.stdout).toContain("no open decisions");
  });

  test("open refuses a duplicate question naming the existing id", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Pick a queue",
        "--question",
        "Which queue backs the worker?",
        "--option",
        "postgres",
        "--option",
        "rabbit",
      ],
      { env },
    );
    const dup = await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Pick a queue",
        "--question",
        "  which QUEUE backs the worker?  ",
        "--option",
        "postgres",
      ],
      { env },
    );
    expect(dup.returncode).not.toBe(0);
    expect(dup.stderr).toContain("open-pick-a-queue");
  });

  test("discard records the reason and list_open partitions by status", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Retry budget for ingest",
        "--question",
        "Which retry budget for ingest?",
        "--option",
        "3",
        "--option",
        "5",
      ],
      { env },
    );
    const discarded = await runCli(
      [
        "brain",
        "decision",
        "discard",
        "open-retry-budget-for-ingest",
        "--config",
        configPath,
        "--reason",
        "superseded by the panel verdict",
        "--json",
      ],
      { env },
    );
    expect(discarded.returncode).toBe(0);
    expect(JSON.parse(discarded.stdout).status).toBe("discarded");

    const list = await runCli(
      ["brain", "decision", "list_open", "--config", configPath, "--status", "discarded", "--json"],
      { env },
    );
    const listOut = JSON.parse(list.stdout);
    expect(listOut.open_decisions.map((r: { id: string }) => r.id)).toEqual([
      "open-retry-budget-for-ingest",
    ]);

    const shown = await runCli(
      ["brain", "decision", "show_open", "open-retry-budget-for-ingest", "--config", configPath],
      { env },
    );
    expect(shown.returncode).toBe(0);
    expect(shown.stdout).toContain("superseded by the panel verdict");
  });

  test("list_open names unreadable records instead of reporting an empty queue", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Fragile record",
        "--question",
        "Does the fragile record survive a hand edit?",
        "--option",
        "yes",
        "--option",
        "no",
      ],
      { env },
    );
    const path = join(vault, "Brain", "decisions", "open-fragile-record.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("status: open", "status: gone"), "utf8");
    const list = await runCli(
      ["brain", "decision", "list_open", "--config", configPath, "--json"],
      {
        env,
      },
    );
    expect(list.returncode).toBe(0);
    const out = JSON.parse(list.stdout);
    expect(out.open_decisions).toEqual([]);
    expect(out.unreadable).toHaveLength(1);
    expect(out.unreadable[0].reason).toContain("status");
  });

  test("resolve without --choice exits non-zero with usage", async () => {
    await runCli(
      [
        "brain",
        "decision",
        "open",
        "--config",
        configPath,
        "--title",
        "Undecided",
        "--question",
        "Undecided question?",
        "--option",
        "a",
      ],
      { env },
    );
    const r = await runCli(
      ["brain", "decision", "resolve", "open-undecided", "--config", configPath],
      { env },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--choice");
  });
});
