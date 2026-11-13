/**
 * The lane page store (task 2.10 WP6): the same page calls write files on
 * an unswitched machine and `lane-entry` records on a store-only one,
 * which then writes nothing under the vault and reads its pages back from
 * the fold; with no vault at all the calls work the same.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { isFileAlreadyExists } from "../../../src/core/fs-atomic.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { evaluateStaleness, MATERIALIZE_FRESHNESS } from "../../../src/core/brain/staleness.ts";
import {
  laneEntryClockMs,
  laneEntryInPrivate,
  lanePageExists,
  listLaneFiles,
  moveLanePage,
  moveLaneTree,
  readLanePage,
  parseLanePage,
  readLaneText,
  removeLanePage,
  removeLaneTree,
  writeLanePage,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { foldLaneEntries } from "../../../src/core/store/lane-records.ts";
import { formatFrontmatter } from "../../../src/core/vault.ts";
import { VaultAdapterRequiredError } from "../../../src/core/vault-adapter/index.ts";
import {
  bindVaultToStore,
  VaultBindingMismatchError,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

describe.each(LANE_MODES)("lane pages (%s)", (mode) => {
  test("write, read, list, move and remove a page", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const before = lane.vaultHash();
    const dir = join(vault, "Brain", "dead-ends");
    const page = join(dir, "de-2026-11-07-x.md");
    if (mode === "legacy") mkdirSync(dir, { recursive: true });

    expect(
      writeLanePage(vault, page, { kind: "brain-dead-end", id: "de-x" }, "Body.\n", {
        overwrite: false,
      }),
    ).toBe(true);
    let collided: unknown = null;
    try {
      writeLanePage(vault, page, { kind: "brain-dead-end" }, "Again.\n", {
        overwrite: false,
      });
    } catch (error) {
      collided = error;
    }
    expect(isFileAlreadyExists(collided)).toBe(true);
    expect(lanePageExists(vault, page)).toBe(true);
    expect(readLanePage(vault, page)).toMatchObject({
      frontmatter: { kind: "brain-dead-end", id: "de-x" },
    });
    expect(readLanePage(vault, page)?.body.trim()).toBe("Body.");
    expect(listLaneFiles(vault, dir)).toEqual(["de-2026-11-07-x.md"]);

    const archived = join(dir, "archive", "de-x.md");
    if (mode === "legacy") mkdirSync(join(dir, "archive"), { recursive: true });
    moveLanePage(vault, page, archived);
    expect(listLaneFiles(vault, dir)).toEqual([]);
    expect(listLaneFiles(vault, join(dir, "archive"))).toEqual(["de-x.md"]);
    removeLanePage(vault, archived);
    expect(lanePageExists(vault, archived)).toBe(false);

    const json = join(vault, "Brain", "entities", "lexicon.json");
    if (mode === "legacy") mkdirSync(join(vault, "Brain", "entities"), { recursive: true });
    writeLaneText(vault, json, `${JSON.stringify({ words: ["a"] })}\n`);
    expect(JSON.parse(readLaneText(vault, json)!)).toEqual({ words: ["a"] });

    if (mode === "legacy") {
      expect(existsSync(json)).toBe(true);
    } else {
      expect(lane.vaultHash()).toBe(before);
      const kinds = lane.laneRecords().map((r) => r.kind);
      expect(kinds.filter((k) => k === "lane-entry")).toHaveLength(3);
      expect(kinds.filter((k) => k === "lane-entry-remove")).toHaveLength(2);
    }
  });

  test("a page whose frontmatter reserves it lands in private", () => {
    lane = makeLaneEnv(mode);
    if (mode === "legacy") return;
    const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
    writeLanePage(lane.vault, page, { kind: "brain-obligation", visibility: "private" }, "Owed.\n");
    expect(lane.laneRecords("shared")).toHaveLength(0);
    const records = lane.laneRecords("private");
    expect(records).toHaveLength(1);
    expect(records[0]!.body["lane"]).toBe("obligations");
    expect(records[0]!.body["entry"]).toBe("obl-x");
  });

  test("an overwrite that drops the visibility field keeps a private entry private", () => {
    lane = makeLaneEnv(mode);
    const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
    const json = join(lane.vault, "Brain", "obligations", "obl-x.json");
    if (mode === "legacy") mkdirSync(dirname(page), { recursive: true });
    writeLanePage(
      lane.vault,
      page,
      { kind: "brain-obligation", visibility: "private" },
      "Secret.\n",
    );
    writeLaneText(lane.vault, json, '{"visibility":"private","owed":"secret"}\n');
    // An agent overwrite that keeps the text but omits the field.
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "Secret, still.\n", {
      overwrite: true,
    });
    writeLaneText(lane.vault, json, '{"owed":"secret"}\n');
    writeLaneText(lane.vault, page, "---\nkind: brain-obligation\n---\nSecret, again.\n");
    expect(lane.laneRecords("shared")).toEqual([]);
    expect(lane.laneRecords("private")).toHaveLength(5);
    if (mode === "legacy") return;
    expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Secret, again.");
    expect(laneEntryInPrivate(lane.vault, page)).toBe(true);
    expect(laneEntryInPrivate(lane.vault, json)).toBe(true);
  });

  test("a shared page overwritten as private leaves no trace for a shared-only reader", () => {
    lane = makeLaneEnv(mode);
    const page = join(lane.vault, "Brain", "obligations", "obl-y.md");
    const json = join(lane.vault, "Brain", "obligations", "obl-y.json");
    if (mode === "legacy") mkdirSync(dirname(page), { recursive: true });
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "Open text.\n");
    writeLaneText(lane.vault, json, '{"owed":"open"}\n');
    // A shared overwrite that stays shared removes nothing.
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "Open, edited.\n", {
      overwrite: true,
    });
    expect(lane.laneRecords().filter((r) => r.kind === "lane-entry-remove")).toEqual([]);

    writeLanePage(
      lane.vault,
      page,
      { kind: "brain-obligation", visibility: "private" },
      "Secret now.\n",
      { overwrite: true },
    );
    writeLaneText(lane.vault, json, '{"visibility":"private","owed":"secret"}\n');
    // A machine holding only shared sees both entries go, and no new text.
    const sharedOnly = sharedFold(lane);
    expect(sharedOnly.get("obligations/obl-y")?.value ?? null).toBeNull();
    expect(sharedOnly.get("obligations/obl-y.json")?.value ?? null).toBeNull();
    const sharedText = JSON.stringify(lane.laneRecords("shared").map((r) => r.body));
    expect(sharedText).not.toContain("Secret now");
    expect(sharedText).not.toContain("secret");
    if (mode === "legacy") return;
    // A machine holding both reads the private version.
    expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Secret now.");
    expect(readLaneText(lane.vault, json)).toContain('"secret"');
    expect(laneEntryInPrivate(lane.vault, page)).toBe(true);
    expect(laneEntryInPrivate(lane.vault, json)).toBe(true);
  });
});

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "an entry a peer stamped ahead of this clock (%s)",
  (mode) => {
    const AHEAD_MS = 5 * 60 * 1000;
    function peerEntry(env: LaneEnv, entry: string, text: string): void {
      appendRecord(
        openStore({ root: env.env.storeRoot, device: "dev-b" }),
        {
          partition: "shared",
          stream: "events",
          kind: "lane-entry",
          agent: "t",
          body: {
            authority: "agent",
            lane: "obligations",
            entry,
            fields: { kind: "brain-obligation" },
            text,
          },
        },
        { now: () => Date.now() + AHEAD_MS },
      );
    }

    test("an overwrite as private still removes it for a shared-only reader", () => {
      lane = makeLaneEnv(mode);
      peerEntry(lane, "obl-ahead", "Open text.\n");
      const page = join(lane.vault, "Brain", "obligations", "obl-ahead.md");
      expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Open text.");
      writeLanePage(
        lane.vault,
        page,
        { kind: "brain-obligation", visibility: "private" },
        "Secret now.\n",
        { overwrite: true },
      );
      expect(sharedFold(lane).get("obligations/obl-ahead")?.value ?? null).toBeNull();
      expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Secret now.");
    });

    test("a plain overwrite and a removal take effect", () => {
      lane = makeLaneEnv(mode);
      peerEntry(lane, "obl-edit", "Open text.\n");
      peerEntry(lane, "obl-gone", "Open text.\n");
      const edit = join(lane.vault, "Brain", "obligations", "obl-edit.md");
      const gone = join(lane.vault, "Brain", "obligations", "obl-gone.md");
      writeLanePage(lane.vault, edit, { kind: "brain-obligation" }, "Edited.\n", {
        overwrite: true,
      });
      expect(readLanePage(lane.vault, edit)?.body.trim()).toBe("Edited.");
      removeLanePage(lane.vault, gone);
      expect(lanePageExists(lane.vault, gone)).toBe(false);
    });
  },
);

/** The live lane entries a machine that holds only `shared` reads, by `<lane>/<entry>`. */
function sharedFold(env: LaneEnv) {
  return foldLaneEntries(env.laneRecords("shared")).entries;
}

