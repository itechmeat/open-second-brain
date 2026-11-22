import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildIntentReview } from "../../../src/core/brain/intent-review.ts";
import { scanBrain } from "../../../src/core/brain/dream-scan.ts";
import { createWindowContext } from "../../../src/core/brain/dream-replay/window.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { buildReachLogFixture } from "../../helpers/reach-log-fixture.ts";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe("dream window intent review", () => {
  test("keeps readable signals when using the scanned window", () => {
    const base = join(tmpdir(), `o2b-window-intent-${crypto.randomUUID()}`);
    bases.push(base);
    const fixture = buildReachLogFixture(base, false);
    const day = new Date().toISOString().slice(0, 10);
    writeSignal(fixture.vault, {
      topic: "readable-topic",
      signal: "positive",
      agent: "test",
      principle: "Prefer readable topic.",
      created_at: `${day}T00:00:00Z`,
      date: day,
      slug: "readable-topic",
    });

    const window = createWindowContext(new Date(), scanBrain(fixture.vault));
    const report = buildIntentReview(fixture.vault, {
      now: window.instant,
      signals: window.signals.signals,
      readable: (path) => path.startsWith("Brain/inbox/"),
    });

    expect(report.reviews.map((review) => review.topic)).toEqual(["readable-topic"]);
  });
});
