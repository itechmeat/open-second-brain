/**
 * The privacy-marker restamp on a switched vault with no `Brain/` tree. On
 * an unswitched machine the restamp walks the whole vault, `Brain/` pages
 * included; once switched those pages are lane entries, so the scan reads
 * them from the lane store and the apply stamps the entry through the lane
 * page store, without writing a `Brain/` file.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { planPrivacyMarkerRestamp } from "../../../../src/core/brain/privacy-marker-restamp.ts";
import {
  readLanePage,
  readLaneText,
  writeLaneText,
} from "../../../../src/core/store/lane-pages.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SIGNAL_STATE_KIND } from "../../../../src/core/store/fold-signals.ts";
import { readStoreEntities } from "../../../../src/core/store/read/store-entities.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import {
  clearOriginChannel,
  ORIGIN_CHANNEL,
  setOriginChannel,
} from "../../../../src/core/origin-channel.ts";
import * as vaultModule from "../../../../src/core/vault.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("a lane page with an informal marker is a candidate, and the apply stamps it in the store", () => {
  env = makeStoreEnv("osb-restamp-", { legacyTree: false });
  const { vault } = env;
  const lanePage = join(vault, "Brain", "sources", "secret.md");
  writeLaneText(vault, lanePage, "---\ntitle: Secret\naccess: private\n---\n\nBody.\n");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "mine.md"), "---\nsensitivity: confidential\n---\n\nMine.\n");
  expect(existsSync(join(vault, "Brain"))).toBe(false);

  const preview = planPrivacyMarkerRestamp(vault);
  expect(preview.candidates.map((c) => c.path)).toEqual([
    "Brain/sources/secret.md",
    "notes/mine.md",
  ]);

  const applied = planPrivacyMarkerRestamp(vault, { apply: true });
  expect(applied.skipped).toEqual([]);
  expect(applied.updated).toBe(2);
  const page = readLanePage(vault, lanePage);
  expect(page?.frontmatter["visibility"]).toEqual(["private"]);
  expect(page?.frontmatter["access"]).toBe("private");
  expect(page?.body.trim()).toBe("Body.");
  expect(existsSync(join(vault, "Brain"))).toBe(false);
  expect(planPrivacyMarkerRestamp(vault).candidates).toEqual([]);
});

test("a lane page whose stored text holds lines its fields omit is skipped by name", () => {
  env = makeStoreEnv("osb-restamp-raw-", { legacyTree: false });
  const { vault } = env;
  // A folded block scalar and a comment line: the parsed fields drop both,
  // the stored text keeps them. A rewrite from the fields would lose them.
  const folded = join(vault, "Brain", "sources", "folded.md");
  const foldedText =
    "---\ntitle: Folded\naccess: private\nsummary: >\n  kept only in the text\n---\n\nBody.\n";
  writeLaneText(vault, folded, foldedText);
  const commented = join(vault, "Brain", "sources", "commented.md");
  const commentedText =
    "---\ntitle: Commented\n# kept only in the text\naccess: private\n---\n\nBody.\n";
  writeLaneText(vault, commented, commentedText);
  expect(readLaneText(vault, folded)).toBe(foldedText);
  expect(readLaneText(vault, commented)).toBe(commentedText);

  const applied = planPrivacyMarkerRestamp(vault, { apply: true });
  expect(applied.candidates.map((c) => c.path)).toEqual([
    "Brain/sources/commented.md",
    "Brain/sources/folded.md",
  ]);
  expect(applied.updated).toBe(0);
  expect(applied.skipped.map((s) => s.path)).toEqual([
    "Brain/sources/commented.md",
    "Brain/sources/folded.md",
  ]);
  for (const skip of applied.skipped) expect(skip.reason).toContain("would lose");
  expect(readLaneText(vault, folded)).toBe(foldedText);
  expect(readLaneText(vault, commented)).toBe(commentedText);
});

// Captured at module load, before a `mock.module` call can replace it.
const realParseText = vaultModule.parseFrontmatterTextWithNotices;

test("a lane entry edited while the apply reads it is skipped and reported, not overwritten", () => {
  env = makeStoreEnv("osb-restamp-race-", { legacyTree: false });
  const { vault } = env;
  const lanePage = join(vault, "Brain", "sources", "secret.md");
  const before = "---\ntitle: Secret\naccess: private\n---\n\nBody.\n";
  const edited = "---\ntitle: Secret, edited\naccess: private\n---\n\nBody.\n";
  writeLaneText(vault, lanePage, before);
  expect(planPrivacyMarkerRestamp(vault).candidates.map((c) => c.path)).toEqual([
    "Brain/sources/secret.md",
  ]);

  // Another writer lands its edit the instant the apply has read the entry:
  // the apply parses the read text for lines a write would lose, after the
  // read and before the write.
  let landed = false;
  mock.module("../../../../src/core/vault.ts", () => ({
    ...vaultModule,
    parseFrontmatterTextWithNotices(text: string) {
      if (!landed && text === before) {
        landed = true;
        writeLaneText(vault, lanePage, edited);
      }
      return realParseText(text);
    },
  }));
  let applied: ReturnType<typeof planPrivacyMarkerRestamp>;
  try {
    applied = planPrivacyMarkerRestamp(vault, { apply: true });
  } finally {
    mock.module("../../../../src/core/vault.ts", () => vaultModule);
  }
  expect(landed).toBe(true);
  expect(applied.updated).toBe(0);
  expect(applied.skipped).toEqual([
    {
      path: "Brain/sources/secret.md",
      reason: "page changed while it was read for the write; run the restamp again",
    },
  ]);
  const page = readLanePage(vault, lanePage);
  expect(page?.frontmatter["title"]).toBe("Secret, edited");
  expect(page?.frontmatter["visibility"]).toBeUndefined();

  // The next run stamps the edited entry.
  expect(planPrivacyMarkerRestamp(vault, { apply: true }).updated).toBe(1);
  const stamped = readLanePage(vault, lanePage);
  expect(stamped?.frontmatter["title"]).toBe("Secret, edited");
  expect(stamped?.frontmatter["visibility"]).toEqual(["private"]);
});

test("a lane page is not stamped while the lane fold may miss a newer version of it", () => {
  env = makeStoreEnv("osb-restamp-gap-", { legacyTree: false });
  const { vault } = env;
  const lanePage = join(vault, "Brain", "sources", "secret.md");
  writeLaneText(vault, lanePage, "---\ntitle: Secret\naccess: private\n---\n\nBody.\n");

  // A peer's events shard, read once, then gone: whatever it held is
  // unknown to this read.
  const peerShard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: "sig-elsewhere", fields: { topic: "elsewhere" } },
  }).path;
  readStoreEntities();
  rmSync(peerShard);

  const applied = planPrivacyMarkerRestamp(vault, { apply: true });
  expect(applied.updated).toBe(0);
  expect(applied.skipped).toEqual([
    {
      path: "Brain/sources/secret.md",
      reason: "the lane store could not be read in full; run the restamp again once it reads",
    },
  ]);
  expect(readLanePage(vault, lanePage)?.frontmatter["visibility"]).toBeUndefined();
});

test("the stamp keeps the authority of the entry it stamps, so a later agent rewrite still lands", () => {
  env = makeStoreEnv("osb-restamp-authority-", { legacyTree: false });
  const { vault } = env;
  const lanePage = join(vault, "Brain", "sources", "secret.md");
  // An agent wrote the summary (an unclaimed process writes as an agent).
  writeLaneText(vault, lanePage, "---\ntitle: Secret\naccess: private\n---\n\nBody.\n");
  // A person runs the restamp.
  setOriginChannel(ORIGIN_CHANNEL.cli);
  try {
    expect(planPrivacyMarkerRestamp(vault, { apply: true }).updated).toBe(1);
  } finally {
    clearOriginChannel();
  }
  expect(readLanePage(vault, lanePage)?.frontmatter["visibility"]).toEqual(["private"]);
  // The agent refreshes the summary later: its write replaces the entry.
  writeLaneText(
    vault,
    lanePage,
    "---\ntitle: Secret, refreshed\naccess: private\nvisibility: [private]\n---\n\nNew body.\n",
  );
  expect(readLanePage(vault, lanePage)?.frontmatter["title"]).toBe("Secret, refreshed");
});