/** A staged folder with a shared manifest and a private report. */
function mixedFolder(env: LaneEnv, name: string): string {
  const dir = join(env.vault, "Brain", "dream", "staged", name);
  writeLaneText(env.vault, join(dir, "manifest.json"), '{"schema":"x"}\n');
  writeLanePage(env.vault, join(dir, "REPORT.md"), { visibility: "private" }, "Report.\n");
  return dir;
}
const tombstones = (env: LaneEnv, p: "shared" | "private") =>
  env.laneRecords(p).filter((r) => r.kind === "lane-entry-remove");

describe.each(LANE_MODES.filter((m) => m !== "legacy"))("a mixed folder (%s)", (mode) => {
  test("moved: each entry and its tombstone stay in the entry's own partition", () => {
    lane = makeLaneEnv(mode);
    const from = mixedFolder(lane, "stage-1");
    const to = join(lane.vault, "Brain", "dream", "applied", "stage-1");
    moveLaneTree(lane.vault, from, to);
    expect(readLaneText(lane.vault, join(to, "manifest.json"))).toContain('"schema"');
    expect(readLanePage(lane.vault, join(to, "REPORT.md"))?.body.trim()).toBe("Report.");
    expect(lanePageExists(lane.vault, join(from, "manifest.json"))).toBe(false);
    // A shared-only reader sees the manifest leave the staged folder.
    const sharedOnly = sharedFold(lane);
    expect(sharedOnly.get("dream/staged/stage-1/manifest.json")?.value ?? null).toBeNull();
    expect(sharedOnly.get("dream/applied/stage-1/manifest.json")?.value).not.toBeNull();
    expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("REPORT");
    expect(tombstones(lane, "shared")).toHaveLength(1);
    expect(tombstones(lane, "private")).toHaveLength(1);
  });

  test("removed: a shared-only reader no longer sees the manifest", () => {
    lane = makeLaneEnv(mode);
    const dir = mixedFolder(lane, "stage-2");
    removeLaneTree(lane.vault, dir);
    expect(sharedFold(lane).get("dream/staged/stage-2/manifest.json")?.value ?? null).toBeNull();
    expect(tombstones(lane, "shared")).toHaveLength(1);
    expect(tombstones(lane, "private")).toHaveLength(1);
    expect(lanePageExists(lane.vault, join(dir, "manifest.json"))).toBe(false);
    expect(lanePageExists(lane.vault, join(dir, "REPORT.md"))).toBe(false);
  });
});

