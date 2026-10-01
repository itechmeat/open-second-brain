/**
 * Config-only health of the optional cross-encoder rerank.
 *
 * Rerank fails closed by contract when it is enabled and its endpoint
 * does not resolve (`rerank/index.ts`, invariant 2): every search throws
 * a typed `SearchError`. That is the right behaviour at query time and a
 * late way to learn about a missing key, so this check says it first,
 * from the configuration alone. It also reads the rerank decommission
 * survey, the same way `embedding-sunset-check.ts` reads the embedding
 * one, so a model whose retirement is announced is named before search
 * starts skipping it (`rerank-model-sunset` in the retrieval trail).
 *
 * ## No network, by design
 *
 * Endpoint liveness is a query-time fact and is already reported there,
 * per answer, as `rerank-provider-unavailable` with a typed category. A
 * doctor probe would spend provider budget on every run, send a request
 * an operator did not ask for, and report a state that is stale the
 * moment the pass ends. So the check proves configuration only: the
 * three endpoint fields resolve to non-blank values, the base URL carries
 * no `user:password@` part and passes the endpoint rule the provider
 * applies (shape only), the key variable is set and not blank, a provider
 * name that left a field empty is named, and the survey's answer for the
 * model.
 *
 * ## Scope
 *
 * Only an enabled rerank of kind `openai-compat`. Disabled is the default
 * and healthy. `local` needs no endpoint. `decision-model` resolves
 * through the decision-model config, which has its own check
 * (`o2b decision-model check`), and neither kind carries a model string
 * the survey could be keyed on.
 */

import { discoverConfig } from "../../config.ts";
import { assertHttpEgressEndpoint } from "../../search/embeddings/http-util.ts";
import { resolveSearchConfig } from "../../search/index.ts";
import {
  EMBEDDING_SUNSET,
  EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS,
  EMBEDDING_SUNSET_UNDETERMINED_REASON,
  type EmbeddingSunsetSurvey,
  type EmbeddingSunsetVerdict,
} from "../../search/embeddings/sunset.ts";
import { loadRerankRegistry } from "../../search/rerank/registry.ts";
import { classifyRerankSunset, RERANK_SUNSET_SURVEY } from "../../search/rerank/sunset.ts";
import type { ResolvedRerankConfig } from "../../search/types.ts";
import { envOrConfig } from "../../validate.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { EMBEDDING_SUNSET_WARNING_WINDOW_DAYS } from "./embedding-sunset-check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** An enabled remote rerank whose endpoint cannot resolve. */
export const RERANK_ENDPOINT_UNCONFIGURED_CODE = "rerank-endpoint-unconfigured";

/** The configured rerank model has an announced decommission date inside the window. */
export const RERANK_MODEL_SUNSET_ANNOUNCED_CODE = "rerank-model-sunset-announced";

/** The configured rerank model is outside the survey; no statement was made. */
export const RERANK_MODEL_SUNSET_UNSURVEYED_CODE = "rerank-model-sunset-unsurveyed";

/** The check ran and reached no sunset verdict; the message says why. */
export const RERANK_MODEL_SUNSET_UNDETERMINED_CODE = "rerank-model-sunset-undetermined";

/** The only rerank kind that resolves a remote endpoint keyed on a model string. */
const REMOTE_RERANK_KIND: ResolvedRerankConfig["kind"] = "openai-compat";

/** The config keys an operator edits, named in the findings verbatim. */
const BASE_URL_KEY = "search_rerank_base_url";
const MODEL_KEY = "search_rerank_model";
const ENV_KEY_KEY = "search_rerank_env_key";
const PROVIDER_KEY = "search_rerank_provider";
const ALLOW_INSECURE_HTTP_KEY = "search_rerank_allow_insecure_http";
/** The environment override of {@link PROVIDER_KEY}, read the way the resolver reads it. */
const PROVIDER_ENV = "OPEN_SECOND_BRAIN_SEARCH_RERANK_PROVIDER";

/** Why every rerank-enabled search fails while the endpoint is unresolved. */
const FAIL_CLOSED =
  "rerank is enabled with the openai-compat kind, so every search resolves this endpoint and " +
  "fails while it cannot";

/**
 * The provider name the configuration carries, or null.
 *
 * Read with the resolver's own precedence (environment over config file)
 * and the resolver's own config source: no file when the pass names no
 * config path, exactly as `resolveSearchConfig` does, so the two can never
 * disagree about which name is in force.
 */
function configuredProviderName(configPath: string | undefined): string | null {
  const config = configPath ? discoverConfig(configPath).data : {};
  return envOrConfig(process.env, config, PROVIDER_ENV, PROVIDER_KEY);
}

