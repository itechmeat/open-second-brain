/**
 * The render pass without a manual command: the end of a dream pass and
 * the session-start hook run it on the view writer, at most hourly from
 * the hook, inside a time budget, fail-open, and a machine that is not the
 * writer reads nothing but the writer records.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { autoViewAudit, runAutoViewPass } from "../../../src/core/view/auto-render.ts";
import { VIEW_TARGET_ENV } from "../../../src/core/view/constants.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import {
  AUTO_NOW as NOW,
  makeAutoViewEnv,
  makeLegacyDreamVault,
  seedWriterStore,
  type AutoViewEnv,
} from "./fixtures/auto-env.ts";

const HOUR = 3_600_000;

let env: AutoViewEnv;
let parent: string;
let root: string;
let view: string;

beforeEach(() => {
  env = makeAutoViewEnv("osb-view-auto-");
  ({ parent, root, view } = env);
});

afterEach(() => env.cleanup());

function writerStore(): StoreHandle {
  return seedWriterStore(root);
}

describe("automatic view render", () => {
  test("no store, or no device id: nothing runs", () => {
    expect(runAutoViewPass({ trigger: "dream" })).toBeNull();
    initStore({ root });
    process.env["O2B_DEVICE_ID"] = "";
    expect(runAutoViewPass({ trigger: "session-start" })).toBeNull();
  });

  test("the session-start trigger renders at most once an hour", () => {
    writerStore();
    let clock = NOW;
    const now = () => clock;
    expect(runAutoViewPass({ trigger: "session-start", now })?.status).toBe("waiting-for-claim");
    clock += HOUR - 1;
    expect(runAutoViewPass({ trigger: "session-start", now })).toEqual({ status: "throttled" });
    clock += 2;
    expect(runAutoViewPass({ trigger: "session-start", now })?.status).toBe("rendered");
    expect(fs.readFileSync(join(view, "about-me.md"), "utf8")).toContain("- Rule A.");
    // The dream trigger is not throttled.
    expect(runAutoViewPass({ trigger: "dream", now })?.status).toBe("rendered");
  });

  test("a spent time budget defers the remaining pages to the next pass", () => {
    writerStore();
    runAutoViewPass({ trigger: "dream" });
    const result = runAutoViewPass({ trigger: "dream", budgetMs: -1 });
    expect(result?.status).toBe("rendered");
    expect(
      result?.status === "rendered" &&
        result.pages.length > 0 &&
        result.pages.every((p) => p.status === "deferred"),
    ).toBe(true);
  });

  test("a failure is returned, never thrown", () => {
    writerStore();
    process.env[VIEW_TARGET_ENV] = join(root, "shared", "view");
    const result = runAutoViewPass({ trigger: "dream" });
    expect(result?.status).toBe("error");
    expect(result?.status === "error" && result.error).toContain("inside the brain store");
  });

  test("an idle pass reads no page file, and a machine that is not the writer reads only the writer records", () => {
    const a = writerStore();
    const opts = { target: view, vault: null, agent: "t" } as const;
    runViewPass(a, opts);
    runViewPass(a, opts);
    const read = spyOn(fs, "readFileSync");
    const opened = spyOn(fs, "openSync");
    try {
      const idle = runViewPass(a, opts);
      expect(
        idle.status === "rendered" &&
          idle.pages.length > 0 &&
          idle.pages.every((p) => p.status === "unchanged"),
      ).toBe(true);
      const touched = [...read.mock.calls, ...opened.mock.calls].map((c) => String(c[0]));
      expect(touched.filter((p) => p.startsWith(view))).toEqual([]);
      // A page touched since the writer left it is read again.
      const page = join(view, "about-me.md");
      fs.utimesSync(page, new Date(NOW), new Date(NOW));
      read.mockClear();
      runViewPass(a, opts);
      expect(read.mock.calls.map((c) => String(c[0]))).toContain(page);

      read.mockClear();
      opened.mockClear();
      const b = openStore({
        root,
        device: "dev-b",
        dirs: {
          platform: process.platform,
          home: join(parent, "home-b"),
          env: { XDG_STATE_HOME: join(parent, "state-b"), LOCALAPPDATA: join(parent, "state-b") },
        },
      });
      expect(runViewPass(b, { ...opts, target: join(parent, "view-b") })).toEqual({
        status: "not-writer",
        writer: "dev-a",
      });
      const paths = [...read.mock.calls, ...opened.mock.calls].map((c) => String(c[0]));
      const shards = paths.filter((p) => p.endsWith(".jsonl"));
      expect(shards.length).toBeGreaterThan(0);
      expect(shards.every((p) => p.includes(join("shared", "settings")))).toBe(true);
    } finally {
      read.mockRestore();
      opened.mockRestore();
    }
  });

  test("a dream pass on a machine that is not the writer names the writer in its summary", () => {
    initStore({ root });
    const b = openStore({ root, device: "dev-b" });
    claimViewWriter(b, { agent: "t" });
    const vault = makeLegacyDreamVault(parent);
    const summary = dream(vault);
    expect(summary.view).toEqual({
      status: "not-writer",
      summary: "this machine writes no view page; the view writer is dev-b",
      writer: "dev-b",
    });
    expect(dream(vault, { dryRun: true }).view).toBeUndefined();
  });
});

describe("autoViewAudit", () => {
  test("a pass that rendered nothing, or left a page refused or busy, is not ok, and names why", () => {
    const [incompleteOk, incomplete] = autoViewAudit({
      status: "incomplete-read",
      shards: ["shared/events/dev-b.jsonl"],
    });
    expect(incompleteOk).toBe(false);
    expect(incomplete["shards"]).toEqual(["shared/events/dev-b.jsonl"]);
    const [refusedOk, refused] = autoViewAudit({
      status: "rendered",
      pages: [
        { page: "about-me.md", status: "written", ingested: 0 },
        { page: "decisions.md", status: "refused", ingested: 0, detail: "a folder is in the way" },
      ],
    });
    expect(refusedOk).toBe(false);
    expect(refused["pages"]).toEqual([
      { page: "decisions.md", status: "refused", detail: "a folder is in the way" },
    ]);
    const [deferredOk] = autoViewAudit({
      status: "rendered",
      pages: [{ page: "about-me.md", status: "deferred", ingested: 0 }],
    });
    expect(deferredOk).toBe(true);
  });
});
