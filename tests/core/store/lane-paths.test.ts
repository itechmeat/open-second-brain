/**
 * Lane entry ids and legacy paths (`store/lane-paths.ts`, design D14 item
 * 2): every path the mapping accepts turns back into itself (so no two
 * paths share an entry), and a name that would not round-trip is refused.
 */
import { describe, expect, test } from "bun:test";

import {
  brainRelOfEntry,
  laneNameRefusal,
  lanePlaceOf,
} from "../../../src/core/store/lane-paths.ts";

/** Paths that name an entry: every row of the lane path table, and every kept extension. */
const ACCEPTED = [
  "about.md",
  "lexicon.json",
  "standing-rules.md",
  "dead-ends/de-x.md",
  "dead-ends/archive/de-x.md",
  "entities/lexicon.json",
  "entities/rows.jsonl",
  "entities/schema.yaml",
  "entities/schema.yml",
  "entities/notes.txt",
  "entities/view.base",
  "entities/table.csv",
  "state/exact.md",
  "skill-benchmarks/bench.md",
  "standing-rules/team.md",
  ".sessions/s-1.json",
  ".archives/src.txt",
  // A page whose name without `.md` reads as a kept file keeps its whole name.
  "entities/x.json.md",
  "entities/x.md.md",
  "x.yaml.md",
];

/** Paths that would not map back to themselves. */
const REFUSED = [
  // An extension that is neither a page nor a kept file, or none.
  "entities/x.png",
  "entities/README",
  "image.png",
  // A top folder that is not a lane name, or is another folder's lane name.
  "My Notes/x.md",
  "exact-state/exact.md",
  "skill-benchmark/bench.md",
  "standing-rule/team.md",
  "write-session/s-1.json",
  "brain/about.md",
  // The place of a root file with a lane.
  "standing-rules/standing-rules.md",
  // An entry with no name.
  "entities/.md",
];

describe("lane entry ids and legacy paths", () => {
  test("every accepted path maps to an entry and back to itself", () => {
    for (const path of ACCEPTED) {
      const place = lanePlaceOf(path);
      expect({ path, place: place !== null }).toEqual({ path, place: true });
      expect(brainRelOfEntry(place!.lane, place!.entry)).toBe(path);
      expect(laneNameRefusal(path)).toBeNull();
    }
  });

  test("a page and a kept file of one name are two entries", () => {
    expect(lanePlaceOf("entities/x.json")).toEqual({ lane: "entities", entry: "x.json" });
    expect(lanePlaceOf("entities/x.json.md")).toEqual({ lane: "entities", entry: "x.json.md" });
  });

  test("a name that does not round-trip is refused, with the reason", () => {
    for (const path of REFUSED) {
      expect({ path, place: lanePlaceOf(path) }).toEqual({ path, place: null });
      expect(laneNameRefusal(path)).toContain(path);
    }
    expect(laneNameRefusal("exact-state/exact.md")).toContain("state/exact.md");
  });

  test("the Brain root names no entry", () => {
    expect(lanePlaceOf("")).toBeNull();
    expect(laneNameRefusal("")).not.toBeNull();
  });
});
