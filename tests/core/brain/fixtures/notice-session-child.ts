/**
 * Child process for the one-time notice race: one session start on
 * `vault`. It renders its runtime notices, writes `<out>.rendered`, and
 * waits for the `go` file (the parent opens it once every child rendered),
 * so every child holds a rendered copy of the notice before any of them
 * goes on to load the active body and consume the notice. It then writes
 * `shown` or `hidden` to `<out>`, by whether the session's text carries
 * the notice.
 *
 * argv: <vault> <out> <go>
 * The environment (state directories) is the parent's.
 */
import { existsSync, writeFileSync } from "node:fs";
import { spyOn } from "bun:test";

import * as notices from "../../../../src/core/brain/runtime-notices.ts";
import {
  assembleActiveContext,
  createInjectionMeter,
} from "../../../../hooks/lib/active-context.ts";

const [vault, out, go] = process.argv.slice(2) as [string, string, string];
const render = notices.collectRuntimeNotices;
spyOn(notices, "collectRuntimeNotices").mockImplementation((...args) => {
  const rendered = render(...args);
  writeFileSync(`${out}.rendered`, "");
  const deadline = Date.now() + 25_000;
  while (!existsSync(go) && Date.now() < deadline) Bun.sleepSync(5);
  return rendered;
});
const text = assembleActiveContext(vault, 10_000, createInjectionMeter(10_000), {
  startsSession: true,
});
writeFileSync(out, text.includes("o2b brain migrate-store --rollback") ? "shown" : "hidden");
