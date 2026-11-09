/**
 * The render protocol (task 2.8, design D7): edits are detected against the
 * stored base before a render, merged with the user winning, re-checked
 * before the replacement, conflict copies are ingested and removed, and
 * only changed bytes are written. Human edits become human records.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { allRecords, catchUp } from "../../../src/core/view/catch-up.ts";
import { VIEW_RECOVER_DAYS } from "../../../src/core/view/constants.ts";
import { listReplacedVersions } from "../../../src/core/view/recover.ts";
import { runViewPass, type ViewPassReport } from "../../../src/core/view/render.ts";
import type { ReplaceHooks } from "../../../src/core/view/page-io.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { blobPath, partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedLogEvent, seedPreference } from "./fixtures/seed.ts";

const MON = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = MON + 86_400_000 * 5;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  clock = MON + 86_400_000 * 5;
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
  seedPreference(a, MON, "pref-a", { principle: "Rule A.", status: "confirmed", scope: "work" });
  seedPreference(a, MON + 1, "pref-b", {
    principle: "Rule B.",
    status: "confirmed",
    scope: "work",
  });
  seedLogEvent(a, MON + 2, "note", { text: "Did a thing." });
  claimViewWriter(a, { agent: "t", now });
  pass();
  pass();
});
afterEach(() => m.cleanup());

function pass(hooks?: ReplaceHooks, store: StoreHandle = a): ViewPassReport {
  clock += 1000;
  return runViewPass(store, {
    target: m.view(store.device),
    vault: null,
    agent: "t",
    now,
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

/** Files under `dir` whose bytes contain `text`. */
function filesHolding(dir: string, text: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => {
    const path = join(dir, name);
    return statSync(path).isFile() && readFileSync(path).includes(text);
  });
}

const about = () => join(m.view("dev-a"), "about-me.md");
const read = (path = about()) => readFileSync(path, "utf8");

function records(kind: string): StoreRecord[] {
  return allRecords(catchUp(a, now)).filter((r) => r.kind === kind);
}

function humanPreferenceSets(): Array<Record<string, unknown>> {
  return records("preference-set")
    .filter((r) => r.body["authority"] === "human")
    .map((r) => ({ preference: r.body["preference"], fields: r.body["fields"] }));
}

