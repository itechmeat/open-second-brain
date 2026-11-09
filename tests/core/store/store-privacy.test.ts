/**
 * The store-backed privacy judge (task 2.10, design D14 item 18): once a
 * machine is store-only, preference and signal references are judged from
 * the store's folds, not from legacy pages, and a reference the folds
 * cannot resolve stays private. An unswitched machine keeps judging the
 * legacy pages.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { isPrivatePreference } from "../../../src/core/store/dual-write-records.ts";
import { operationPrivacy } from "../../../src/core/store/operation-privacy.ts";
import {
  claimSourceIsPrivate,
  logRefsNamePrivatePage,
  rowNamesPrivatePage,
} from "../../../src/core/store/reference-privacy.ts";
import {
  judgesFromStore,
  storePreferenceIdIsKnownPrivate,
  storePreferenceIdIsPrivate,
  storeSignalIdIsPrivate,
} from "../../../src/core/store/store-privacy.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function append(
  partition: "shared" | "private",
  kind: string,
  body: Record<string, unknown>,
  stream: "events" | "settings" = "events",
): void {
  appendRecord(openStore({ root: env!.storeRoot, device: "dev-a" }), {
    partition,
    stream,
    kind,
    agent: "test",
    body,
  });
}

function preference(partition: "shared" | "private", slug: string, extra = {}): void {
  append(partition, "preference-set", {
    authority: "agent",
    preference: `pref-${slug}`,
    fields: { principle: `principle ${slug}`, status: "confirmed", ...extra },
  });
}

function signal(partition: "shared" | "private", id: string, extra = {}): void {
  append(partition, "signal", {
    id,
    path: `Brain/inbox/${id}.md`,
    staged: false,
    frontmatter: { id, principle: "p", ...extra },
    raw: null,
  });
}

/** A legacy preference page that says the opposite of the store. */
function legacyPage(slug: string, visibility: "private" | null): void {
  const dir = join(env!.vault, "Brain", "preferences");
  mkdirSync(dir, { recursive: true });
  const vis = visibility === null ? "" : `visibility: ${visibility}\n`;
  writeFileSync(
    join(dir, `pref-${slug}.md`),
    `---\nkind: brain-preference\nid: pref-${slug}\n${vis}---\n\nbody\n`,
  );
}

function switchThisDevice(): void {
  append("shared", DEVICE_SWITCHED_KIND, { authority: "human", device: "dev-a" }, "settings");
}