describe.each(LANE_MODES.filter((m) => m !== "legacy"))("lane pages in the store (%s)", (mode) => {
  test("an overwrite with what the entry holds appends nothing", () => {
    lane = makeLaneEnv(mode);
    const page = join(lane.vault, "Brain", "digests", "weekly.md");
    expect(
      writeLanePage(lane.vault, page, { kind: "digest" }, "Same.\n", {
        overwrite: true,
      }),
    ).toBe(true);
    expect(
      writeLanePage(lane.vault, page, { kind: "digest" }, "Same.\n", {
        overwrite: true,
      }),
    ).toBe(false);
    writeLaneText(lane.vault, join(lane.vault, "Brain", "digests", "w.json"), '{"a":1}\n');
    writeLaneText(lane.vault, join(lane.vault, "Brain", "digests", "w.json"), '{"a":1}\n');
    expect(lane.laneRecords().filter((r) => r.kind === "lane-entry")).toHaveLength(2);
  });

  test("a structured write over a raw entry drops the raw once and then churns nothing", () => {
    lane = makeLaneEnv(mode);
    const page = join(lane.vault, "Brain", "digests", "churn.md");
    // No blank line after the closing fence: the whole write keeps a raw.
    writeLaneText(lane.vault, page, "---\nkind: digest\n---\nBody.\n");
    const entries = () => lane!.laneRecords().filter((r) => r.kind === "lane-entry");
    expect(entries()).toHaveLength(1);
    const written = writeLanePage(lane.vault, page, { kind: "digest" }, "Body.\n", {
      overwrite: true,
    });
    expect(written).toBe(true);
    expect(entries()).toHaveLength(2);
    // The same parts again match the entry (its raw is gone) and are skipped.
    const again = writeLanePage(lane.vault, page, { kind: "digest" }, "Body.\n", {
      overwrite: true,
    });
    expect(again).toBe(false);
    expect(entries()).toHaveLength(2);
  });

  test("a caller editing the frontmatter it read does not change the next read", () => {
    lane = makeLaneEnv(mode);
    const page = join(lane.vault, "Brain", "pledges", "p.md");
    writeLanePage(lane.vault, page, { kind: "pledge", status: "open" }, "P.\n");
    const [meta] = parseLanePage(lane.vault, page);
    meta["status"] = "edited";
    readLanePage(lane.vault, page)!.frontmatter["status"] = "edited too";
    expect(parseLanePage(lane.vault, page)[0]["status"]).toBe("open");
  });

  test("a malformed JSON lane file is written as text, as the legacy writer writes it", () => {
    lane = makeLaneEnv(mode);
    const path = join(lane.vault, "Brain", "entities", "broken.json");
    const before = lane.vaultHash();
    writeLaneText(lane.vault, path, "{not json\n");
    expect(readLaneText(lane.vault, path)).toBe("{not json\n");
    // Into the store as text: one entry, no file under the vault.
    expect(lane.vaultHash()).toBe(before);
    expect(lane.laneRecords().filter((r) => r.kind === "lane-entry")).toHaveLength(1);
  });
});

