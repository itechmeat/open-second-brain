/**
 * The codex adapter names ChatGPT desktop in exactly one place: the
 * detect note, when the codex binary is absent and the config.toml merge
 * is the lane that applies.
 *
 * ChatGPT desktop has no MCP registration of its own - it reads the same
 * `$CODEX_HOME/config.toml` the codex target writes. The design settled
 * on naming it as a reader of that shared config, not on a target of its
 * own: the target vocabulary is frozen, and a second target for one file
 * would claim bytes the codex target owns and report them as drift. So
 * this file pins the whole surface the wave lands - the note and the
 * docs rows - and refuses the regressions the review gate names: a
 * detection or status change, and a new install target id.
 *
 * The docs assertions at the bottom are content checks over README.md
 * and install/codex.md, so a docs row that drops the install command or
 * the shared-config naming fails here rather than drifting silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexAdapter,
  resetCodexRunner,
  setCodexRunner,
  type CodexRunner,
} from "../../../../src/core/install/adapters/codex.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../../../../src/core/install/json-merge.ts";
import { INSTALL_TARGET_ID, INSTALL_TARGET_IDS } from "../../../../src/core/runtime/host-facts.ts";
import type { InstallEnv } from "../../../../src/core/install/types.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-codex-note-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-codex-note-h-"));
});

afterEach(() => {
  resetCodexRunner();
  for (const dir of [vault, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function env(overrides: Record<string, string> = {}): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC", ...overrides },
    now: new Date("2026-11-02T12:00:00.000Z"),
  };
}

/** A runner whose binary does not exist; running it is a test failure. */
const absentCodex: CodexRunner = {
  available: () => false,
  run: () => {
    throw new Error("the adapter must not spawn codex when it reported the binary absent");
  },
};

/** A runner that reports the binary present; detect never spawns it. */
const presentCodex: CodexRunner = {
  available: () => true,
  run: () => {
    throw new Error("detect must not spawn codex; only apply and verify do");
  },
};

/** The file the config merge writes: both Open Second Brain tables declared. */
function writeConfigWithBothTables(): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      `[mcp_servers.${OSB_KEY_FULL}]`,
      'command = "o2b"',
      'args = ["mcp"]',
      "",
      `[mcp_servers.${OSB_KEY_WRITER}]`,
      'command = "o2b"',
      'args = ["mcp"]',
      "",
    ].join("\n"),
  );
}

/** Half an install: one table declared, the other missing. */
function writeConfigWithOneTable(): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [`[mcp_servers.${OSB_KEY_FULL}]`, 'command = "o2b"', 'args = ["mcp"]', ""].join("\n"),
  );
}

// ---------- The detect note ----------

describe("the codex detect note names ChatGPT desktop when the binary is absent", () => {
  test("with a config.toml present, the note names ChatGPT desktop and the config merge", () => {
    writeConfigWithBothTables();
    setCodexRunner(absentCodex);
    const result = codexAdapter.detect(env());
    const note = result.notes.join(" ");
    expect(note).toContain("config.toml merge");
    expect(note).toContain("ChatGPT desktop");
  });

  test("with no config yet, the note names ChatGPT desktop all the same", () => {
    // A ChatGPT-desktop-only operator may not have a config.toml yet;
    // the merge lane is still the one that would apply, and this note is
    // the discovery surface that tells them the codex target serves
    // their app.
    setCodexRunner(absentCodex);
    const result = codexAdapter.detect(env());
    expect(result.status).toBe("not-installed");
    expect(result.notes.join(" ")).toContain("ChatGPT desktop");
  });

  test("with the binary present, the note is unchanged", () => {
    setCodexRunner(presentCodex);
    const result = codexAdapter.detect(env());
    expect(result.notes).toEqual(["codex CLI present; registration goes through `codex mcp add`"]);
  });
});

// ---------- Statuses are unchanged ----------

describe("detect statuses are unchanged by the ChatGPT naming", () => {
  const FILE_STATES: ReadonlyArray<{
    readonly label: string;
    readonly setup: () => void;
    readonly expected: "not-installed" | "drift" | "installed";
  }> = [
    { label: "no config file", setup: () => undefined, expected: "not-installed" },
    {
      label: "one server table declared",
      setup: () => writeConfigWithOneTable(),
      expected: "drift",
    },
    {
      label: "both server tables declared",
      setup: () => writeConfigWithBothTables(),
      expected: "installed",
    },
  ];

  for (const lane of [
    { name: "binary present", runner: presentCodex },
    { name: "binary absent", runner: absentCodex },
  ]) {
    for (const state of FILE_STATES) {
      test(`${lane.name} + ${state.label} keeps status ${state.expected}`, () => {
        setCodexRunner(lane.runner);
        state.setup();
        expect(codexAdapter.detect(env()).status).toBe(state.expected);
      });
    }
  }
});

// ---------- The target vocabulary stays frozen ----------

describe("ChatGPT desktop is a reader of the shared config, not a target", () => {
  test("no ChatGPT install target id exists and codex keeps its own", () => {
    expect("chatgptDesktop" in INSTALL_TARGET_ID).toBe(false);
    expect(Object.values(INSTALL_TARGET_ID).join(" ").toLowerCase()).not.toContain("chatgpt");
    expect(INSTALL_TARGET_IDS.join(" ").toLowerCase()).not.toContain("chatgpt");
    expect(codexAdapter.target).toBe("codex");
  });
});

// ---------- The docs rows (D2) ----------

describe("the docs name ChatGPT desktop and the codex install command", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

  test("the README supported-clients row names ChatGPT desktop, the command and the guide", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const rows = readme.split("\n").filter((line) => line.includes("ChatGPT desktop"));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some(
        (line) =>
          line.includes("o2b install --target codex --apply") && line.includes("install/codex.md"),
      ),
    ).toBe(true);
  });

  test("the codex guide carries a ChatGPT desktop section covering config, install and uninstall", () => {
    const guide = readFileSync(join(repoRoot, "install", "codex.md"), "utf8");
    const lines = guide.split("\n");
    const headingIndex = lines.findIndex((line) => line.trim() === "## ChatGPT desktop");
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    const nextHeading = lines.findIndex((line, i) => i > headingIndex && line.startsWith("## "));
    const end = nextHeading === -1 ? lines.length : nextHeading;
    const section = lines.slice(headingIndex, end).join("\n");
    expect(section).toContain("$CODEX_HOME/config.toml");
    expect(section).toContain("o2b install --target codex --apply");
    expect(section).toContain("o2b uninstall --target codex");
  });
});
