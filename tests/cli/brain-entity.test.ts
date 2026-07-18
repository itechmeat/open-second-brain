import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-entity-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

async function seed(): Promise<void> {
  const out = await runCli(
    [
      "brain",
      "entity",
      "set",
      "people",
      "Ada",
      "--alias",
      "the operator",
      "--body",
      "Vault operator.",
    ],
    { env: env() },
  );
  expect(out.returncode).toBe(0);
}

describe("o2b brain entity", () => {
  test("set creates and reports the entity id", async () => {
    const out = await runCli(["brain", "entity", "set", "people", "Ada", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["id"]).toBe("ent-people-ada");
    expect(payload["created"]).toBe(true);
  });

  test("get resolves by alias and prints the record", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "get", "the operator", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["id"]).toBe("ent-people-ada");
    expect(payload["name"]).toBe("Ada");
  });

  test("get returns exit 2 for an unknown entity", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "get", "nobody", "--json"], { env: env() });
    expect(out.returncode).toBe(2);
  });

  test("list filters by category", async () => {
    await seed();
    await runCli(["brain", "entity", "set", "projects", "Open Second Brain"], { env: env() });
    const out = await runCli(["brain", "entity", "list", "--category", "people", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { entities: Array<{ id: string }> };
    expect(payload.entities.map((e) => e.id)).toEqual(["ent-people-ada"]);
  });

  test("relate writes a typed relation", async () => {
    await seed();
    await runCli(["brain", "entity", "set", "projects", "Open Second Brain"], { env: env() });
    const out = await runCli(
      ["brain", "entity", "relate", "Ada", "related", "Open Second Brain", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { relations: Array<{ target: string }> };
    expect(payload.relations[0]!.target).toBe("ent-projects-open-second-brain");
  });

  test("archive and restore round-trip", async () => {
    await seed();
    const archived = await runCli(["brain", "entity", "archive", "Ada", "--json"], {
      env: env(),
    });
    expect(archived.returncode).toBe(0);
    expect((JSON.parse(archived.stdout) as Record<string, unknown>)["status"]).toBe("archived");

    const gone = await runCli(["brain", "entity", "get", "Ada"], { env: env() });
    expect(gone.returncode).toBe(2);

    const restored = await runCli(["brain", "entity", "archive", "Ada", "--restore", "--json"], {
      env: env(),
    });
    expect(restored.returncode).toBe(0);
    expect((JSON.parse(restored.stdout) as Record<string, unknown>)["status"]).toBe("active");
  });

  test("duplicate alias claim fails with a clear error", async () => {
    await seed();
    const out = await runCli(
      ["brain", "entity", "set", "people", "Imposter", "--alias", "the operator"],
      { env: env() },
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("alias");
  });

  test("set strips Markdown decoration from the stored name", async () => {
    const out = await runCli(["brain", "entity", "set", "projects", "**Mercury**", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["name"]).toBe("Mercury");
    expect(payload["id"]).toBe("ent-projects-mercury");
  });

  test("set rejects a structurally-junk name with a non-zero exit", async () => {
    const out = await runCli(["brain", "entity", "set", "people", "***"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("invalid entity label");
  });

  test("prune is dry-run by default and reports no candidates on a clean vault", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "prune", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { confirmed: boolean; candidates: unknown[] };
    expect(payload.confirmed).toBe(false);
    expect(payload.candidates).toEqual([]);
  });
});