describe("a removed entry's tombstone", () => {
  test("lands where the entry lives, even when the page it names turned private", () => {
    lane = makeLaneEnv("store");
    const note = join(lane.vault, "Notes", "otters.md");
    mkdirSync(join(lane.vault, "Notes"), { recursive: true });
    writeFileSync(note, "---\ntitle: Otters\n---\nOpen.\n");
    const page = join(lane.vault, "Brain", "obligations", "obl-otters.md");
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "See [[Notes/otters]].\n");
    expect(lane.laneRecords("shared").map((r) => r.kind)).toEqual(["lane-entry"]);
    writeFileSync(note, "---\ntitle: Otters\nvisibility: private\n---\nNow private.\n");
    removeLanePage(lane.vault, page);
    expect(lane.laneRecords("shared").map((r) => r.kind)).toEqual([
      "lane-entry",
      "lane-entry-remove",
    ]);
    expect(lane.laneRecords("private")).toEqual([]);
    expect(lanePageExists(lane.vault, page)).toBe(false);
  });
});

describe("a moved source-archive entry", () => {
  test("stays in the shared partition it lives in, tombstone and copy alike", () => {
    lane = makeLaneEnv("store");
    // Written by a device that holds no private partition: it lives in shared.
    appendRecord(openStore({ root: lane.env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "agent",
        lane: "source-archive",
        entry: "old/a",
        fields: { kind: "source" },
        text: "Archived.\n",
      },
    });
    const from = join(lane.vault, "Brain", ".archives", "old", "a.md");
    const to = join(lane.vault, "Brain", ".archives", "new", "a.md");
    moveLanePage(lane.vault, from, to);
    expect(lane.laneRecords("private")).toHaveLength(0);
    expect(
      lane
        .laneRecords("shared")
        .map((r) => r.kind)
        .toSorted(),
    ).toEqual(["lane-entry", "lane-entry", "lane-entry-remove"]);
    expect(lanePageExists(lane.vault, to)).toBe(true);
  });
});

