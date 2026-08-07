/**
 * `o2b brain query` point-in-time recall (what-the-index-already-knew,
 * task J).
 *
 * The expiry filter has taken an as-of instant since C5 - `filterExpired`
 * defaults `now` to the wall clock and `queryByTopic` threads a `now`
 * option straight into it - and no surface ever passed one. The CLI
 * called `queryByTopic(vault, topic)` with no options object at all, so
 * "what did the brain hold as of last month" was unaskable from the one
 * surface that enforces expiry, and `--show-expired` (which MCP has had
 * since C5) did not exist on the CLI either.
 *
 * The byte-identity pins below are the EXACT stdout the pre-change binary
 * produced for the same fixture, captured before the flags existed. They
 * are literals rather than a re-serialised comparison so a change in key
 * order, indentation or trailing newline fails here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal, type WriteSignalInput } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

const TOPIC = "deploy";
/** The lapsed signal's expiration; every probe instant is chosen around it. */
const LAPSED_EXPIRY = "2026-07-15";
/** An instant BEFORE the expiry: the lapsed signal was still live then. */
const BEFORE_EXPIRY = "2026-06-01T00:00:00Z";
/** An instant AFTER the expiry, still deterministic against any wall clock. */
const AFTER_EXPIRY = "2026-08-01T00:00:00Z";

const LAPSED_PRINCIPLE = "Principle for lapsed";
const EVERGREEN_PRINCIPLE = "Principle for evergreen";

/** Exact pre-change stdout for `--topic deploy --json`, no new flags. */
const PINNED_JSON_STDOUT = `{
  "signals": [
    {
      "kind": "brain-signal",
      "id": "sig-2026-05-02-evergreen",
      "created_at": "2026-05-02T00:00:00Z",
      "tags": [
        "brain",
        "brain/signal",
        "brain/topic/deploy"
      ],
      "topic": "deploy",
      "signal": "positive",
      "agent": "tester",
      "principle": "Principle for evergreen"
    }
  ],
  "preference": null,
  "all_log_events": []
}
`;

/** Exact pre-change stdout for `--topic deploy` on the human surface. */
const PINNED_TEXT_STDOUT =
  "topic: deploy\n" +
  "preference: (none)\n" +
  "signals: 1\n" +
  "  - sig-2026-05-02-evergreen (positive, 2026-05-02T00:00:00Z)\n" +
  "log_events: 0\n";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-query-as-of-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath: config });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function signal(slug: string, overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: TOPIC,
    signal: "positive",
    agent: "tester",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
    ...overrides,
  };
}

/** One signal that has lapsed, one that never expires. */
function seed(): void {
  writeSignal(vault, signal("lapsed", { expiration_date: LAPSED_EXPIRY }));
  writeSignal(
    vault,
    signal("evergreen", { created_at: "2026-05-02T00:00:00Z", date: "2026-05-02" }),
  );
}

async function query(...args: string[]) {
  return runCli(["brain", "query", "--vault", vault, "--topic", TOPIC, ...args], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
}

function principles(stdout: string): string[] {
  const payload = JSON.parse(stdout) as { signals: ReadonlyArray<{ principle: string }> };
  return payload.signals.map((s) => s.principle).toSorted();
}

describe("brain query --at", () => {
  test("recalls what the brain held at an instant before the memory lapsed", async () => {
    seed();
    const r = await query("--json", "--at", BEFORE_EXPIRY);
    expect(r.stderr).toBe("");
    expect(r.returncode).toBe(0);
    expect(principles(r.stdout)).toEqual([EVERGREEN_PRINCIPLE, LAPSED_PRINCIPLE]);
  });

  test("an instant after the expiry drops the lapsed memory again", async () => {
    seed();
    const r = await query("--json", "--at", AFTER_EXPIRY);
    expect(r.returncode).toBe(0);
    expect(principles(r.stdout)).toEqual([EVERGREEN_PRINCIPLE]);
  });

  test("a date-only instant is accepted and read as UTC midnight", async () => {
    seed();
    const r = await query("--json", "--at", "2026-06-01");
    expect(r.returncode).toBe(0);
    expect(principles(r.stdout)).toEqual([EVERGREEN_PRINCIPLE, LAPSED_PRINCIPLE]);
  });

  test("an unparseable instant is refused by name, never coerced to now", async () => {
    seed();
    const r = await query("--json", "--at", "last month");
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--at");
    expect(r.stderr).toContain("ISO-8601 instant or YYYY-MM-DD date");
    expect(r.stderr).toContain("last month");
    // A refused query answers nothing; it must not fall through to today.
    expect(r.stdout).toBe("");
  });

  test("--at outside topic mode is refused rather than silently ignored", async () => {
    seed();
    const r = await runCli(
      ["brain", "query", "--vault", vault, "--since", BEFORE_EXPIRY, "--at", BEFORE_EXPIRY],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--topic");
  });
});

describe("brain query --show-expired", () => {
  test("keeps a lapsed memory in the result", async () => {
    seed();
    const r = await query("--json", "--show-expired");
    expect(r.returncode).toBe(0);
    expect(principles(r.stdout)).toEqual([EVERGREEN_PRINCIPLE, LAPSED_PRINCIPLE]);
  });

  test("is refused outside topic mode", async () => {
    seed();
    const r = await runCli(
      ["brain", "query", "--vault", vault, "--since", BEFORE_EXPIRY, "--show-expired"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--topic");
  });
});

describe("byte identity when both flags are absent", () => {
  test("--json stdout is byte-for-byte the pre-change output", async () => {
    seed();
    const r = await query("--json");
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(PINNED_JSON_STDOUT);
  });

  test("the human surface is byte-for-byte the pre-change output", async () => {
    seed();
    const r = await query();
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe(PINNED_TEXT_STDOUT);
  });

  test("the pins are not vacuous: either flag changes those exact bytes", async () => {
    seed();
    const withAt = await query("--json", "--at", BEFORE_EXPIRY);
    const withShowExpired = await query("--json", "--show-expired");
    expect(withAt.stdout).not.toBe(PINNED_JSON_STDOUT);
    expect(withShowExpired.stdout).not.toBe(PINNED_JSON_STDOUT);
  });
});
