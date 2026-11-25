/**
 * The rename of the default view folder (release 2.0.2): the readable
 * pages of the vault move from `brain-view/` (the default folder of
 * 2.0.1) to `o2b-memory/`, the program does the rename itself on the
 * machine that writes the view, and a folder that holds a file of the
 * user keeps its name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { LEGACY_VIEW_DEFAULT_DIR, VIEW_DEFAULT_DIR } from "../../../src/core/view/constants.ts";
import { finishDefaultFolder } from "../../../src/core/view/default-folder.ts";
import { runViewPass, type ViewPassReport } from "../../../src/core/view/render.ts";
import { resolveViewTarget } from "../../../src/core/view/target.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedPreference } from "./fixtures/seed.ts";

const MON = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = MON + 86_400_000 * 5;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
let vault: string;
let configPath: string;

beforeEach(() => {
  clock = MON + 86_400_000 * 5;
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
  seedPreference(a, MON, "pref-a", { principle: "Rule A.", status: "confirmed", scope: "work" });
  claimViewWriter(a, { agent: "t", now });
  vault = join(m.parent, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(m.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  // The claim settles in a scratch folder, so the vault holds nothing yet.
  passInto(join(m.parent, "settle"));
  passInto(join(m.parent, "settle"));
});
afterEach(() => {
  m.cleanup();
});

/** The view target the machine config names, or `null`. */
function target(): { dir: string; origin: "env" | "config" | "default" } | null {
  return resolveViewTarget(a.root, configPath, vault);
}

/** One render pass into the target the config names. */
function pass(store: StoreHandle = a): ViewPassReport {
  clock += 1000;
  const t = target();
  return runViewPass(store, {
    target: t?.dir ?? null,
    ...(t !== null ? { targetOrigin: t.origin } : {}),
    vault,
    agent: "t",
    now,
  });
}

/** One render pass into a folder, as the release before this one wrote it. */
function passInto(dir: string, store: StoreHandle = a): ViewPassReport {
  clock += 1000;
  return runViewPass(store, {
    target: dir,
    targetOrigin: "default",
    vault,
    agent: "t",
    now,
  });
}

const legacy = () => join(vault, LEGACY_VIEW_DEFAULT_DIR);
const current = () => join(vault, VIEW_DEFAULT_DIR);

