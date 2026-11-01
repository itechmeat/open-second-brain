/**
 * The delivery provenance probe and the fail-closed treatment derivation
 * (K1, lane A of the delivery-trust wave).
 *
 * `pageOriginForDelivery` reads the three provenance stamps a page
 * already carries - `origin_channel`, `content_class`,
 * `untrusted_source` - through the shared frontmatter cache, and
 * `storedTextTreatment` resolves the delivery treatment from them with
 * absence fail-closed: only a channel of `cli` with no other marker is
 * operator-authored plain; everything else - every agent-origin stamp,
 * and EVERY absence (no probe at all, no channel, the `unset` literal,
 * a page that cannot be read) - resolves `fenced`. The stamps forbid
 * backfill, so absence means "written before the stamp existed", a
 * statement about knowledge; the delivery side does not guess
 * operator-authorship it cannot prove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import type { FrontmatterCache } from "../../../../src/core/search/result-filters.ts";
import { CONTENT_CLASS_FIELD } from "../../../../src/core/brain/provenance/content-class.ts";
import { ORIGIN_CHANNEL_FIELD } from "../../../../src/core/origin-channel.ts";
import { UNTRUSTED_SOURCE_FRONTMATTER_KEY } from "../../../../src/core/brain/trust/untrusted-provenance.ts";
import {
  deliveryOriginLabel,
  pageOriginForDelivery,
  storedTextTreatment,
} from "../../../../src/core/brain/provenance/page-origin.ts";
import { DELIVERY_TREATMENT } from "../../../../src/core/brain/delivery-shaping.ts";

let vault: string;
let cache: FrontmatterCache;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-origin-"));
  mkdirSync(join(vault, "notes"), { recursive: true });
  cache = new Map();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function page(rel: string, frontmatter: string): string {
  const body = "Body prose that a delivery either hands over plain or fences.";
  writeFileSync(join(vault, rel), `---\n${frontmatter}---\n\n${body}\n`);
  return rel;
}

describe("storedTextTreatment derivation", () => {
  test("channel cli with no other marker is the one plain answer", () => {
    const rel = page("notes/cli.md", `${ORIGIN_CHANNEL_FIELD}: cli\n`);
    const origin = pageOriginForDelivery(vault, rel, cache);
    expect(origin).toEqual({
      originChannel: "cli",
      contentClass: null,
      untrustedSource: false,
    });
    expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.plain);
  });

  test("channel mcp-tool resolves fenced as agent-origin", () => {
    const rel = page("notes/mcp.md", `${ORIGIN_CHANNEL_FIELD}: mcp-tool\n`);
    expect(storedTextTreatment(pageOriginForDelivery(vault, rel, cache))).toBe(
      DELIVERY_TREATMENT.fenced,
    );
  });

  test("channel import resolves fenced as agent-origin", () => {
    const rel = page("notes/import.md", `${ORIGIN_CHANNEL_FIELD}: import\n`);
    expect(storedTextTreatment(pageOriginForDelivery(vault, rel, cache))).toBe(
      DELIVERY_TREATMENT.fenced,
    );
  });

  test("content_class prompt-derived resolves fenced even on a cli page", () => {
    const rel = page(
      "notes/prompt.md",
      `${ORIGIN_CHANNEL_FIELD}: cli\n${CONTENT_CLASS_FIELD}: prompt-derived\n`,
    );
    const origin = pageOriginForDelivery(vault, rel, cache);
    expect(origin.contentClass).toBe("prompt-derived");
    expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.fenced);
  });

  test("the untrusted_source marker resolves fenced even on a cli page", () => {
    const rel = page(
      "notes/marked.md",
      `${ORIGIN_CHANNEL_FIELD}: cli\n${UNTRUSTED_SOURCE_FRONTMATTER_KEY}: true\n`,
    );
    const origin = pageOriginForDelivery(vault, rel, cache);
    expect(origin.untrustedSource).toBe(true);
    expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.fenced);
  });

  test("the string form of the marker a YAML round-trip leaves behind resolves fenced", () => {
    const rel = page(
      "notes/marked-str.md",
      `${ORIGIN_CHANNEL_FIELD}: cli\n${UNTRUSTED_SOURCE_FRONTMATTER_KEY}: "true"\n`,
    );
    expect(storedTextTreatment(pageOriginForDelivery(vault, rel, cache))).toBe(
      DELIVERY_TREATMENT.fenced,
    );
  });

  test("EVERY absence resolves fenced: null origin, null channel, the unset literal", () => {
    // Null origin: the caller could not probe at all.
    expect(storedTextTreatment(null)).toBe(DELIVERY_TREATMENT.fenced);
    // A legacy page carrying no stamps.
    const legacy = page("notes/legacy.md", "title: Legacy\n");
    expect(storedTextTreatment(pageOriginForDelivery(vault, legacy, cache))).toBe(
      DELIVERY_TREATMENT.fenced,
    );
    // The absorbed `unset` literal: no entry point claimed the process.
    const unset = page("notes/unset.md", `${ORIGIN_CHANNEL_FIELD}: unset\n`);
    const unsetOrigin = pageOriginForDelivery(vault, unset, cache);
    expect(unsetOrigin.originChannel).toBe("unset");
    expect(storedTextTreatment(unsetOrigin)).toBe(DELIVERY_TREATMENT.fenced);
  });

  test("a hand-edited out-of-vocabulary channel is no evidence of authorship: fenced", () => {
    const rel = page("notes/hand.md", `${ORIGIN_CHANNEL_FIELD}: carrier-pigeon\n`);
    const origin = pageOriginForDelivery(vault, rel, cache);
    expect(origin.originChannel).toBeNull();
    expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.fenced);
  });
});

describe("pageOriginForDelivery probe", () => {
  test("a page that does not exist probes to a fenced absence without throwing", () => {
    const origin = pageOriginForDelivery(vault, "notes/never-written.md", cache);
    expect(origin).toEqual({ originChannel: null, contentClass: null, untrustedSource: false });
    expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.fenced);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a page that cannot be read probes to a fenced absence without throwing",
    () => {
      const rel = page("notes/locked.md", `${ORIGIN_CHANNEL_FIELD}: cli\n`);
      chmodSync(join(vault, rel), 0o000);
      try {
        const origin = pageOriginForDelivery(vault, rel, cache);
        expect(origin).toEqual({
          originChannel: null,
          contentClass: null,
          untrustedSource: false,
        });
        expect(storedTextTreatment(origin)).toBe(DELIVERY_TREATMENT.fenced);
      } finally {
        chmodSync(join(vault, rel), 0o644);
      }
    },
  );

  test("probes ride the shared cache: one cached entry across repeated reads", () => {
    const rel = page("notes/shared.md", `${ORIGIN_CHANNEL_FIELD}: cli\n`);
    expect(cache.size).toBe(0);
    const first = pageOriginForDelivery(vault, rel, cache);
    const second = pageOriginForDelivery(vault, rel, cache);
    // One frontmatter read per (vault, path) pair: the second probe was
    // served from the caller's cache, and the entry carries the read
    // verdict the cache is the single seam for.
    expect(cache.size).toBe(1);
    expect(second).toEqual(first);
  });
});

describe("deliveryOriginLabel", () => {
  test("names the derived provenance for each resolution", () => {
    const cli = pageOriginForDelivery(
      vault,
      page("notes/l-cli.md", `${ORIGIN_CHANNEL_FIELD}: cli\n`),
      cache,
    );
    expect(deliveryOriginLabel(cli)).toBe("stored text: operator-authored (origin_channel=cli)");

    const mcp = pageOriginForDelivery(
      vault,
      page("notes/l-mcp.md", `${ORIGIN_CHANNEL_FIELD}: mcp-tool\n`),
      cache,
    );
    expect(deliveryOriginLabel(mcp)).toBe("stored text: agent-authored (origin_channel=mcp-tool)");

    const legacy = pageOriginForDelivery(
      vault,
      page("notes/l-legacy.md", "title: Legacy\n"),
      cache,
    );
    expect(deliveryOriginLabel(legacy)).toBe(
      "stored text: unverified provenance (no derivable stamps)",
    );
  });

  test("the label is always single-line and attribute-safe", () => {
    for (const rel of [
      page("notes/a.md", `${ORIGIN_CHANNEL_FIELD}: cli\n`),
      page("notes/b.md", `${CONTENT_CLASS_FIELD}: prompt-derived\n`),
      page("notes/c.md", `${UNTRUSTED_SOURCE_FRONTMATTER_KEY}: true\n`),
      page("notes/d.md", ""),
    ]) {
      const label = deliveryOriginLabel(pageOriginForDelivery(vault, rel, cache));
      expect(label).not.toMatch(/[\n\r\t]/);
      expect(label).not.toMatch(/["<>]/);
    }
  });
});
