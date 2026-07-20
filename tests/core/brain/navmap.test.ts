import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildNavmap,
  deriveNavmap,
  renderNavmap,
  type Navmap,
} from "../../../src/core/brain/navmap.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-navmap-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("deriveNavmap", () => {
  test("maps graph stats into the navmap shape", () => {
    const navmap = deriveNavmap({
      documentCount: 128,
      nodeCount: 90,
      edgeCount: 342,
      topByDegree: [
        { path: "Brain/MOCs/projects.md", degree: 24 },
        { path: "Brain/MOCs/people.md", degree: 12 },
      ],
    });
    expect(navmap.documentCount).toBe(128);
    expect(navmap.edgeCount).toBe(342);
    expect(navmap.hubs).toEqual([
      { path: "Brain/MOCs/projects.md", degree: 24 },
      { path: "Brain/MOCs/people.md", degree: 12 },
    ]);
  });
});

describe("renderNavmap", () => {
  test("renders a deterministic, fenced structural block", () => {
    const navmap: Navmap = {
      documentCount: 128,
      nodeCount: 90,
      edgeCount: 342,
      hubs: [
        { path: "Brain/MOCs/projects.md", degree: 24 },
        { path: "Brain/MOCs/people.md", degree: 12 },
      ],
    };
    const first = renderNavmap(navmap);
    const second = renderNavmap(navmap);
    expect(first).toBe(second);
    expect(first).toContain("128");
    expect(first).toContain("342");
    expect(first).toContain("Brain/MOCs/projects.md");
    expect(first).toContain("24");
  });

  test("returns an empty string when there are no hubs (nothing to map)", () => {
    const navmap: Navmap = { documentCount: 3, nodeCount: 0, edgeCount: 0, hubs: [] };
    expect(renderNavmap(navmap)).toBe("");
  });

  test("neutralizes a hub path that smuggles a newline", () => {
    const navmap: Navmap = {
      documentCount: 1,
      nodeCount: 1,
      edgeCount: 1,
      hubs: [{ path: "Brain/evil\nInjected: line.md", degree: 2 }],
    };
    const rendered = renderNavmap(navmap);
    const bodyLines = rendered.split("\n").filter((l) => l.startsWith("- "));
    expect(bodyLines).toHaveLength(1);
  });
});

describe("buildNavmap", () => {
  test("returns null on a vault with no search index (fail-open)", async () => {
    const configPath = join(vault, "config.yaml");
    const navmap = await buildNavmap(vault, configPath);
    expect(navmap).toBeNull();
  });
});
