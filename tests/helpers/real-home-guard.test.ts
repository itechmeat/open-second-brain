/**
 * The real-home guard (`tests/helpers/real-home-guard.ts`): which locations
 * it watches, that it reports a new entry or a changed control file exactly
 * once, and how it tells this run's writes from another process's. What
 * the watcher reports for every state of a watched path, every transition
 * and every clock is the table in `real-home-guard-states.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

import {
  carriesMarker,
  guardIsStrict,
  HOST_DEPTH,
  leakMessage,
  NewEntryWatcher,
  OWN_DEPTH,
  persistentEntries,
  realControlFiles,
  realHomeRoots,
  realHomes,
  summaryMessage,
} from "./real-home-guard.ts";
import { CHMOD_CANNOT_DENY } from "./platform.ts";
import { tempDirs } from "./temp-dir.ts";

const mkTemp = tempDirs();

describe("realHomeRoots", () => {
  test("POSIX defaults: the product's own trees deep, the host homes at their top level", () => {
    const roots = realHomeRoots({}, "/home/u", "linux");
    const depthOf = (p: string) => roots.find((r) => r.path === p)?.depth;
    for (const own of [
      "/home/u/.config/open-second-brain",
      "/home/u/.local/share/open-second-brain",
      "/home/u/.local/state/open-second-brain",
      "/home/u/.cache/open-second-brain",
    ]) {
      expect(depthOf(own)).toBe(OWN_DEPTH);
    }
    for (const host of ["/home/u/.claude", "/home/u/.codex", "/home/u/.config/github-copilot"]) {
      expect(depthOf(host)).toBe(HOST_DEPTH);
    }
  });

  test("an exported base is watched together with the home fallback a cleared variable reaches", () => {
    const paths = realHomeRoots(
      {
        XDG_STATE_HOME: "/x/state",
        XDG_CONFIG_HOME: "/x/config",
        CLAUDE_CONFIG_DIR: "/x/claude-profile",
        CODEX_HOME: "/x/codex-home",
        OPEN_SECOND_BRAIN_STORE_ROOT: "/x/store",
      },
      "/home/u",
      "linux",
    ).map((r) => r.path);
    for (const expected of [
      posix.join("/x/state", "open-second-brain"),
      "/home/u/.local/state/open-second-brain",
      posix.join("/x/config", "open-second-brain"),
      "/home/u/.config/open-second-brain",
      posix.join("/x/config", "github-copilot"),
      "/home/u/.config/github-copilot",
      "/x/claude-profile",
      "/home/u/.claude",
      "/x/codex-home",
      "/home/u/.codex",
      "/x/store",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test("the folders the product writes into below a host home's top level are watched", () => {
    const roots = realHomeRoots({ PI_HOME: "/x/pi" }, "/home/u", "linux");
    const depthOf = (p: string) => roots.find((r) => r.path === p)?.depth;
    expect(depthOf("/home/u/.pi/skills")).toBe(1);
    expect(depthOf("/x/pi/skills")).toBe(1);
    expect(depthOf("/home/u/.grok/hooks")).toBe(1);
    expect(depthOf("/home/u/.config/opencode/plugins")).toBe(1);
    expect(depthOf("/home/u/.hermes/cron")).toBe(1);
    expect(depthOf("/home/u/.claude/.o2b-backups")).toBe(2);
    expect(depthOf("/home/u/.local/bin")).toBe(1);
  });

  test("Windows: the app-data roots and an exported XDG base are watched, each once", () => {
    const paths = realHomeRoots(
      {
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        XDG_CONFIG_HOME: "D:\\xdg",
      },
      "C:\\Users\\u",
      "win32",
    ).map((r) => r.path);
    expect(paths).toContain(win32.join("C:\\Users\\u\\AppData\\Local", "open-second-brain"));
    expect(paths).toContain(win32.join("C:\\Users\\u\\AppData\\Roaming", "open-second-brain"));
    expect(paths).toContain(win32.join("D:\\xdg", "open-second-brain"));
    expect(paths).toContain(win32.join("C:\\Users\\u", ".claude"));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("realHomes", () => {
  test("Windows: the profile os.homedir() reads and a different HOME are both watched, the profile first", () => {
    expect(
      realHomes(
        { HOME: "C:\\msys\\home\\u", USERPROFILE: "C:\\Users\\u" },
        "win32",
        "C:\\Users\\u",
      ),
    ).toEqual(["C:\\Users\\u", "C:\\msys\\home\\u"]);
    expect(realHomes({ USERPROFILE: "C:\\Users\\u" }, "win32", "C:\\Users\\u")).toEqual([
      "C:\\Users\\u",
    ]);
  });

  test("POSIX: HOME, and os.homedir() when it differs; USERPROFILE means nothing there", () => {
    expect(realHomes({ HOME: "/home/u", USERPROFILE: "/x" }, "linux", "/home/u")).toEqual([
      "/home/u",
    ]);
    expect(realHomes({ HOME: "" }, "linux", "/home/u")).toEqual(["/home/u"]);
    expect(realHomes({ HOME: "/h" }, "darwin", "/Users/u")).toEqual(["/h", "/Users/u"]);
  });
});

describe("realControlFiles", () => {
  test("the machine config at its exported path and at the fallback, and the hosts' config files", () => {
    const files = realControlFiles(
      { OPEN_SECOND_BRAIN_CONFIG: "/x/cfg/config.yaml", XDG_CONFIG_HOME: "/x/config" },
      "/home/u",
      "linux",
    );
    for (const expected of [
      "/x/cfg/config.yaml",
      "/x/cfg/profiles.json",
      "/x/config/open-second-brain/config.yaml",
      "/home/u/.config/open-second-brain/config.yaml",
      "/home/u/.codex/config.toml",
      "/home/u/.claude/settings.json",
      "/home/u/.cursor/mcp.json",
      "/x/config/opencode/opencode.json",
      "/home/u/.hermes/cron/jobs.json",
    ]) {
      expect(files).toContain(expected);
    }
    expect(files).not.toContain("/home/u/.claude.json");
  });
});

describe("NewEntryWatcher", () => {
  test("a new entry at any watched depth is reported once, an old one never", () => {
    const base = mkTemp("osb-guard-");
    const own = join(base, "own");
    mkdirSync(join(own, "stores", "held"), { recursive: true });
    mkdirSync(join(own, "stores", "01OLD", "clock"), { recursive: true });
    writeFileSync(join(own, "stores", "old.json"), "{}");
    const watcher = new NewEntryWatcher([{ path: own, depth: OWN_DEPTH }]);
    expect(watcher.check()).toEqual([]);

    writeFileSync(join(own, "stores", "held", "abc.shared"), "x");
    mkdirSync(join(own, "stores", "01STORE"));
    writeFileSync(join(own, "stores", "01OLD", "clock", "dev-b.json"), "{}");
    writeFileSync(join(own, "stores", "old.json"), '{"changed":true}');
    expect(watcher.check().toSorted()).toEqual(
      [
        join(own, "stores", "01STORE"),
        join(own, "stores", "held", "abc.shared"),
        join(own, "stores", "01OLD", "clock", "dev-b.json"),
      ].toSorted(),
    );
    expect(watcher.check()).toEqual([]);
  });

  test("a host home is watched at its top level only", () => {
    const base = mkTemp("osb-guard-");
    const host = join(base, "host");
    mkdirSync(join(host, "projects"), { recursive: true });
    const watcher = new NewEntryWatcher([{ path: host, depth: 1 }]);
    writeFileSync(join(host, "projects", "session.jsonl"), "");
    expect(watcher.check()).toEqual([]);
    writeFileSync(join(host, "config.toml"), "");
    expect(watcher.check()).toEqual([join(host, "config.toml")]);
  });

  test("a root that did not exist is reported when it appears, and removal is no leak", () => {
    const base = mkTemp("osb-guard-");
    const root = join(base, "absent");
    const watcher = new NewEntryWatcher([{ path: root, depth: 2 }]);
    expect(watcher.check()).toEqual([]);
    mkdirSync(join(root, "inner"), { recursive: true });
    expect(watcher.check()).toEqual([root]);
    writeFileSync(join(root, "inner", "late"), "");
    expect(watcher.check()).toEqual([join(root, "inner", "late")]);
    rmSync(root, { recursive: true, force: true });
    expect(watcher.check()).toEqual([]);
  });

  test("the SQLite sidecar of a database that was there is no leak, one of a new database is", () => {
    const base = mkTemp("osb-guard-");
    const host = join(base, "host");
    mkdirSync(host);
    writeFileSync(join(host, "kanban.db"), "");
    const watcher = new NewEntryWatcher([{ path: host, depth: 1 }]);
    writeFileSync(join(host, "kanban.db-wal"), "");
    writeFileSync(join(host, "kanban.db-shm"), "");
    expect(watcher.check()).toEqual([]);
    writeFileSync(join(host, "fresh.db"), "");
    writeFileSync(join(host, "fresh.db-wal"), "");
    expect(watcher.check().toSorted()).toEqual(
      [join(host, "fresh.db"), join(host, "fresh.db-wal")].toSorted(),
    );
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a root that exists but cannot be listed is no finding, and is watched once it can be",
    () => {
      const base = mkTemp("osb-guard-");
      const host = join(base, "host");
      mkdirSync(host);
      writeFileSync(join(host, "old"), "");
      chmodSync(host, 0o000);
      try {
        const watcher = new NewEntryWatcher([{ path: host, depth: 1 }]);
        expect(watcher.check()).toEqual([]);
        chmodSync(host, 0o700);
        expect(watcher.check()).toEqual([]);
        writeFileSync(join(host, "late"), "");
        expect(watcher.check()).toEqual([join(host, "late")]);
      } finally {
        chmodSync(host, 0o700);
      }
    },
  );

  test("an entry that is gone again after the grace is not reported", () => {
    const base = mkTemp("osb-guard-");
    const kept = join(base, "kept");
    writeFileSync(kept, "");
    expect(persistentEntries([kept, join(base, "transient.tmp")])).toEqual([kept]);
  });
});

describe("attribution", () => {
  const marker = "osb-run-AbC123";

  test("a finding is this run's when its name, content, link target or a nested file names a run root", () => {
    const base = mkTemp("osb-guard-");
    writeFileSync(join(base, "plain.json"), '{"vault":"/elsewhere"}');
    expect(carriesMarker(join(base, "plain.json"), [marker])).toBe(false);

    writeFileSync(join(base, "cfg.yaml"), `vault: /tmp/${marker}/vault\n`);
    expect(carriesMarker(join(base, "cfg.yaml"), [marker])).toBe(true);

    // JSON escapes a Windows path's separators; the root's name still matches.
    writeFileSync(join(base, "mcp.json"), `{"cwd":"D:\\\\a\\\\tmp\\\\${marker}\\\\v"}`);
    expect(carriesMarker(join(base, "mcp.json"), [marker])).toBe(true);

    mkdirSync(join(base, "01STORE", "clock"), { recursive: true });
    writeFileSync(join(base, "01STORE", "clock", "dev.json"), `{"root":"/tmp/${marker}/s"}`);
    expect(carriesMarker(join(base, "01STORE"), [marker])).toBe(true);

    mkdirSync(join(base, `vault-${marker}`));
    expect(carriesMarker(join(base, `vault-${marker}`), [marker])).toBe(true);

    expect(carriesMarker(join(base, "cfg.yaml"), [])).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a link is this run's when its target names a run root",
    () => {
      const base = mkTemp("osb-guard-");
      symlinkSync(`/tmp/${marker}/bin/o2b`, join(base, "o2b"));
      expect(carriesMarker(join(base, "o2b"), [marker])).toBe(true);
    },
  );

  test("strict on CI or when asked, collecting elsewhere", () => {
    expect(guardIsStrict({ CI: "true" })).toBe(true);
    expect(guardIsStrict({ CI: "1" })).toBe(true);
    expect(guardIsStrict({ CI: "false" })).toBe(false);
    expect(guardIsStrict({})).toBe(false);
    expect(guardIsStrict({ O2B_TEST_REAL_HOME_GUARD: "strict" })).toBe(true);
  });

  test("the failure says what was seen, and that another process may be the creator when unproven", () => {
    const proven = leakMessage([{ kind: "new", path: "/h/.codex/x", attributed: true }]);
    expect(proven).toContain("/h/.codex/x (new entry; names a temp root of this test run)");
    expect(proven).not.toContain("another process");

    const unproven = leakMessage([
      { kind: "changed", path: "/h/.codex/config.toml", attributed: false },
    ]);
    expect(unproven).toContain(
      "/h/.codex/config.toml (content changed; names no temp root of this run)",
    );
    expect(unproven).toContain("may have been written by another process");

    const summary = summaryMessage([
      {
        kind: "new",
        path: "/h/.hermes/x.db",
        attributed: false,
        afterTest: 7,
        at: "2026-11-21T00:00:00.000Z",
      },
    ]);
    expect(summary).toContain("/h/.hermes/x.db (new entry), seen after test #7");
    expect(summary).toContain("another process");
    expect(summary).toContain("O2B_TEST_REAL_HOME_GUARD=strict");
  });
});
