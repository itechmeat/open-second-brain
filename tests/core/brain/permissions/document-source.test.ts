/**
 * The permissions document as a shared setting (design D14 item 3, review
 * finding F461): `permissions.document` holds the YAML text
 * `Brain/_permissions.yaml` held. Only the operator sets it; every gate
 * reads it, with no vault too; an unswitched machine with no setting still
 * reads the legacy file; and doctor warns when deny rules sit in a legacy
 * file no gate reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DoctorCheckContext,
  DoctorFindings,
} from "../../../../src/core/brain/doctor/check.ts";
import {
  PERMISSIONS_LEGACY_ONLY_CODE,
  PERMISSIONS_UNREADABLE_CODE,
  permissionsDocumentCheck,
  permissionsLegacyOnlyCheck,
} from "../../../../src/core/brain/doctor/permissions-check.ts";
import {
  PERMISSIONS_DOCUMENT_SETTING,
  PermissionsDocumentError,
} from "../../../../src/core/brain/permissions/document.ts";
import {
  loadPermissionsDocumentFor,
  PERMISSIONS_SETTING_LABEL,
} from "../../../../src/core/brain/permissions/document-source.ts";
import {
  BrainSettingError,
  setBrainSetting,
} from "../../../../src/core/brain/policy/settings-write.ts";
import {
  resolveWriteDisposition,
  WriteRefusedError,
} from "../../../../src/core/brain/write-disposition.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { AUTHORITY_FIELD, SETTING_SET_KIND } from "../../../../src/core/store/constants.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "../store-only/fixtures.ts";

const DENY_ALL = "version: 1\ndefault_action: deny\n";
const ALLOW_ALL = "version: 1\ndefault_action: allow\n";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const human = (vault: string) => ({ vault, authority: "human" as const, agent: "o" });
const agent = (vault: string) => ({ vault, authority: "agent" as const, agent: "a" });

function writeLegacy(vault: string, text: string): void {
  writeFileSync(join(vault, "Brain", "_permissions.yaml"), text, "utf8");
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof WriteRefusedError || err instanceof BrainSettingError) {
      return err.constructor.name;
    }
    throw err;
  }
  return "none";
}

describe("permissions.document setting", () => {
  test("an agent cannot set it on either kind of machine; the operator can", () => {
    env = makeStoreEnv("osb-perm-src-op-");
    const unswitched = (() => {
      try {
        setBrainSetting(agent(env!.vault), PERMISSIONS_DOCUMENT_SETTING, ALLOW_ALL);
      } catch (err) {
        return err instanceof BrainSettingError ? err.code : String(err);
      }
      return "written";
    })();
    expect(unswitched).toBe("operator_only_setting");
    switchDevice(env.storeRoot);
    expect(() =>
      setBrainSetting(agent(env!.vault), PERMISSIONS_DOCUMENT_SETTING, ALLOW_ALL),
    ).toThrow(BrainSettingError);
    expect(partitionRecords(env.storeRoot, "shared").some((r) => r.kind === "setting-set")).toBe(
      false,
    );
    expect(setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, DENY_ALL).changed).toBe(
      true,
    );
  });

  test("a value that is not a valid document is refused", () => {
    env = makeStoreEnv("osb-perm-src-invalid-");
    let code = "written";
    try {
      setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, "version: 2\n");
    } catch (err) {
      code = err instanceof BrainSettingError ? err.code : String(err);
    }
    expect(code).toBe("invalid_setting_value");
  });

  test("a switched machine enforces the setting and ignores the legacy file", () => {
    env = makeStoreEnv("osb-perm-src-switched-");
    writeLegacy(env.vault, ALLOW_ALL);
    switchDevice(env.storeRoot);
    expect(loadPermissionsDocumentFor(env.vault).document).toBeNull();
    expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("none");
    setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, DENY_ALL);
    const loaded = loadPermissionsDocumentFor(env.vault);
    expect(loaded.path).toBe(PERMISSIONS_SETTING_LABEL);
    expect(loaded.document?.default_action).toBe("deny");
    expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("WriteRefusedError");
  });

  test("a lost private partition stays out of the write gate's refusal text", () => {
    env = makeStoreEnv("osb-perm-src-lost-private-");
    switchDevice(env.storeRoot);
    // A read on the switched machine records the partitions it holds.
    expect(loadPermissionsDocumentFor(env.vault).document).toBeNull();
    rmSync(join(env.storeRoot, "private", "store.json"));
    let caught: unknown = null;
    try {
      resolveWriteDisposition(env.vault, "notes");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionsDocumentError);
    const err = caught as PermissionsDocumentError;
    expect(err.message).toContain(PERMISSIONS_SETTING_LABEL);
    expect(err.message).not.toContain("private/");
    expect(err.message).not.toContain("partition leave");
    // The raw cause rides along for the operator's own doctor.
    expect((err.cause as Error).message).toContain("private/store.json");
  });

  test("with no vault the deny still holds", () => {
    env = makeStoreEnv("osb-perm-src-novault-", { legacyTree: false, configureVault: false });
    expect(refusal(() => resolveWriteDisposition(null, "signals"))).toBe("none");
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o",
      body: { [AUTHORITY_FIELD]: "human", key: PERMISSIONS_DOCUMENT_SETTING, value: DENY_ALL },
    });
    expect(refusal(() => resolveWriteDisposition(null, "signals"))).toBe("WriteRefusedError");
  });

  test("an unswitched machine reads the legacy file until the setting is set", () => {
    env = makeStoreEnv("osb-perm-src-legacy-");
    writeLegacy(env.vault, DENY_ALL);
    const fromFile = loadPermissionsDocumentFor(env.vault);
    expect(fromFile.path).toBe(join(env.vault, "Brain", "_permissions.yaml"));
    expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("WriteRefusedError");
    setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, ALLOW_ALL);
    expect(loadPermissionsDocumentFor(env.vault).path).toBe(PERMISSIONS_SETTING_LABEL);
    expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("none");
  });

  test("a value won by agent authority is not a policy", () => {
    env = makeStoreEnv("osb-perm-src-agent-record-");
    switchDevice(env.storeRoot);
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "a",
      body: { [AUTHORITY_FIELD]: "agent", key: PERMISSIONS_DOCUMENT_SETTING, value: ALLOW_ALL },
    });
    expect(loadPermissionsDocumentFor(env.vault).document).toBeNull();
  });

  test("an operator value that does not parse fails closed", () => {
    env = makeStoreEnv("osb-perm-src-broken-");
    switchDevice(env.storeRoot);
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o",
      body: {
        [AUTHORITY_FIELD]: "human",
        key: PERMISSIONS_DOCUMENT_SETTING,
        value: "version: 9\n",
      },
    });
    expect(() => loadPermissionsDocumentFor(env!.vault)).toThrow(PermissionsDocumentError);
  });

  // POSIX modes only, and root reads a 0000 folder anyway.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a settings stream that cannot be read fails closed, not open",
    () => {
      env = makeStoreEnv("osb-perm-src-unreadable-");
      switchDevice(env.storeRoot);
      setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, DENY_ALL);
      expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("WriteRefusedError");
      const settings = join(env.storeRoot, "shared", "settings");
      chmodSync(settings, 0o000);
      try {
        expect(() => loadPermissionsDocumentFor(env!.vault)).toThrow(PermissionsDocumentError);
        expect(() => resolveWriteDisposition(env!.vault, "notes")).toThrow();
        const out: DoctorFindings = { issues: [], uncertain: [] };
        permissionsDocumentCheck.run(doctorContext(env!), out);
        expect(out.issues.map((i) => i.code)).toEqual([PERMISSIONS_UNREADABLE_CODE]);
        expect(legacyOnlyFindings(env!)).toEqual([]);
      } finally {
        chmodSync(settings, 0o755);
      }
    },
  );

  test("the shard of the operator's deny gone since this machine read it: still refused", () => {
    env = makeStoreEnv("osb-perm-src-gone-");
    switchDevice(env.storeRoot);
    // The sole permissions.document record sits in a peer's settings shard.
    const shard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o",
      body: { [AUTHORITY_FIELD]: "human", key: PERMISSIONS_DOCUMENT_SETTING, value: DENY_ALL },
    }).path;
    expect(refusal(() => resolveWriteDisposition(env!.vault, "notes"))).toBe("WriteRefusedError");
    // Taken away mid-sync, `shared/store.json` left in place.
    rmSync(shard);
    expect(() => loadPermissionsDocumentFor(env!.vault)).toThrow(PermissionsDocumentError);
    expect(() => resolveWriteDisposition(env!.vault, "notes")).toThrow();
    const out: DoctorFindings = { issues: [], uncertain: [] };
    permissionsDocumentCheck.run(doctorContext(env), out);
    expect(out.issues.map((i) => i.code)).toEqual([PERMISSIONS_UNREADABLE_CODE]);
    expect(out.issues[0]!.message).toContain("shared/settings/dev-b/");
  });
});

/** A switched machine whose operator denies note writes in the setting. */
function switchedWithDeny(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix);
  writeLegacy(e.vault, ALLOW_ALL);
  switchDevice(e.storeRoot);
  setBrainSetting(human(e.vault), PERMISSIONS_DOCUMENT_SETTING, DENY_ALL);
  // The gate reads the setting, which also records the sticky switch.
  expect(refusal(() => resolveWriteDisposition(e.vault, "notes"))).toBe("WriteRefusedError");
  return e;
}

