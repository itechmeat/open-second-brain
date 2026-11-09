/**
 * `o2b store device list|retire` (design D6, D11a): the devices the brain
 * store knows, and the human `device-retire` record that takes a machine
 * that is gone for good off the digest roster and out of the legacy
 * removal gate. The work lives in `core/store/device-roster.ts`; this file
 * parses flags and renders.
 *
 * Exit codes: 0 for an answer (a list, a retirement, a device already
 * retired), 1 for a refusal (no store, no device id, this machine's own
 * id, an id the store has never seen without `--force`, a private
 * reason), 2 for a broken argv. Under `--json` every refusal and usage
 * error is a `{ ok: false, reason, error }` answer on stdout.
 */

import {
  ConfigReadError,
  isValidDeviceId,
  readDeviceId,
  resolveAgentName,
  resolveDeviceId,
  resolveVault,
} from "../core/config.ts";
import {
  DeviceRetireRefusal,
  listDevices,
  retireDevice,
  type DeviceEntry,
} from "../core/store/device-roster.ts";
import { PartitionUnavailableError } from "../core/store/appender.ts";
import { openStore, StoreOpenError, type StoreHandle } from "../core/store/store-open.ts";
import {
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

const LIST_USAGE = "usage: o2b store device list [--config <file>] [--json]";
const RETIRE_USAGE =
  "usage: o2b store device retire <device-id> [--reason <text>] [--force] [--config <file>] [--json]";
export const STORE_DEVICE_USAGE = `${LIST_USAGE}\n${RETIRE_USAGE}`;

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

export function cmdStoreDevice(argv: ReadonlyArray<string>): number {
  const verb = argv[0];
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(`${STORE_DEVICE_USAGE}\n`);
    return EXIT.ok;
  }
  if (verb === "list") return cmdList(argv.slice(1));
  if (verb === "retire") return cmdRetire(argv.slice(1));
  process.stderr.write(
    `error: ${verb === undefined ? "missing" : `unknown`} store device verb` +
      `${verb === undefined ? "" : `: ${verb}`}\n${STORE_DEVICE_USAGE}\n`,
  );
  return EXIT.usage;
}

/** A refusal of this verb itself, with its JSON reason. */
class DeviceVerbRefusal extends Error {
  constructor(
    readonly reason: "no-device" | "unknown-device",
    message: string,
  ) {
    super(message);
    this.name = "DeviceVerbRefusal";
  }
}

/**
 * The store this machine writes to, as its own device. `list` only reads:
 * it never mints a device id into the machine config (`readDeviceId`).
 */
function openHere(configPath: string | undefined, mode: "read" | "write"): StoreHandle {
  const { root } = resolveConfiguredStoreRoot(configPath);
  if (mode === "write") return openStore({ root, device: resolveDeviceId(configPath) });
  const device = readDeviceId(configPath ?? null);
  if (device === null) {
    throw new DeviceVerbRefusal(
      "no-device",
      "this machine has no device id; run `o2b store init` to give it one",
    );
  }
  return openStore({ root, device });
}

function isRefusal(err: unknown): err is Error {
  return (
    err instanceof DeviceRetireRefusal ||
    err instanceof DeviceVerbRefusal ||
    err instanceof StoreOpenError ||
    err instanceof StoreRootInsideVaultError ||
    err instanceof PartitionUnavailableError ||
    err instanceof ConfigReadError
  );
}

/** The JSON reason of a refusal: one per error class, so a caller can act on it. */
function reasonOf(err: Error): string {
  if (err instanceof DeviceRetireRefusal || err instanceof DeviceVerbRefusal) return err.reason;
  if (err instanceof StoreOpenError) return "no-store";
  if (err instanceof StoreRootInsideVaultError) return "store-root-in-vault";
  if (err instanceof PartitionUnavailableError) return "partition-unavailable";
  return "config";
}

function refuse(err: Error, json: boolean): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: reasonOf(err), error: err.message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${err.message}\n`);
  return EXIT.refused;
}

/** A usage error: the usage on stderr, and the JSON failure on stdout under `--json`. */
function usage(argv: ReadonlyArray<string>, message: string, text: string): number {
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: "usage", error: message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${message}\n${text}\n`);
  return EXIT.usage;
}