describe("a lane write into the user's vault on a store-only machine", () => {
  test("is a file, guarded by the vault adapter: the bound vault writes", () => {
    lane = makeLaneEnv("store");
    bindVaultToStore(lane.vault);
    const page = join(lane.vault, "skills", "deploy", "SKILL.md");
    writeLaneText(lane.vault, page, "# Deploy\n");
    expect(existsSync(page)).toBe(true);
    expect(lane.laneRecords()).toHaveLength(0);
  });

  test("a vault that is not the one bound to the store is refused", () => {
    lane = makeLaneEnv("store");
    // The adapter compares the store binding once the legacy tree is gone
    // (while it remains, the tree's own identity marker is the guard).
    rmSync(join(lane.vault, "Brain"), { recursive: true, force: true });
    const other = join(lane.env.parent, "other-vault");
    mkdirSync(other, { recursive: true });
    bindVaultToStore(other);
    const page = join(lane.vault, "skills", "deploy", "SKILL.md");
    expect(() => writeLaneText(lane!.vault, page, "# Deploy\n")).toThrow(VaultBindingMismatchError);
    expect(existsSync(page)).toBe(false);
  });

  test("with no vault there is no user vault to write into", () => {
    lane = makeLaneEnv("no-vault");
    const page = join(lane.vault, "skills", "deploy", "SKILL.md");
    expect(() => writeLaneText(lane!.vault, page, "# Deploy\n")).toThrow(VaultAdapterRequiredError);
    expect(existsSync(lane.vault)).toBe(false);
  });
});

describe("freshness of lane-record outputs on a store-only machine", () => {
  test("a cluster note record newer than every input note is fresh; a newer note makes it stale", () => {
    lane = makeLaneEnv("store");
    const note = join(lane.vault, "notes", "a.md");
    mkdirSync(join(lane.vault, "notes"), { recursive: true });
    writeFileSync(note, "# A\n");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(note, past, past);
    const output = join(lane.vault, "Brain", "clusters", "cluster-a.md");
    writeLaneText(lane.vault, output, "---\nkind: brain-cluster\n---\nA.\n");
    const clock = laneEntryClockMs(lane.vault, output);
    expect(clock).not.toBeNull();
    const stamp = (path: string) => laneEntryClockMs(lane!.vault, path);
    expect(evaluateStaleness([note], [output], { outputStampMs: stamp }).state).toBe(
      MATERIALIZE_FRESHNESS.fresh,
    );
    const future = new Date(clock! + 60_000);
    utimesSync(note, future, future);
    expect(evaluateStaleness([note], [output], { outputStampMs: stamp }).state).toBe(
      MATERIALIZE_FRESHNESS.stale,
    );
  });
});

/** Every `events` shard of `partition`, absolute paths. */
function eventsShards(env: LaneEnv, partition: "shared" | "private"): string[] {
  const dir = join(env.env.storeRoot, partition, "events");
  return readdirSync(dir).flatMap((device) =>
    readdirSync(join(dir, device)).map((name) => join(dir, device, name)),
  );
}