const identity = (e: StoreEnv, partition: string): string =>
  join(e.storeRoot, partition, "store.json");

describe("a switched machine whose store cannot be opened", () => {
  const cases: ReadonlyArray<[string, (e: StoreEnv) => void]> = [
    [
      "every store.json gone",
      (e) => {
        rmSync(identity(e, "shared"));
        rmSync(identity(e, "private"));
      },
    ],
    ["shared/store.json corrupt", (e) => writeFileSync(identity(e, "shared"), "{ not json")],
    ["only shared/store.json gone", (e) => rmSync(identity(e, "shared"))],
    [
      "only private/store.json gone (a partition this machine held)",
      (e) => rmSync(identity(e, "private")),
    ],
  ];

  for (const [name, breakStore] of cases) {
    test(`${name}: the operator's deny still refuses a note write`, () => {
      env = switchedWithDeny("osb-perm-src-nostore-");
      breakStore(env);
      expect(() => loadPermissionsDocumentFor(env!.vault)).toThrow(PermissionsDocumentError);
      expect(() => resolveWriteDisposition(env!.vault, "notes")).toThrow();
      const out: DoctorFindings = { issues: [], uncertain: [] };
      permissionsDocumentCheck.run(doctorContext(env), out);
      expect(out.issues.map((i) => i.code)).toEqual([PERMISSIONS_UNREADABLE_CODE]);
    });
  }

  test("an unswitched machine with no store still reads its legacy file", () => {
    env = makeStoreEnv("osb-perm-src-nostore-legacy-");
    writeLegacy(env.vault, DENY_ALL);
    rmSync(identity(env, "shared"));
    rmSync(identity(env, "private"));
    expect(loadPermissionsDocumentFor(env.vault).document?.default_action).toBe("deny");
  });
});

