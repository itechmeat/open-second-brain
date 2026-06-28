import { test, expect } from "bun:test";

import {
  toolDescriptors,
  skillDescriptors,
  firstLine,
  surfaceGroup,
  type SurfaceDescriptor,
} from "../../../src/core/surface/descriptor.ts";

const TOOLS = [
  {
    name: "second_brain_status",
    description: "Report Open Second Brain configuration and vault status.",
  },
  {
    name: "brain_feedback",
    description: "Record one Brain taste signal.\nLong second line that must not leak.",
  },
  { name: "schema_inspect", description: "Inspect Brain schema vocabulary." },
  { name: "brain_search", description: "Hybrid keyword + semantic vault search." },
];

test("toolDescriptors emits one sorted descriptor per tool", () => {
  const out = toolDescriptors(TOOLS);
  expect(out.map((d) => d.name)).toEqual([
    "brain_feedback",
    "brain_search",
    "schema_inspect",
    "second_brain_status",
  ]);
  for (const d of out) expect(d.kind).toBe("tool");
});

test("descriptions are first-line only", () => {
  const out = toolDescriptors(TOOLS);
  const feedback = out.find((d) => d.name === "brain_feedback")!;
  expect(feedback.description).toBe("Record one Brain taste signal.");
});

test("surfaceGroup derives a group from the name prefix", () => {
  expect(surfaceGroup("brain_feedback")).toBe("brain");
  expect(surfaceGroup("schema_inspect")).toBe("schema");
  expect(surfaceGroup("second_brain_status")).toBe("core");
  expect(surfaceGroup("vault_health")).toBe("core");
});

test("skillDescriptors maps skill entries with the skill group", () => {
  const out = skillDescriptors([
    { name: "brain-memory", description: "Memory discipline skill.", path: "skills/brain-memory" },
    { name: "schema-author", description: "", path: "skills/schema-author" },
  ]);
  expect(out).toHaveLength(2);
  expect(out[0]!.kind).toBe("skill");
  expect(out[0]!.group).toBe("skill");
  expect(out[0]!.name).toBe("brain-memory");
});

test("skillDescriptors omits triggers tags unless includeTriggers is set", () => {
  const skills = [
    {
      name: "agent-search",
      description: "Search the web.",
      path: "skills/agent-search",
      triggers: "research lookup",
    },
  ];
  const off = skillDescriptors(skills);
  expect(off[0]!.tags).toEqual([]);
  const on = skillDescriptors(skills, true);
  expect(on[0]!.tags).toEqual(["research lookup"]);
});

test("skillDescriptors with includeTriggers still emits no tag for an empty triggers field", () => {
  const skills = [{ name: "bare", description: "No triggers.", path: "skills/bare", triggers: "" }];
  expect(skillDescriptors(skills, true)[0]!.tags).toEqual([]);
});

test("firstLine trims and collapses to the first non-empty line", () => {
  expect(firstLine("  hello world \n second")).toBe("hello world");
  expect(firstLine("\n\nlate start\nrest")).toBe("late start");
  expect(firstLine("")).toBe("");
});

test("descriptor list is frozen and deterministic across calls", () => {
  const a = toolDescriptors(TOOLS);
  const b = toolDescriptors(TOOLS);
  expect(a).toEqual(b);
  expect(Object.isFrozen(a)).toBe(true);
  const d: SurfaceDescriptor = a[0]!;
  expect(Object.isFrozen(d)).toBe(true);
});