describe("the default view folder", () => {
  test("a fresh brain writes to o2b-memory/", () => {
    expect(target()?.dir).toBe(current());
    expect(target()?.origin).toBe("default");
    const report = pass();
    expect(report.status).toBe("rendered");
    expect(existsSync(join(current(), "about-me.md"))).toBe(true);
    expect(existsSync(legacy())).toBe(false);
  });

  test("a 2.0.1 vault with a default brain-view/ ends with o2b-memory/ and no brain-view/", () => {
    // The release before this one wrote the pages into the vault's
    // `brain-view/` folder.
    passInto(legacy());
    expect(existsSync(join(legacy(), "about-me.md"))).toBe(true);
    const before = readFileSync(join(legacy(), "about-me.md"), "utf8");

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(existsSync(legacy())).toBe(false);
    expect(existsSync(join(current(), "about-me.md"))).toBe(true);
    expect(readFileSync(join(current(), "about-me.md"), "utf8")).toBe(before);
  });

  test("a custom view_target is untouched", () => {
    const custom = join(m.parent, "my-views");
    writeFileSync(configPath, `vault: ${vault}\nview_target: ${custom}\n`);
    passInto(legacy());
    expect(existsSync(join(legacy(), "about-me.md"))).toBe(true);

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(target()?.origin).toBe("config");
    expect(existsSync(join(legacy(), "about-me.md"))).toBe(true);
    expect(existsSync(join(custom, "about-me.md"))).toBe(true);
    expect(existsSync(current())).toBe(false);
  });

  test("a foreign file in brain-view/ survives, and the line about it is said once", () => {
    passInto(legacy());
    const mine = join(legacy(), "my-note.md");
    writeFileSync(mine, "# My note\n");

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(report.status === "rendered" ? report.notice : null).toContain("my-note.md");
    expect(existsSync(mine)).toBe(true);
    expect(readFileSync(mine, "utf8")).toBe("# My note\n");
    expect(existsSync(join(current(), "about-me.md"))).toBe(true);

    // The line is said once: the next pass says nothing about it.
    const again = pass();
    expect(again.status === "rendered" ? again.notice : null).toBeUndefined();
    expect(existsSync(mine)).toBe(true);
  });

  test("a folder the view did not write is never renamed", () => {
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "my-note.md"), "# My note\n");

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(existsSync(join(legacy(), "my-note.md"))).toBe(true);
    expect(existsSync(join(current(), "about-me.md"))).toBe(true);
  });

  test("an old folder that arrives by sync is removed once the new one holds its pages", () => {
    passInto(legacy());
    // A sync tool delivers the new folder beside the old one.
    cpSync(legacy(), current(), { recursive: true });

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(existsSync(legacy())).toBe(false);
    expect(existsSync(join(current(), "about-me.md"))).toBe(true);
  });

  test("a legacy page whose content the new folder does not hold keeps the old folder", () => {
    passInto(legacy());
    const page = join(legacy(), "about-me.md");
    const rendered = readFileSync(page, "utf8");
    // The old folder holds an edit the new folder does not: the render
    // reads the new folder only, so that edit is in no store yet.
    writeFileSync(page, `${rendered}\nAn edit only the old folder holds.\n`);
    // A sync tool delivers the new folder beside the old one.
    mkdirSync(current(), { recursive: true });
    writeFileSync(join(current(), "about-me.md"), rendered);

    const report = pass();
    expect(report.status).toBe("rendered");
    // The old folder keeps the edit, and the line says which file it is.
    expect(existsSync(page)).toBe(true);
    expect(readFileSync(page, "utf8")).toContain("An edit only the old folder holds.");
    expect(report.status === "rendered" ? report.notice : null).toContain("about-me.md");
  });

  test("an old folder holding an older render of the view is removed, not kept as an edit", () => {
    passInto(legacy());
    const before = readFileSync(join(legacy(), "about-me.md"), "utf8");
    // A sync tool delivers the new folder beside the old one, and the
    // brain changes before the next pass: the new page differs from the
    // old one, which is still a page the view rendered, with no edit.
    cpSync(legacy(), current(), { recursive: true });
    seedPreference(a, MON, "pref-b", { principle: "Rule B.", status: "confirmed", scope: "work" });

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(readFileSync(join(current(), "about-me.md"), "utf8")).not.toBe(before);
    expect(existsSync(legacy())).toBe(false);
  });

  test("a file written into the old folder after its scan survives the removal", () => {
    passInto(legacy());
    // A sync tool delivers the new folder beside the old one, with a newer
    // render of one page, so the old page is compared with its render
    // records.
    cpSync(legacy(), current(), { recursive: true });
    writeFileSync(join(current(), "about-me.md"), "<!-- open-second-brain-view -->\nNewer.\n");
    mkdirSync(join(legacy(), "mine"));

    // Another program writes into the old folder between the scan and
    // the removal: the comparison of the page runs in that window.
    const outcome = finishDefaultFolder(current(), new Set(), () => {
      writeFileSync(join(legacy(), "mine", "note.md"), "A note of the user.\n");
      return true;
    });

    expect(readFileSync(join(legacy(), "mine", "note.md"), "utf8")).toBe("A note of the user.\n");
    expect(existsSync(join(legacy(), "about-me.md"))).toBe(false);
    expect(outcome).toEqual({ status: "kept", files: ["mine/note.md"] });
  });

  test("a directory where the new folder's page belongs keeps the legacy page", () => {
    passInto(legacy());
    const page = join(legacy(), "about-me.md");
    const before = readFileSync(page, "utf8");
    // The new folder holds a directory under the page's name: the view
    // cannot write the page there, and no copy of it can be read.
    mkdirSync(join(current(), "about-me.md"), { recursive: true });

    const report = pass();
    expect(report.status).toBe("rendered");
    expect(readFileSync(page, "utf8")).toBe(before);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a new copy of a page that cannot be read keeps the legacy page",
    () => {
      passInto(legacy());
      cpSync(legacy(), current(), { recursive: true });
      const page = join(legacy(), "about-me.md");
      chmodSync(join(current(), "about-me.md"), 0o000);

      const outcome = finishDefaultFolder(current(), new Set());
      expect(outcome).toEqual({ status: "incomplete" });
      expect(existsSync(page)).toBe(true);
    },
  );

  test("a page that was not written does not allow its legacy copy to be deleted", () => {
    passInto(legacy());
    const page = join(legacy(), "about-me.md");
    // The new folder holds a link the view refuses to write through, so
    // the page is never written there.
    mkdirSync(current(), { recursive: true });
    symlinkSync(join(m.parent, "nowhere.md"), join(current(), "about-me.md"));

    const report = pass();
    expect(report.status).toBe("rendered");
    // The legacy copy stays: the new folder holds no page of it.
    expect(existsSync(page)).toBe(true);
  });
});
