/**
 * `o2b brain session <op>` (Agent Write Contract Suite, t_bc36a8a2):
 * the CLI face of the write-session kernel. Envelopes are printed as
 * JSON with `--json` (the machine contract shared with the MCP tool);
 * the human rendering stays one-line-per-fact.
 *
 * Exit codes: 0 on an accepted operation, 1 when the envelope reports
 * a non-advancing state (needs-correction / failed) or the request was
 * structurally rejected, 2 on usage errors.
 */

import { readFileSync } from "node:fs";

import {
  WriteSessionRequestError,
  abandonSession,
  approveSession,
  openArtifactSession,
  sessionEnvelope,
} from "../../../core/brain/write-session/engine.ts";
import { dispatchSubmit } from "../../../core/brain/write-session/panel.ts";
import {
  listWriteSessions,
  readWriteSession,
  sweepWriteSessions,
} from "../../../core/brain/write-session/store.ts";
import type {
  WriteSessionEnvelope,
  WriteSessionIntent,
} from "../../../core/brain/write-session/types.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain session <open|submit|approve|abandon|status|list|sweep> " +
  "[<session-id>] [--target T] [--file F] [--schema-type S] [--intent create|overwrite|merge] " +
  "[--prompt P] [--require-review] [--retry-cap N] [--agent A] [--vault V] [--json]";

function renderEnvelope(env: WriteSessionEnvelope, asJson: boolean): void {
  if (asJson) {
    // Spread: the readonly envelope interface has no index signature,
    // so it is not assignable to okJson's Record parameter directly.
    okJson({ ...env });
    return;
  }
  ok(`session: ${env.session_id} (${env.kind})`);
  ok(`status: ${env.status}`);
  ok(`step: ${env.step}`);
  ok(`target: ${env.target_path}`);
  ok(`attempts left: ${env.attempts_left}`);
  for (const e of env.errors) ok(`error: [${e.code}] ${e.path}: ${e.message}`);
}

/** Mutating ops exit 1 when the envelope reports a non-advancing state. */
function emitEnvelope(env: WriteSessionEnvelope, asJson: boolean): number {
  renderEnvelope(env, asJson);
  return env.status === "needs-correction" || env.status === "failed" ? 1 : 0;
}

function emitRequestError(err: WriteSessionRequestError, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message: err.message, errors: err.errors });
    return 1;
  }
  return fail(
    err.errors.length > 0
      ? `${err.message} (${err.errors.map((e) => e.code).join(", ")})`
      : err.message,
  );
}

/** JSON-mode callers get JSON on EVERY failure path, not just envelopes. */
function emitCliError(message: string, asJson: boolean): number {
  if (asJson) {
    okJson({ ok: false, message });
    return 1;
  }
  return fail(message);
}

function readBody(fileFlag: string | undefined): string {
  if (fileFlag !== undefined && fileFlag !== "-") {
    return readFileSync(fileFlag, "utf8");
  }
  // `--file -` or no flag: read stdin synchronously (agents pipe bodies).
  return readFileSync(0, "utf8");
}

export async function cmdBrainSession(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    target: { type: "string" },
    file: { type: "string" },
    prompt: { type: "string" },
    agent: { type: "string" },
    intent: { type: "string" },
    "schema-type": { type: "string" },
    "require-review": { type: "boolean" },
    "retry-cap": { type: "string" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  const { config, vault } = brainVerbContext(flags);

  try {
    switch (op) {
      case "open": {
        const target = flags["target"] as string | undefined;
        if (!target) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const intentRaw = (flags["intent"] as string | undefined) ?? "create";
        if (intentRaw !== "create" && intentRaw !== "overwrite" && intentRaw !== "merge") {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const retryCapRaw = flags["retry-cap"] as string | undefined;
        const env = openArtifactSession(vault, {
          agent: resolveBrainAgent(flags, config),
          targetPath: target,
          intent: intentRaw as WriteSessionIntent,
          requireReview: flags["require-review"] === true,
          ...(flags["prompt"] ? { prompt: String(flags["prompt"]) } : {}),
          ...(flags["schema-type"] ? { schemaType: String(flags["schema-type"]) } : {}),
          ...(retryCapRaw !== undefined ? { retryCap: Number(retryCapRaw) } : {}),
        });
        return emitEnvelope(env, asJson);
      }
      case "submit": {
        const id = positional[1];
        if (!id) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const env = dispatchSubmit(vault, {
          sessionId: id,
          text: readBody(flags["file"] as string | undefined),
        });
        return emitEnvelope(env, asJson);
      }
      case "approve":
      case "abandon": {
        const id = positional[1];
        if (!id) {
          process.stderr.write(`${USAGE}\n`);
          return 2;
        }
        const env =
          op === "approve"
            ? approveSession(vault, { sessionId: id })
            : abandonSession(vault, { sessionId: id });
        return emitEnvelope(env, asJson);
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
        // A status QUERY always exits 0 - the envelope carries the state.
        renderEnvelope(sessionEnvelope(probe.session), asJson);
        return 0;
      }
      case "list": {
        const sessions = listWriteSessions(vault, new Date().toISOString());
        if (asJson) {
          okJson({ sessions: sessions.map((s) => sessionEnvelope(s)) });
          return 0;
        }
        if (sessions.length === 0) {
          ok("no write-sessions");
          return 0;
        }
        for (const s of sessions) {
          ok(`${s.id}  ${s.kind}  ${s.status}  ${s.targetPath}`);
        }
        return 0;
      }
      case "sweep": {
        const res = sweepWriteSessions(vault, new Date().toISOString());
        if (asJson) {
          okJson({ removed: res.removed, kept: res.kept });
          return 0;
        }
        ok(`sweep: ${res.removed} removed, ${res.kept} kept`);
        return 0;
      }
      default: {
        process.stderr.write(`${USAGE}\n`);
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof WriteSessionRequestError) {
      return emitRequestError(err, asJson);
    }
    return emitCliError(err instanceof Error ? err.message : String(err), asJson);
  }
}