function parse(
  argv: ReadonlyArray<string>,
  usageText: string,
  extra: Record<string, { type: "string" | "boolean" }> = {},
): { flags: Record<string, unknown>; positional: string[] } | number {
  try {
    const { flags, positional } = parseFlags(argv, {
      config: { type: "string" },
      json: { type: "boolean" },
      ...extra,
    });
    return { flags, positional };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return usage(argv, err.message, usageText);
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function renderList(devices: ReadonlyArray<DeviceEntry>): string {
  if (devices.length === 0) return "The brain store knows no device yet.\n";
  const width = Math.max(6, ...devices.map((d) => d.device.length)) + 2;
  const lines = [`${"device".padEnd(width)}${"last seen".padEnd(26)}state`];
  for (const d of devices) {
    const notes = [
      d.thisMachine ? "this machine" : null,
      !d.onRoster && d.state !== "retired" ? "off the roster" : null,
      d.returnedAfterRetire ? "wrote again after it was retired" : null,
    ].filter((n): n is string => n !== null);
    lines.push(
      `${d.device.padEnd(width)}${(iso(d.lastSeenMs) ?? "never").padEnd(26)}${d.state}` +
        (notes.length > 0 ? ` (${notes.join(", ")})` : ""),
    );
  }
  return `${lines.join("\n")}\n`;
}

function cmdList(argv: ReadonlyArray<string>): number {
  const parsed = parse(argv, LIST_USAGE);
  if (typeof parsed === "number") return parsed;
  const json = parsed.flags["json"] === true;
  if (parsed.positional.length > 0) {
    return usage(argv, `unexpected argument: ${parsed.positional[0]}`, LIST_USAGE);
  }
  let store: StoreHandle;
  let devices: DeviceEntry[];
  try {
    store = openHere(parsed.flags["config"] as string | undefined, "read");
    devices = listDevices(store);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return refuse(err, json);
  }
  process.stdout.write(
    json
      ? `${JSON.stringify(
          {
            ok: true,
            device: store.device,
            devices: devices.map((d) => ({
              device: d.device,
              last_seen: iso(d.lastSeenMs),
              state: d.state,
              on_roster: d.onRoster,
              this_machine: d.thisMachine,
              returned_after_retire: d.returnedAfterRetire,
            })),
          },
          sortedReplacer,
          2,
        )}\n`
      : renderList(devices),
  );
  return EXIT.ok;
}

function cmdRetire(argv: ReadonlyArray<string>): number {
  const parsed = parse(argv, RETIRE_USAGE, {
    reason: { type: "string" },
    force: { type: "boolean" },
  });
  if (typeof parsed === "number") return parsed;
  const json = parsed.flags["json"] === true;
  if (parsed.positional.length === 0)
    return usage(argv, "name the device id to retire", RETIRE_USAGE);
  if (parsed.positional.length > 1) {
    return usage(argv, `unexpected argument: ${parsed.positional[1]}`, RETIRE_USAGE);
  }
  const device = parsed.positional[0]!;
  const configPath = parsed.flags["config"] as string | undefined;
  const reason = parsed.flags["reason"] as string | undefined;
  try {
    const store = openHere(configPath, "write");
    // A retirement is a permanent record: an id the store has never seen
    // (a typo) is refused unless the operator insists. This machine's own
    // id, a malformed id and a machine without the shared partition are
    // refused by the roster with their own reasons, which `--force` would
    // not get past, so the guard leaves them to it.
    const knowable = isValidDeviceId(device) && store.partitions.has("shared");
    const unknown =
      knowable && device !== store.device && !listDevices(store).some((d) => d.device === device);
    if (unknown && parsed.flags["force"] !== true) {
      throw new DeviceVerbRefusal(
        "unknown-device",
        `the brain store has no record of a device ${device}; check \`o2b store device list\`, ` +
          "or pass --force to retire it anyway",
      );
    }
    const result = retireDevice(store, {
      device,
      ...(reason !== undefined ? { reason } : {}),
      agent: resolveAgentName(configPath),
      vault: resolveVault(configPath),
    });
    const message =
      result.status === "retired"
        ? `Retired ${device} (record ${result.record.id}). It leaves the digest roster and no ` +
          "longer holds back the removal of the legacy tree; if it writes again, doctor says so."
        : `${device} is already retired (record ${result.record.id}); nothing was written.`;
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, status: result.status, device, record: result.record.id }, sortedReplacer, 2)}\n`
        : `${message}\n`,
    );
    return EXIT.ok;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return refuse(err, json);
  }
}
