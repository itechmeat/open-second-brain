/**
 * `brain_feedback` slugs keep letters of any script, and a topic whose rule
 * an older release filed under the Latin-only slug keeps meeting that rule.
 *
 * Before, the slug was `slugify(topic)`: "без восклицаний" was
 * `unnamed-<hash>` and "Проект release" was `release`. The new slug is
 * `titleSlug(topic)`. A force-confirmed re-record of a topic whose rule
 * already sits under the old slug must meet that rule (the writer refuses
 * a second rule beside it), and a plain re-record must reinforce it on the
 * dream pass, which groups signals by topic, never by slug.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dream } from "../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { slugify } from "../../src/core/vault.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-feedback-slug-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-feedback-slug-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const feedback = FEEDBACK_TOOLS.find((t) => t.name === "brain_feedback")!.handler;
const PRINCIPLE = "Never use exclamation marks in technical docs";

function record(topic: string, forceConfirmed: boolean) {
  return feedback(ctx, {
    topic,
    signal: "positive",
    principle: PRINCIPLE,
    ...(forceConfirmed ? { force_confirmed: true } : {}),
  });
}

function prefsDir(): string {
  return join(vault, "Brain", "preferences");
}

/** Preference pages of this suite's topic (the starter bundle ships its own). */
function prefsOf(topic: string): string[] {
  return readdirSync(prefsDir()).filter(
    (name) => name.endsWith(".md") && readFileSync(join(prefsDir(), name), "utf8").includes(topic),
  );
}

/** Force-confirm `topic`, then move its rule to the slug an older release gave it. */
async function storeUnderOldSlug(topic: string): Promise<string> {
  const res = (await record(topic, true)) as { preference_id: string };
  const slug = res.preference_id.slice("pref-".length);
  const old = slugify(topic);
  const from = join(prefsDir(), `pref-${slug}.md`);
  const text = readFileSync(from, "utf8").replaceAll(`pref-${slug}`, `pref-${old}`);
  writeFileSync(join(prefsDir(), `pref-${old}.md`), text, "utf8");
  rmSync(from);
  return old;
}

describe("brain_feedback slugs of non-Latin topics", () => {
  for (const [topic, slug] of [
    ["без восклицаний", "без-восклицаний"],
    ["Проект release", "проект-release"],
    ["不要感叹号", "不要感叹号"],
  ] as const) {
    test(`the signal, the rule and the topic tag keep the words (${topic})`, async () => {
      const res = (await record(topic, true)) as {
        signal_id: string;
        preference_id: string;
        preference_path: string;
      };
      expect(res.preference_id).toBe(`pref-${slug}`);
      expect(res.signal_id).toMatch(new RegExp(`^sig-\\d{4}-\\d{2}-\\d{2}-${slug}$`, "u"));
      expect(readFileSync(join(vault, res.preference_path), "utf8")).toContain(
        `brain/topic/${slug}`,
      );
    });
  }
});

describe("a rule an older release filed under the Latin-only slug", () => {
  for (const topic of ["без восклицаний", "不要感叹号"]) {
    test(`a force-confirmed re-record meets it instead of minting a second rule (${topic})`, async () => {
      const old = await storeUnderOldSlug(topic);
      await expect(record(topic, true)).rejects.toThrow(
        `preference already exists: Brain/preferences/pref-${old}.md`,
      );
      expect(prefsOf(topic)).toEqual([`pref-${old}.md`]);
    });

    test(`a plain re-record reinforces it on the dream pass (${topic})`, async () => {
      const old = await storeUnderOldSlug(topic);
      await record(topic, false);
      dream(vault, { configPath });
      expect(prefsOf(topic)).toEqual([`pref-${old}.md`]);
    });
  }

  test("a different topic that shared the old slug gets its own rule", async () => {
    const old = await storeUnderOldSlug("Проект release");
    expect(old).toBe("release");
    const res = (await record("Тема release", true)) as { preference_id: string };
    expect(res.preference_id).toBe("pref-тема-release");
  });
});
