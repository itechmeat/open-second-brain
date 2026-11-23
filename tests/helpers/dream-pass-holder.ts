/**
 * Start a separate process that holds the dream pass lock of one device
 * (`dream-pass-holder-main.ts`), for tests that need a live holder other
 * than the test process. Resolves once the child holds the lock; the
 * caller kills it or awaits its exit. With `untilFile` the child releases
 * the lock as soon as that file exists, and `holdMs` only caps the hold.
 */
import { dirname, join } from "node:path";

import type { StoreHandle } from "../../src/core/store/store-open.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { homeEnv } from "./platform.ts";

const MAIN = join(import.meta.dir, "dream-pass-holder-main.ts");

export async function startDreamPassHolder(
  store: StoreHandle,
  holdMs: number,
  untilFile?: string,
): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
  const handle = JSON.stringify({ ...store, partitions: [...store.partitions] });
  const tempRoot = dirname(dirname(store.deviceStateDir));
  const proc = Bun.spawn(
    [
      process.execPath,
      MAIN,
      handle,
      String(holdMs),
      ...(untilFile === undefined ? [] : [untilFile]),
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        ...homeEnv(join(tempRoot, "home", store.device)),
        XDG_CONFIG_HOME: join(tempRoot, "config"),
        XDG_DATA_HOME: join(tempRoot, "data"),
        XDG_STATE_HOME: store.deviceStateDir,
        XDG_CACHE_HOME: join(tempRoot, "cache"),
        OPEN_SECOND_BRAIN_CONFIG: join(tempRoot, "config.yaml"),
        [STORE_ROOT_ENV]: store.root,
        O2B_DEVICE_ID: store.device,
      },
    },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("held")) {
    // Reads are sequential by nature: each waits for the one before.
    // oxlint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder exited before it held the lock: ${out}`);
    out += decoder.decode(value);
  }
  reader.releaseLock();
  return proc;
}