describe("render protocol", () => {
  test("an idle render changes no file's bytes or modification time, and writes no record", () => {
    const files = [about(), join(m.view("dev-a"), "decisions.md")];
    const old = new Date(MON);
    for (const f of files) utimesSync(f, old, old);
    const before = files.map((f) => [readFileSync(f, "utf8"), statSync(f).mtimeMs] as const);
    const count = allRecords(catchUp(a, now)).length;
    const report = pass();
    expect(report.status).toBe("rendered");
    expect(
      report.status === "rendered" &&
        report.pages.length > 0 &&
        report.pages.every((p) => p.status === "unchanged"),
    ).toBe(true);
    expect(files.map((f) => [readFileSync(f, "utf8"), statSync(f).mtimeMs] as const)).toEqual(
      before,
    );
    expect(allRecords(catchUp(a, now)).length).toBe(count);
  });

  test("a phone-style whole-file rewrite becomes human records, and the next render keeps it", () => {
    const original = read();
    const phone =
      // A byte-order mark, as some phone editors write.
      "\uFEFF" +
      original
        .replace("- Rule A.", "- Rule A, in my words.")
        .replace("- Rule B.\n", "- Rule B.\n- Also remember the milk.\n")
        .replaceAll("\n", "\r\n");
    writeFileSync(about(), phone);
    const report = pass();
    expect(
      report.status === "rendered" && report.pages.find((p) => p.page === "about-me.md"),
    ).toMatchObject({ ingested: 2 });
    expect(humanPreferenceSets()).toEqual([
      { preference: "pref-a", fields: { principle: "Rule A, in my words." } },
    ]);
    const additions = records("view-addition");
    expect(additions.map((r) => r.body)).toEqual([
      {
        authority: "human",
        page: "about-me.md",
        after: "pref:pref-b",
        text: "- Also remember the milk.",
      },
    ]);
    const after = read();
    expect(after).toContain("- Rule A, in my words.\n- Rule B.\n- Also remember the milk.\n");
    expect(after).not.toContain("\r");
    // Stable from here on: the next pass ingests nothing and writes nothing.
    const count = allRecords(catchUp(a, now)).length;
    pass();
    expect(read()).toBe(after);
    expect(allRecords(catchUp(a, now)).length).toBe(count);
  });

  test("an edit seen while its merge base has not synced is ingested once the base arrives", () => {
    const renders = records("view-render").filter((r) => r.body["page"] === "about-me.md");
    const base = blobPath(partitionDir(a.root, "shared"), renders.at(-1)!.body["base"] as string);
    const away = `${base}.away`;
    renameSync(base, away);
    writeFileSync(about(), read().replace("- Rule A.", "- Rule A, edited offline."));
    const pending = pass();
    expect(
      pending.status === "rendered" && pending.pages.find((p) => p.page === "about-me.md"),
    ).toMatchObject({ status: "base-pending" });
    renameSync(away, base);
    pass();
    expect(humanPreferenceSets()).toEqual([
      { preference: "pref-a", fields: { principle: "Rule A, edited offline." } },
    ]);
  });

  test("only an idle pass records that the writer is alive", () => {
    clock += 2 * 86_400_000;
    const before = records("view-pass").length;
    clock += 1000;
    runViewPass(a, { target: null, vault: null, agent: "t", now });
    expect(records("view-pass")).toHaveLength(before);
    pass();
    expect(records("view-pass")).toHaveLength(before + 1);
  });

  test("a page truncated by a sync tool retires nothing and is rendered back whole", () => {
    seedPreference(a, MON + 3, "pref-c", {
      principle: "Rule C.",
      status: "confirmed",
      scope: "work",
    });
    pass();
    pass();
    const whole = read();
    writeFileSync(about(), whole.split("\n").slice(0, 3).join("\n") + "\n");
    pass();
    expect(humanPreferenceSets()).toEqual([]);
    expect(read()).toBe(whole);
    // The truncated bytes are kept, recoverable.
    expect(records("view-replaced").length).toBeGreaterThan(0);
  });

  test("deleting a rule line retires the rule; deleting the page retires nothing", () => {
    writeFileSync(about(), read().replace("- Rule B.\n", ""));
    pass();
    expect(humanPreferenceSets()).toEqual([
      { preference: "pref-b", fields: { status: "retired" } },
    ]);
    expect(read()).not.toContain("Rule B.");
    // The retire is visible in the week's history, and the edit that made it is recoverable.
    expect(read(join(m.view("dev-a"), "history", "2026-W45.md"))).toContain(
      "- You retired a rule: Rule B.",
    );
    expect(listReplacedVersions(a, "about-me.md", now).map((v) => v.reason)).toEqual(["edit"]);
    unlinkSync(about());
    pass();
    expect(read()).toContain("- Rule A.");
    expect(humanPreferenceSets()).toHaveLength(1);
  });

  test("a history edit is kept as a correction by every later render", () => {
    const week = join(m.view("dev-a"), "history", "2026-W45.md");
    writeFileSync(week, read(week).replace("- Did a thing.", "- Did a thing, and it worked."));
    pass();
    expect(records("view-correction").map((r) => r.body["text"])).toEqual([
      "- Did a thing, and it worked.",
    ]);
    seedLogEvent(a, MON + 3, "note", { text: "Another thing." });
    pass();
    const text = read(week);
    expect(text).toContain("- Did a thing, and it worked.");
    expect(text).toContain("- Another thing.");
  });

  test("an agent change and a user edit of other lines merge, the user's line kept", () => {
    writeFileSync(about(), read().replace("- Rule A.", "- Rule A, my way."));
    seedPreference(a, clock + 10, "pref-b", { principle: "Rule B, revised." });
    clock += 100;
    pass();
    const text = read();
    expect(text).toContain("- Rule A, my way.");
    expect(text).toContain("- Rule B, revised.");
  });

  test("a racing edit with no conflict copy is recovered from the replaced bytes", () => {
    seedPreference(a, clock + 10, "pref-c", {
      principle: "Rule C.",
      status: "confirmed",
      scope: "work",
    });
    clock += 100;
    const racing = read().replace("- Rule A.", "- Rule A, edited on the phone.");
    let raced = false;
    const report = pass({
      beforeCapture: (path) => {
        if (path !== about() || raced) return;
        raced = true;
        writeFileSync(path, racing);
      },
    });
    expect(
      report.status === "rendered" && report.pages.find((p) => p.page === "about-me.md"),
    ).toMatchObject({ status: "written", ingested: 1 });
    expect(humanPreferenceSets()).toEqual([
      { preference: "pref-a", fields: { principle: "Rule A, edited on the phone." } },
    ]);
    const text = read();
    expect(text).toContain("- Rule A, edited on the phone.");
    expect(text).toContain("- Rule C.");
    expect(records("view-replaced").map((r) => r.body["reason"])).toEqual(["race"]);
  });

  test("a racing edit with a conflict copy is ingested and leaves no copy behind", () => {
    const copy = join(m.view("dev-a"), "about-me.sync-conflict-20261106-120000-ABCDEFG.md");
    writeFileSync(copy, read().replace("- Rule B.", "- Rule B, from the phone."));
    pass();
    expect(existsSync(copy)).toBe(false);
    expect(readdirSync(m.view("dev-a")).filter((n) => n.includes("conflict"))).toEqual([]);
    expect(humanPreferenceSets()).toEqual([
      { preference: "pref-b", fields: { principle: "Rule B, from the phone." } },
    ]);
    expect(read()).toContain("- Rule B, from the phone.");
    expect(readdirSync(m.view("dev-a")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a private racing edit lands in private, and no shared file holds its text", () => {
    // A new rule makes the pass render, so the edit races the replace.
    seedPreference(a, clock + 10, "pref-c", {
      principle: "Rule C.",
      status: "confirmed",
      scope: "work",
    });
    clock += 100;
    const racing = read().replace("- Rule A.", "- Rule A <private>racing secret</private>");
    let raced = false;
    pass({
      beforeCapture: (path) => {
        if (path !== about() || raced) return;
        raced = true;
        writeFileSync(path, racing);
      },
    });
    expect(raced).toBe(true);
    const privateSets = (catchUp(a, now).records.get("private") ?? []).filter(
      (r) => r.kind === "preference-set" || r.kind === "view-replaced",
    );
    expect(privateSets.map((r) => [r.kind, r.body["reason"] ?? null])).toEqual([
      ["view-replaced", "race"],
      ["preference-set", null],
    ]);
    const shared = catchUp(a, now).records.get("shared") ?? [];
    expect(shared.filter((r) => r.kind === "view-replaced" && r.body["reason"] === "race")).toEqual(
      [],
    );
    expect(filesHolding(join(m.root("dev-a"), "private"), "racing secret")).not.toEqual([]);
    expect(filesHolding(join(m.root("dev-a"), "shared"), "racing secret")).toEqual([]);
    expect(read()).not.toContain("racing secret");
  });

  test("a conflict copy that is the writer's own older render is removed without an edit", () => {
    const copy = join(m.view("dev-a"), "about-me (conflicted copy 2026-11-06).md");
    writeFileSync(copy, read());
    pass();
    expect(existsSync(copy)).toBe(false);
    expect(humanPreferenceSets()).toEqual([]);
  });

  test("o2b view recover lists replaced versions with their text, newest first", () => {
    writeFileSync(about(), read().replace("- Rule A.", "- First edit."));
    pass();
    writeFileSync(about(), read().replace("- First edit.", "- Second edit."));
    pass();
    const versions = listReplacedVersions(a, "about-me.md", now);
    expect(versions.map((v) => v.reason)).toEqual(["edit", "edit"]);
    expect(versions[0]!.text).toContain("- Second edit.");
    expect(versions[1]!.text).toContain("- First edit.");
    // Both still listed inside the window; none once it has passed.
    const day = 86_400_000;
    const inside = listReplacedVersions(
      a,
      "about-me.md",
      () => clock + (VIEW_RECOVER_DAYS - 1) * day,
    );
    expect(inside).toHaveLength(2);
    const after = () => clock + (VIEW_RECOVER_DAYS + 1) * day;
    expect(listReplacedVersions(a, "about-me.md", after)).toEqual([]);
  });

  test("a private edit on a machine without the private partition is refused and left on disk", () => {
    const parent = m.parent;
    const root = join(parent, "server-store");
    initStore({ root, partitions: ["shared"] });
    const s = openStore({
      root,
      device: "srv",
      dirs: {
        platform: process.platform,
        home: join(parent, "home", "srv"),
        env: {
          XDG_STATE_HOME: join(parent, "state", "srv"),
          LOCALAPPDATA: join(parent, "state", "srv"),
        },
      },
    });
    seedPreference(s, MON, "pref-a", { principle: "Rule A.", status: "confirmed" });
    claimViewWriter(s, { agent: "t", now });
    pass(undefined, s);
    pass(undefined, s);
    const path = join(m.view("srv"), "about-me.md");
    const edited = read(path).replace("- Rule A.", "- Rule A <private>secret</private>");
    writeFileSync(path, edited);
    const report = pass(undefined, s);
    expect(
      report.status === "rendered" && report.pages.find((p) => p.page === "about-me.md"),
    ).toMatchObject({ status: "refused" });
    expect(read(path)).toBe(edited);
  });

  test("a private edit is stored in private, and the page keeps the rule's last shared version", () => {
    writeFileSync(about(), read().replace("- Rule A.", "- Rule A <private>secret</private>"));
    pass();
    const privateSets = (catchUp(a, now).records.get("private") ?? []).filter(
      (r) => r.kind === "preference-set" || r.kind === "view-replaced",
    );
    expect(privateSets.map((r) => r.kind)).toEqual(["view-replaced", "preference-set"]);
    expect(read()).not.toContain("secret");
    expect(read()).toContain("- Rule A.\n");
    // Stable: the next pass sees its own render and stores nothing more.
    const count = allRecords(catchUp(a, now)).length;
    pass();
    expect(allRecords(catchUp(a, now)).length).toBe(count);
  });
});