/** Overwrites of `page` that keep its secret text and drop its visibility field. */
function secretWrites(env: LaneEnv, page: string): void {
  const writes = [
    () =>
      writeLanePage(env.vault, page, { kind: "brain-obligation" }, "Secret, still.\n", {
        overwrite: true,
      }),
    () => writeLaneText(env.vault, page, "---\nkind: brain-obligation\n---\nSecret, again.\n"),
  ];
  // Each write lands in `private` or is refused; neither reaches `shared`.
  for (const write of writes) {
    try {
      write();
    } catch {
      // refused: the private shard cannot take the append either
    }
  }
}

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "a private entry whose private events shard cannot be seen (%s)",
  (mode) => {
    // POSIX modes only, and root reads a 0000 file anyway.
    test.skipIf(CHMOD_CANNOT_DENY)(
      "unreadable: an overwrite without the visibility field goes nowhere near shared",
      () => {
        lane = makeLaneEnv(mode);
        const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
        writeLanePage(
          lane.vault,
          page,
          { kind: "brain-obligation", visibility: "private" },
          "Secret.\n",
        );
        const [shard] = eventsShards(lane, "private");
        chmodSync(shard!, 0o000);
        try {
          // As a fresh process meets it: the fold is read anew.
          const later = new Date(Date.now() + 60_000);
          utimesSync(shard!, later, later);
          expect(laneEntryInPrivate(lane.vault, page)).toBe(true);
          secretWrites(lane, page);
        } finally {
          chmodSync(shard!, 0o600);
        }
        expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain(
          "Secret",
        );
      },
    );

    test("gone since this machine read it: the overwrite still stays out of shared", () => {
      lane = makeLaneEnv(mode);
      const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
      writeLanePage(
        lane.vault,
        page,
        { kind: "brain-obligation", visibility: "private" },
        "Secret.\n",
      );
      expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Secret.");
      for (const shard of eventsShards(lane, "private")) rmSync(shard);
      secretWrites(lane, page);
      expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");
    });
  },
);

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "a private entry whose private partition lost its identity file (%s)",
  (mode) => {
    test("an overwrite without the visibility field never reaches shared", () => {
      lane = makeLaneEnv(mode);
      const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
      writeLanePage(
        lane.vault,
        page,
        { kind: "brain-obligation", visibility: "private" },
        "Secret.\n",
      );
      expect(lane.laneRecords("private")).toHaveLength(1);
      // The shard stays; only the partition's identity file is gone.
      rmSync(join(lane.env.storeRoot, "private", "store.json"));
      expect(laneEntryInPrivate(lane.vault, page)).toBe(true);
      secretWrites(lane, page);
      expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");
    });
  },
);

describe("a store-only machine that never held private", () => {
  test("keeps writing lane pages to shared", () => {
    lane = makeLaneEnv("store", "osb-lane-", { partitions: ["shared"] });
    const page = join(lane.vault, "Brain", "obligations", "obl-y.md");
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "Open.\n");
    expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Open.");
    expect(laneEntryInPrivate(lane.vault, page)).toBe(false);
    expect(lane.laneRecords("shared").map((r) => r.body["text"])).toEqual(["Open.\n"]);
  });
});

/** Every blob file of `partition`, absolute paths. */
function blobFiles(env: LaneEnv, partition: "shared" | "private"): string[] {
  const dir = join(env.env.storeRoot, partition, "blobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((sub) =>
    readdirSync(join(dir, sub)).map((name) => join(dir, sub, name)),
  );
}

/** Pretend a fresh process meets the shards: the lane fold is read anew. */
function touchShards(env: LaneEnv, partition: "shared" | "private"): void {
  const later = new Date(Date.now() + 60_000);
  for (const shard of eventsShards(env, partition)) utimesSync(shard, later, later);
}

/** A body longer than the line-size cap, so the record line names a blob. */
const LONG_SECRET = `Secret.\n\n${"x".repeat(20_000)}\n`;

describe.each(LANE_MODES.filter((m) => m !== "legacy"))(
  "a private entry whose body blob has not arrived yet (%s)",
  (mode) => {
    test("an overwrite without the visibility field never reaches shared", () => {
      lane = makeLaneEnv(mode);
      const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
      writeLanePage(
        lane.vault,
        page,
        { kind: "brain-obligation", visibility: "private" },
        LONG_SECRET,
      );
      const blobs = blobFiles(lane, "private");
      expect(blobs.length).toBeGreaterThan(0);
      // The shard has arrived on this machine; its blob has not.
      for (const blob of blobs) rmSync(blob);
      touchShards(lane, "private");
      expect(laneEntryInPrivate(lane.vault, page)).toBe(true);
      secretWrites(lane, page);
      expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");
    });

    test("the fold is read again once the blob arrives, with no shard change", () => {
      lane = makeLaneEnv(mode);
      const page = join(lane.vault, "Brain", "obligations", "obl-x.md");
      writeLanePage(
        lane.vault,
        page,
        { kind: "brain-obligation", visibility: "private" },
        LONG_SECRET,
      );
      const parked = join(lane.env.storeRoot, "..", "parked-blobs");
      mkdirSync(parked, { recursive: true });
      const blobs = blobFiles(lane, "private").map((path) => ({
        path,
        aside: join(parked, basename(path)),
      }));
      for (const { path, aside } of blobs) renameSync(path, aside);
      touchShards(lane, "private");
      expect(readLanePage(lane.vault, page)).toBeNull();
      // The blob arrives; the shard's size and mtime stay as they were.
      for (const { path, aside } of blobs) renameSync(aside, path);
      expect(readLanePage(lane.vault, page)?.body.startsWith("Secret.")).toBe(true);
    });
  },
);

