import { describe, expect, test } from "bun:test";
import {
  decidePublish,
  compareTagVersion,
  parseDistTagOutput,
  parseRegistryOutput,
} from "../../scripts/publish-plan.ts";

describe("publish plan", () => {
  test.each([
    [
      "manual run",
      "2.0.0",
      { eventName: "workflow_dispatch", refType: "branch", refName: "main" },
      "skip-not-a-tag",
      "",
    ],
    [
      "branch",
      "2.0.0",
      { eventName: "push", refType: "branch", refName: "main" },
      "skip-not-a-tag",
      "",
    ],
    [
      "disabled",
      "2.0.0",
      { eventName: "push", refType: "tag", refName: "v2.0.0", enabled: "no" },
      "skip-disabled",
      "latest",
    ],
    [
      "already published",
      "2.0.0",
      {
        eventName: "push",
        refType: "tag",
        refName: "v2.0.0",
        enabled: "enabled",
        registry: { versions: ["2.0.0"], latest: "2.0.0" },
      },
      "skip-already-published",
      "latest",
    ],
    [
      "prerelease",
      "2.1.0-rc.1",
      {
        eventName: "push",
        refType: "tag",
        refName: "v2.1.0-rc.1",
        enabled: "enabled",
        registry: { versions: [], latest: null },
      },
      "publish",
      "next",
    ],
    [
      "first version",
      "2.0.0",
      {
        eventName: "push",
        refType: "tag",
        refName: "v2.0.0",
        enabled: "enabled",
        registry: { versions: [], latest: null },
      },
      "publish",
      "latest",
    ],
    [
      "existing versions without latest tag",
      "1.9.1",
      {
        eventName: "push",
        refType: "tag",
        refName: "v1.9.1",
        enabled: "enabled",
        registry: { versions: ["1.9.0", "2.0.0-rc.1"], latest: null },
      },
      "publish",
      "latest",
    ],
    [
      "higher than latest",
      "2.1.0",
      {
        eventName: "push",
        refType: "tag",
        refName: "v2.1.0",
        enabled: "enabled",
        registry: { versions: ["2.0.0"], latest: "2.0.0" },
      },
      "publish",
      "latest",
    ],
    [
      "lower than latest",
      "2.0.5",
      {
        eventName: "push",
        refType: "tag",
        refName: "v2.0.5",
        enabled: "enabled",
        registry: { versions: ["2.1.0"], latest: "2.1.0" },
      },
      "publish",
      "release-2.x",
    ],
  ] as const)("%s", (_name, version, input, action, tag) => {
    const plan = decidePublish({ version, ...input } as never);
    expect(plan.action).toBe(action);
    expect(plan.tag).toBe(tag);
  });

  test("rejects tag mismatch, unreadable registry, and absent package while enabled", () => {
    expect(() => compareTagVersion("1.0.1", "v1.0.0")).toThrow("package version");
    expect(() =>
      decidePublish({
        version: "1.0.0",
        eventName: "push",
        refType: "tag",
        refName: "v1.0.0",
        enabled: "enabled",
        registry: { error: "unreadable" },
      }),
    ).toThrow("registry");
    expect(() =>
      decidePublish({
        version: "1.0.0",
        eventName: "push",
        refType: "tag",
        refName: "v1.0.0",
        enabled: "enabled",
        registry: { error: "missing" },
      }),
    ).toThrow("first version");
  });

  test("parses recorded npm client outputs", () => {
    expect(parseDistTagOutput("next: 2.0.0-rc.1\n")).toEqual({ version: "2.0.0-rc.1" });
    expect(parseDistTagOutput("")).toEqual({ error: "no-tags" });
    expect(parseRegistryOutput('{"versions":["1.0.0"],"dist-tags":{"latest":"1.0.0"}}')).toEqual({
      versions: ["1.0.0"],
      latest: "1.0.0",
    });
    expect(
      parseRegistryOutput('{"versions":["1.9.0","2.0.0-rc.1"],"dist-tags":{"next":"2.0.0-rc.1"}}'),
    ).toEqual({ versions: ["1.9.0", "2.0.0-rc.1"], latest: null });
    expect(parseRegistryOutput("", '{"error":{"code":"E404"}}')).toEqual({ error: "missing" });
    expect(parseRegistryOutput("not json", "not json")).toEqual({ error: "unreadable" });
  });
});
