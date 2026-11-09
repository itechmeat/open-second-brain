/**
 * The folder names the migration writes under its device-local folder
 * (`<device state>/migration/`, `journal.ts` `migrationDir`), in one leaf
 * so a reader of that layout imports names, not the writers:
 *
 *  - `local/<vault-relative path>`: every surface the map sends to
 *    `device-local`, copied there at switch time (`local-state.ts`). The
 *    store-only machine keeps its machine state there from then on
 *    (`state/machine-state.ts`).
 *  - `backup/files/<vault-relative path>`: the verified copy of every
 *    surface the map sends to `backup` (`backup.ts`).
 */

/** The device-local copies of the machine state, under the migration folder. */
export const MIGRATION_LOCAL_DIR = "local";

/** The migration's backups, under the migration folder. */
export const MIGRATION_BACKUP_DIR = "backup";

/** The copied backup-class files, under {@link MIGRATION_BACKUP_DIR}. */
export const MIGRATION_BACKUP_FILES_DIR = "files";
