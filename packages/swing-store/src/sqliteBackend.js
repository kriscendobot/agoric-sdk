// @ts-check
/* eslint-env node */
/**
 * SQLite backend entrypoint for swing-store.
 *
 * This module is the single SQLite construction point used by the rest of
 * swing-store. It owns the choice of underlying driver (here, Node's built-in
 * `node:sqlite`) and exposes an Agoric-local Database/Statement surface that
 * matches the subset of the `better-sqlite3` API the package historically
 * relied on. Centralizing construction here keeps the call sites in
 * swingStore.js, exporter.js, and the tests free of driver-specific knowledge
 * and lets future driver swaps be a one-file change.
 *
 * Drop-in compatibility shims provided on top of `node:sqlite`:
 *  - statement.pluck(toggle?)    — emulate better-sqlite3 column-0 extraction.
 *  - statement.raw(toggle?)      — emulate better-sqlite3 array-row mode.
 *  - statement.bind(...args)     — store bound parameters for subsequent calls.
 *  - statement.iterate(...args)  — wrap StatementSync.iterate() to apply
 *                                  pluck/raw transforms and bound parameters.
 *  - statement.all/get/run       — apply pluck/raw transforms and bound
 *                                  parameters; preserve better-sqlite3 return
 *                                  shape (run returns
 *                                  `{ changes, lastInsertRowid }`).
 *  - database.pragma(stmt, opts) — better-sqlite3-shaped pragma helper.
 *  - database.inTransaction      — alias for the native `isTransaction`.
 *  - database.unsafeMode(toggle) — no-op; the journal-mode / synchronous-mode
 *                                  pragmas swing-store toggles still flow
 *                                  through `pragma()`.
 *
 * For DB-serialization tests, the legacy better-sqlite3 `serialize()` /
 * `options.serialized` round-trip is replaced by the native `sqlite.backup`
 * API per mhofman's review on Agoric/agoric-sdk#12198. The `backupDatabase`
 * helper below exposes that path for tests; the previous `debug.serialize`
 * surface has been removed from `swingStore.js`.
 *
 * @see {@link https://nodejs.org/api/sqlite.html | node:sqlite docs}
 */
import { Buffer } from 'node:buffer';
// `@types/node` versions earlier than 22.16 do not include the stabilized
// `node:sqlite` typings (notably the module-level `backup` function, the
// `DatabaseSync.isTransaction` getter, and the `readOnly` constructor option).
// The runtime exports exist as of Node 22.16; suppress the typing gap at the
// import site so the rest of the module type-checks without forcing a
// monorepo-wide `@types/node` bump.
// @ts-expect-error - backup added to node:sqlite types in @types/node ≥ 22.16
import { DatabaseSync, backup } from 'node:sqlite';

/**
 * @typedef {object} BackendDatabaseOptions
 * @property {boolean} [readonly] Open the database in read-only mode.
 */

/**
 * @typedef {object} PragmaOptions
 * @property {boolean} [simple] Return only the first column of the first row.
 */

/**
 * Convert a `node:sqlite` column value into the value better-sqlite3 returns
 * for the same row. The main reshaping is `Uint8Array` to `Buffer` so callers
 * that expect Node Buffer semantics (e.g., `Readable.from`,
 * `Buffer.concat`) keep working. The conversion is a view over the same
 * memory and is O(1).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function shapeValue(value) {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

/**
 * Re-shape a `node:sqlite` row (an object with a null prototype) into the
 * value better-sqlite3 returns under the equivalent pluck/raw configuration.
 *
 * @param {unknown} row
 * @param {boolean} pluck
 * @param {boolean} raw
 * @returns {unknown}
 */