/**
 * Whether `value` is absent for the runtime: null, empty or whitespace.
 * The endpoint resolver rejects a blank string the same way it rejects a
 * missing one, so a variable exported as `RERANK_KEY=` is a gap here too.
 */
function blank(value: string | null): boolean {
  return (value ?? "").trim() === "";
}

/**
 * The fixed finding for a base URL that carries `user:password@`. The key
 * travels in a header from {@link ENV_KEY_KEY}, and the endpoint rule's
 * own refusal repeats the raw URL, so the URL is never echoed here.
 */
const CREDENTIALED_BASE_URL =
  `${BASE_URL_KEY} must not carry user:password@ credentials; the key is sent in a header ` +
  `from ${ENV_KEY_KEY}`;

/** Whether `baseUrl` parses and names a username or a password. */
function carriesCredentials(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Not a URL at all: the endpoint rule names that itself, and a string
    // it cannot parse has no userinfo part to strip.
    return false;
  }
  return parsed.username !== "" || parsed.password !== "";
}

/** Stands in for the configured base URL wherever a refusal would repeat it. */
const BASE_URL_PLACEHOLDER = `<${BASE_URL_KEY}>`;

/**
 * Why `baseUrl` would be refused by the endpoint rule the rerank provider
 * applies at construction (`assertHttpEgressEndpoint`), or null when it is
 * accepted. No request is sent; the rule reads the URL's shape only. The
 * rule's message repeats the raw value, and a string the URL parser rejects
 * (or one without a scheme) can still carry `user:password@` that
 * {@link carriesCredentials} cannot see, so every occurrence of the value is
 * replaced with {@link BASE_URL_PLACEHOLDER} and the rest of the message kept.
 */
function baseUrlRefusal(rerank: ResolvedRerankConfig, baseUrl: string): string | null {
  // The opt-out admits any parseable http URL; answer that here so the
  // runtime's once-per-process plain-http warning is not spent by doctor.
  if (rerank.allowInsecureHttp === true) {
    try {
      if (new URL(baseUrl).protocol === "http:") return null;
    } catch {
      // Not a URL: fall through, the rule names it.
    }
  }
  try {
    assertHttpEgressEndpoint(baseUrl, BASE_URL_KEY, {
      allowInsecureHttp: rerank.allowInsecureHttp === true,
      key: ALLOW_INSECURE_HTTP_KEY,
    });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split(baseUrl).join(BASE_URL_PLACEHOLDER);
  }
}

/** Every reason the endpoint cannot resolve, in the order an operator fixes them. */
function endpointGaps(rerank: ResolvedRerankConfig, ctx: DoctorCheckContext): string[] {
  const gaps: string[] = [];
  if (rerank.baseUrl === null || blank(rerank.baseUrl)) {
    gaps.push(`${BASE_URL_KEY} is not set`);
  } else if (carriesCredentials(rerank.baseUrl)) {
    gaps.push(CREDENTIALED_BASE_URL);
  } else {
    const refusal = baseUrlRefusal(rerank, rerank.baseUrl);
    if (refusal !== null) gaps.push(refusal);
  }
  if (blank(rerank.model)) gaps.push(`${MODEL_KEY} is not set`);
  if (blank(rerank.envKey)) {
    gaps.push(`${ENV_KEY_KEY} is not set, so no API key can be read`);
  } else if (blank(rerank.apiKey)) {
    gaps.push(`the environment variable ${rerank.envKey} named by ${ENV_KEY_KEY} is not set`);
  }
  // An unregistered provider name matters only when it is why a field is
  // empty: the explicit search_rerank_* values win over a profile, so with
  // all of them set search works and the name is no endpoint gap. A
  // profile carries the base URL, the model and the key variable, never
  // the key itself, so an unset key value is not the name's doing.
  if (!blank(rerank.baseUrl) && !blank(rerank.model) && !blank(rerank.envKey)) return gaps;
  const provider = configuredProviderName(ctx.configPath);
  if (provider !== null && !loadRerankRegistry(ctx.vault).some((p) => p.name === provider)) {
    gaps.unshift(
      `${PROVIDER_KEY} names ${provider}, which no registered rerank profile carries, so its ` +
        "base URL, model and key variable were not applied",
    );
  }
  return gaps;
}

/** The provenance clause every sunset message carries. */
function provenance(verdict: EmbeddingSunsetVerdict): string {
  return `this rests on the rerank decommission survey last reviewed ${verdict.surveyed_at}, which records model strings and identifies nobody's endpoint`;
}

