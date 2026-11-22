import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import {
  createWindowContext,
  readWindowEvidence,
} from "../../../src/core/brain/dream-replay/window.ts";
import { collectEvidenceForSlug } from "../../../src/core/brain/evidence-read.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { preferencePath, retiredPath } from "../../../src/core/brain/paths.ts";
import { scanBrain } from "../../../src/core/brain/dream-scan.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { makeStoreEnv } from "../../core/store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const NOW = new Date("2026-06-01T12:00:00Z");

function seedPreference(vault: string, slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-15T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
  });
  appendApplyEvidence(
    vault,
    { pref_id: slug, artifact: "Daily/one.md", result: "applied", agent: "claude" },
    { now: new Date("2026-05-03T09:00:00Z") },
  );
  appendLogEvent(vault, {
    timestamp: "2026-05-04T09:00:00Z",
    eventType: "apply-evidence",
    agent: "codex",
    body: {
      preference: `[[ret-${slug}]]`,
      result: "violated",
      artifact: "Daily/two.md",
      agent: "codex",
    },
  });
}

function evidenceSections(vault: string, slug: string): string[] {
  const body = readFileSync(retiredPath(vault, slug), "utf8");
  return ["Recent applications", "Recent violations"].map((heading) => {
    const start = body.indexOf(`## ${heading}`);
    const next = body.indexOf("\n## ", start + 4);
    return body.slice(start, next < 0 ? undefined : next);
  });
}

describe("dream window evidence", () => {
  test("slug lookup matches the existing collector, including ret targets", () => {
    const env = makeStoreEnv("osb-window-evidence-lookup-");
    try {
      switchDevice(env.storeRoot);
      seedPreference(env.vault, "window-rule");
      const context = createWindowContext(NOW, scanBrain(env.vault));
      context.setEvidence(readWindowEvidence(env.vault, context.signals, () => {}));

      expect(context.evidence.lookup("window-rule", { sinceIso: "" })).toEqual(
        collectEvidenceForSlug(env.vault, "window-rule", { sinceIso: "" }),
      );
      expect(context.evidence.lookup("window-rule", { sinceIso: "" }).violated).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  test("slug lookup excludes events older than its cutoff", () => {
    const env = makeStoreEnv("osb-window-evidence-cutoff-");
    try {
      switchDevice(env.storeRoot);
      seedPreference(env.vault, "cutoff-rule");
      const context = createWindowContext(NOW, scanBrain(env.vault));
      context.setEvidence(readWindowEvidence(env.vault, context.signals, () => {}));

      const result = context.evidence.lookup("cutoff-rule", {
        sinceIso: "2026-05-04T00:00:00Z",
      });
      expect(result.applied).toEqual([]);
      expect(result.violated.map((row) => row.timestamp)).toEqual(["2026-05-04T09:00:00Z"]);
    } finally {
      env.cleanup();
    }
  });

  test("cutoff lookup skips a long older application history", () => {
    const env = makeStoreEnv("osb-window-evidence-long-cutoff-");
    try {
      switchDevice(env.storeRoot);
      writePreference(env.vault, {
        slug: "long-history-rule",
        topic: "long-history-rule",
        principle: "Rule long-history-rule",
        created_at: "2025-01-01T00:00:00Z",
        unconfirmed_until: "2025-01-15T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2025-01-02T00:00:00Z",
        evidenced_by: [],
      });
      for (let i = 0; i < 200; i++) {
        appendLogEvent(env.vault, {
          timestamp: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
          eventType: "apply-evidence",
          agent: "codex",
          body: {
            preference: "[[pref-long-history-rule]]",
            result: "applied",
            artifact: `Daily/old-${i}.md`,
          },
        });
      }
      appendLogEvent(env.vault, {
        timestamp: "2026-05-03T09:00:00Z",
        eventType: "apply-evidence",
        agent: "codex",
        body: {
          preference: "[[pref-long-history-rule]]",
          result: "applied",
          artifact: "Daily/recent.md",
        },
      });
      const context = createWindowContext(NOW, scanBrain(env.vault));
      const evidence = readWindowEvidence(env.vault, context.signals, () => {});
      context.setEvidence(evidence);

      let oldTimestampVisits = 0;
      for (const event of evidence.events) {
        if (event.timestamp >= "2026-05-01T00:00:00Z") continue;
        const timestamp = event.timestamp;
        Object.defineProperty(event, "timestamp", {
          configurable: true,
          get() {
            oldTimestampVisits++;
            return timestamp;
          },
        });
      }

      const result = evidence.lookup("long-history-rule", {
        sinceIso: "2026-05-01T00:00:00Z",
      });
      expect(result.applied).toHaveLength(1);
      expect(result.violated).toEqual([]);
      expect(oldTimestampVisits).toBeLessThanOrEqual(20);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  test("pass and command-line retirements write identical evidence sections", () => {
    const passEnv = makeStoreEnv("osb-window-evidence-pass-");
    const cliEnv = makeStoreEnv("osb-window-evidence-cli-");
    try {
      seedPreference(passEnv.vault, "same-rule");
      seedPreference(cliEnv.vault, "same-rule");
      appendApplyEvidence(
        passEnv.vault,
        {
          pref_id: "same-rule",
          artifact: "Daily/obsolete.md",
          result: "outdated",
          agent: "claude",
        },
        { now: new Date("2026-05-05T09:00:00Z") },
      );
      appendApplyEvidence(
        cliEnv.vault,
        {
          pref_id: "same-rule",
          artifact: "Daily/obsolete.md",
          result: "outdated",
          agent: "claude",
        },
        { now: new Date("2026-05-05T09:00:00Z") },
      );
      const summary = dream(passEnv.vault, { now: NOW });
      expect(summary.retired.map((item) => item.id)).toContain("ret-same-rule");
      moveToRetired(
        cliEnv.vault,
        preferencePath(cliEnv.vault, "same-rule"),
        "superseded-by-context",
        {
          now: NOW,
          retired_by: "dream-window-test",
        },
      );

      expect(evidenceSections(passEnv.vault, "same-rule")).toEqual(
        evidenceSections(cliEnv.vault, "same-rule"),
      );
    } finally {
      cliEnv.cleanup();
      passEnv.cleanup();
    }
  });
});
