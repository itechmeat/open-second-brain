/**
 * The egress consent stamp (write-honesty-egress-consent, Lane F).
 *
 * A stamp is a record of WHAT WOULD LEAVE the machine, made before
 * anything leaves. Two properties are asserted here and they are the
 * whole point of the primitive:
 *
 *   1. THE KILL SWITCH WINS. A machine whose operator set the kill
 *      switch refuses every stamp, whatever any other environment value
 *      says. There is no environment value that re-enables it, because a
 *      kill switch that could be talked out of by the next variable in
 *      the environment would not be one.
 *   2. A REFUSAL DISCLOSES THE PAYLOAD CLASS. An operator who is told
 *      "egress refused" learns nothing; an operator who is told "page
 *      bodies were withheld" can go and look at the thing that was
 *      withheld.
 *
 * The stamp is also where the redaction happens: a stamped payload has
 * been through the shared egress guard, so what the stamp carries is
 * what would ACTUALLY leave, not what the caller meant to send. No
 * egress destination is declared in this release, so the primitive
 * declares none: the caller names the site it is stamping for.
 *
 * Every credential-shaped value below is assembled at runtime by the
 * fake-credentials helper, so no source line carries a literal shaped
 * like a real one.
 */

import { describe, expect, test } from "bun:test";

import {
  CONSENT_STAMP_ENV,
  CONSENT_STAMP_GRANT_VALUES,
  CONSENT_STAMP_KILL_ENV,
  CONSENT_STAMP_OUTCOME,
  stampEgressConsent,
} from "../../src/core/egress/consent-stamp.ts";
import { REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";
import { FAKE_VENDOR_KEY } from "../helpers/fake-credentials.ts";

/** The class of content this fixture offers to the boundary. */
const PAYLOAD_CLASS = "vault page bodies";

/** The site the stamp is for. No destination is declared in this release. */
const SITE = "brain-export";

describe("the egress consent stamp", () => {
  test("the kill switch refuses every stamp, whatever the grant says", () => {
    // The matrix the brief names: the kill switch set, plus EVERY value
    // that would otherwise grant consent.
    for (const grant of CONSENT_STAMP_GRANT_VALUES) {
      const verdict = stampEgressConsent({
        site: SITE,
        payloadClass: PAYLOAD_CLASS,
        payload: { body: "a page body" },
        env: { [CONSENT_STAMP_ENV]: grant, [CONSENT_STAMP_KILL_ENV]: "1" },
      });
      expect(`${grant}: ${verdict.outcome}`).toBe(`${grant}: ${CONSENT_STAMP_OUTCOME.withheld}`);
    }
  });

  test("the kill switch refuses even when the grant is absent", () => {
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: { [CONSENT_STAMP_KILL_ENV]: "1" },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
  });

  test("the kill switch is a presence switch: no value re-enables it", () => {
    // Every non-empty value keeps the refusal in force, including the
    // ones that would read as "off" to a boolean parser and the ones
    // that are only whitespace - the raw value is what the operator set,
    // and nothing trims it away. An operator who has set the variable
    // has said no, and the next variable in the environment does not get
    // to say otherwise.
    for (const value of ["1", "true", "0", "false", "off", "please", " "]) {
      const verdict = stampEgressConsent({
        site: SITE,
        payloadClass: PAYLOAD_CLASS,
        payload: { body: "a page body" },
        env: { [CONSENT_STAMP_ENV]: "true", [CONSENT_STAMP_KILL_ENV]: value },
      });
      expect(`${value}: ${verdict.outcome}`).toBe(`${value}: ${CONSENT_STAMP_OUTCOME.withheld}`);
    }
  });

  test("a whitespace-only kill-switch value still refuses", () => {
    // Presence, not parse: the value is non-empty, so the switch is in
    // force even though trimming it would read as unset - the same
    // untrimmed presence rule the grant check applies to its own value.
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: { [CONSENT_STAMP_ENV]: "true", [CONSENT_STAMP_KILL_ENV]: "  " },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.withheld) return;
    expect(verdict.reason).toContain("kill switch");
  });

  test("a refusal discloses the payload class", () => {
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: { [CONSENT_STAMP_KILL_ENV]: "1" },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.withheld) return;
    expect(verdict.detail).toContain(PAYLOAD_CLASS);
    expect(verdict.reason).toContain(PAYLOAD_CLASS);
    expect(verdict.detail.trim().length).toBeGreaterThan(0);
  });

  test("a grant with no kill switch issues a stamp", () => {
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: { [CONSENT_STAMP_ENV]: "true" },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.stamped);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.stamped) return;
    expect(verdict.payload).toEqual({ body: "a page body" });
    expect(verdict.redacted).toBe(false);
  });

  test("no grant is a refusal, not a silent stamp", () => {
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: {},
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.withheld) return;
    expect(verdict.reason).toContain(CONSENT_STAMP_ENV);
  });

  test("a set-but-unrecognized grant value is named, not told to set what is already set", () => {
    // "no egress consent is recorded; set X to grant it" is a false
    // sentence when the variable IS set: the operator would re-run the
    // instruction that already failed. The refusal names the value as
    // the problem and lists what grants.
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: "a page body" },
      env: { [CONSENT_STAMP_ENV]: "yes" },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.withheld) return;
    expect(verdict.reason).toContain("unrecognized");
    expect(verdict.reason).toContain(CONSENT_STAMP_ENV);
    for (const grant of CONSENT_STAMP_GRANT_VALUES) {
      expect(verdict.reason).toContain(grant);
    }
  });

  test("the stamped payload is the redacted one: what would leave, not what was meant to", () => {
    const verdict = stampEgressConsent({
      site: SITE,
      payloadClass: PAYLOAD_CLASS,
      payload: { body: `the key is ${FAKE_VENDOR_KEY}` },
      env: { [CONSENT_STAMP_ENV]: "true" },
    });
    expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.stamped);
    if (verdict.outcome !== CONSENT_STAMP_OUTCOME.stamped) return;
    expect(verdict.redacted).toBe(true);
    expect(JSON.stringify(verdict.payload)).not.toContain(FAKE_VENDOR_KEY);
    expect(JSON.stringify(verdict.payload)).toContain(REDACTION_PLACEHOLDER);
  });

  test("every refusal carries a non-empty reason and discloses the class", () => {
    const cases = [{ [CONSENT_STAMP_KILL_ENV]: "1" }, {}, { [CONSENT_STAMP_ENV]: "maybe" }];
    for (const env of cases) {
      const verdict = stampEgressConsent({
        site: SITE,
        payloadClass: PAYLOAD_CLASS,
        payload: { body: "a page body" },
        env,
      });
      expect(verdict.outcome).toBe(CONSENT_STAMP_OUTCOME.withheld);
      if (verdict.outcome !== CONSENT_STAMP_OUTCOME.withheld) return;
      expect(verdict.reason.trim().length).toBeGreaterThan(0);
      expect(verdict.reason).toContain(PAYLOAD_CLASS);
    }
  });
});
