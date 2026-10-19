/**
 * `node:sqlite`: Node's synchronous SQLite API (`DatabaseSync`, `StatementSync`), over SQLite's own WebAssembly build.
 *
 * Node links SQLite and answers `node:sqlite` from it. This engine carries no SQLite of its own: the host that starts
 * the realm supplies SQLite's WebAssembly build (`@sqlite.org/sqlite-wasm`, initialized before any guest code runs) as
 * `globalThis.__substrateSqlite`, the way it supplies amaro for `.ts` files (internals/amaro.ts). Without it, a program
 * that asks for `node:sqlite` is refused by name, as a Node built without SQLite refuses it.
 *
 * A database is the file's bytes held in SQLite's memory and written back whole, atomically (a sibling written, then
 * renamed over the file), when a statement outside a transaction changed it, at the end of the transaction that did,
 * and at close. Before a statement outside a transaction, a file another process has rewritten since it was last read
 * here is read again. That is the consistency SQLite's own locking gives two processes at statement granularity, without
 * its locks: two processes writing the same file at the same moment can lose one's write. A WAL-mode file is read as
 * its main database file alone. `:memory:` is never written. First need: Volter Harness (supercode's session stores and
 * boards import `node:sqlite` at module top; card t_d4b07ea8).
 */

/** The parts of the guest's `fs` this module reads and writes the database file through. */
export interface SqliteFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  renameSync(from: string, to: string): void;
  statSync(path: string): { mtimeMs: number; size: number };
  unlinkSync?(path: string): void;
}

// The surface of @sqlite.org/sqlite-wasm this module uses: its oo1 layer and a few C entry points.
interface WasmStmt {
  bind(values: unknown, value?: unknown): WasmStmt;
  step(): boolean;
  get(target: unknown[] | Record<string, unknown>): unknown;
  getColumnNames(): string[];
  columnCount: number;
  parameterCount: number;
  pointer: number;
  reset(clearBindings?: boolean): WasmStmt;
  clearBindings(): WasmStmt;
  finalize(): void;
  getColumnType?(index: number): number;
}
interface WasmDb {
  pointer: number;
  exec(sql: string): unknown;
  prepare(sql: string): WasmStmt;
  close(): void;
}
interface Sqlite3 {
  oo1: { DB: new (filename?: string, flags?: string) => WasmDb };
  capi: Record<string, any>;
  wasm: { allocFromTypedArray(bytes: Uint8Array): number };
}

const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
const SQLITE_DESERIALIZE_RESIZEABLE = 2;
const SQLITE_DESERIALIZE_READONLY = 4;
const SQLITE_INTEGER = 1, SQLITE_FLOAT = 2, SQLITE_TEXT = 3, SQLITE_BLOB = 4, SQLITE_NULL = 5;

function sqliteError(message: string, code = 'ERR_SQLITE_ERROR'): Error {
  return Object.assign(new Error(message), { code });
}

function invalidState(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_INVALID_STATE' });
}

