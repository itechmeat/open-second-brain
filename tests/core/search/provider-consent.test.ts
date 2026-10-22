/**
 * The provider-consent resolver: UNSET is not DECLINED, and a record that
 * cannot be read is a decline (write-honesty-egress-consent, Lane F).
 *
 * The defect this file exists for: an operator who wrote
 * `search_semantic_enabled: false` and an operator who never configured
 * semantic search at all reached the SAME capability tier, so every surface
 * reported the same sentence for two opposite situations - one of them a
 * decision, the other an absence. The resolver separates them, and it does
 * so WITHOUT inventing a third "off" spelling: the capability tier still
 * answers what the configuration can do, and the consent answers only
 * whether the operator wrote a decline.
 *
 * The fail-closed arm is the other half: a consent record that cannot be
 * read is not a record of consent. Reading it as "unset" would turn a
 * broken config back into a silent default, which is the same defect the
 * config reader itself refuses elsewhere ("an unreadable config is not
 * consent to print host paths", `src/mcp/vault-path-field.ts`).
 *
 * No test here reaches the network, and none of them drops permission
 * bits: the unreadable fixture is a DIRECTORY in the config's place, which
 * every platform refuses the same way.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVIDER_CONSENT_KEY,
  PROVIDER_CONSENT_REENABLE_KEYS,
  PROVIDER_CONSENT_STATE,
  providerConsentIsDeclined,
  resolveProviderConsent,
} from "../../../src/core/search/provider-consent.ts";
import {
  resolveSemanticCapability,
  SEMANTIC_CAPABILITY_TIER,
} from "../../../src/core/search/capability-tier.ts";
import { BRAIN_CONFIG_TEMPLATE_OMISSIONS } from "../../../src/core/brain/config-template.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";

/** A resolved configuration with no provider named and the switch off. */
const UNSET_SEMANTIC: ResolvedEmbeddingConfig = Object.freeze({
  enabled: false,
  provider: "openai-compat",
  baseUrl: null,
  model: null,
  apiKey: null,
  dimension: null,
  timeoutMs: 10_000,
  concurrency: 4,
  batchSize: 32,
  costGateUsd: 0,
  maxRetries: 3,
});

/** A configuration that names the sentinel provider explicitly. */
const DECLINED_PROVIDER_SEMANTIC: ResolvedEmbeddingConfig = Object.freeze({
  ...UNSET_SEMANTIC,
  provider: "disabled",
});

/** A configuration with the switch on and a provider that needs a key. */
const KEYLESS_SEMANTIC: ResolvedEmbeddingConfig = Object.freeze({
  ...UNSET_SEMANTIC,
  enabled: true,
});

interface Fixture {
  readonly dir: string;
  readonly configPath: string;
  readonly cleanup: () => void;
}

