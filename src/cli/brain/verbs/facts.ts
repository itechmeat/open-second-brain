/**
 * `o2b brain facts decompose` (t_cbd22536): deterministic atomic-fact
 * decomposition of a file or inline text, with optional explicit
 * ledger ingest (`--ingest --entity E`) for assertions matching a
 * structured fact family. The capture hot path never calls this -
 * decomposition is an operator/agent-invoked step by design.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { readFileSync } from "node:fs";

import { decomposeAtomicFacts } from "../../../core/brain/atomic-facts.ts";
import { buildEntityIndex } from "../../../core/brain/entities/index-builder.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { claimsFromAssertion } from "../../../core/brain/truth/ingest.ts";
import { appendClaimEvent } from "../../../core/brain/truth/store.ts";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE =
  "usage: o2b brain facts decompose (--file <path> | --text <text>) " +
  "[--ingest --entity E] [--agent N] [--vault <path>] [--json]";

export async function cmdBrainFacts(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    file: { type: "string" },
    text: { type: "string" },
    ingest: { type: "boolean" },
    entity: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional[0] !== "decompose") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const asJson = flags["json"] === true;
  const filePath = flags["file"] as string | undefined;
  const inlineText = flags["text"] as string | undefined;
  if ((filePath === undefined) === (inlineText === undefined)) {
    process.stderr.write(`brain facts decompose: exactly one of --file or --text\n${USAGE}\n`);
    return 2;
  }
  const ingest = flags["ingest"] === true;
  const entity = (flags["entity"] as string | undefined)?.trim();
  if (ingest && (entity === undefined || entity === "")) {
    process.stderr.write(`brain facts decompose: --ingest requires --entity\n${USAGE}\n`);
    return 2;
  }
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  try {
    let text: string;
    let sourceRef: string;
    if (filePath !== undefined) {
      text = readFileSync(filePath, "utf8");
      sourceRef = `[[${filePath}]]`;
    } else {
      text = inlineText!;
      sourceRef = "[[inline-text]]";
    }

    let registryEntities: ReturnType<typeof buildEntityIndex>["entities"];
    try {
      registryEntities = buildEntityIndex(vault).entities;
    } catch {
      registryEntities = [];
    }
    const assertions = decomposeAtomicFacts(text, { entities: registryEntities });

    let ingested = 0;
    if (ingest) {
      const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);
      const ts = isoSecond(new Date());
      for (const assertion of assertions) {
        const claims = claimsFromAssertion(assertion, {
          entity: entity!,
          agent,
          ts,
          source: sourceRef,
        });
        for (const claim of claims) {
          appendClaimEvent(vault, claim);
          ingested++;
        }
      }
    }

    if (asJson) {
      okJson({ assertions, ...(ingest ? { ingested } : {}) });
    } else {
      ok(`assertions: ${assertions.length}${ingest ? `, ingested: ${ingested}` : ""}`);
      for (const a of assertions) {
        const heading = a.headingPath.length > 0 ? ` [${a.headingPath.join(" > ")}]` : "";
        ok(`  L${a.line} ${a.kind}${heading}: ${a.text}`);
      }
    }
    return 0;
  } catch (exc) {
    const message = `facts decompose failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
