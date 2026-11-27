/**
 * The feedback check on an unswitched vault (change `lane-reach-residuals`,
 * package 19; owed by 2.0.4, fifth closure round, finding 7b).
 *
 * Below local reach a forced `brain_feedback` judges whether the rule at
 * the topic's slug is held in `private` before its first write. On a
 * vault that never switched to the store the rule page's own marker
 * decides (`feedback-reach.ts`), not the store: a vault with no store at
 * all must not fail closed for a rule that is not private, and a rule
 * page reserved `private` still refuses with the fixed answer, writing
 * nothing. Each remote case is paired with the local control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { preferencePathOf } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { isPrivatePageFile } from "../../src/core/store/private-page.ts";
import { readStoreEntities } from "../../src/core/store/read/store-entities.ts";
import { judgesFromStore } from "../../src/core/store/store-privacy.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { digestVaultTree } from "../helpers/vault-digest.ts";
import { call } from "./lane-private-partition-reach-writes-fixture.ts";

const TOPIC = "zqunswitched bun rule";
const SLUG = "zqunswitched-bun-rule";

interface Vault {
  readonly vault: string;
  readonly configPath: string;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0).toReversed()) rmSync(dir, { recursive: true, force: true });
});

/** A vault that never switched, with no store configured, holding the rule at `SLUG`. */
function unswitched(visibility: ReadonlyArray<string>): Vault {
  const vault = mkdtempSync(join(tmpdir(), "osb-owed-feedback-vault-"));
  made.push(vault);
  const configHome = mkdtempSync(join(tmpdir(), "osb-owed-feedback-cfg-"));
  made.push(configHome);
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
  bootstrapBrain(vault, { configPath });
  writePreference(vault, {
    slug: SLUG,
    topic: TOPIC,
    principle: "Use bun for scripts",
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-01T00:00:00Z",
    evidenced_by: [],
    visibility,
  });
  expect(judgesFromStore(vault, configPath)).toBe(false);
  expect(readStoreEntities(configPath)).toBeNull();
  expect(isPrivatePageFile(preferencePathOf(vault, SLUG))).toBe(visibility.includes("private"));
  return { vault, configPath };
}

const remote = (v: Vault): MCPServer => new MCPServer(v);
const local = (v: Vault): MCPServer => new MCPServer(v, { reach: TRANSPORT_REACH.local });

const forced = {
  topic: TOPIC,
  signal: "positive",
  principle: "Use bun for every script",
  force_confirmed: true,
};

/** The inbox signals of this suite's topic. */
function signals(v: Vault): number {
  const dir = join(v.vault, "Brain", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.includes("zqunswitched")).length : 0;
}

describe("a forced feedback on an unswitched vault with no store", () => {
  test("a remote call over a rule that is not private is not refused and records its signal", async () => {
    const v = unswitched([]);
    const answer = await call(remote(v), "brain_feedback", forced);
    expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(false);
    expect(signals(v)).toBe(1);
  });

  test("the local control over the same rule records its signal too", async () => {
    const v = unswitched([]);
    const answer = await call(local(v), "brain_feedback", forced);
    expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(false);
    expect(signals(v)).toBe(1);
  });

  test("a remote call over a rule page reserved private gets the fixed answer and writes nothing", async () => {
    const v = unswitched(["private"]);
    const before = digestVaultTree(v.vault, { mtime: true });
    const answer = await call(remote(v), "brain_feedback", forced);
    expect({
      fixed: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: answer.includes(SLUG),
      signals: signals(v),
    }).toEqual({ fixed: true, names: false, signals: 0 });
    expect(digestVaultTree(v.vault, { mtime: true })).toBe(before);
  });

  test("the local control over the private rule page is not given the fixed answer", async () => {
    const v = unswitched(["private"]);
    const answer = await call(local(v), "brain_feedback", forced);
    expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(false);
    expect(signals(v)).toBe(1);
  });
});