/** A temporary directory with a config path inside it. */
function fixture(prefix: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `o2b-${prefix}-`));
  return {
    dir,
    configPath: join(dir, "config.yaml"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the provider-consent resolver", () => {
  test("a configuration that records no decision is UNSET, not declined", () => {
    const f = fixture("consent-unset");
    try {
      writeFileSync(f.configPath, 'vault: "/tmp/v"\n');
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.unset);
      expect(providerConsentIsDeclined(consent)).toBe(false);
      expect(consent.declineKeys).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("an ABSENT config file is UNSET: nothing was written, so nothing was declined", () => {
    const f = fixture("consent-absent");
    try {
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.unset);
    } finally {
      f.cleanup();
    }
  });

  test("search_semantic_enabled=false is an explicit decline", () => {
    const f = fixture("consent-semantic-off");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(providerConsentIsDeclined(consent)).toBe(true);
      expect(consent.declineKeys).toEqual([PROVIDER_CONSENT_KEY.semantic]);
    } finally {
      f.cleanup();
    }
  });

  test("embedding_provider=disabled is an explicit decline", () => {
    const f = fixture("consent-provider-disabled");
    try {
      writeFileSync(f.configPath, "embedding_provider: disabled\n");
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(consent.declineKeys).toEqual([PROVIDER_CONSENT_KEY.provider]);
    } finally {
      f.cleanup();
    }
  });

  test("both spellings at once are one decline carrying both keys", () => {
    const f = fixture("consent-both");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\nembedding_provider: disabled\n");
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(consent.declineKeys).toEqual([
        PROVIDER_CONSENT_KEY.semantic,
        PROVIDER_CONSENT_KEY.provider,
      ]);
    } finally {
      f.cleanup();
    }
  });

  test("the environment spelling records the same decline as the config spelling", () => {
    const f = fixture("consent-env");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: true\n");
      const consent = resolveProviderConsent({
        configPath: f.configPath,
        env: { OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "false" },
      });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(consent.declineKeys).toEqual([PROVIDER_CONSENT_KEY.semantic]);
    } finally {
      f.cleanup();
    }
  });

  test("a config value that cannot be read is a DECLINE, not an absence", () => {
    // A DIRECTORY in the config's place: the reader refuses a path that
    // exists and is not a regular file, on every platform, with no
    // permission bits involved.
    const f = fixture("consent-unreadable");
    try {
      mkdirSync(f.configPath, { recursive: true });
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(providerConsentIsDeclined(consent)).toBe(true);
      expect(consent.detail).toContain(PROVIDER_CONSENT_KEY.semantic);
    } finally {
      f.cleanup();
    }
  });

  test("a consent value that cannot be parsed is a DECLINE, not an absence", () => {
    const f = fixture("consent-unparseable");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: maybe\n");
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.declined);
      expect(consent.declineKeys).toEqual([PROVIDER_CONSENT_KEY.semantic]);
    } finally {
      f.cleanup();
    }
  });

  test("the resolver extends the capability tier instead of replacing it", () => {
    const f = fixture("consent-tier");
    try {
      writeFileSync(f.configPath, 'vault: "/tmp/v"\n');
      // The tier still answers what the configuration can do, and the
      // consent carries that same tier rather than a second ladder.
      const unset = resolveProviderConsent({
        configPath: f.configPath,
        env: {},
        semantic: KEYLESS_SEMANTIC,
      });
      expect(unset.capability?.tier).toBe(SEMANTIC_CAPABILITY_TIER.credentialMissing);
      expect(unset.capability?.tier).toBe(resolveSemanticCapability(KEYLESS_SEMANTIC).tier);
      // A declined configuration sits on the SAME disabled rung - the
      // consent adds a fact beside the tier, it does not invent a rung.
      writeFileSync(f.configPath, "embedding_provider: disabled\n");
      const declined = resolveProviderConsent({
        configPath: f.configPath,
        env: {},
        semantic: DECLINED_PROVIDER_SEMANTIC,
      });
      expect(declined.capability?.tier).toBe(SEMANTIC_CAPABILITY_TIER.disabled);
      expect(declined.capability?.tier).toBe(
        resolveSemanticCapability(DECLINED_PROVIDER_SEMANTIC).tier,
      );
      expect(declined.state).toBe(PROVIDER_CONSENT_STATE.declined);
    } finally {
      f.cleanup();
    }
  });

  test("a resolved configuration is not a witness: only the record is", () => {
    // A configuration that was ASSEMBLED rather than read - a fixture, an
    // override - names the sentinel provider without any operator having
    // written a decision down. Claiming a decline there would report a
    // decision the operator never made.
    const f = fixture("consent-assembled");
    try {
      writeFileSync(f.configPath, 'vault: "/tmp/v"\n');
      const consent = resolveProviderConsent({
        configPath: f.configPath,
        env: {},
        semantic: DECLINED_PROVIDER_SEMANTIC,
      });
      expect(consent.state).toBe(PROVIDER_CONSENT_STATE.unset);
      expect(consent.capability?.tier).toBe(SEMANTIC_CAPABILITY_TIER.disabled);
    } finally {
      f.cleanup();
    }
  });

  test("the refusal names the keys that would re-enable the provider", () => {
    const f = fixture("consent-reenable");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      const consent = resolveProviderConsent({ configPath: f.configPath, env: {} });
      for (const key of PROVIDER_CONSENT_REENABLE_KEYS) {
        expect(consent.detail).toContain(key);
      }
      expect(consent.reenableKeys).toEqual([
        PROVIDER_CONSENT_KEY.semantic,
        PROVIDER_CONSENT_KEY.provider,
      ]);
    } finally {
      f.cleanup();
    }
  });

  test("every verdict carries a non-empty detail", () => {
    const f = fixture("consent-detail");
    try {
      writeFileSync(f.configPath, "search_semantic_enabled: false\n");
      for (const semantic of [UNSET_SEMANTIC, DECLINED_PROVIDER_SEMANTIC, KEYLESS_SEMANTIC]) {
        const consent = resolveProviderConsent({
          configPath: f.configPath,
          env: {},
          semantic,
        });
        expect(consent.detail.trim().length).toBeGreaterThan(0);
      }
    } finally {
      f.cleanup();
    }
  });
});

describe("the config surface of the record is declared", () => {
  test("the template declares where the decline lives, and names both spellings", () => {
    // The record is a MACHINE-configuration key, so the vault template
    // declares it as an omission with a written reason rather than
    // templating a knob the resolver never reads. The reason has to name
    // the two spellings, or it is a note to nobody.
    const omission = BRAIN_CONFIG_TEMPLATE_OMISSIONS.find(
      (entry) => entry.key === "provider_consent",
    );
    expect(omission).toBeDefined();
    expect(omission!.reason.trim().length).toBeGreaterThan(80);
    expect(omission!.reason).toContain(PROVIDER_CONSENT_KEY.semantic);
    expect(omission!.reason).toContain(PROVIDER_CONSENT_KEY.provider);
  });
});