function doctorContext(e: StoreEnv): DoctorCheckContext {
  return {
    vault: e.vault,
    now: new Date("2026-11-08T12:00:00Z"),
    config: undefined,
    dbPath: undefined,
    configPath: e.configPath,
    knownBasenames: new Set(),
    idIndex: new Map(),
    preferences: [],
    logs: [],
  };
}

function legacyOnlyFindings(e: StoreEnv): string[] {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  permissionsLegacyOnlyCheck.run(doctorContext(e), out);
  return out.issues.map((i) => i.code);
}

describe("doctor: deny rules only in a legacy permissions file", () => {
  test("a switched machine with the deny rules not in the setting warns", () => {
    env = makeStoreEnv("osb-perm-src-doc-warn-");
    writeLegacy(env.vault, DENY_ALL);
    switchDevice(env.storeRoot);
    expect(legacyOnlyFindings(env)).toEqual([PERMISSIONS_LEGACY_ONLY_CODE]);
    setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, ALLOW_ALL);
    expect(legacyOnlyFindings(env)).toEqual([PERMISSIONS_LEGACY_ONLY_CODE]);
  });

  test("silent once the setting holds the same rules, whatever the layout", () => {
    env = makeStoreEnv("osb-perm-src-doc-same-");
    writeLegacy(env.vault, DENY_ALL);
    switchDevice(env.storeRoot);
    // What `$(cat file)` hands the CLI: the trailing newline is gone.
    setBrainSetting(human(env.vault), PERMISSIONS_DOCUMENT_SETTING, DENY_ALL.trimEnd());
    expect(legacyOnlyFindings(env)).toEqual([]);
  });

  test("silent where the gates read the file, and for a file with no deny", () => {
    env = makeStoreEnv("osb-perm-src-doc-silent-");
    writeLegacy(env.vault, DENY_ALL);
    expect(legacyOnlyFindings(env)).toEqual([]);
    writeLegacy(env.vault, ALLOW_ALL);
    switchDevice(env.storeRoot);
    expect(legacyOnlyFindings(env)).toEqual([]);
  });
});
