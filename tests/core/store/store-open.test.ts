import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  STORE_FORMAT_FILE,
  STORE_FORMAT_VERSION,
  STORE_IDENTITY_FILE,
} from "../../../src/core/store/constants.ts";
import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import { NoStoreError, openStore, StoreOpenError } from "../../../src/core/store/store-open.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

describe("opening a brain store", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-open-");
  });
  afterEach(() => tmp.cleanup());

  test("an initialised store opens with both partitions and a device-local state dir outside it", () => {
    const store = tmp.open("dev-a");
    expect([...store.partitions].toSorted()).toEqual(["private", "shared"]);
    expect(store.deviceStateDir).toContain(store.storeId);
    expect(store.deviceStateDir.startsWith(tmp.root)).toBe(false);
  });

  test("reopening keeps the store id", () => {
    expect(tmp.open("dev-a").storeId).toBe(tmp.open("dev-b").storeId);
  });

  test("a machine that holds only the shared partition does not grow a private one", () => {
    tmp.open("dev-a");
    rmSync(join(tmp.root, "private"), { recursive: true, force: true });
    const store = tmp.open("dev-b");
    expect([...store.partitions]).toEqual(["shared"]);
    expect(existsSync(join(tmp.root, "private"))).toBe(false);
  });

  test("partitions of two different stores under one root are refused", () => {
    tmp.open("dev-a");
    writeFileSync(
      join(tmp.root, "private", STORE_IDENTITY_FILE),
      `${JSON.stringify({ store_id: "01JBZ3NDEKTSV4RRFFQ69G5FAV", format: 1 })}\n`,
    );
    expect(() => tmp.open("dev-a")).toThrow(/different stores/);
  });

  test("an invalid device id is refused by name", () => {
    expect(() => openStore({ root: tmp.root, device: "", dirs: tmp.dirs("x") })).toThrow(
      StoreOpenError,
    );
  });

  test("a root without a store is refused with the init hint, and nothing is created", () => {
    expect(() => openStore({ root: tmp.root, device: "dev-a", dirs: tmp.dirs("a") })).toThrow(
      NoStoreError,
    );
    expect(() => openStore({ root: tmp.root, device: "dev-a", dirs: tmp.dirs("a") })).toThrow(
      /o2b store init/,
    );
    expect(existsSync(tmp.root)).toBe(false);
  });

  test("a root that is a regular file is refused as not a directory, not as a missing store", () => {
    writeFileSync(tmp.root, "not a directory");
    let caught: unknown;
    try {
      openStore({ root: tmp.root, device: "dev-a", dirs: tmp.dirs("a") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreOpenError);
    expect(caught).not.toBeInstanceOf(NoStoreError);
    expect((caught as Error).message).toContain("not a directory");
  });

  test("a newer format document on disk is never downgraded; an older one is refreshed", () => {
    tmp.open("dev-a");
    const sharedDoc = join(tmp.root, "shared", STORE_FORMAT_FILE);
    const newer = "<!-- open-second-brain-store-format: 99 -->\n# newer\n";
    writeFileSync(sharedDoc, newer);
    tmp.open("dev-a");
    expect(readFileSync(sharedDoc, "utf8")).toBe(newer);
    writeFileSync(sharedDoc, "<!-- open-second-brain-store-format: 0 -->\n# older\n");
    tmp.open("dev-a");
    expect(readFileSync(sharedDoc, "utf8")).toBe(shippedFormatDoc());
  });

  test("a copy of the same format version with other prose is left alone, so releases do not churn it", () => {
    tmp.open("dev-a");
    const sharedDoc = join(tmp.root, "shared", STORE_FORMAT_FILE);
    const sameVersion = `<!-- open-second-brain-store-format: ${STORE_FORMAT_VERSION} -->\n# other prose\n`;
    writeFileSync(sharedDoc, sameVersion);
    tmp.open("dev-a");
    expect(readFileSync(sharedDoc, "utf8")).toBe(sameVersion);
  });

  test("the root copy of the format document is refreshed on an existing store too", () => {
    tmp.open("dev-a");
    const rootDoc = join(tmp.root, STORE_FORMAT_FILE);
    writeFileSync(rootDoc, "<!-- open-second-brain-store-format: 0 -->\n# older\n");
    tmp.open("dev-b");
    expect(readFileSync(rootDoc, "utf8")).toBe(shippedFormatDoc());
  });
});
