/**
 * The lanes whose page name carries a title slug inside a longer stem, as
 * one table per lane group:
 *
 * 1. Rewrite in place (source summaries, distillations): the stem is
 *    `<slug>-<hash>` and the hash names the record, so the page under the
 *    old Latin-only slug is the same record. The caller's reach is asked
 *    of the page selected, under either slug, before it is read or
 *    written; a withheld page is never read, rewritten or doubled beside.
 * 2. Exclusive writes (design notes, panels): one note per topic and day.
 *    A same-topic note of the day under the old slug refuses the write as
 *    a second note under the new slug does; another topic that once
 *    shared the old slug does not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";

import { commitDesignNote } from "../../../../src/core/brain/design-note.ts";
import { distillSource } from "../../../../src/core/brain/distill/distill-source.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  openPanelSession,
  submitToPanelSession,
} from "../../../../src/core/brain/write-session/panel.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { slugify, titleKeySlug } from "../../../../src/core/vault.ts";

const NOW = new Date("2026-07-10T08:00:00Z");
const LATER = new Date("2026-07-11T09:00:00Z");
const SOURCE = "Статьи/Проект release.md";
const WORDS = "статьи-проект-release-md";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-title-stems-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Статьи"), { recursive: true });
  writeFileSync(join(vault, SOURCE), "# Title\n\nBody text.\n", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type Readable = (rel: string) => boolean;

interface RewriteLane {
  readonly name: string;
  /** Run the lane on SOURCE; answers the vault-relative POSIX page path and `created`. */
  run(now: Date, readable?: Readable): { path: string; created: boolean };
}

const REWRITE_LANES: readonly RewriteLane[] = [
  {
    name: "source summaries (ingest)",
    run: (now, readable) => {
      const res = ingestSource(
        vault,
        { sourcePath: SOURCE, summary: "A summary.", extraction: { entities: [], relations: [] } },
        { agent: "claude", now, ...(readable ? { readable } : {}) },
      );
      return { path: res.summaryPath, created: res.created };
    },
  },
  {
    name: "distillations",
    run: (now, readable) => {
      const res = distillSource(
        vault,
        { sourcePath: SOURCE, claims: [{ text: "Body text." }] },
        { agent: "claude", now, ...(readable ? { readable } : {}) },
      );
      return { path: res.distillationPath, created: res.created };
    },
  },
];

/** The page names in the folder of `rel` that carry the same record hash. */
function sameRecord(rel: string): string[] {
  const hash = basename(rel).slice(-15, -3);
  return readdirSync(join(vault, posix.dirname(rel)))
    .filter((name) => name.endsWith(`${hash}.md`))
    .toSorted();
}

/** Move the page at `rel` to the name an older release gave it; answers the new rel. */
function toOldSlug(rel: string): string {
  const oldRel = posix.join(posix.dirname(rel), basename(rel).replace(WORDS, slugify(SOURCE)));
  renameSync(join(vault, rel), join(vault, oldRel));
  return oldRel;
}

for (const lane of REWRITE_LANES) {
  describe(`${lane.name}: rewrite in place`, () => {
    test("a readable page under the old slug is rewritten there, never doubled", () => {
      const oldRel = toOldSlug(lane.run(NOW).path);
      const again = lane.run(LATER);
      expect(again).toEqual({ path: oldRel, created: false });
      expect(sameRecord(oldRel)).toEqual([basename(oldRel)]);
    });

    test("a withheld page under the new slug is neither read nor rewritten", () => {
      const first = lane.run(NOW).path;
      const before = readFileSync(join(vault, first), "utf8");
      const mtime = statSync(join(vault, first)).mtimeMs;
      const again = lane.run(LATER, (rel) => rel !== first);
      expect(again).toEqual({ path: first, created: true });
      expect(readFileSync(join(vault, first), "utf8")).toBe(before);
      expect(statSync(join(vault, first)).mtimeMs).toBe(mtime);
    });

    test("a withheld page under the old slug is not doubled under the new one", () => {
      const first = lane.run(NOW).path;
      const oldRel = toOldSlug(first);
      const before = readFileSync(join(vault, oldRel), "utf8");
      const again = lane.run(LATER, (rel) => rel !== oldRel);
      // The answer an absent page gets: the new slug's path, created.
      expect(again).toEqual({ path: first, created: true });
      expect(existsSync(join(vault, first))).toBe(false);
      expect(readFileSync(join(vault, oldRel), "utf8")).toBe(before);
      expect(sameRecord(oldRel)).toEqual([basename(oldRel)]);
    });
  });
}