describe("on a store-only machine", () => {
  test("a shared preference names nothing private, a private one does, an unknown one does", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("shared", "open");
    preference("private", "secret");
    preference("shared", "marked", { visibility: "private" });
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-open]]"])).toBe(false);
    expect(logRefsNamePrivatePage(env.vault, ["ret-open"])).toBe(false);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-secret]]"])).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["pref-marked"])).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-nowhere]]"])).toBe(true);
    expect(isPrivatePreference(env.vault, "open")).toBe(false);
    expect(isPrivatePreference(env.vault, "nowhere")).toBe(true);
  });

  test("the legacy pages are not read", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("shared", "open");
    preference("private", "secret");
    legacyPage("open", "private");
    legacyPage("secret", null);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-open]]"])).toBe(false);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-secret]]"])).toBe(true);
  });

  test("a path to a preference page is judged by the fold, not the legacy page", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("private", "secret");
    legacyPage("secret", null);
    expect(logRefsNamePrivatePage(env.vault, ["Brain/preferences/pref-secret.md"])).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["[[Brain/preferences/pref-secret]]"])).toBe(true);
    expect(claimSourceIsPrivate(env.vault, "[[Brain/preferences/pref-secret]]")).toBe(true);
    // A preference the fold does not hold, its page gone: private.
    expect(logRefsNamePrivatePage(env.vault, ["Brain/retired/ret-gone.md"])).toBe(true);
  });

  test("a removed preference marked private by its fields stays private", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("shared", "marked", { visibility: "private" });
    append("shared", "preference-remove", { authority: "agent", preference: "pref-marked" });
    expect(storePreferenceIdIsPrivate("pref-marked")).toBe(true);
  });

  // POSIX modes only, and root reads a 0000 file anyway.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "while an events shard cannot be read every entity is private, and the read is retried",
    () => {
      env = makeStoreEnv("osb-store-privacy-");
      switchThisDevice();
      preference("shared", "open");
      appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
        partition: "shared",
        stream: "events",
        kind: "note",
        agent: "test",
        body: {},
      });
      const shard = readdirSync(join(env.storeRoot, "shared", "events", "dev-b")).map((n) =>
        join(env!.storeRoot, "shared", "events", "dev-b", n),
      )[0]!;
      chmodSync(shard, 0o000);
      try {
        expect(storePreferenceIdIsPrivate("pref-open")).toBe(true);
      } finally {
        chmodSync(shard, 0o644);
      }
      // Readable again with the same size and mtime: not served from a cache.
      expect(storePreferenceIdIsPrivate("pref-open")).toBe(false);
    },
  );

  test("signals resolve through the store's signal records", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    signal("shared", "sig-2026-11-06-open");
    signal("private", "sig-2026-11-06-secret");
    signal("shared", "sig-2026-11-06-marked", { access: "private" });
    expect(logRefsNamePrivatePage(env.vault, ["[[sig-2026-11-06-open]]"])).toBe(false);
    expect(logRefsNamePrivatePage(env.vault, ["sig-2026-11-06-secret"])).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["[[sig-2026-11-06-marked]]"])).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["[[sig-2026-11-06-unknown]]"])).toBe(true);
    expect(claimSourceIsPrivate(env.vault, "[[sig-2026-11-06-open]]")).toBe(false);
  });

  test("an operation verdict judges a row's references from the folds", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("shared", "open");
    const open = operationPrivacy(env.vault, { content: [{ value: { ref: "[[pref-open]]" } }] });
    const unknown = operationPrivacy(env.vault, { content: [{ value: { ref: "pref-gone" } }] });
    expect(open()).toBe(false);
    expect(unknown()).toBe(true);
  });

  test("with no readable store every preference and signal reference is private", () => {
    env = makeStoreEnv("osb-store-privacy-");
    switchThisDevice();
    preference("shared", "open");
    signal("shared", "sig-2026-11-06-open");
    expect(judgesFromStore(env.vault)).toBe(true);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-open]]"])).toBe(false);
    // The store root is gone (unsynced, unmounted): nothing can be judged,
    // so the store judge fails closed.
    rmSync(env.storeRoot, { recursive: true, force: true });
    expect(storePreferenceIdIsPrivate("pref-open")).toBe(true);
    expect(storeSignalIdIsPrivate("sig-2026-11-06-open")).toBe(true);
    expect(storePreferenceIdIsKnownPrivate("pref-open")).toBe(true);
  });
});

describe("with no vault", () => {
  test("a page reference cannot be judged and is private; free text names nothing", () => {
    env = makeStoreEnv("osb-store-privacy-", { legacyTree: false, configureVault: false });
    preference("shared", "open");
    expect(rowNamesPrivatePage(null, { note: "[[Some Note]]" })).toBe(true);
    expect(rowNamesPrivatePage(null, { note: "plain words" })).toBe(false);
    expect(rowNamesPrivatePage(null, { ref: "[[pref-open]]" })).toBe(false);
    expect(claimSourceIsPrivate(null, "notes/page.md")).toBe(true);
  });
});

describe("on an unswitched machine", () => {
  test("the legacy pages still decide", () => {
    env = makeStoreEnv("osb-store-privacy-");
    preference("private", "open");
    legacyPage("open", null);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-open]]"])).toBe(false);
    expect(logRefsNamePrivatePage(env.vault, ["[[pref-nowhere]]"])).toBe(true);
  });
});
