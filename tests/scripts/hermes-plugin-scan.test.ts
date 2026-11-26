/**
 * `scripts/hermes-plugin-scan.ts` - the pinned scanner fetch.
 *
 * The CI gate fetches Hermes' scanner modules from the GitHub contents API.
 * A shared runner can hit that API's rate limit (HTTP 429) or a transient
 * server error; the fetch retries those a bounded number of times with
 * backoff, honours a `Retry-After` header, and otherwise surfaces the last
 * status by name. A stubbed fetch and sleep keep the tests off the network.
 *
 * The verdict rule: the documented install must scan `safe`, because Hermes
 * asks for confirmation on `caution` and so stops every non-interactive
 * install and unattended update; any target that scans `dangerous` fails too.
 */

import { describe, expect, test } from "bun:test";

import {
  GUARD_FETCH_ATTEMPTS,
  GUARD_FETCH_BASE_DELAY_MS,
  fetchGuardFile,
  formatScanReport,
  gateFailures,
  type GuardFetchDeps,
  type ScanTarget,
} from "../../scripts/hermes-plugin-scan.ts";

const PATH = "tools/skills_guard.py";
const BODY = new TextEncoder().encode("print('guard')\n");

function stubFetch(responses: Array<() => Response>): {
  fetch: GuardFetchDeps["fetch"];
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  }) satisfies GuardFetchDeps["fetch"];
  return { fetch: fetchImpl, calls: () => calls };
}

function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const status = (code: number, headers?: Record<string, string>) => () =>
  new Response("rate limited", { status: code, headers });
const ok = () => new Response(BODY, { status: 200 });

describe("fetchGuardFile", () => {
  test("a rate-limited fetch is retried with exponential backoff until it succeeds", async () => {
    const stub = stubFetch([status(429), status(429), ok]);
    const clock = recordingSleep();
    const data = await fetchGuardFile(PATH, {
      fetch: stub.fetch,
      sleep: clock.sleep,
    });
    expect(new TextDecoder().decode(data)).toBe("print('guard')\n");
    expect(stub.calls()).toBe(3);
    expect(clock.delays).toEqual([GUARD_FETCH_BASE_DELAY_MS, GUARD_FETCH_BASE_DELAY_MS * 2]);
  });

  test("a Retry-After header in seconds sets the wait", async () => {
    const stub = stubFetch([status(429, { "Retry-After": "7" }), ok]);
    const clock = recordingSleep();
    await fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep });
    expect(clock.delays).toEqual([7000]);
  });

  test("a server error is retried like a rate limit", async () => {
    const stub = stubFetch([status(503), ok]);
    const clock = recordingSleep();
    await fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep });
    expect(stub.calls()).toBe(2);
  });

  test("exhausted attempts throw the last status by name", async () => {
    const stub = stubFetch([status(429)]);
    const clock = recordingSleep();
    await expect(fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep })).rejects.toThrow(
      new RegExp(`${PATH}@[0-9a-f]{40}: HTTP 429 after ${GUARD_FETCH_ATTEMPTS} attempts`),
    );
    expect(stub.calls()).toBe(GUARD_FETCH_ATTEMPTS);
    expect(clock.delays).toHaveLength(GUARD_FETCH_ATTEMPTS - 1);
  });

  test("a client error other than 429 is not retried", async () => {
    const stub = stubFetch([status(404)]);
    const clock = recordingSleep();
    await expect(fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep })).rejects.toThrow(
      /HTTP 404 after 1 attempt/,
    );
    expect(stub.calls()).toBe(1);
    expect(clock.delays).toEqual([]);
  });
});

const DOCUMENTED: ScanTarget = { path: ".", label: "documented", documented: true };
const SUBDIR: ScanTarget = { path: "plugins/hermes", label: "subdir", documented: false };

describe("gateFailures", () => {
  test("a safe documented install and a safe subdirectory pass", () => {
    expect(
      gateFailures([
        { target: DOCUMENTED, verdict: "safe" },
        { target: SUBDIR, verdict: "safe" },
      ]),
    ).toEqual([]);
  });

  test("a caution verdict on the documented install fails: it needs a confirmation", () => {
    const failures = gateFailures([{ target: DOCUMENTED, verdict: "caution" }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(".: caution");
    expect(failures[0]).toContain("unattended update");
  });

  test("a caution verdict on a target that is not the documented install is reported only", () => {
    expect(gateFailures([{ target: SUBDIR, verdict: "caution" }])).toEqual([]);
  });

  test("a dangerous verdict fails on any target", () => {
    const failures = gateFailures([{ target: SUBDIR, verdict: "dangerous" }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("--force does not override it");
  });
});

describe("formatScanReport", () => {
  const finding = (severity: string, pattern: string, file: string) => ({
    severity,
    pattern,
    file,
    line: 3,
    match: `${pattern} text`,
  });
  const report = {
    verdict: "caution",
    findings: [
      finding("medium", "path_traversal", "src/a.ts"),
      finding("medium", "path_traversal", "tests/a.test.ts"),
      finding("low", "agent_config_ref", "README.md"),
      finding("high", "role_pretend", "docs/x.md"),
    ],
  };

  test("prints the verdict, the counts by severity and by pattern, and every high finding", () => {
    const text = formatScanReport(DOCUMENTED, report, { verbose: false });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe(
      ". (documented): caution - 4 findings: critical 0, high 1, medium 2, low 1",
    );
    // Patterns are ordered by severity, then by count.
    expect(lines.slice(1, 4).map((l) => l.trim().split(/\s+/))).toEqual([
      ["1", "high", "role_pretend"],
      ["2", "medium", "path_traversal"],
      ["1", "low", "agent_config_ref"],
    ]);
    expect(lines.slice(4)).toEqual(["  [high] role_pretend docs/x.md:3  role_pretend text"]);
  });

  test("--verbose also lists the medium findings outside the test trees", () => {
    const text = formatScanReport(DOCUMENTED, report, { verbose: true });
    expect(text).toContain("[medium] path_traversal src/a.ts:3");
    expect(text).not.toContain("tests/a.test.ts");
  });
});
