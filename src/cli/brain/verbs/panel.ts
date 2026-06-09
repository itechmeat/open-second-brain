/**
 * `o2b brain panel <op>` (Agent Write Contract Suite, t_0cc6fdff):
 * convenience face of the decision-panel session kind. `open` takes
 * the topic as positional text; `submit`/`status` are sugar over the
 * shared session surface for panel-shaped sessions.
 */

import { readFileSync } from "node:fs";

import {
  WriteSessionRequestError,
  sessionEnvelope,
} from "../../../core/brain/write-session/engine.ts";
import { openPanelSession, submitToPanelSession } from "../../../core/brain/write-session/panel.ts";
import { readWriteSession } from "../../../core/brain/write-session/store.ts";
import type { WriteSessionEnvelope } from "../../../core/brain/write-session/types.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain panel <open <topic...>|submit <session-id>|status <session-id>> " +
  "[--personas a,b,c] [--target T] [--file F] [--require-review] [--agent A] [--vault V] [--json]";

function renderEnvelope(env: WriteSessionEnvelope, asJson: boolean): void {
  if (asJson) {
    // Spread: the readonly envelope interface has no index signature,
    // so it is not assignable to okJson's Record parameter directly.
    okJson({ ...env });
    return;
  }
  ok(`panel session: ${env.session_id}`);
  ok(`status: ${env.status}`);
  ok(`step: ${env.step}`);
  ok(`target: ${env.target_path}`);
  for (const e of env.errors) ok(`error: [${e.code}] ${e.path}: ${e.message}`);
  if (env.status === "needs-llm-step") {
    ok(`prompt: ${env.prompt}`);
  }
}

function exitCode(env: WriteSessionEnvelope): number {
  return env.status === "needs-correction" || env.status === "failed" ? 1 : 0;
}

/** JSON-mode callers get JSON on EVERY failure path, not just envelopes. */
function emitCliError(message: string, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message });
    return 1;
  }
  return fail(message);
}

export async function cmdBrainPanel(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    personas: { type: "string" },
    target: { type: "string" },
    file: { type: "string" },
    agent: { type: "string" },
    "require-review": { type: "boolean" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  const { config, vault } = brainVerbContext(flags);

  try {
    switch (op) {
      case "open": {
        const topic = positional.slice(1).join(" ").trim();
        if (!topic) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const personasFlag = flags["personas"] as string | undefined;
        const env = openPanelSession(vault, {
          agent: resolveBrainAgent(flags, config),
          topic,
          requireReview: flags["require-review"] === true,
          ...(personasFlag
            ? {
                personas: personasFlag
                  .split(",")
                  .map((p) => p.trim())
                  .filter((p) => p !== ""),
              }
            : {}),
          ...(flags["target"] ? { targetPath: String(flags["target"]) } : {}),
        });
        renderEnvelope(env, asJson);
        return exitCode(env);
      }
      case "submit": {
        const id = positional[1];
        if (!id) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const fileFlag = flags["file"] as string | undefined;
        const text =
          fileFlag !== undefined && fileFlag !== "-"
            ? readFileSync(fileFlag, "utf8")
            : readFileSync(0, "utf8");
        const env = submitToPanelSession(vault, { sessionId: id, text });
        renderEnvelope(env, asJson);
        return exitCode(env);
      }
      case "status": {
        const id = positional[1];
        if (!id) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const probe = readWriteSession(vault, id, new Date().toISOString());
        if (probe.error !== null) return emitCliError(probe.error, asJson);
        if (probe.session === null) {
          return emitCliError(`unknown write-session: ${id}`, asJson);
        }
        renderEnvelope(sessionEnvelope(probe.session), asJson);
        return 0;
      }
      default: {
        process.stderr.write(`${USAGE}\n`);
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof WriteSessionRequestError) {
      if (asJson) {
        okJson({ ok: false, message: err.message, errors: err.errors });
        return 1;
      }
      return fail(err.message);
    }
    return emitCliError(err instanceof Error ? err.message : String(err), asJson);
  }
}
