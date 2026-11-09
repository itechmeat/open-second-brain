/**
 * Where accepted skills live when no `skills_dir` is configured (design
 * D14, task 2.10). Skills are files agents read (`SKILL.md`), so they are
 * never store records:
 *
 *  - an unswitched machine keeps today's vault-local `Brain/skills/`;
 *  - a switched machine with a vault uses `<vault>/skills/`, outside the
 *    legacy tree (the migration moves a legacy `Brain/skills/` there);
 *  - a machine with no vault uses `<device state>/skills/`, device-local,
 *    through the machine-state resolver.
 */

import { join } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { machineStateLocation } from "../state/machine-state.ts";
import { laneVaultRoot } from "../store/lane-pages.ts";
import { storeOnlyMode } from "../store/store-only.ts";

/** The vault-relative folder of a switched machine's skills. */
export const SWITCHED_SKILLS_DIR = "skills";

/**
 * The default skills directory of `vault` (`null`, an empty string, or
 * the no-vault root, for none), decided with the machine config at
 * `configPath` (default: the configured one).
 */
export function defaultSkillsDir(vault: string | null | undefined, configPath?: string): string {
  if (
    vault === null ||
    vault === undefined ||
    vault.trim() === "" ||
    vault === laneVaultRoot(null)
  ) {
    return join(machineStateLocation(null, configPath).root, SWITCHED_SKILLS_DIR);
  }
  const mode = storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) });
  if (mode.storeOnly) return join(vault, SWITCHED_SKILLS_DIR);
  return join(vault, BRAIN_ROOT_REL, "skills");
}