describe("raw lane text on a store-only machine", () => {
  test("a canonical page stores a record with no raw", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-canonical.md");
    writeLaneText(lane.vault, page, formatFrontmatter({ kind: "k" }, "Body."));
    const body = lane.laneRecords().find((r) => r.kind === "lane-entry")!.body as Record<
      string,
      unknown
    >;
    expect("raw" in body).toBe(false);
    expect(readLaneText(lane.vault, page)).toBe(formatFrontmatter({ kind: "k" }, "Body."));
  });

  test("a page without frontmatter reads back verbatim", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-raw.md");
    writeLaneText(lane.vault, page, "Just text.\n");
    expect(readLaneText(lane.vault, page)).toBe("Just text.\n");
  });

  test("a quoted value reads back verbatim", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-quote.md");
    writeLaneText(lane.vault, page, "---\nid: '123'\n---\nBody.\n");
    expect(readLaneText(lane.vault, page)).toBe("---\nid: '123'\n---\nBody.\n");
    expect(readLanePage(lane.vault, page)?.frontmatter.id).toBe("123");
  });

  test("CRLF and a missing final newline read back verbatim", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-crlf.md");
    writeLaneText(lane.vault, page, "---\r\nkind: k\r\n---\r\nBody.\r\n");
    expect(readLaneText(lane.vault, page)).toBe("---\r\nkind: k\r\n---\r\nBody.\r\n");
    const noFinal = join(lane.vault, "Brain", "obligations", "obl-no-final.md");
    writeLaneText(lane.vault, noFinal, "---\nkind: k\n---\nBody.");
    expect(readLaneText(lane.vault, noFinal)).toBe("---\nkind: k\n---\nBody.");
  });

  test("JSON formatting reads back verbatim", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "raw.json");
    writeLaneText(lane.vault, page, '{"a":1}\n');
    expect(readLaneText(lane.vault, page)).toBe('{"a":1}\n');
  });

  test("a quoting-only rewrite is written", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-requote.md");
    writeLaneText(lane.vault, page, "---\nid: '123'\n---\nBody.\n");
    const afterFirst = lane.laneRecords().filter((r) => r.kind === "lane-entry").length;
    writeLaneText(lane.vault, page, '---\nid: "123"\n---\nBody.\n');
    const grown = lane.laneRecords().filter((r) => r.kind === "lane-entry").length;
    expect(grown).toBe(afterFirst + 1);
    expect(readLaneText(lane.vault, page)).toBe('---\nid: "123"\n---\nBody.\n');
    writeLaneText(lane.vault, page, '---\nid: "123"\n---\nBody.\n');
    const stable = lane.laneRecords().filter((r) => r.kind === "lane-entry").length;
    expect(stable).toBe(grown);
  });

  test("a structured write replaces the raw", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-struct.md");
    writeLaneText(lane.vault, page, "Just text.\n");
    writeLanePage(lane.vault, page, { kind: "k" }, "New.\n", { overwrite: true });
    expect(readLaneText(lane.vault, page)).toBe(formatFrontmatter({ kind: "k" }, "New.\n"));
  });

  test("a move keeps the raw", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-mv.md");
    writeLaneText(lane.vault, page, "Just text.\n");
    const dir = join(lane.vault, "Brain", "obligations");
    moveLanePage(lane.vault, page, join(dir, "obl-moved.md"));
    expect(readLaneText(lane.vault, join(dir, "obl-moved.md"))).toBe("Just text.\n");
    const tree = join(lane.vault, "Brain", "obligations", "obl-tree");
    mkdirSync(tree, { recursive: true });
    const treePage = join(tree, "obl-in-tree.md");
    writeLaneText(lane.vault, treePage, "Just text.\n");
    const other = join(lane.vault, "Brain", "obligations", "obl-tree-2");
    moveLaneTree(lane.vault, tree, other);
    expect(readLaneText(lane.vault, join(other, "obl-in-tree.md"))).toBe("Just text.\n");
  });

  test("a private region in a frontmatter comment sends the entry to private", () => {
    lane = makeLaneEnv("store");
    const page = join(lane.vault, "Brain", "obligations", "obl-comment.md");
    writeLaneText(lane.vault, page, "---\n# <private>secret</private>\nkind: k\n---\nBody.\n");
    expect(lane.laneRecords("shared")).toEqual([]);
    expect(lane.laneRecords("private")).toHaveLength(1);
  });

  test("a private reference in a frontmatter comment", () => {
    lane = makeLaneEnv("store");
    // The page the comment names exists on disk and carries no `pref-`/
    // `ret-` prefix: without one, the entry is judged by the reserved-page
    // rule (the page's own `visibility`), not by the missing-preference
    // rule. The page is written as a file directly, since a lane write on
    // a store-only machine lands in the store, not under the vault.
    const notes = join(lane.vault, "Brain", "notes");
    mkdirSync(notes, { recursive: true });
    const reserved = join(notes, "private-note.md");
    writeFileSync(reserved, "Plain.\n");
    const page = join(lane.vault, "Brain", "obligations", "obl-rawref-open.md");
    writeLaneText(
      lane.vault,
      page,
      "---\n# see [[Brain/notes/private-note]]\nkind: k\n---\nBody.\n",
    );
    // Control: the page is not reserved, so the entry naming it stays in
    // shared.
    const openEntry = lane
      .laneRecords("shared")
      .filter((r) => r.kind === "lane-entry" && r.body["lane"] === "obligations");
    expect(openEntry).toHaveLength(1);
    expect(lane.laneRecords("private").filter((r) => r.body["lane"] === "obligations")).toEqual([]);
    // Now reserve the same page as private: a further entry naming it must
    // go to private, and the earlier one stays where it was judged.
    writeFileSync(reserved, "---\nvisibility: private\n---\nReserved.\n");
    const judgedPage = join(lane.vault, "Brain", "obligations", "obl-rawref.md");
    writeLaneText(
      lane.vault,
      judgedPage,
      "---\n# see [[Brain/notes/private-note]]\nkind: k\n---\nBody.\n",
    );
    const judged = lane
      .laneRecords("private")
      .filter((r) => r.kind === "lane-entry" && r.body["lane"] === "obligations");
    expect(judged).toHaveLength(1);
    const shared = lane
      .laneRecords("shared")
      .filter((r) => r.kind === "lane-entry" && r.body["lane"] === "obligations");
    expect(shared).toHaveLength(1);
    expect(shared[0]!.body["entry"]).toBe("obl-rawref-open");
  });

  test("a raw that does not parse back is not served", () => {
    lane = makeLaneEnv("store");
    appendRecord(openStore({ root: lane.env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "agent",
        lane: "obligations",
        entry: "obl-hand",
        fields: { kind: "k" },
        text: "Body.",
        raw: "---\nkind: other\n---\nBody.\n",
      },
    });
    const page = join(lane.vault, "Brain", "obligations", "obl-hand.md");
    expect(readLaneText(lane.vault, page)).toBe(formatFrontmatter({ kind: "k" }, "Body."));
  });

  test("a hand-appended shared raw with a frontmatter comment is served as written", () => {
    lane = makeLaneEnv("store");
    appendRecord(openStore({ root: lane.env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "agent",
        lane: "obligations",
        entry: "obl-hand-comment",
        fields: { kind: "k" },
        text: "Body.",
        raw: "---\n# see [[pref-nowhere-raw]]\nkind: k\n---\nBody.\n",
      },
    });
    const page = join(lane.vault, "Brain", "obligations", "obl-hand-comment.md");
    expect(readLaneText(lane.vault, page)).toBe(
      "---\n# see [[pref-nowhere-raw]]\nkind: k\n---\nBody.\n",
    );
  });
});
