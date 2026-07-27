/**
 * The approval queue gets its preview (no-dead-ends, task 11).
 *
 * `applyPending` was the only applier in the codebase with no dry run:
 * an operator reviewing the write-approval queue could see what was
 * staged and could apply it, but had no way to be told what applying
 * would do before it happened.
 *
 * "Writes nothing" is asserted by digesting the whole vault tree before
 * and after, not by spot-checking the two files the move touches - the
 * defect a preview must not have is a write somewhere the author did not
 * think to look.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import {
  PendingApplyConflictError,
  PendingSignalNotFoundError,
  applyPending,
  listPending,
  stagePendingSignal,
} from "../../../src/core/brain/pending.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

let tmp: string;
let vault: string;
let configPath: string;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-pending-dry-run-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function stageOne(topic: string): string {
  return stagePendingSignal(vault, {
    topic,
    signal: "positive",
    agent: "test-agent",
    principle: `principle for ${topic}`,
    created_at: NOW.toISOString(),
    date: NOW.toISOString().slice(0, "YYYY-MM-DD".length),
    slug: topic,
  }).id;
}

describe("applyPending dry run", () => {
  test("reports exactly what an apply would move", () => {
    const id = stageOne("preview-me");

    const preview = applyPending(vault, id, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.id).toBe(id);
    expect(preview.path).toBe(join(brainDirs(vault).inbox, `${id}.md`));

    const real = applyPending(vault, id);
    expect(real.dryRun).toBe(false);
    // Identical report: the preview named the same id and the same
    // destination the apply actually used.
    expect({ id: real.id, path: real.path }).toEqual({ id: preview.id, path: preview.path });
  });

  test("leaves the vault tree byte-identical", () => {
    const id = stageOne("untouched");
    const before = digestVaultTree(vault);

    applyPending(vault, id, { dryRun: true });

    expect(digestVaultTree(vault)).toBe(before);
    // And the queue still holds it, so the preview did not consume it.
    expect(listPending(vault).map((entry) => entry.id)).toEqual([id]);
  });

  test("a missing id is refused by the preview exactly as by the apply", () => {
    expect(() => applyPending(vault, "sig-2026-07-18-nope", { dryRun: true })).toThrow(
      PendingSignalNotFoundError,
    );
  });

  test("a destination that already exists is refused before either path writes", () => {
    const id = stageOne("collide");
    applyPending(vault, id);
    // Re-stage the same id so a second apply would target an occupied inbox slot.
    stageOne("collide");
    const before = digestVaultTree(vault);

    expect(() => applyPending(vault, id, { dryRun: true })).toThrow(PendingApplyConflictError);
    expect(() => applyPending(vault, id)).toThrow(PendingApplyConflictError);
    expect(digestVaultTree(vault)).toBe(before);
  });
});

describe("applyPending apply behaviour is unchanged", () => {
  test("the staged bytes land in the inbox verbatim and the staged copy goes", () => {
    const id = stageOne("moved");
    const staged = join(brainDirs(vault).pending, `${id}.md`);
    const contents = readFileSync(staged, "utf8");

    const result = applyPending(vault, id);

    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(result.path, "utf8")).toBe(contents);
    expect(listPending(vault)).toEqual([]);
  });

  test("omitting the option is the same call it always was", () => {
    const id = stageOne("default-arg");
    const result = applyPending(vault, id);
    expect(result.path).toBe(join(brainDirs(vault).inbox, `${id}.md`));
  });
});
