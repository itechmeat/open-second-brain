/**
 * `o2b brain hallways mine|show|promote|dismiss` (recall-quality wave,
 * Lane B / t_13a82a31). The CLI over the session-mined ledger: mine
 * derives the artifact and the reviewable proposals, show reads them
 * back, promote is the ONE bridge into the entity registry (thresholded,
 * through upsertEntity/relateEntities exclusively), dismiss silences a
 * key. Ambient mining never writes an entity page - only promote does.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { SESSION_ENTITY_MENTION_KIND } from "../../src/core/brain/link-graph/session-mining.ts";
import {
  dismissHallwayKey,
  HALLWAYS_ARTIFACT_REL,
} from "../../src/core/brain/link-graph/hallways.ts";
import {
  deriveEntityLexicon,
  writeEntityLexicon,
  __clearEntityLexiconCache,
} from "../../src/core/brain/entities/lexicon.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hallways-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  __clearEntityLexiconCache();
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/** One mined-mention ledger row (the import loop's on-disk shape). */
function mention(family: string, key: string, sessionRef: string): void {
  appendContinuityRecord(vault, {
    kind: SESSION_ENTITY_MENTION_KIND,
    createdAt: "2026-09-18T09:00:00Z",
    sourceRefs: [{ id: `${sessionRef}:u-0:${family}:${key}` }],
    payload: { family, key, session_ref: sessionRef, turn_id: "u-0" },
  });
}

/** Seed one key in `n` distinct sessions, plus a paired key beside it. */
function seedPair(n: number): void {
  for (let i = 1; i <= n; i++) {
    mention("symbol", "SessionStore", `s${i}.jsonl`);
    mention("symbol", "PayloadRegistry", `s${i}.jsonl`);
  }
}

/** The vault's entity page files, category by category. The lexicon
 * artifact (Brain/entities/lexicon.json) is a file, not a category. */
function entityFiles(): string[] {
  const root = join(vault, "Brain", "entities");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const category of readdirSync(root)) {
    const dir = join(root, category);
    if (!statSync(dir).isDirectory()) continue;
    out.push(...readdirSync(dir).map((f) => `${category}/${f}`));
  }
  return out;
}

describe("o2b brain hallways mine", () => {
  test("derives the artifact and the proposals, and writes no entity page", async () => {
    seedPair(3);

    const out = await runCli(["brain", "hallways", "mine", "--json"], { env: env() });

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["session_count"]).toBe(3);
    expect(payload["keys"]).toBe(2);
    expect(payload["pairs"]).toBe(1);
    expect(existsSync(join(vault, "Brain", "link-graph", "hallways.json"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "proposals", "hallways.md"))).toBe(true);
    // Ambient mining NEVER writes the registry - promotion is the only
    // bridge into Brain/entities/, and it has not run here.
    expect(entityFiles()).toEqual([]);
    // The artifact is the derived one, not the co-occurrence graph's.
    expect(HALLWAYS_ARTIFACT_REL.split("\\").join("/")).toBe("Brain/link-graph/hallways.json");
    expect(existsSync(join(vault, "Brain", "link-graph", "co-occurrence.json"))).toBe(false);
  });

  test("an empty ledger mines an empty derivation and still says so", async () => {
    const out = await runCli(["brain", "hallways", "mine", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["session_count"]).toBe(0);
    expect(payload["keys"]).toBe(0);
  });

  test("the proposals file lists only keys at or above the session threshold", async () => {
    seedPair(3);
    mention("symbol", "OnceOnly", "s1.jsonl");

    const out = await runCli(["brain", "hallways", "mine"], { env: env() });
    expect(out.returncode).toBe(0);

    const body = readFileSync(join(vault, "Brain", "proposals", "hallways.md"), "utf8");
    expect(body).toContain("SessionStore");
    expect(body).toContain("PayloadRegistry");
    expect(body).not.toContain("OnceOnly");
  });
});

describe("o2b brain hallways show", () => {
  test("prints the proposals artifact when it exists", async () => {
    seedPair(3);
    await runCli(["brain", "hallways", "mine"], { env: env() });

    const out = await runCli(["brain", "hallways", "show", "--json"], { env: env() });

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["exists"]).toBe(true);
    expect(payload["path"]).toBe("Brain/proposals/hallways.md");
    expect(payload["proposals"]).toBe(2);
  });

  test("is fail-soft when nothing was mined yet", async () => {
    const out = await runCli(["brain", "hallways", "show", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["exists"]).toBe(false);
  });
});

