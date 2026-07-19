/**
 * Full-page extract step (R1, t_1dcbf352). The step fetches page text through
 * the keyed helper and hands it to the existing citation-constrained pipeline,
 * never inventing content: the finding statement is drawn only from the fetched
 * text and cites the fetched URL. HTTP is mocked at the transport boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  type ExternalFetchResponse,
  type ExternalFetchTransport,
} from "../../../../src/core/brain/research/external-fetch.ts";
import { extractPage, findingFromExtract } from "../../../../src/core/brain/research/extract.ts";
import { writeResearchReport } from "../../../../src/core/brain/research/research.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-extract-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function textResponse(html: string): ExternalFetchResponse {
  return { ok: true, status: 200, json: async () => ({}), text: async () => html };
}

function transportOf(res: ExternalFetchResponse): ExternalFetchTransport {
  return async () => res;
}

const HTML =
  "<html><head><style>.x{}</style><script>bad()</script></head>" +
  "<body><h1>Restaking</h1><p>Slashing risk compounds across AVSs.</p></body></html>";

describe("extractPage", () => {
  test("strips markup and script/style content into plain text", async () => {
    const page = await extractPage(
      { apiKey: "k", transport: transportOf(textResponse(HTML)) },
      "https://a.example/1",
    );
    expect(page.url).toBe("https://a.example/1");
    expect(page.text).toContain("Slashing risk compounds across AVSs");
    expect(page.text).not.toContain("bad()");
    expect(page.text).not.toContain("<p>");
  });
});

describe("findingFromExtract feeds the citation-constrained pipeline", () => {
  test("the finding cites the fetched URL and carries only fetched text", async () => {
    const page = await extractPage(
      { apiKey: "k", transport: transportOf(textResponse(HTML)) },
      "https://a.example/1",
    );
    const finding = findingFromExtract(page);
    expect(finding.sources).toEqual(["https://a.example/1"]);
    expect(page.text).toContain(finding.statement.slice(0, 20));

    const res = writeResearchReport(
      vault,
      { title: "Extract survey", sources: [page.url], findings: [finding] },
      { agent: "claude", now: new Date("2026-06-13T12:00:00Z") },
    );
    const md = readFileSync(join(vault, res.reportPath), "utf8");
    expect(md).toContain("Slashing risk compounds across AVSs");
    expect(md).toContain("https://a.example/1");
  });
});
