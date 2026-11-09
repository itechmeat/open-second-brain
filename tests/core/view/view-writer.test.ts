/**
 * The view writer role (task 2.7, design D7): the first machine takes it,
 * two simultaneous first claims leave one winner whose rival wrote no
 * page, a move waits for the old writer's release so no page is written
 * by both, a forced move renders at once and the old writer stops at its
 * first catch-up after it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { VIEW_RENDER_KIND } from "../../../src/core/view/constants.ts";
import { allRecords, catchUp } from "../../../src/core/view/catch-up.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import {
  claimViewWriter,
  readViewWriter,
  requestViewWriter,
} from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
let clock = NOW;
const now = () => clock;
const agent = "view-test";

let m: Machines;
beforeEach(() => {
  clock = NOW;
  m = makeMachines(["dev-a", "dev-b"]);
});
afterEach(() => m.cleanup());

function pass(store: StoreHandle) {
  clock += 1000;
  return runViewPass(store, { target: m.view(store.device), vault: null, agent, now });
}

function pagesIn(device: string): string[] {
  return existsSync(m.view(device)) ? readdirSync(m.view(device)) : [];
}

function renderDevices(store: StoreHandle): string[] {
  return allRecords(catchUp(store, now))
    .filter((r) => r.kind === VIEW_RENDER_KIND)
    .map((r) => r.device);
}

describe("view writer role", () => {
  test("the first machine to initialise the store takes the role, once", () => {
    const a = m.open("dev-a");
    expect(claimViewWriter(a, { agent, now }).claimed).toBe(true);
    expect(readViewWriter(a, now)).toMatchObject({ writer: "dev-a", via: "claim" });
    m.sync();
    const b = m.open("dev-b");
    expect(claimViewWriter(b, { agent, now })).toEqual({ claimed: false, writer: "dev-a" });
  });

  test("a malformed claim does not keep a machine from claiming", () => {
    const a = m.open("dev-a");
    // An agent-authority claim: rejected by the fold, so nobody holds the role.
    appendRecord(a, {
      partition: "shared",
      stream: "settings",
      kind: "view-writer-claim",
      agent,
      body: { authority: "agent", device: "dev-a" },
    });
    expect(readViewWriter(a, now).writer).toBeNull();
    expect(claimViewWriter(a, { agent, now }).claimed).toBe(true);
    expect(readViewWriter(a, now).writer).toBe("dev-a");
  });

  test("a fresh claim waits one catch-up before its first render", () => {
    const a = m.open("dev-a");
    claimViewWriter(a, { agent, now });
    expect(pass(a).status).toBe("waiting-for-claim");
    expect(pagesIn("dev-a")).toEqual([]);
    expect(pass(a).status).toBe("rendered");
    expect(pagesIn("dev-a")).toContain("about-me.md");
  });

  test("two simultaneous first claims: the lowest clock wins and the loser writes no page", () => {
    const a = m.open("dev-a");
    const b = m.open("dev-b");
    claimViewWriter(b, { agent, now: () => NOW + 5 });
    claimViewWriter(a, { agent, now: () => NOW + 9 });
    // Each pass before the claims meet only waits.
    expect(pass(a).status).toBe("waiting-for-claim");
    expect(pass(b).status).toBe("waiting-for-claim");
    m.sync();
    expect(readViewWriter(a, now).writer).toBe("dev-b");
    expect(readViewWriter(b, now).writer).toBe("dev-b");
    expect(pass(a)).toEqual({ status: "not-writer", writer: "dev-b" });
    expect(pass(b).status).toBe("rendered");
    expect(pagesIn("dev-a")).toEqual([]);
    expect(pagesIn("dev-b")).toContain("about-me.md");
  });

  test("a move takes effect only after the old writer's release: no page is written by both", () => {
    const a = m.open("dev-a");
    claimViewWriter(a, { agent, now });
    pass(a);
    expect(pass(a).status).toBe("rendered");
    m.sync();
    const b = m.open("dev-b");
    const asked = requestViewWriter(b, { agent, now, force: false });
    expect(asked).toMatchObject({ status: "requested", previous: "dev-a" });
    // The request has not reached A: B is not the writer yet and renders nothing.
    expect(pass(b)).toEqual({ status: "not-writer", writer: "dev-a" });
    expect(pagesIn("dev-b")).toEqual([]);
    m.sync();
    // A sees the request at its catch-up and releases instead of rendering.
    const rendersBefore = renderDevices(a).filter((d) => d === "dev-a").length;
    expect(pass(a)).toEqual({ status: "released", to: "dev-b" });
    expect(pass(a)).toEqual({ status: "not-writer", writer: "dev-b" });
    expect(renderDevices(a).filter((d) => d === "dev-a").length).toBe(rendersBefore);
    // B still waits until the release reaches it.
    expect(pass(b)).toEqual({ status: "not-writer", writer: "dev-a" });
    m.sync();
    expect(pass(b).status).toBe("rendered");
    expect(pagesIn("dev-b")).toContain("about-me.md");
    m.sync();
    const order = allRecords(catchUp(b, now)).filter(
      (r) => r.kind === VIEW_RENDER_KIND || r.kind === "view-writer-released",
    );
    const releaseAt = order.findIndex((r) => r.kind === "view-writer-released");
    // The release is in the order, with renders on both sides of it.
    expect(releaseAt).toBeGreaterThan(0);
    expect(releaseAt).toBeLessThan(order.length - 1);
    // Every render before the release is A's, every one after it is B's.
    expect(order.slice(0, releaseAt).every((r) => r.device === "dev-a")).toBe(true);
    expect(order.slice(releaseAt + 1).every((r) => r.device === "dev-b")).toBe(true);
  });

  test("a forced move renders at once, warns, and the old writer stops at its next catch-up", () => {
    const a = m.open("dev-a");
    claimViewWriter(a, { agent, now });
    pass(a);
    pass(a);
    m.sync();
    const b = m.open("dev-b");
    const forced = requestViewWriter(b, { agent, now, force: true });
    expect(forced.status).toBe("forced");
    expect(forced.status === "forced" && forced.warning).toContain("may render the view once more");
    expect(pass(b).status).toBe("rendered");
    // A has not seen the move yet: it may render once more.
    expect(pass(a).status).toBe("rendered");
    m.sync();
    expect(pass(a)).toEqual({ status: "not-writer", writer: "dev-b" });
  });

  test("only a human request for the requesting device itself moves the role", () => {
    const a = m.open("dev-a");
    claimViewWriter(a, { agent, now });
    m.sync();
    const b = m.open("dev-b");
    for (const body of [
      { authority: "agent", device: "dev-b", force: true },
      { authority: "human", device: "dev-a", force: true },
    ]) {
      appendRecord(
        b,
        { partition: "shared", stream: "settings", kind: "view-writer-request", agent, body },
        { now },
      );
    }
    m.sync();
    const state = readViewWriter(a, now);
    expect(state.writer).toBe("dev-a");
    expect(state.rejected.map((r) => r.reason)).toEqual([
      "only the user moves the view writer role",
      "a device claims or requests the role only for itself",
    ]);
  });

  test("with no claim, a request takes the role at once", () => {
    const b = m.open("dev-b");
    expect(requestViewWriter(b, { agent, now, force: false })).toMatchObject({
      status: "taken",
      previous: null,
    });
    expect(pass(b).status).toBe("rendered");
  });
});

describe("a writer record read only in part", () => {
  test("a corrupt line in a settings shard stops the pass as an incomplete read", () => {
    const a = m.open("dev-a");
    claimViewWriter(a, { agent, now });
    expect(pass(a).status).toBe("waiting-for-claim");
    for (const value of ["en", "ru"]) {
      appendRecord(a, {
        partition: "shared",
        stream: "settings",
        kind: "setting-set",
        agent,
        body: { authority: "human", key: "view.language", value },
      });
    }
    const dir = join(a.root, "shared", "settings", "dev-a");
    const shard = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(shard, "utf8").split("\n");
    // The middle record could have been a handover; it no longer verifies.
    lines[1] = lines[1]!.replace('"value":"en"', '"value":"de"');
    writeFileSync(shard, lines.join("\n"));
    expect(pass(a).status).toBe("incomplete-read");
    expect(pagesIn("dev-a")).toEqual([]);
  });
});