const DAY = "2026-07-10";

/** Answer every persona step of a panel session, then its synthesis. */
function finishPanel(sessionId: string) {
  let env = submitToPanelSession(vault, { sessionId, text: "Feasible.", now: NOW.toISOString() });
  for (let i = 0; i < 8 && env.step !== "synthesis"; i++) {
    env = submitToPanelSession(vault, { sessionId, text: "Sound.", now: NOW.toISOString() });
  }
  return submitToPanelSession(vault, { sessionId, text: "Ship it.", now: NOW.toISOString() });
}

describe("panels: two sessions of one topic and day across an upgrade", () => {
  test("the second is refused at publication when the first published under the old name", () => {
    const topic = "Проект release";
    const legacy = `Brain/decisions/panels/panel-${DAY}-${slugify(topic)}.md`;
    // A session an older release opened, aimed at the old name.
    const first = openPanelSession(vault, {
      agent: "tester",
      topic,
      now: NOW.toISOString(),
      targetPath: legacy,
    });
    const second = openPanelSession(vault, { agent: "tester", topic, now: NOW.toISOString() });
    expect(second.target_path).toBe(
      `Brain/decisions/panels/panel-${DAY}-${titleKeySlug(topic)}.md`,
    );
    expect(finishPanel(first.session_id).status).toBe("done");
    const late = finishPanel(second.session_id);
    expect(late.status).not.toBe("done");
    expect(existsSync(join(vault, second.target_path))).toBe(false);
  });
});

function alternative(name: string, recommended: boolean): Record<string, unknown> {
  return {
    name,
    approach: `Do it with ${name}.`,
    tradeoffs: `${name} costs time.`,
    recommended,
  };
}

const NOTE = {
  title: "Where the release notes live",
  alternatives: [alternative("pages", false), alternative("store", true)],
};

interface ExclusiveLane {
  readonly name: string;
  /** The vault-relative path of a note for `topic` written today under `slug`. */
  rel(topic: string, slug: string): string;
  /** A note for `topic` as the lane writes it (its frontmatter carries the topic). */
  seed(topic: string, slug: string): void;
  /** Write today's note for `topic`; throws when the lane refuses it. Answers the path it targets. */
  write(topic: string): string;
  /** True when the write itself refuses an occupied name (false: the target is fixed now, refused at commit). */
  readonly refusesAtWrite: boolean;
}

function seedNote(rel: string, topic: string): void {
  mkdirSync(join(vault, dirname(rel)), { recursive: true });
  writeFileSync(join(vault, rel), `---\ntopic: ${JSON.stringify(topic)}\n---\n\n# ${topic}\n`);
}

const EXCLUSIVE_LANES: readonly ExclusiveLane[] = [
  {
    name: "design notes",
    rel: (_topic, slug) => posix.join("Brain", "decisions", `design-${DAY}-${slug}.md`),
    seed(topic, slug) {
      seedNote(this.rel(topic, slug), topic);
    },
    write: (topic) => {
      const res = commitDesignNote(vault, topic, NOTE, { agent: "tester", now: NOW });
      return posix.relative(vault.replaceAll("\\", "/"), res.path.replaceAll("\\", "/"));
    },
    refusesAtWrite: true,
  },
  {
    name: "panels",
    rel: (_topic, slug) => posix.join("Brain", "decisions", "panels", `panel-${DAY}-${slug}.md`),
    seed(topic, slug) {
      seedNote(this.rel(topic, slug), topic);
    },
    // A panel's target is fixed when the session opens and refused at
    // commit when occupied, so the target it opens with is the answer.
    write: (topic) =>
      openPanelSession(vault, { agent: "tester", topic, now: NOW.toISOString() }).target_path,
    refusesAtWrite: false,
  },
];