function shapeRow(row, pluck, raw) {
  if (row === undefined || row === null) return row;
  if (pluck) {
    if (typeof row !== 'object') return shapeValue(row);
    const keys = Object.keys(/** @type {object} */ (row));
    if (keys.length === 0) return undefined;
    return shapeValue(
      /** @type {Record<string, unknown>} */ (row)[keys[0]],
    );
  }
  if (raw) {
    if (typeof row !== 'object') return [shapeValue(row)];
    return Object.values(/** @type {object} */ (row)).map(shapeValue);
  }
  // Convert null-prototype objects to plain objects to match
  // better-sqlite3's shape; convert Uint8Array column values to Buffer.
  if (row && typeof row === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {object} */ (row))) {
      out[k] = shapeValue(v);
    }
    return out;
  }
  return row;
}

/**
 * Wrap a `node:sqlite` StatementSync to add better-sqlite3-compatible
 * pluck/raw/bind helpers and to reshape rows on the way out.
 *
 * @param {import('node:sqlite').StatementSync} statement
 */
function wrapStatement(statement) {
  let pluck = false;
  let raw = false;
  /** @type {readonly unknown[]} */
  let bound = [];

  // better-sqlite3 silently coerces `undefined` to NULL when binding
  // parameters; `node:sqlite` rejects `undefined` with ERR_INVALID_ARG_TYPE.
  // Match better-sqlite3's leniency here so the broad call surface keeps
  // working.
  const normalize = value => (value === undefined ? null : value);
  const normalizeAll = args => {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      // Named-parameter object; copy with undefined → null on each entry.
      const out = {};
      for (const [k, v] of Object.entries(args[0])) {
        out[k] = normalize(v);
      }
      return [out];
    }
    return args.map(normalize);
  };

  const withBound = args => {
    if (bound.length === 0) return normalizeAll(args);
    return normalizeAll([...bound, ...args]);
  };

  const wrapped = {
    /**
     * @param {boolean} [toggle]
     */
    pluck(toggle = true) {
      pluck = !!toggle;
      if (pluck) raw = false;
      return wrapped;
    },
    /**
     * @param {boolean} [toggle]
     */
    raw(toggle = true) {
      raw = !!toggle;
      if (raw) pluck = false;
      return wrapped;
    },
    /**
     * @param {...unknown} args
     */
    bind(...args) {
      bound = args;
      return wrapped;
    },
    /**
     * @param {...unknown} args
     */
    run(...args) {
      return statement.run(...withBound(args));
    },
    /**
     * @param {...unknown} args
     */
    get(...args) {
      const row = statement.get(...withBound(args));
      return shapeRow(row, pluck, raw);
    },
    /**
     * @param {...unknown} args
     */
    all(...args) {
      const rows = statement.all(...withBound(args));
      return rows.map(row => shapeRow(row, pluck, raw));
    },
    /**
     * @param {...unknown} args
     */
    *iterate(...args) {
      // @types/node < 22.16 lacks StatementSync.iterate; cast around it.
      const it = /** @type {any} */ (statement).iterate(...withBound(args));
      for (const row of it) {
        yield shapeRow(row, pluck, raw);
      }
    },
    /**
     * Expose the underlying StatementSync for advanced callers that want the
     * native API directly.
     */
    get native() {
      return statement;
    },
  };

  return wrapped;
}

/**
 * Wrap a `node:sqlite` DatabaseSync to add the better-sqlite3-compatible
 * methods swing-store uses (pragma, inTransaction alias, unsafeMode).
 *
 * @param {import('node:sqlite').DatabaseSync} database
 */
