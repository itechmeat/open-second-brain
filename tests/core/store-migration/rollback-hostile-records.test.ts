/**
 * The rollback replays records of every device, and a synced peer can
 * write any body (FORMAT.md, Trust). Records whose paths climb out of
 * `Brain/` (`..`, absolute, Windows-style), whose migrated key points
 * elsewhere, whose log timestamp is no date or whose preference id is no
 * slug are refused and reported, the rest of the rollback runs, and no
 * file outside `Brain/` is written or removed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

const FAST = { settleMs: 0 } as const;
/**
 * An instant after the switch `runMigration` stamps with the real clock,
 * inside the store's clock-drift bound, so the fold order holds on any
 * date the suite runs.
 */
function afterTheSwitch(): number {
  return Date.now() + 60_000;
}
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function put(
  store: StoreHandle,
  kind: string,
  body: Record<string, unknown>,
  at = afterTheSwitch(),
): string {
  return appendRecord(
    store,
    {
      partition: "shared",
      stream: kind === "log-event" ? "log" : "events",
      kind,
      agent: "t",
      body,
    },
    { now: () => at },
  ).record.id;
}

function signal(store: StoreHandle, id: string, path: string): string {
  return put(store, "signal", {
    id,
    path,
    staged: false,
    frontmatter: { id, topic: "t", principle: `Planted by ${id}` },
    raw: "Planted.",
  });
}

describe("rollback over hostile peer records", () => {
  test("refuses and reports records whose paths leave Brain/, and writes nothing outside it", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const outside = fleet.parent;
    const victim = join(outside, "victim.md");
    writeFileSync(victim, "keep me\n");

    b.use();
    const peer = b.store();
    const hostile = [
      signal(peer, "sig-up", "../../signal-up.md"),
      signal(peer, "sig-abs", join(outside, "signal-abs.md").split("\\").join("/")),
      signal(peer, "sig-win", "Brain\\..\\..\\..\\signal-win.md"),
      signal(peer, "sig-notes", "notes/signal-in-notes.md"),
      put(peer, "lane-entry", {
        authority: "agent",
        lane: "obligations",
        entry: "../../../../lane-up",
        fields: {},
        text: "Escaped.",
      }),
      put(peer, "lane-entry", {
        authority: "agent",
        lane: "obligations",
        entry: "obl-keyed",
        fields: {},
        text: "Keyed elsewhere.",
        migrated: { key: "notes/keyed.md", sum: "s", part: 0, parts: 1 },
      }),
      put(peer, "log-event", {
        timestamp: "../../../../log-up",
        event_type: "note",
        body: { text: "escaped log" },
      }),
      put(peer, "preference-set", {
        authority: "human",
        preference: "pref-../../../../pref-up",
        fields: { principle: "Escaped" },
      }),
    ];
    // A forgotten signal whose page path points at a file outside Brain/.
    const forgotten = signal(peer, "sig-victim", "../../victim.md");
    put(peer, "signal-removed", { authority: "human", signal: "sig-victim" }, afterTheSwitch() + 1);
    const climbingKey = put(peer, "lane-entry", {
      authority: "agent",
      lane: "obligations",
      entry: "obl-climb",
      fields: {},
      text: "Key climbs.",
      migrated: { key: "../../lane-key-up.md", sum: "s", part: 0, parts: 1 },
    });
    signal(peer, "sig-fine", "Brain/inbox/2026-11-08-fine.md");
    fleet.syncStore("dev-b", "dev-a");

    a.use();
    const result = rollback(a.vault);

    for (const name of [
      "signal-up.md",
      "signal-abs.md",
      "signal-win.md",
      "lane-up.md",
      "lane-key-up.md",
    ]) {
      expect({ name, exists: existsSync(join(outside, name)) }).toEqual({ name, exists: false });
    }
    expect(existsSync(join(a.vault, "notes", "signal-in-notes.md"))).toBe(false);
    expect(existsSync(join(a.vault, "notes", "keyed.md"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");

    const refused = new Set(result.refused.map((r) => r.id));
    for (const id of hostile)
      expect({ id, refused: refused.has(id) }).toEqual({ id, refused: true });
    expect(refused.has(forgotten)).toBe(false);
    // A key that is no record path is no mark: the entry goes to its own page.
    expect(refused.has(climbingKey)).toBe(false);
    expect(readFileSync(join(a.vault, "Brain", "obligations", "obl-climb.md"), "utf8")).toContain(
      "Key climbs.",
    );
    expect(readFileSync(join(a.vault, "Brain", "inbox", "2026-11-08-fine.md"), "utf8")).toContain(
      "Planted by sig-fine",
    );
  });
});
