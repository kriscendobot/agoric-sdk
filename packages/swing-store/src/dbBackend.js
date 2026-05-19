// @ts-check
/* eslint-env node */

/**
 * Backend entrypoint for SQLite access in swing-store.
 *
 * This module owns every direct dependency on a specific SQLite binding.
 * The rest of the package imports `createDatabase` and `backupDatabase` from
 * here and uses the small native-first surface they expose:
 *
 *   prepare(sql)   -> StatementSync
 *   exec(sql)      -> void
 *   isTransaction  -> boolean (native, no manual tracking)
 *   pragma(...)    -> better-sqlite3-style pragma helper
 *   transaction(fn)-> better-sqlite3-style transaction wrapper
 *   close()        -> void
 *
 * On each StatementSync:
 *   iterate(...)   -> IterableIterator (native, lazy)
 *   pluck/raw/expand -> better-sqlite3-style chainable mode setters
 *   get/all/run    -> as in node:sqlite / better-sqlite3
 *
 * The current binding is `@photostructure/sqlite`, which carries a vendored
 * SQLite library and a JS surface that matches Node's built-in
 * `node:sqlite`, plus an `enhance()` helper that adds better-sqlite3-style
 * `pragma()`, `transaction()`, and statement modes. Swapping to Node's
 * built-in `node:sqlite` (on Node 22.16+ or behind `--experimental-sqlite`)
 * requires only changing the import below, not any caller.
 *
 * @see https://github.com/photostructure/sqlite
 * @see https://nodejs.org/api/sqlite.html
 */

import {
  DatabaseSync,
  enhance,
  backup as backupSqlite,
} from '@photostructure/sqlite';

/**
 * @import {
 *   DatabaseSyncInstance,
 *   StatementSyncInstance,
 *   EnhancedMethods,
 *   EnhancedStatementMethods,
 * } from '@photostructure/sqlite';
 */

/**
 * A prepared statement with native `iterate` and better-sqlite3-style
 * chainable mode setters.
 *
 * @typedef {StatementSyncInstance & EnhancedStatementMethods} Statement
 */

/**
 * A database connection with native `isTransaction` and better-sqlite3-style
 * `pragma()` / `transaction()` helpers. The `prepare()` method returns
 * Statements (above) rather than the raw StatementSyncInstance.
 *
 * @typedef {Omit<DatabaseSyncInstance, 'prepare'> & EnhancedMethods & {
 *   prepare: (sql: string) => Statement,
 * }} Database
 */

/**
 * @typedef {object} CreateDatabaseOptions
 * @property {boolean} [readonly]  Open the database read-only. Default false.
 */

/**
 * Open a SQLite database backed by the current binding, returning a handle
 * that exposes the native-first surface plus the better-sqlite3-compatible
 * helpers swing-store relies on.
 *
 * @param {string} filename  Path on disk, or `:memory:` for an in-memory
 *   database. Buffer / URL inputs are intentionally rejected; serialization
 *   round-trips go through {@link backupDatabase}.
 * @param {CreateDatabaseOptions} [options]
 * @returns {Database}
 */
export function createDatabase(filename, options = {}) {
  const { readonly = false } = options;
  // The binding accepts string | Buffer | URL, but we narrow to string so
  // that the entrypoint contract is the same regardless of which binding
  // is wired in. Tests that previously relied on `new Database(buffer)`
  // now write the buffer to a temporary file and open the path; production
  // code only ever passes a path.
  typeof filename === 'string' ||
    (() => {
      throw new TypeError(
        'createDatabase: filename must be a string (path or ":memory:")',
      );
    })();

  const raw = new DatabaseSync(filename, { readOnly: readonly });
  // `enhance` adds `.pragma()`, `.transaction()`, and `.pluck()` / `.raw()` /
  // `.expand()` on statements returned from `prepare()`. Native methods
  // (`prepare`, `exec`, `iterate`, `isTransaction`, `close`) are left intact.
  return /** @type {Database} */ (/** @type {unknown} */ (enhance(raw)));
}

/**
 * Convert a SQLite BLOB column value (a `Uint8Array` under both
 * `node:sqlite` and `@photostructure/sqlite`) into a Node.js `Buffer`
 * without copying. `better-sqlite3` returned BLOBs as Buffers directly;
 * downstream code that does `Readable.from(blob)` or similar Buffer-only
 * operations needs the wrapped view.
 *
 * @param {Uint8Array | null | undefined} blob
 * @returns {Buffer | null | undefined}
 */
export function blobToBuffer(blob) {
  if (blob == null) return blob;
  // Buffer.from(arrayBuffer, byteOffset, length) is a zero-copy view.
  return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
}

/**
 * Back up a source database to a destination path using the SQLite Online
 * Backup API. Returns a promise that resolves once the backup completes.
 *
 * The destination is created (or replaced) on disk; both in-memory and
 * file-backed source databases are supported. Callers that need a Buffer
 * (e.g. test fixtures that previously used better-sqlite3's `serialize()`)
 * can `fs.readFileSync` the destination after the promise resolves.
 *
 * @param {Database} source
 * @param {string} destination  Filesystem path for the backup target.
 * @returns {Promise<number>}  Number of pages written.
 */
export async function backupDatabase(source, destination) {
  // The binding's `backup` accepts `DatabaseSyncInstance`, which an enhanced
  // database is structurally compatible with (enhance() augments the
  // instance without removing the native methods backup needs).
  return backupSqlite(
    /** @type {DatabaseSyncInstance} */ (/** @type {unknown} */ (source)),
    destination,
  );
}
