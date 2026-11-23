import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const publish = workflow.split("  publish:\n")[1]?.split("  publish-smoke:\n")[0] ?? "";
const smoke = workflow.split("  publish-smoke:\n")[1] ?? "";

test("registry publish workflow keeps verification and identity boundaries", () => {
  expect(publish).not.toBe("");
  expect(publish).toContain("needs: verify");
  expect(publish).toContain("environment: npm-publish");
  expect(publish).toContain("id-token: write");
  expect((workflow.match(/id-token: write/g) ?? []).length).toBe(1);
  expect(workflow).not.toMatch(/secrets\.[A-Za-z_]*NPM|secrets\.[A-Za-z_]*REGISTRY/i);
  expect(publish).toContain("action: ${{ steps.plan.outputs.action }}");
  expect(publish).toContain("tag: ${{ steps.plan.outputs.tag }}");
  expect(publish).toContain("version: ${{ steps.plan.outputs.version }}");
  expect(publish).toMatch(
    /if: steps\.plan\.outputs\.action == 'publish'[\s\S]*?npm publish "\$TARBALL"/,
  );
  expect(publish).toContain("path: ${{ steps.pack.outputs.path }}");
  expect(publish).toContain('bun run scripts/pack-manifest.ts --tarball "$tarball"');
  expect(publish).not.toContain("pack:check");
  expect(publish.indexOf("Compare release tag to package version")).toBeGreaterThanOrEqual(0);
  expect(publish.indexOf("Pack checked tarball")).toBeGreaterThanOrEqual(0);
  expect(publish.indexOf("Compare release tag to package version")).toBeLessThan(
    publish.indexOf("Pack checked tarball"),
  );
  expect(publish).toContain("npm@$NPM_VERSION");
  expect(publish).toContain("NPM_VERSION: 11.14.1");
  expect(publish).toContain("group: registry-publish-open-second-brain");
  expect(publish).toContain("cancel-in-progress: false");
  expect(publish).toContain(
    "name: open-second-brain-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(publish).not.toContain("name: open-second-brain-${{ github.ref_name }}");
  expect(smoke).toContain("if: needs.publish.outputs.action == 'publish'");
});