function wrapDatabase(database) {
  const db = {
    /**
     * @param {string} sql
     */
    prepare(sql) {
      return wrapStatement(database.prepare(sql));
    },
    /**
     * @param {string} sql
     */
    exec(sql) {
      database.exec(sql);
    },
    /**
     * better-sqlite3's pragma helper:
     *  - Returns rows from `PRAGMA <stmt>` as objects.
     *  - With `{ simple: true }`, returns just the first column of the first
     *    row.
     *
     * @param {string} statement  Pragma body (without the leading `PRAGMA `).
     * @param {PragmaOptions} [options]
     */
    pragma(statement, options = {}) {
      const sql = `PRAGMA ${statement}`;
      const stmt = database.prepare(sql);
      if (options.simple) {
        const row = stmt.get();
        if (row === undefined || row === null) return undefined;
        const keys = Object.keys(/** @type {object} */ (row));
        return /** @type {Record<string, unknown>} */ (row)[keys[0]];
      }
      const rows = stmt.all();
      return rows.map(row => ({ .../** @type {object} */ (row) }));
    },
    /**
     * better-sqlite3 exposes `inTransaction`; `node:sqlite` exposes
     * `isTransaction`. Alias the latter under the former for legacy callers;
     * new code should prefer `isTransaction` per mhofman's review on
     * Agoric/agoric-sdk#12198.
     */
    get inTransaction() {
      // @types/node < 22.16 lacks DatabaseSync.isTransaction; cast around it.
      return /** @type {any} */ (database).isTransaction;
    },
    get isTransaction() {
      return /** @type {any} */ (database).isTransaction;
    },
    /**
     * better-sqlite3's `unsafeMode(true)` permits operations otherwise blocked
     * by the driver (e.g., running PRAGMA inside a transaction it would
     * normally refuse). `node:sqlite` does not enforce those guards, so the
     * toggle is a no-op here; the underlying journal-mode / synchronous-mode
     * pragmas swing-store toggles still flow through `pragma()`.
     *
     * @param {boolean} _toggle
     */
    unsafeMode(_toggle) {
      // No-op for node:sqlite.
    },
    /**
     * Close the database. Mirrors better-sqlite3's close().
     */
    close() {
      database.close();
    },
    /**
     * Expose the underlying DatabaseSync for advanced callers that want the
     * native API directly (e.g., for sqlite.backup()).
     */
    get native() {
      return database;
    },
  };

  return db;
}

/** @typedef {ReturnType<typeof wrapDatabase>} BackendDatabase */

/**
 * Open a SQLite database, returning the swing-store-shaped wrapper.
 *
 * @param {string} filePath  File path or `:memory:`.
 * @param {BackendDatabaseOptions} [options]
 * @returns {BackendDatabase}
 */
export function makeDatabase(filePath, options = {}) {
  const { readonly = false } = options;
  const database = new DatabaseSync(
    filePath,
    /** @type {any} */ ({ readOnly: readonly }),
  );
  return wrapDatabase(database);
}

/**
 * Back up a database to a file using the native `sqlite.backup` API.
 *
 * Per mhofman's review on Agoric/agoric-sdk#12198, this is the preferred path
 * for tests that need a clone of the live DB state: back up to a file, then
 * either re-open the file with `makeDatabase()` or read it back as a Buffer.
 *
 * The `node:sqlite` `sqlite.backup` API is asynchronous (returns a Promise);
 * the convenience wrapper preserves that shape.
 *
 * @param {BackendDatabase} db  Source database.
 * @param {string} destPath  Filesystem path for the backup.
 * @returns {Promise<number>}  Number of pages copied (from the native API).
 */
export async function backupDatabase(db, destPath) {
  return backup(db.native, destPath);
}

/**
 * Synchronously copy a database into a destination file using SQLite's
 * `VACUUM INTO` statement.
 *
 * `VACUUM INTO` was introduced in SQLite 3.27 (Feb 2019) and is exposed by
 * `node:sqlite` through plain `db.exec`. Unlike the asynchronous
 * `sqlite.backup` API, it runs to completion before returning, which lets us
 * preserve the synchronous `debug.serialize()` shape callers across the
 * monorepo rely on without forcing them to convert to async/await.
 *
 * Callers must ensure `destPath` does not already exist; `VACUUM INTO`
 * refuses to overwrite.
 *
 * @param {BackendDatabase} db  Source database.
 * @param {string} destPath  Filesystem path to write the database to.
 */
export function vacuumIntoSync(db, destPath) {
  // SQL string interpolation with single-quote escaping; the path is
  // controlled by trusted callers (test harnesses), but escape defensively.
  const escaped = destPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}
