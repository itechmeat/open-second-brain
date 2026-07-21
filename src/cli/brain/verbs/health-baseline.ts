import {
  HealthBaselineError,
  readHealthBaseline,
  writeHealthBaseline,
} from "../../../core/brain/health-baseline.ts";
import { isValidIsoInstant } from "../../../core/brain/health/iso-time.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
} from "../helpers.ts";

/**
 * `o2b brain health-baseline` - operate the acknowledge-before watermark
 * (`health.silence_before` in `_brain.yaml`).
 *
 * Subcommands:
 *   set <date>|now   record the watermark (date-only or full ISO instant)
 *   get              print the current watermark
 *   clear            remove the watermark
 *
 * The date is a positional argument (not a `--value` flag as in
 * `brain state`) because a single required value reads cleaner as
 * `set 2026-01-01` than `set --date 2026-01-01`. Setting only changes
 * what the semantic-health report surfaces; detection and stored memory
 * are untouched.
 */
export async function cmdBrainHealthBaseline(argv: string[]): Promise<number> {
  const sub = argv[0];
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  if (sub === "get") {
    const { vault } = brainVerbContext(flags);
    try {
      const baseline = readHealthBaseline(vault);
      if (json) okJson(baseline === null ? { present: false } : { present: true, baseline });
      else ok(baseline === null ? "no health baseline set" : baseline);
      return 0;
    } catch (exc) {
      return handleBaselineError("get", exc, json);
    }
  }

  if (sub === "set") {
    const raw = normalizeFlagString(positional[0]);
    if (raw === null) return usageError("brain health-baseline set requires a <date> or 'now'");
    const value = raw === "now" ? new Date().toISOString() : raw;
    if (!isValidIsoInstant(value)) {
      return usageError(
        `brain health-baseline set: not an ISO-8601 date (YYYY-MM-DD) or timestamp: ${raw}`,
      );
    }
    const { vault } = brainVerbContext(flags);
    try {
      writeHealthBaseline(vault, value);
      if (json) okJson({ baseline: value });
      else ok(`health baseline set to ${value}`);
      return 0;
    } catch (exc) {
      return handleBaselineError("set", exc, json);
    }
  }

  if (sub === "clear") {
    const { vault } = brainVerbContext(flags);
    try {
      const existed = readHealthBaseline(vault) !== null;
      writeHealthBaseline(vault, null);
      if (json) okJson({ cleared: existed });
      else ok(existed ? "health baseline cleared" : "no health baseline set");
      return 0;
    } catch (exc) {
      return handleBaselineError("clear", exc, json);
    }
  }

  return usageError(
    `brain health-baseline: unknown subcommand '${sub ?? ""}' (expected set|get|clear)`,
  );
}

/**
 * Surface a {@link HealthBaselineError} (or a config-load failure) as an
 * operational failure - the `{ ok: false, message }` envelope under
 * `--json`, otherwise a plain `fail()` line. Any other error is a genuine
 * bug and rethrown.
 */
function handleBaselineError(op: string, exc: unknown, json: boolean): number {
  if (exc instanceof HealthBaselineError || exc instanceof Error) {
    const message = `health-baseline ${op} failed: ${exc.message}`;
    if (json) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
  throw exc;
}