describe("o2b brain hallways promote", () => {
  test("refuses a key below the session threshold, naming both counts", async () => {
    mention("symbol", "SessionStore", "s1.jsonl");

    const out = await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], {
      env: env(),
    });

    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("1");
    expect(out.stderr).toContain("3");
    expect(entityFiles()).toEqual([]);
  });

  test("refuses a dismissed key and names the real remedy", async () => {
    seedPair(3);
    dismissHallwayKey(vault, "symbol", "SessionStore");

    const out = await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], {
      env: env(),
    });

    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("dismissed");
    // The refusal names the working state, not a verb that does not exist:
    // a dismissal is final for this artifact, and the way back is the
    // persisted dismissal set itself.
    expect(out.stderr).toContain("final for this artifact");
    expect(out.stderr).toContain("Brain/proposals/hallways-dismissed.json");
    expect(out.stderr).not.toContain("to be undone first");
    expect(entityFiles()).toEqual([]);
  });

  test("a key at the threshold promotes through upsertEntity, not a raw write", async () => {
    seedPair(3);

    const out = await runCli(["brain", "hallways", "promote", "symbol", "SessionStore", "--json"], {
      env: env(),
    });

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["created"]).toBe(true);
    expect(payload["entity"]).toBe("ent-symbol-sessionstore");
    // The page exists because the REGISTRY wrote it: it reads back
    // through the registry's own lookup.
    const get = await runCli(["brain", "entity", "get", "SessionStore", "--json"], {
      env: env(),
    });
    expect(get.returncode).toBe(0);
    expect((JSON.parse(get.stdout) as Record<string, unknown>)["id"]).toBe(
      "ent-symbol-sessionstore",
    );
  });

  test("a lowered threshold admits a key the default refuses (--min-sessions)", async () => {
    seedPair(2);

    const refused = await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], {
      env: env(),
    });
    expect(refused.returncode).toBe(1);

    const okOut = await runCli(
      ["brain", "hallways", "promote", "symbol", "SessionStore", "--min-sessions", "2", "--json"],
      { env: env() },
    );
    expect(okOut.returncode).toBe(0);
    expect(entityFiles()).toEqual(["symbol/ent-symbol-sessionstore.md"]);
  });

  test("a partner already in the registry is related through relateEntities", async () => {
    seedPair(3);
    await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], { env: env() });

    const out = await runCli(
      ["brain", "hallways", "promote", "symbol", "PayloadRegistry", "--json"],
      { env: env() },
    );

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["related"]).toEqual(["ent-symbol-sessionstore"]);
    const page = readFileSync(
      join(vault, "Brain", "entities", "symbol", "ent-symbol-payloadregistry.md"),
      "utf8",
    );
    expect(page).toContain("related:");
    expect(page).toContain("[[ent-symbol-sessionstore]]");
  });

  test("a promoted key never relates a dismissed partner", async () => {
    seedPair(3);
    await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], { env: env() });
    dismissHallwayKey(vault, "symbol", "SessionStore");

    const out = await runCli(
      ["brain", "hallways", "promote", "symbol", "PayloadRegistry", "--json"],
      { env: env() },
    );

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    // The dismissed partner is already an entity, but the pair with a
    // dismissed side is not offered, so promote adds no edge to it.
    expect(payload["related"]).toEqual([]);
    const page = readFileSync(
      join(vault, "Brain", "entities", "symbol", "ent-symbol-payloadregistry.md"),
      "utf8",
    );
    expect(page).not.toContain("[[ent-symbol-sessionstore]]");
  });

  test("promotes under the same bounded-wait deadline the mine fold carries", async () => {
    seedPair(3);
    // A clock that jumps a full day per reading, so any budget the safeguard
    // ladder resolves has elapsed by the fold's first checkpoint - the same
    // deterministic arm the MCP long-running-tools tests use against a real
    // createSafeguard. The fold is the expensive half of promote (it is the
    // same O(k^2) pass mine runs), so it takes the same deadline.
    let tick = 0;
    const spy = spyOn(Date, "now").mockImplementation(() => {
      tick += 1;
      return tick * 86_400_000;
    });
    try {
      const out = await runCli(["brain", "hallways", "promote", "symbol", "SessionStore"], {
        env: env(),
      });
      expect(out.returncode).toBe(1);
      expect(out.stderr).toContain("safeguard timeout");
      expect(out.stderr).toContain("sessions");
      expect(entityFiles()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a promoted label failing the tightened admission gate is refused BY THE GATE", async () => {
    // The pinned coupling: promotion's only writer is the registry's
    // admission path, so a mined key the tightened gate rejects
    // (recall-quality A2 - here a multi-token ALL-CAPS heading
    // residue, refused structurally regardless of the lexicon) never
    // becomes an entity page, however many sessions mention it.
    for (let i = 1; i <= 3; i++) mention("symbol", "QUICK BROWN FOX", `s${i}.jsonl`);
    // A resolving caseful handle is what arms the structural shout
    // verdict: seed one capitalised corpus page so the derived
    // artifact carries caseful=true and its own honest hash.
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "seed-corpus.md"),
      "# Corpus\nNarrative prose where Words arrive Capitalised.",
    );
    writeEntityLexicon(vault, deriveEntityLexicon(vault));
    __clearEntityLexiconCache();

    const out = await runCli(["brain", "hallways", "promote", "symbol", "QUICK BROWN FOX"], {
      env: env(),
    });

    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("shouted-heading");
    expect(entityFiles()).toEqual([]);
  });
});

describe("o2b brain hallways dismiss", () => {
  test("persists a dismissal and reports an already-dismissed key", async () => {
    const out = await runCli(["brain", "hallways", "dismiss", "symbol", "SessionStore", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect((JSON.parse(out.stdout) as Record<string, unknown>)["added"]).toBe(true);
    expect(existsSync(join(vault, "Brain", "proposals", "hallways-dismissed.json"))).toBe(true);

    const again = await runCli(
      ["brain", "hallways", "dismiss", "symbol", "SessionStore", "--json"],
      { env: env() },
    );
    expect(again.returncode).toBe(0);
    expect((JSON.parse(again.stdout) as Record<string, unknown>)["added"]).toBe(false);
  });
});

describe("o2b brain hallways usage", () => {
  test("an unknown subcommand is a usage error, not a crash", async () => {
    const out = await runCli(["brain", "hallways", "transmogrify"], { env: env() });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("usage: o2b brain hallways");
  });

  test("promote without a key is a usage error", async () => {
    const out = await runCli(["brain", "hallways", "promote", "symbol"], { env: env() });
    expect(out.returncode).toBe(2);
  });

  test("an unknown family is a usage error", async () => {
    const out = await runCli(["brain", "hallways", "promote", "prose", "Whatever"], {
      env: env(),
    });
    expect(out.returncode).toBe(2);
  });
});