function announcedMessage(verdict: EmbeddingSunsetVerdict): string {
  const days = verdict.days_remaining ?? 0;
  const when =
    days < 0
      ? `passed ${Math.abs(days)} days ago, so search no longer sends it rerank requests and keeps the heuristic order`
      : `${days} days away, inside the ${EMBEDDING_SUNSET_WARNING_WINDOW_DAYS}-day window`;
  return (
    `the configured rerank model ${verdict.model} has an announced decommission date of ` +
    `${verdict.sunset_at}, ${when}. Choose another rerank model or endpoint. Note ${provenance(verdict)}`
  );
}

function unsurveyedMessage(verdict: EmbeddingSunsetVerdict): string {
  return (
    `the configured rerank model ${verdict.model} is outside this build's rerank decommission ` +
    `survey (reviewed ${verdict.surveyed_at}), so NO sunset statement was made about it. That is ` +
    "not the same as no decommission having been announced - nobody here looked this model up"
  );
}

function undeterminedMessage(verdict: EmbeddingSunsetVerdict): string {
  switch (verdict.reason) {
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyStale:
      return (
        `the rerank decommission survey covers ${verdict.model} and records no announcement, but ` +
        `it was reviewed ${verdict.surveyed_at}, more than ${EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS} ` +
        "days ago. A negative is a claim about the world and it expires, so this build will not " +
        "report it as a clean bill of health"
      );
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyEntryMalformed:
      return (
        `the rerank decommission survey entry for ${verdict.model} carries a date this build ` +
        "cannot parse, so no verdict was reached. That is a defect in the shipped table rather " +
        "than in this vault"
      );
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.modelUnresolved:
      // Unreachable from `run`: a missing model is the endpoint finding
      // and the survey is never consulted for it. Kept as its own arm so
      // the switch stays total over the closed reason vocabulary.
      return `the configuration resolved no rerank model, so there was nothing to check. ${provenance(verdict)}`;
    case null:
      return `no verdict was reached for ${verdict.model}, and this build recorded no reason`;
  }
}

/**
 * Build the check against `survey`.
 *
 * A factory, following `makeEmbeddingSunsetCheck`: the survey is data the
 * check reads, so injecting it makes every verdict reachable from a test
 * without editing the shipped table.
 */
export function makeRerankHealthCheck(
  survey: EmbeddingSunsetSurvey = RERANK_SUNSET_SURVEY,
): DoctorCheck {
  return {
    failSoft: true,
    run(ctx: DoctorCheckContext, out: DoctorFindings): void {
      const path = ctx.configPath ?? ctx.vault;
      let rerank: ResolvedRerankConfig;
      try {
        rerank = resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath }).rerank;
      } catch (err) {
        pushUncertain(out.uncertain, {
          code: RERANK_MODEL_SUNSET_UNDETERMINED_CODE,
          path,
          message:
            "the search configuration could not be resolved, so neither the rerank endpoint nor " +
            `the rerank model's decommission state could be checked: ${
              err instanceof Error ? err.message : String(err)
            }`,
        });
        return;
      }
      if (!rerank.enabled || rerank.kind !== REMOTE_RERANK_KIND) return;

      const gaps = endpointGaps(rerank, ctx);
      if (gaps.length > 0) {
        out.issues.push({
          severity: "error",
          code: RERANK_ENDPOINT_UNCONFIGURED_CODE,
          path,
          target: rerank.model ?? "",
          message: `${FAIL_CLOSED}: ${gaps.join("; ")}`,
        } satisfies DoctorIssue);
      }
      // A missing model is already the finding above; consulting the
      // survey for it would meet the operator with two findings for one
      // condition.
      if (rerank.model === null || blank(rerank.model)) return;

      const verdict = classifyRerankSunset(rerank.model, ctx.now.getTime(), survey);
      switch (verdict.state) {
        case EMBEDDING_SUNSET.noneAnnounced:
          return;
        case EMBEDDING_SUNSET.announced:
          if ((verdict.days_remaining ?? 0) > EMBEDDING_SUNSET_WARNING_WINDOW_DAYS) return;
          out.issues.push({
            severity: "warning",
            code: RERANK_MODEL_SUNSET_ANNOUNCED_CODE,
            path,
            target: verdict.model ?? "",
            message: announcedMessage(verdict),
          } satisfies DoctorIssue);
          return;
        case EMBEDDING_SUNSET.unsurveyed:
          pushUncertain(out.uncertain, {
            code: RERANK_MODEL_SUNSET_UNSURVEYED_CODE,
            path,
            message: unsurveyedMessage(verdict),
          });
          return;
        case EMBEDDING_SUNSET.undetermined:
          pushUncertain(out.uncertain, {
            code: RERANK_MODEL_SUNSET_UNDETERMINED_CODE,
            path,
            message: undeterminedMessage(verdict),
          });
          return;
      }
    },
  };
}

/** The registered instance, reading the shipped survey. */
export const rerankHealthCheck: DoctorCheck = makeRerankHealthCheck();
