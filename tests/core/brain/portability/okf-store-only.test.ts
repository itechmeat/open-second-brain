/**
 * The OKF export on a machine switched to the brain store (task 2.10,
 * design D14 item 1): `log.md` is rendered from the store's log events (a
 * switched machine keeps no day files), a `Brain/sources/` page comes
 * from its lane records, and building the bundle writes nothing under the
 * vault. The unswitched cases live in
 * `okf.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import {
  buildOkfBundle,
  importOkfBundle,
  readOkfBundle,
  writeOkfBundle,
} from "../../../../src/core/brain/portability/okf.ts";
import {
  bindVaultToStore,
  VaultBindingMismatchError,
} from "../../../../src/core/vault-adapter/vault-binding.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { withOperationPrivacy } from "../../../../src/core/store/operation-scope.ts";
import { parseFrontmatterText } from "../../../../src/core/vault.ts";
import { partitionRecords } from "../store-only/fixtures.ts";
import { neverHeld } from "../../../helpers/held-partitions.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
import { StoreUnavailableError } from "../../../../src/core/store/read/protection-store.ts";
import { copySharedLogIntoPrivate, logShardsOf } from "../../store/fixtures/log-shards.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "../store-only/fixtures.ts";

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-okf-store-only-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

function fileOf(files: ReadonlyArray<{ path: string; contents: string }>, path: string): string {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`bundle has no file ${path}`);
  return f.contents;
}

describe("buildOkfBundle on a switched machine", () => {
  test("log.md renders the store's log days and lane pages export, writing nothing", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "a stored day" },
    });
    appendLogEvent(env.vault, {
      timestamp: "2026-06-02T09:00:00Z",
      eventType: "note",
      body: { text: "another stored day" },
    });
    writeLanePage(
      env.vault,
      join(env.vault, "Brain", "sources", "src-otters.md"),
      { kind: "brain-source", title: "Otters" },
      "Otters hold hands.\n",
    );
    // A lane record, not a file.
    expect(existsSync(join(env.vault, "Brain", "sources", "src-otters.md"))).toBe(false);
    const before = digestVaultTree(env.vault);

    const bundle = buildOkfBundle(env.vault);
    const log = fileOf(bundle.files, "log.md");
    expect(log.indexOf("## 2026-06-01")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("## 2026-06-01")).toBeLessThan(log.indexOf("## 2026-06-02"));
    expect(log).toContain("a stored day");
    expect(bundle.manifest.log_days).toBe(2);
    const source = bundle.files.find((f) => f.path.endsWith("src-otters.md"));
    expect(source?.path.startsWith("references/")).toBe(true);
    expect(source?.contents).toContain("Otters hold hands.");
    expect(digestVaultTree(env.vault)).toBe(before);
  });
});

describe("private-partition records in the bundle", () => {
  test("a page from the private partition carries visibility: [private]; a shared one does not", () => {
    // Private by partition alone: the entry's own fields name no visibility.
    withOperationPrivacy(true, () =>
      writeLanePage(
        env.vault,
        join(env.vault, "Brain", "sources", "src-diary.md"),
        { kind: "brain-source", title: "Diary", visibility: ["team"] },
        "Kept to myself.\n",
      ),
    );
    writeLanePage(
      env.vault,
      join(env.vault, "Brain", "reports", "rep-open.md"),
      { kind: "brain-report", title: "Open" },
      "Shared report.\n",
    );
    expect(
      partitionRecords(env.storeRoot, "private").some((r) => r.body["entry"] === "src-diary"),
    ).toBe(true);

    const { files } = buildOkfBundle(env.vault);
    const privatePage = files.find((f) => f.path.endsWith("src-diary.md"))!;
    const [privateMeta] = parseFrontmatterText(privatePage.contents);
    expect(privateMeta["visibility"]).toEqual(["team", "private"]);
    const sharedPage = files.find((f) => f.path.endsWith("rep-open.md"))!;
    expect(parseFrontmatterText(sharedPage.contents)[0]["visibility"]).toBeUndefined();
  });
});

describe("importOkfBundle on a switched machine", () => {
  test("a vault that is not the one bound to the store is refused before any page", () => {
    mkdirSync(join(env.vault, "Notes"), { recursive: true });
    writeFileSync(join(env.vault, "Notes", "A.md"), "---\ntitle: A\n---\nbody.\n");
    const dir = join(env.parent, "bundle");
    writeOkfBundle(dir, buildOkfBundle(env.vault));
    const other = join(env.parent, "other-vault");
    mkdirSync(other, { recursive: true });
    bindVaultToStore(other, { configPath: env.configPath });
    expect(() => importOkfBundle(env.vault, readOkfBundle(dir), { trusted: true })).toThrow(
      VaultBindingMismatchError,
    );
  });
});

describe("private log events in the bundle", () => {
  test("a private event leaves log.md, counted in the manifest", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "a shared event" },
    });
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-02T09:00:00Z",
        eventType: "note",
        body: { text: "a private event" },
      });
    });

    const bundle = buildOkfBundle(env.vault);
    const log = fileOf(bundle.files, "log.md");
    expect(log).toContain("a shared event");
    expect(log).not.toContain("a private event");
    expect(bundle.manifest.log_days).toBe(1);
    expect(bundle.manifest.log_private_omitted).toBe(1);
  });

  test("a machine that never held private counts zero", () => {
    neverHeld(env.storeRoot);
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "the only event" },
    });
    const bundle = buildOkfBundle(env.vault);
    expect(bundle.manifest.log_private_omitted).toBe(0);
    expect(fileOf(bundle.files, "log.md")).toContain("the only event");
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable private log shard refuses the export", () => {
    withOperationPrivacy(true, () => {
      appendLogEvent(env.vault, {
        timestamp: "2026-06-01T09:00:00Z",
        eventType: "note",
        body: { text: "kept from the bundle" },
      });
    });
    const [shard] = logShardsOf(env.storeRoot, "private");
    expect(shard).toBeDefined();
    chmodSync(shard!, 0o000);
    try {
      expect(() => buildOkfBundle(env.vault)).toThrow(/cannot read log shard\(s\) private\/log\//);
    } finally {
      chmodSync(shard!, 0o644);
    }
  });

  test("a record in both partitions is private, out of log.md, counted", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "in both" },
    });
    // The same record id in both partitions, as two devices that disagree
    // on its partition would leave it.
    copySharedLogIntoPrivate(env.storeRoot);

    const bundle = buildOkfBundle(env.vault);
    expect(fileOf(bundle.files, "log.md")).not.toContain("in both");
    expect(bundle.manifest.log_private_omitted).toBe(1);
  });

  test("a store that cannot be opened refuses the export", () => {
    appendLogEvent(env.vault, {
      timestamp: "2026-06-01T09:00:00Z",
      eventType: "note",
      body: { text: "an event" },
    });
    // The store opened once, so this machine holds `private`: with its
    // identity file gone the store no longer opens.
    rmSync(join(env.storeRoot, "private", "store.json"));
    expect(() => buildOkfBundle(env.vault)).toThrow(StoreUnavailableError);
  });

  test("a store-only machine never switched, with a corrupt store, refuses the export", () => {
    // No switch marker: store-only because the vault has no legacy tree.
    const plain = makeStoreEnv("osb-okf-unswitched-store-", { legacyTree: false });
    try {
      appendLogEvent(plain.vault, {
        timestamp: "2026-06-01T09:00:00Z",
        eventType: "note",
        body: { text: "an event" },
      });
      writeFileSync(join(plain.storeRoot, "shared", "store.json"), "{ not json");
      expect(() => buildOkfBundle(plain.vault)).toThrow(StoreUnavailableError);
    } finally {
      plain.cleanup();
    }
  });

  test("an explicit vault with no legacy tree, over a corrupt store, refuses the export", () => {
    // The configured vault still has its legacy tree (env.vault); the
    // export names another vault, which is store-only by having none.
    const other = join(env.parent, "other-vault");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(env.storeRoot, "shared", "store.json"), "{ not json");
    expect(() => buildOkfBundle(other)).toThrow(StoreUnavailableError);
  });
});
