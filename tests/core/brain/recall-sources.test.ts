/**
 * Read-only recall sources (Workspace Insight Suite, t_1375e69f): a
 * per-owner-vault registry of external vaults that participate in
 * recall as read-only origins. Registry lives beside the config file
 * (device-level concern, like profiles.json), never inside the vault.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addRecallSource,
  listRecallSources,
  recallSourcesPath,
  removeRecallSource,
} from "../../../src/core/brain/portability/recall-sources.ts";

let tmp: string;
let owner: string;
let external: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-recall-sources-"));
  owner = join(tmp, "owner-vault");
  external = join(tmp, "external-vault");
  mkdirSync(join(owner, "Brain"), { recursive: true });
  mkdirSync(join(external, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${owner}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("add/list/remove round-trip, sorted by alias", () => {
  const second = join(tmp, "second-vault");
  mkdirSync(second, { recursive: true });
  addRecallSource(configPath, owner, "zeta", external);
  addRecallSource(configPath, owner, "alpha", second);
  const listed = listRecallSources(configPath, owner);
  expect(listed.map((s) => s.alias)).toEqual(["alpha", "zeta"]);
  expect(listed[1]!.vault).toBe(external);
  expect(listed[0]!.broken).toBe(false);
  expect(removeRecallSource(configPath, owner, "alpha")).toBe(true);
  expect(removeRecallSource(configPath, owner, "alpha")).toBe(false);
  expect(listRecallSources(configPath, owner)).toHaveLength(1);
});

test("sources are scoped to their owner vault", () => {
  const otherOwner = join(tmp, "other-owner");
  mkdirSync(join(otherOwner, "Brain"), { recursive: true });
  addRecallSource(configPath, owner, "ext", external);
  expect(listRecallSources(configPath, otherOwner)).toHaveLength(0);
});

test("validation: empty alias, duplicate alias, duplicate path, missing target", () => {
  addRecallSource(configPath, owner, "ext", external);
  expect(() => addRecallSource(configPath, owner, "  ", external)).toThrow("alias");
  expect(() => addRecallSource(configPath, owner, "ext", external)).toThrow("already");
  expect(() => addRecallSource(configPath, owner, "ext2", external)).toThrow("already");
  expect(() => addRecallSource(configPath, owner, "ghost", join(tmp, "nope"))).toThrow(
    "does not exist",
  );
});

test("a source pointing at the owner vault itself is refused", () => {
  expect(() => addRecallSource(configPath, owner, "self", owner)).toThrow("itself");
});

test("a direct circular source is refused", () => {
  // external already sources owner; owner sourcing external would be circular.
  addRecallSource(configPath, external, "back", owner);
  expect(() => addRecallSource(configPath, owner, "ext", external)).toThrow("circular");
});

test("a deleted target is listed as broken, not dropped", () => {
  addRecallSource(configPath, owner, "ext", external);
  rmSync(external, { recursive: true, force: true });
  const listed = listRecallSources(configPath, owner);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.broken).toBe(true);
});

test("a malformed registry is tolerated on read", () => {
  writeFileSync(recallSourcesPath(configPath), "{broken");
  expect(listRecallSources(configPath, owner)).toHaveLength(0);
});