function wasmSqlite(): Sqlite3 {
  const supplied = (globalThis as { __substrateSqlite?: Sqlite3 }).__substrateSqlite;
  if (supplied && supplied.oo1 && supplied.capi) return supplied;
  throw Object.assign(new Error('No such built-in module: node:sqlite (this realm was started without SQLite: the image selects it when its code imports node:sqlite)'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
}

/** A value as SQLite binds it: Node's rule (no undefined, booleans refused, typed arrays as blobs). */
function bindable(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw Object.assign(new TypeError(`Provided value cannot be bound to SQLite parameter`), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createSqliteModule(fs: SqliteFs) {
  class DatabaseSync {
    #path: string;
    #readOnly: boolean;
    #foreignKeys: boolean;
    #db: WasmDb | null = null;
    #sqlite: Sqlite3 | null = null;
    #seen: { mtimeMs: number; size: number } | null = null;
    #dirty = false;
    #statements = new Set<StatementSync>();

    constructor(path: unknown, options: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {}) {
      if (typeof path !== 'string' && !(path instanceof Uint8Array) && !(path instanceof URL)) {
        throw Object.assign(new TypeError('The "path" argument must be a string, Uint8Array, or URL without null bytes.'), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      this.#path = path instanceof URL ? decodeURIComponent(path.pathname) : typeof path === 'string' ? path : new TextDecoder().decode(path);
      this.#readOnly = options.readOnly === true;
      this.#foreignKeys = options.enableForeignKeyConstraints !== false;
      if (options.open !== false) this.open();
    }

    get isOpen(): boolean { return this.#db !== null; }
    get isTransaction(): boolean { return this.#db !== null && this.#sqlite!.capi.sqlite3_get_autocommit(this.#db.pointer) === 0; }
    location(): string | null { return this.#memory() ? null : this.#path; }

    #memory(): boolean { return this.#path === ':memory:' || this.#path === ''; }

    open(): void {
      if (this.#db) throw invalidState('database is already open');
      const sqlite = this.#sqlite = wasmSqlite();
      if (this.#readOnly && !this.#memory() && !fs.existsSync(this.#path)) throw sqliteError('unable to open database file', 'ERR_SQLITE_ERROR');
      this.#db = new sqlite.oo1.DB(':memory:', 'c');
      this.#load();
      if (this.#foreignKeys) this.#db.exec('PRAGMA foreign_keys = ON');
      // Node creates the file at open.
      if (!this.#readOnly && !this.#memory() && !fs.existsSync(this.#path)) this.#write();
    }

    /** The file's bytes as the database, or an empty one; noted as what was last seen of the file. */
    #load(): void {
      if (this.#memory() || !fs.existsSync(this.#path)) { this.#seen = null; return; }
      const bytes = fs.readFileSync(this.#path);
      this.#seen = this.#stat();
      if (!bytes.length) return;
      const sqlite = this.#sqlite!;
      const copy = new Uint8Array(bytes);
      // A WAL-mode file (header bytes 18-19 are 2) is read as a rollback-journal one: its WAL is not read here.
      if (copy.length > 19 && copy[18] === 2 && copy[19] === 2) { copy[18] = 1; copy[19] = 1; }
      const pointer = sqlite.wasm.allocFromTypedArray(copy);
      const flags = SQLITE_DESERIALIZE_FREEONCLOSE | (this.#readOnly ? SQLITE_DESERIALIZE_READONLY : SQLITE_DESERIALIZE_RESIZEABLE);
      const rc = sqlite.capi.sqlite3_deserialize(this.#db!.pointer, 'main', pointer, copy.length, copy.length, flags);
      if (rc !== 0) throw sqliteError(`file is not a database (${rc})`);
    }

    #stat(): { mtimeMs: number; size: number } | null {
      try { const stat = fs.statSync(this.#path); return { mtimeMs: stat.mtimeMs, size: stat.size }; } catch { return null; }
    }

    /** Before a statement outside a transaction: the file as another process may have left it. */
    beforeStatement(): void {
      const db = this.#require();
      if (this.#memory() || this.#dirty || this.isTransaction) return;
      const now = this.#stat();
      const seen = this.#seen;
      if (now && (!seen || now.mtimeMs !== seen.mtimeMs || now.size !== seen.size)) {
        for (const statement of this.#statements) statement.release();
        db.close();
        this.#db = new this.#sqlite!.oo1.DB(':memory:', 'c');
        this.#load();
        if (this.#foreignKeys) this.#db.exec('PRAGMA foreign_keys = ON');
      }
    }

    /** After a statement: a change outside a transaction is written now; inside one, at its end. */
    afterStatement(changed: boolean): void {
      if (changed && !this.#readOnly && !this.#memory()) this.#dirty = true;
      if (this.#dirty && !this.isTransaction) this.#write();
    }

    #write(): void {
      if (this.#readOnly || this.#memory()) return;
      const bytes = this.#sqlite!.capi.sqlite3_js_db_export(this.#db!.pointer) as Uint8Array;
      const temporary = `${this.#path}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, this.#path);
      this.#seen = this.#stat();
      this.#dirty = false;
    }

    #require(): WasmDb {
      if (!this.#db) throw invalidState('database is not open');
      return this.#db;
    }

    /** The open handle, for a statement (internal). */
    handle(): WasmDb { return this.#require(); }
    get sqlite(): Sqlite3 { return this.#sqlite ?? wasmSqlite(); }
    track(statement: StatementSync): void { this.#statements.add(statement); }
    untrack(statement: StatementSync): void { this.#statements.delete(statement); }

    exec(sql: string): void {
      if (typeof sql !== 'string') throw Object.assign(new TypeError('The "sql" argument must be a string.'), { code: 'ERR_INVALID_ARG_TYPE' });
      this.beforeStatement();
      const db = this.#require();
      const before = this.#sqlite!.capi.sqlite3_total_changes(db.pointer);
      try { db.exec(sql); }
      catch (error) { throw sqliteError((error as Error).message); }
      finally {
        // DDL changes no rows and still changes the file.
        const changed = this.#sqlite!.capi.sqlite3_total_changes(db.pointer) !== before || /^\s*(create|drop|alter|pragma|vacuum|reindex|replace|insert|update|delete)\b/iu.test(sql) || /;\s*(create|drop|alter|insert|update|delete|replace)\b/iu.test(sql);
        this.afterStatement(changed);
      }
    }

    prepare(sql: string): StatementSync {
      if (typeof sql !== 'string') throw Object.assign(new TypeError('The "sql" argument must be a string.'), { code: 'ERR_INVALID_ARG_TYPE' });
      this.beforeStatement();
      return new StatementSync(this, sql);
    }

    function(): never {
      throw sqliteError('DatabaseSync.function() is not available in this engine\'s node:sqlite');
    }

    close(): void {
      const db = this.#require();
      for (const statement of this.#statements) statement.release();
      this.#statements.clear();
      if (this.#dirty) this.#write();
      db.close();
      this.#db = null;
    }

    [Symbol.dispose](): void { if (this.#db) this.close(); }
  }

  class StatementSync {
    #database: DatabaseSync;
    #sql: string;
    #stmt: WasmStmt | null = null;
    #readBigInts = false;
    #returnArrays = false;
    #allowBareNames = true;
    #handle: WasmDb | null = null;

    constructor(database: DatabaseSync, sql: string) {
      this.#database = database;
      this.#sql = sql;
      this.#compile();
      database.track(this);
    }

    #compile(): WasmStmt {
      const handle = this.#database.handle();
      if (this.#stmt && this.#handle === handle) return this.#stmt;
      try { this.#stmt = handle.prepare(this.#sql); }
      catch (error) { throw sqliteError((error as Error).message); }
      this.#handle = handle;
      return this.#stmt;
    }

    /** The database was read again or closed: this statement is compiled again at its next use. */
    release(): void {
      try { this.#stmt?.finalize(); } catch { /* the handle it belonged to is gone */ }
      this.#stmt = null;
      this.#handle = null;
    }

    get sourceSQL(): string { return this.#sql; }
    get expandedSQL(): string {
      const stmt = this.#compile();
      return this.#database.sqlite.capi.sqlite3_expanded_sql(stmt.pointer) ?? this.#sql;
    }

    setReadBigInts(enabled: boolean): void { this.#readBigInts = Boolean(enabled); }
    setReturnArrays(enabled: boolean): void { this.#returnArrays = Boolean(enabled); }
    setAllowBareNamedParameters(enabled: boolean): void { this.#allowBareNames = Boolean(enabled); }
    setAllowUnknownNamedParameters(): void { /* unknown names are ignored, as SQLite binds by the names it has */ }

    columns(): Array<{ column: string | null; database: string | null; name: string; table: string | null; type: string | null }> {
      const stmt = this.#compile();
      const capi = this.#database.sqlite.capi;
      return stmt.getColumnNames().map((name, index) => ({
        column: capi.sqlite3_column_origin_name?.(stmt.pointer, index) ?? null,
        database: capi.sqlite3_column_database_name?.(stmt.pointer, index) ?? null,
        name,
        table: capi.sqlite3_column_table_name?.(stmt.pointer, index) ?? null,
        type: capi.sqlite3_column_decltype?.(stmt.pointer, index) ?? null,
      }));
    }

    /** Node's binding: a leading plain object names parameters, the rest bind by position. */
    #bind(params: unknown[]): WasmStmt {
      this.#database.beforeStatement();
      const stmt = this.#compile();
      stmt.reset(true);
      let rest = params;
      const capi = this.#database.sqlite.capi;
      const first = params[0];
      if (first !== null && typeof first === 'object' && !ArrayBuffer.isView(first) && !Array.isArray(first)) {
        rest = params.slice(1);
        const named: Record<string, unknown> = {};
        const byBare = new Map<string, string>();
        for (let index = 1; index <= stmt.parameterCount; index++) {
          const name = capi.sqlite3_bind_parameter_name(stmt.pointer, index) as string | null;
          if (name) byBare.set(name.slice(1), name);
        }
        for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
          const full = /^[$:@?]/u.test(key) ? key : this.#allowBareNames ? byBare.get(key) : undefined;
          if (full === undefined) {
            if (!this.#allowBareNames) throw sqliteError(`Unknown named parameter '${key}'`, 'ERR_INVALID_STATE');
            continue;
          }
          named[full] = bindable(value);
        }
        if (Object.keys(named).length) stmt.bind(named);
      }
      if (rest.length) {
        // Positional values fill the anonymous parameters in order (SQLite's index of each `?`).
        const anonymous: number[] = [];
        for (let index = 1; index <= stmt.parameterCount; index++) {
          const name = capi.sqlite3_bind_parameter_name(stmt.pointer, index) as string | null;
          if (!name || name.startsWith('?')) anonymous.push(index);
        }
        rest.forEach((value, at) => {
          const index = anonymous[at];
          if (index === undefined) throw sqliteError('column index out of range', 'ERR_SQLITE_ERROR');
          stmt.bind(index, bindable(value));
        });
      }
      return stmt;
    }

    #row(stmt: WasmStmt): unknown {
      const capi = this.#database.sqlite.capi;
      const names = stmt.getColumnNames();
      const values = names.map((_, index) => {
        const type = capi.sqlite3_column_type(stmt.pointer, index);
        if (type === SQLITE_NULL) return null;
        if (type === SQLITE_INTEGER) {
          const big = capi.sqlite3_column_int64(stmt.pointer, index) as bigint | number;
          const value = typeof big === 'bigint' ? big : BigInt(big);
          if (this.#readBigInts) return value;
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            throw sqliteError(`The value of column ${index} is too large to be represented as a JavaScript number: ${value}`, 'ERR_OUT_OF_RANGE');
          }
          return Number(value);
        }
        if (type === SQLITE_FLOAT) return capi.sqlite3_column_double(stmt.pointer, index);
        if (type === SQLITE_TEXT) return capi.sqlite3_column_text(stmt.pointer, index);
        if (type === SQLITE_BLOB) {
          const row = stmt.get([]) as unknown[];
          const blob = row[index] as Uint8Array;
          return blob instanceof Uint8Array ? new Uint8Array(blob) : new Uint8Array();
        }
        return stmt.get([])?.[index as never];
      });
      if (this.#returnArrays) return values;
      const row = Object.create(null) as Record<string, unknown>;
      names.forEach((name, index) => { row[name] = values[index]; });
      return row;
    }

    #changes(): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const capi = this.#database.sqlite.capi;
      const pointer = this.#database.handle().pointer;
      const changes = Number(capi.sqlite3_changes(pointer));
      const last = capi.sqlite3_last_insert_rowid(pointer) as bigint | number;
      return this.#readBigInts
        ? { changes: BigInt(changes), lastInsertRowid: typeof last === 'bigint' ? last : BigInt(last) }
        : { changes, lastInsertRowid: Number(last) };
    }

    #wrote(stmt: WasmStmt): boolean {
      return this.#database.sqlite.capi.sqlite3_stmt_readonly(stmt.pointer) === 0;
    }

    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const stmt = this.#bind(params);
      let wrote = false;
      try {
        wrote = this.#wrote(stmt);
        while (stmt.step()) { /* a run's rows are not read */ }
        return this.#changes();
      } catch (error) { throw sqliteError((error as Error).message); }
      finally { stmt.reset(true); this.#database.afterStatement(wrote); }
    }

    get(...params: unknown[]): unknown {
      const stmt = this.#bind(params);
      let wrote = false;
      try {
        wrote = this.#wrote(stmt);
        return stmt.step() ? this.#row(stmt) : undefined;
      } catch (error) { throw (error as { code?: string }).code ? error : sqliteError((error as Error).message); }
      finally { stmt.reset(true); this.#database.afterStatement(wrote); }
    }

    all(...params: unknown[]): unknown[] {
      const stmt = this.#bind(params);
      let wrote = false;
      try {
        wrote = this.#wrote(stmt);
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(this.#row(stmt));
        return rows;
      } catch (error) { throw (error as { code?: string }).code ? error : sqliteError((error as Error).message); }
      finally { stmt.reset(true); this.#database.afterStatement(wrote); }
    }

    *iterate(...params: unknown[]): Generator<unknown, void, unknown> {
      // Read whole before the first row is given: a write between rows (the caller's) cannot move the cursor.
      for (const row of this.all(...params)) yield row;
    }
  }

  const constants = {
    SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2,
    SQLITE_CHANGESET_DATA: 1, SQLITE_CHANGESET_NOTFOUND: 2, SQLITE_CHANGESET_CONFLICT: 3,
    SQLITE_CHANGESET_CONSTRAINT: 4, SQLITE_CHANGESET_FOREIGN_KEY: 5,
  };

  return { DatabaseSync, StatementSync, constants };
}
