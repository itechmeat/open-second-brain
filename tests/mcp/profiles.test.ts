import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOOL_SURFACE_PROFILES,
  resolveToolSurface,
  toolSurfaceProfileNames,
} from "../../src/mcp/profiles.ts";
import { resolveMcpToolProfile } from "../../src/core/config.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { evaluateToolCapabilities } from "../../src/mcp/capabilities.ts";

test("the five named profiles exist", () => {
  expect(toolSurfaceProfileNames().toSorted()).toEqual([
    "catalog",
    "full",
    "minimal",
    "recall",
    "writer",
  ]);
});

test("full profile resolves to the unrestricted surface", () => {
  const surface = resolveToolSurface({ profileName: "full" });
  expect(surface.scope).toBe("full");
  expect(surface.window).toBeUndefined();
  expect(surface.unknownProfile).toBeUndefined();
});

test("catalog profile resolves to the catalog scope with no window", () => {
  const surface = resolveToolSurface({ profileName: "catalog" });
  expect(surface.scope).toBe("catalog");
  expect(surface.window).toBeUndefined();
});

test("recall profile keeps the memory surface and withholds admin tools", () => {
  const surface = resolveToolSurface({ profileName: "recall" });
  expect(surface.scope).toBe("full");
  const evaluated = evaluateToolCapabilities(buildToolTable(surface.scope), {
    scope: surface.scope,
    serverName: "test",
    ...(surface.window ? { window: surface.window } : {}),
  });
  const names = evaluated.tools.map((t) => t.name);
  expect(names).toContain("second_brain_capabilities");
  expect(names).toContain("brain_search");
  expect(names).toContain("brain_context_pack");
  expect(names).toContain("brain_feedback");
  expect(names).not.toContain("schema_apply_mutations");
  expect(names).not.toContain("payment_memory_init");
  const withheld = evaluated.report.withheld.map((w) => w.name);
  expect(withheld).toContain("schema_apply_mutations");
});

test("minimal profile is the floor: writers, context, search, diagnostic", () => {
  const surface = resolveToolSurface({ profileName: "minimal" });
  const evaluated = evaluateToolCapabilities(buildToolTable(surface.scope), {
    scope: surface.scope,
    serverName: "test",
    ...(surface.window ? { window: surface.window } : {}),
  });
  const names = evaluated.tools.map((t) => t.name).toSorted();
  expect(names).toEqual([
    "brain_apply_evidence",
    "brain_context",
    "brain_feedback",
    "brain_note",
    "brain_pinned_context",
    "brain_search",
    "second_brain_capabilities",
  ]);
});

test("an unknown profile fails OPEN to the full surface and reports the name", () => {
  const surface = resolveToolSurface({ profileName: "typo-profile" });
  expect(surface.scope).toBe("full");
  expect(surface.window).toBeUndefined();
  expect(surface.unknownProfile).toBe("typo-profile");
});

test("no profile name resolves to explicit flags or the default full surface", () => {
  expect(resolveToolSurface({}).scope).toBe("full");
  expect(resolveToolSurface({ explicitScope: "writer" }).scope).toBe("writer");
});

test("an explicit scope wins over the profile scope", () => {
  const surface = resolveToolSurface({ profileName: "catalog", explicitScope: "full" });
  expect(surface.scope).toBe("full");
});

test("explicit window fields override profile window fields", () => {
  const surface = resolveToolSurface({
    profileName: "minimal",
    explicitWindow: { allowedTools: ["brain_feedback"] },
  });
  expect(surface.window?.allowedTools).toEqual(["brain_feedback"]);
});

test("every named profile is defined with a description", () => {
  for (const profile of Object.values(TOOL_SURFACE_PROFILES)) {
    expect(profile.description.length).toBeGreaterThan(0);
  }
});

// ── config key ───────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-profile-cfg-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("resolveMcpToolProfile reads mcp_tool_profile from config", () => {
  const config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${tmp}"\nmcp_tool_profile: "recall"\n`);
  expect(resolveMcpToolProfile(config)).toBe("recall");
});

test("resolveMcpToolProfile returns null when absent or config missing", () => {
  const config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${tmp}"\n`);
  expect(resolveMcpToolProfile(config)).toBeNull();
  expect(resolveMcpToolProfile(join(tmp, "ghost.yaml"))).toBeNull();
});
