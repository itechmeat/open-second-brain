/**
 * The OKF export on a machine switched to the brain store (task 2.10,
 * design D14 item 1): `log.md` is rendered from the store's log events (a
 * switched machine keeps no day files), a `Brain/sources/` page comes
 * from its lane records, and building the bundle writes nothing under the
 * vault. The unswitched cases live in
 * `okf.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
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
