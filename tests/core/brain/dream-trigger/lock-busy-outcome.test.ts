/**
 * The day record after a pass that ended at a store lock that stayed busy
 * past its wait. Incomplete only when the pass had left work in the queue
 * (items produced, answers recorded: store appends that outlive it), with
 * that work named; a busy lock met before any work was left, or met again
 * by the next pass, is a failure. The exit of such a pass follows the
 * record, and a pass whose ending could not be recorded fails.
 */
import { describe, expect, test } from "bun:test";

import {
  busyLockPassIncomplete,
  decideDayOutcome,
  recordDreamOutcomeResult,
  retryDelayMs,
} from "../../../../src/core/brain/dream-trigger/outcome.ts";
import { emptyDreamTriggerRecord } from "../../../../src/core/brain/dream-trigger/record.ts";
import { LockBusyError } from "../../../../src/core/store/local-lock.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { agentFixture } from "../dream-agent/fixture.ts";

const HOLDER = "held by process 4242 (o2b hook) since 2026-11-26T09:00:00.000Z (130 s)";

function busyClock(): LockBusyError {
  return new LockBusyError(
    `store lock busy: /s/clock/dev-a.json: ${HOLDER}, still held after waiting 120000 ms; retry`,
    "/s/clock/dev-a.json",
    HOLDER,
    null,
  );
}

async function statusOf(configPath: string): Promise<string> {
  const status = await runCli(["dream", "status"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  return status.stdout;
}

describe("a pass that ends at a busy store lock", () => {
  test("after leaving work in the queue is incomplete, and names the work kept", async () => {
    const x = agentFixture();
    try {
      x.text("a");
      const startedAt = new Date();
      const ended = startedAt.getTime() + 60_000;
      const recording = recordDreamOutcomeResult(null, {
        configPath: x.f.configPath,
        startedAt,
        result: { threw: busyClock() },
        kept: { produced: 3, answered: 501 },
        by: "worker",
        now: () => ended,
      });
      expect(recording.kind).toBe("recorded");
      const record = recording.kind === "recorded" ? recording.record : null;
      expect(record?.last_run?.outcome).toBe("incomplete");
      expect(record?.failures).toBe(1);
      expect(record?.retry_at).toBe(new Date(ended + retryDelayMs(1)).toISOString());
      expect(record?.reason).toBe(
        "the pass stopped at a busy store lock; kept in the work queue: 3 item(s) produced, " +
          "501 answer(s) recorded (the next pass applies them): " +
          busyClock().message,
      );
      expect(await statusOf(x.f.configPath)).toContain("501 answer(s) recorded");
    } finally {
      x.cleanup();
    }
  });

  test("before leaving any work is a failure", async () => {
    const x = agentFixture();
    try {
      x.text("a");
      const startedAt = new Date();
      const ended = startedAt.getTime() + 60_000;
      for (const kept of [undefined, { produced: 0, answered: 0 }]) {
        const recording = recordDreamOutcomeResult(null, {
          configPath: x.f.configPath,
          startedAt,
          result: { threw: busyClock() },
          ...(kept !== undefined ? { kept } : {}),
          by: "worker",
          now: () => ended,
        });
        const record = recording.kind === "recorded" ? recording.record : null;
        expect(record?.last_run?.outcome).toBe("failed");
        expect(record?.reason).toBe(`the pass failed: ${busyClock().message}`);
      }
      const status = await statusOf(x.f.configPath);
      expect(status).toContain("the pass failed: store lock busy");
      expect(status).not.toContain("kept in the work queue");
    } finally {
      x.cleanup();
    }
  });

  test("again in the next pass is a failure, whatever that pass left", () => {
    const startedAt = new Date("2026-11-26T09:00:00.000Z");
    const endedAt = new Date("2026-11-26T09:19:00.000Z");
    const first = decideDayOutcome({
      previous: { ...emptyDreamTriggerRecord("/r"), failures: 1 },
      startedAt,
      endedAt,
      by: "worker",
      end: { kind: "lock-busy", message: "store lock busy", kept: { produced: 0, answered: 9 } },
    });
    expect(first?.last_run?.outcome).toBe("incomplete");
    expect(first?.failures).toBe(2);
    expect(first?.retry_at).toBe(new Date(endedAt.getTime() + retryDelayMs(2)).toISOString());

    const later = new Date(endedAt.getTime() + retryDelayMs(2));
    const second = decideDayOutcome({
      previous: first!,
      startedAt: later,
      endedAt: later,
      by: "worker",
      end: { kind: "lock-busy", message: "store lock busy", kept: { produced: 0, answered: 9 } },
    });
    expect(second?.last_run?.outcome).toBe("failed");
    expect(second?.reason).toBe(
      "the pass failed: a store lock stayed busy in two passes in a row: store lock busy",
    );
    expect(second?.failures).toBe(3);
    expect(second?.retry_at).toBe(new Date(later.getTime() + retryDelayMs(3)).toISOString());
  });
});

describe("whether a pass that ends at a busy store lock exits as incomplete", () => {
  const kept = { produced: 0, answered: 9 };
  const startedAt = new Date("2026-11-26T09:00:00.000Z");
  const endedAt = new Date("2026-11-26T09:19:00.000Z");
  const first = decideDayOutcome({
    previous: emptyDreamTriggerRecord("/r"),
    startedAt,
    endedAt,
    by: "worker",
    end: { kind: "lock-busy", message: "store lock busy", kept },
  })!;

  test("follows the record: the first busy ending is incomplete, the second in a row fails", () => {
    expect(busyLockPassIncomplete(busyClock(), { kind: "recorded", record: first }, kept)).toBe(
      true,
    );
    const second = decideDayOutcome({
      previous: first,
      startedAt: endedAt,
      endedAt,
      by: "worker",
      end: { kind: "lock-busy", message: "store lock busy", kept },
    })!;
    expect(busyLockPassIncomplete(busyClock(), { kind: "recorded", record: second }, kept)).toBe(
      false,
    );
  });

  test("is a failure when its ending could not be recorded, whatever it left", () => {
    // After a first busy ending recorded incomplete, the second one's record
    // fails: the stored record still shows the first, and the second must
    // not pass for a first.
    expect(first.last_run?.outcome).toBe("incomplete");
    expect(
      busyLockPassIncomplete(busyClock(), { kind: "failed", message: "disk full" }, kept),
    ).toBe(false);
  });

  test("with nothing to record, follows the work left; another error is never incomplete", () => {
    expect(busyLockPassIncomplete(busyClock(), { kind: "skipped" }, kept)).toBe(true);
    expect(
      busyLockPassIncomplete(busyClock(), { kind: "skipped" }, { produced: 0, answered: 0 }),
    ).toBe(false);
    expect(
      busyLockPassIncomplete(new Error("disk full"), { kind: "recorded", record: first }, kept),
    ).toBe(false);
  });
});