for (const lane of EXCLUSIVE_LANES) {
  describe(`${lane.name}: one note per topic and day`, () => {
    const TOPIC = "Проект release";

    test("a same-topic note of the day under the old slug holds the name", () => {
      lane.seed(TOPIC, slugify(TOPIC));
      const oldRel = lane.rel(TOPIC, slugify(TOPIC));
      const seeded = readFileSync(join(vault, oldRel), "utf8");
      const before = readdirSync(join(vault, dirname(oldRel)));
      if (lane.refusesAtWrite) {
        // Refused, never reused: the old note is left as it was.
        expect(() => lane.write(TOPIC)).toThrow();
      } else {
        // Aimed at the occupied name, which the commit refuses.
        expect(lane.write(TOPIC)).toBe(oldRel);
      }
      expect(readdirSync(join(vault, dirname(oldRel)))).toEqual(before);
      expect(readFileSync(join(vault, oldRel), "utf8")).toBe(seeded);
    });

    for (const [how, stored, typed] of [
      ["NFD then, NFC now", "Cafe\u0301 plan", "Café plan"],
      ["NFC then, NFD now", "Café plan", "Cafe\u0301 plan"],
      ["no Latin letter, more spaces now", "远程 办公", "远程   办公"],
    ] as const) {
      test(`a same-topic note under the old slug of another spelling holds the name (${how})`, () => {
        lane.seed(stored, slugify(stored));
        const oldRel = lane.rel(stored, slugify(stored));
        expect(slugify(typed)).not.toBe(slugify(stored));
        const before = readdirSync(join(vault, dirname(oldRel)));
        if (lane.refusesAtWrite) expect(() => lane.write(typed)).toThrow();
        else expect(lane.write(typed)).toBe(oldRel);
        expect(readdirSync(join(vault, dirname(oldRel)))).toEqual(before);
      });
    }

    test("another topic that once shared the old slug does not hold the name", () => {
      lane.seed("Тема release", slugify(TOPIC));
      expect(lane.write(TOPIC)).toBe(lane.rel(TOPIC, titleKeySlug(TOPIC)));
    });

    test("an existing Unicode-normalized filename with the same stored topic holds the name", () => {
      const topic = "Café plan";
      const oldRel = lane.rel(topic, titleKeySlug(topic).normalize("NFD"));
      lane.seed(topic, titleKeySlug(topic).normalize("NFD"));
      const before = readFileSync(join(vault, oldRel), "utf8");
      if (lane.refusesAtWrite) expect(() => lane.write(topic)).toThrow();
      else expect(lane.write(topic)).toBe(oldRel);
      expect(readFileSync(join(vault, oldRel), "utf8")).toBe(before);
    });

    test.skipIf(IS_WINDOWS)(
      "a same-topic note behind the old name that leads outside the vault is never read",
      () => {
        const outside = join(tmp, "outside.md");
        writeFileSync(outside, `---\ntopic: ${JSON.stringify(TOPIC)}\n---\n\n# ${TOPIC}\n`);
        const oldRel = lane.rel(TOPIC, slugify(TOPIC));
        mkdirSync(join(vault, dirname(oldRel)), { recursive: true });
        symlinkSync(outside, join(vault, oldRel));
        expect(lane.write(TOPIC)).toBe(lane.rel(TOPIC, titleKeySlug(TOPIC)));
      },
    );

    test("an ASCII topic keeps the one name it always had", () => {
      expect(lane.write("Ship the parser")).toBe(lane.rel("Ship the parser", "ship-the-parser"));
    });
  });
}
