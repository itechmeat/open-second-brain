/**
 * `o2b state status` - the CLI half of the in-vault state inventory.
 *
 * The property worth asserting here is not the report's content, which
 * `tests/core/state/surfaces.test.ts` owns, but that the two streams are
 * two views of ONE value: every surface the JSON carries is named by the
 * human text, and neither stream is assembled in this layer.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  STATE_REACHABILITY,
  STATE_SURFACES,
  type StateInventory,
} from "../../src/core/state/surfaces.ts";
import { runCli } from "../helpers/run-cli.ts";

function tempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "osb-state-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  return vault;
}

async function statusJson(vault: string, env: Record<string, string> = {}) {
  const r = await runCli(["state", "status", "--vault", vault, "--json"], { env });
  expect(r.stderr).toBe("");
  expect(r.returncode).toBe(0);
  return JSON.parse(r.stdout) as StateInventory;
}

describe("o2b state status", () => {
  test("reports one row per declared surface, with a verdict and an origin", async () => {
    const vault = tempVault();
    const payload = await statusJson(vault);
    expect(payload.vault).toBe(vault);
    expect(payload.surfaces.length).toBe(STATE_SURFACES.length);
    const incomplete = payload.surfaces
      .filter((s) => s.reachability.state === undefined || s.origin === undefined)
      .map((s) => s.id);
    expect(incomplete.join("\n")).toBe("");
  });

  test("a surface that exists is present and one that does not is absent", async () => {
    const vault = tempVault();
    const lease = STATE_SURFACES.find((s) => s.id === "maintenance_lease")!.derive(vault, null);
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(lease, "", "utf8");
    const payload = await statusJson(vault);
    const byId = new Map(payload.surfaces.map((s) => [s.id, s]));
    expect(byId.get("maintenance_lease")!.reachability.state).toBe(STATE_REACHABILITY.present);
    expect(byId.get("watchdog_audit")!.reachability.state).toBe(STATE_REACHABILITY.absent);
  });

  test("an environment override moves the path and is reported as its origin", async () => {
    const vault = tempVault();
    const payload = await statusJson(vault, {
      OPEN_SECOND_BRAIN_SEARCH_DB: join(vault, "elsewhere", "brain.sqlite"),
    });
    const index = payload.surfaces.find((s) => s.id === "search_index")!;
    expect(index.path).toBe(join(vault, "elsewhere", "brain.sqlite"));
    expect(index.origin).toBe("env");
  });

  test("the human stream names every surface the JSON stream carries", async () => {
    // One value, two renderings. A hand-written second copy is exactly
    // what drifts, so the human text is checked against the machine one.
    const vault = tempVault();
    const payload = await statusJson(vault);
    const human = await runCli(["state", "status", "--vault", vault]);
    expect(human.returncode).toBe(0);
    const unnamed = payload.surfaces
      .filter((s) => !human.stdout.includes(s.label) || !human.stdout.includes(s.path))
      .map((s) => s.id);
    expect(unnamed.join("\n")).toBe("");
  });

  test("an unknown state verb is a usage error, not a silent success", async () => {
    const r = await runCli(["state", "no-such-verb"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown state verb");
    expect(r.stderr).toContain("o2b state status");
  });

  test("state with no verb prints its usage and refuses", async () => {
    const r = await runCli(["state"]);
    expect(r.returncode).toBe(2);
    expect(r.stdout).toContain("o2b state status");
  });
});
