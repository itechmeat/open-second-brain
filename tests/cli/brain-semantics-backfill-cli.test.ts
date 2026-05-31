import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-semantics-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "writing",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    pinned: false,
    confidence: BRAIN_CONFIDENCE.low,
    ...overrides,
  };
}

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
}

test("brain semantics-backfill --json prints a dry-run proposal plan", async () => {
  await bootstrap();
  const old = writePreference(vault, basePref("old"));
  moveToRetired(vault, old.path, BRAIN_RETIRED_REASON.rebutted, {
    now: new Date("2026-06-01T00:00:00Z"),
    retired_by: "[[Brain/log/2026-06-01]]",
  });
  writePreference(vault, basePref("new", { supersedes: "[[ret-old]]" }));

  const result = await runCli(["brain", "semantics-backfill", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });

  expect(result.returncode).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.ok).toBe(true);
  expect(payload.dry_run).toBe(true);
  expect(payload.count).toBe(1);
  expect(payload.proposals[0]).toMatchObject({
    source_id: "ret-old",
    target_id: "pref-new",
    relation: "superseded_by",
    field: "superseded_by",
    value: "[[pref-new]]",
  });
});
