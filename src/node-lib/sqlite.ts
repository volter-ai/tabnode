/**
 * `node:sqlite`: Node's synchronous SQLite API (`DatabaseSync`, `StatementSync`), over SQLite's own WebAssembly build
 * called through its C API (./sqlite-wasm.ts).
 *
 * Node links SQLite and answers `node:sqlite` from it; this engine carried none, and a program that imports it at module
 * top died at load. A database here is the file's bytes held in SQLite's memory (sqlite3_deserialize), written back
 * whole and atomically (a sibling written, then renamed over the file) after a change outside a transaction, at the end
 * of the transaction that made one, and at close; before a statement outside a transaction, a file another process has
 * rewritten since it was last read here is read again. That is SQLite's statement-level consistency between processes,
 * without its locks: two processes writing one file at the same moment can lose one's write. A WAL-mode file is read
 * as its main database file alone. `:memory:` is never written. First need: Volter Harness, whose session stores and
 * boards import `node:sqlite` at module top (card t_d4b07ea8).
 */
import { sqliteC, type SqliteC } from './sqlite-wasm';

/** The parts of the guest's `fs` this module reads and writes the database file through. */
export interface SqliteFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  renameSync(from: string, to: string): void;
  statSync(path: string): { mtimeMs: number; size: number };
}

const SQLITE_OK = 0, SQLITE_ROW = 100, SQLITE_DONE = 101;
const SQLITE_INTEGER = 1, SQLITE_FLOAT = 2, SQLITE_TEXT = 3, SQLITE_BLOB = 4, SQLITE_NULL = 5;
const SQLITE_OPEN_READWRITE = 0x2, SQLITE_OPEN_CREATE = 0x4;
const SQLITE_DESERIALIZE_FREEONCLOSE = 1, SQLITE_DESERIALIZE_RESIZEABLE = 2, SQLITE_DESERIALIZE_READONLY = 4;
const SQLITE_TRANSIENT = -1;

function sqliteError(message: string, errcode?: number): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', ...(errcode !== undefined ? { errcode, errstr: message } : {}) });
}
function invalidState(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_INVALID_STATE' });
}
function argType(message: string): TypeError {
  return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

export function createSqliteModule(fs: SqliteFs) {
  class DatabaseSync {
    #path: string;
    #readOnly: boolean;
    #foreignKeys: boolean;
    #c: SqliteC | null = null;
    #db = 0;
    #seen: { mtimeMs: number; size: number } | null = null;
    #dirty = false;
    #statements = new Set<StatementSync>();

    constructor(path: unknown, options: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {}) {
      if (typeof path !== 'string' && !(path instanceof Uint8Array) && !(path instanceof URL)) {
        throw argType('The "path" argument must be a string, Uint8Array, or URL without null bytes.');
      }
      this.#path = path instanceof URL ? decodeURIComponent(path.pathname) : typeof path === 'string' ? path : new TextDecoder().decode(path);
      this.#readOnly = options?.readOnly === true;
      this.#foreignKeys = options?.enableForeignKeyConstraints !== false;
      if (options?.open !== false) this.open();
    }

    get isOpen(): boolean { return this.#db !== 0; }
    get isTransaction(): boolean { return this.#db !== 0 && this.#c!.exports.sqlite3_get_autocommit(this.#db) === 0; }
    location(): string | null { return this.#memory() ? null : this.#path; }
    #memory(): boolean { return this.#path === ':memory:' || this.#path === ''; }

    open(): void {
      if (this.#db) throw invalidState('database is already open');
      this.#c = sqliteC();
      if (this.#readOnly && !this.#memory() && !fs.existsSync(this.#path)) throw sqliteError('unable to open database file', 14);
      this.#connect();
      // Node creates the file at open.
      if (!this.#readOnly && !this.#memory() && !fs.existsSync(this.#path)) this.#write();
    }

    /** A new in-memory connection holding the file's bytes (or none), with Node's per-connection settings. */
    #connect(): void {
      const c = this.#c!, cell = c.cell(), name = c.cString(':memory:');
      try {
        const rc = c.exports.sqlite3_open_v2(name, cell, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, 0);
        this.#db = new DataView(c.memory.buffer).getUint32(cell, true);
        if (rc !== SQLITE_OK) { const message = this.#errmsg(); c.exports.sqlite3_close_v2(this.#db); this.#db = 0; throw sqliteError(message, rc); }
      } finally { c.free(cell); c.free(name); }
      this.#load();
      if (this.#foreignKeys) this.#execRaw('PRAGMA foreign_keys = ON');
    }

    #errmsg(): string { return this.#c!.string(this.#c!.exports.sqlite3_errmsg(this.#db)) ?? 'unknown error'; }

    #load(): void {
      if (this.#memory() || !fs.existsSync(this.#path)) { this.#seen = null; return; }
      const bytes = new Uint8Array(fs.readFileSync(this.#path));
      this.#seen = this.#stat();
      if (!bytes.length) return;
      // A WAL-mode file (header bytes 18-19 are 2) is read as a rollback-journal one: its WAL is not read here.
      if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1; }
      const c = this.#c!, pointer = c.alloc(bytes), schema = c.cString('main');
      try {
        const flags = SQLITE_DESERIALIZE_FREEONCLOSE | (this.#readOnly ? SQLITE_DESERIALIZE_READONLY : SQLITE_DESERIALIZE_RESIZEABLE);
        const rc = c.exports.sqlite3_deserialize(this.#db, schema, pointer, BigInt(bytes.length), BigInt(bytes.length), flags);
        if (rc !== SQLITE_OK) throw sqliteError('file is not a database', rc);
      } finally { c.free(schema); }
    }

    #stat(): { mtimeMs: number; size: number } | null {
      try { const stat = fs.statSync(this.#path); return { mtimeMs: stat.mtimeMs, size: stat.size }; } catch { return null; }
    }

    #execRaw(sql: string): void {
      const c = this.#c!, text = c.cString(sql), error = c.cell();
      try {
        const rc = c.exports.sqlite3_exec(this.#db, text, 0, 0, error);
        if (rc !== SQLITE_OK) {
          const pointer = new DataView(c.memory.buffer).getUint32(error, true);
          const message = c.string(pointer) ?? this.#errmsg();
          c.free(pointer);
          throw sqliteError(message, rc);
        }
      } finally { c.free(text); c.free(error); }
    }

    /** Before a statement outside a transaction: the file as another process may have left it. */
    beforeStatement(): void {
      this.#require();
      if (this.#memory() || this.#dirty || this.isTransaction) return;
      const now = this.#stat(), seen = this.#seen;
      if (now && (!seen || now.mtimeMs !== seen.mtimeMs || now.size !== seen.size)) {
        for (const statement of this.#statements) statement.release();
        this.#c!.exports.sqlite3_close_v2(this.#db);
        this.#db = 0;
        this.#connect();
      }
    }

    /** After a statement: a change outside a transaction is written now; inside one, at its end. */
    afterStatement(changed: boolean): void {
      if (changed && !this.#readOnly && !this.#memory()) this.#dirty = true;
      if (this.#dirty && !this.isTransaction) this.#write();
    }

    #write(): void {
      if (this.#readOnly || this.#memory()) return;
      const c = this.#c!, size = c.cell(8), schema = c.cString('main');
      let bytes: Uint8Array;
      try {
        const pointer = c.exports.sqlite3_serialize(this.#db, schema, size, 0) as number;
        const length = Number(new DataView(c.memory.buffer).getBigInt64(size, true));
        bytes = pointer ? c.bytes(pointer, length) : new Uint8Array();
        c.free(pointer);
      } finally { c.free(size); c.free(schema); }
      const temporary = `${this.#path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, this.#path);
      this.#seen = this.#stat();
      this.#dirty = false;
    }

    #require(): number {
      if (!this.#db) throw invalidState('database is not open');
      return this.#db;
    }

    /** The open connection and SQLite, for a statement (internal). */
    connection(): { c: SqliteC; db: number } { return { c: this.#c!, db: this.#require() }; }
    track(statement: StatementSync): void { this.#statements.add(statement); }
    untrack(statement: StatementSync): void { this.#statements.delete(statement); }

    exec(sql: string): void {
      if (typeof sql !== 'string') throw argType('The "sql" argument must be a string.');
      this.beforeStatement();
      const before = this.#c!.exports.sqlite3_total_changes(this.#db);
      let changed = true;
      try { this.#execRaw(sql); changed = this.#c!.exports.sqlite3_total_changes(this.#db) !== before || !/^\s*(select|with|explain)\b/iu.test(sql); }
      finally { this.afterStatement(changed); }
    }

    prepare(sql: string): StatementSync {
      if (typeof sql !== 'string') throw argType('The "sql" argument must be a string.');
      this.beforeStatement();
      return new StatementSync(this, sql);
    }

    function(): never { throw sqliteError('DatabaseSync.function() is not available in this engine\'s node:sqlite'); }

    close(): void {
      this.#require();
      for (const statement of this.#statements) statement.release();
      this.#statements.clear();
      if (this.#dirty) this.#write();
      this.#c!.exports.sqlite3_close_v2(this.#db);
      this.#db = 0;
    }

    [Symbol.dispose](): void { if (this.#db) this.close(); }
  }

  class StatementSync {
    #database: DatabaseSync;
    #sql: string;
    #stmt = 0;
    #db = 0;
    #readBigInts = false;
    #returnArrays = false;
    #allowBareNames = true;

    constructor(database: DatabaseSync, sql: string) {
      this.#database = database;
      this.#sql = sql;
      this.#compile();
      database.track(this);
    }

    #compile(): { c: SqliteC; stmt: number; db: number } {
      const { c, db } = this.#database.connection();
      if (this.#stmt && this.#db === db) return { c, stmt: this.#stmt, db };
      const text = c.cString(this.#sql), cell = c.cell();
      try {
        const rc = c.exports.sqlite3_prepare_v2(db, text, -1, cell, 0);
        if (rc !== SQLITE_OK) throw sqliteError(c.string(c.exports.sqlite3_errmsg(db)) ?? 'prepare failed', rc);
        this.#stmt = new DataView(c.memory.buffer).getUint32(cell, true);
        this.#db = db;
      } finally { c.free(text); c.free(cell); }
      return { c, stmt: this.#stmt, db };
    }

    /** The connection was read again or closed: this statement is compiled again at its next use. */
    release(): void {
      if (this.#stmt) { try { this.#database.connection().c.exports.sqlite3_finalize(this.#stmt); } catch { /* its connection is gone */ } }
      this.#stmt = 0;
      this.#db = 0;
    }

    get sourceSQL(): string { return this.#sql; }
    get expandedSQL(): string {
      const { c, stmt } = this.#compile();
      const pointer = c.exports.sqlite3_expanded_sql(stmt) as number;
      const text = c.string(pointer) ?? this.#sql;
      c.free(pointer);
      return text;
    }

    setReadBigInts(enabled: boolean): void { this.#readBigInts = Boolean(enabled); }
    setReturnArrays(enabled: boolean): void { this.#returnArrays = Boolean(enabled); }
    setAllowBareNamedParameters(enabled: boolean): void { this.#allowBareNames = Boolean(enabled); }
    setAllowUnknownNamedParameters(): void { /* names SQLite does not have are not bound */ }

    columns(): Array<{ column: string | null; database: string | null; name: string; table: string | null; type: string | null }> {
      const { c, stmt } = this.#compile();
      const x = c.exports, count = x.sqlite3_column_count(stmt) as number;
      return Array.from({ length: count }, (_, index) => ({
        column: c.string(x.sqlite3_column_origin_name(stmt, index)),
        database: c.string(x.sqlite3_column_database_name(stmt, index)),
        name: c.string(x.sqlite3_column_name(stmt, index)) ?? '',
        table: c.string(x.sqlite3_column_table_name(stmt, index)),
        type: c.string(x.sqlite3_column_decltype(stmt, index)),
      }));
    }

    #bindOne(c: SqliteC, stmt: number, index: number, value: unknown): void {
      const x = c.exports;
      let rc: number;
      if (value === null) rc = x.sqlite3_bind_null(stmt, index);
      else if (typeof value === 'bigint') rc = x.sqlite3_bind_int64(stmt, index, value);
      else if (typeof value === 'number') rc = Number.isSafeInteger(value) ? x.sqlite3_bind_int64(stmt, index, BigInt(value)) : x.sqlite3_bind_double(stmt, index, value);
      else if (typeof value === 'string') {
        const bytes = new TextEncoder().encode(value), pointer = c.alloc(bytes);
        try { rc = x.sqlite3_bind_text(stmt, index, pointer, bytes.length, SQLITE_TRANSIENT); } finally { c.free(pointer); }
      } else if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength), pointer = c.alloc(bytes);
        try { rc = x.sqlite3_bind_blob(stmt, index, pointer, bytes.length, SQLITE_TRANSIENT); } finally { c.free(pointer); }
      } else throw argType(`Provided value cannot be bound to SQLite parameter ${index}.`);
      if (rc !== SQLITE_OK) throw sqliteError(c.string(x.sqlite3_errmsg(this.#db)) ?? 'bind failed', rc);
    }

    /** Node's binding: a leading plain object names parameters, the rest bind by position to the anonymous ones. */
    #bind(params: unknown[]): { c: SqliteC; stmt: number } {
      this.#database.beforeStatement();
      const { c, stmt } = this.#compile();
      const x = c.exports;
      x.sqlite3_reset(stmt);
      x.sqlite3_clear_bindings(stmt);
      const count = x.sqlite3_bind_parameter_count(stmt) as number;
      const names = Array.from({ length: count }, (_, i) => c.string(x.sqlite3_bind_parameter_name(stmt, i + 1)));
      let rest = params;
      const first = params[0];
      if (first !== null && typeof first === 'object' && !ArrayBuffer.isView(first) && !Array.isArray(first)) {
        rest = params.slice(1);
        for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
          let index = /^[$:@?]/u.test(key) ? names.indexOf(key) + 1 : 0;
          if (!index && this.#allowBareNames) index = names.findIndex(name => name !== null && name.slice(1) === key) + 1;
          if (!index) { if (!this.#allowBareNames) throw invalidState(`Unknown named parameter '${key}'`); continue; }
          this.#bindOne(c, stmt, index, value);
        }
      }
      const anonymous = names.flatMap((name, i) => (name === null || name.startsWith('?') ? [i + 1] : []));
      rest.forEach((value, at) => {
        const index = anonymous[at];
        if (index === undefined) throw Object.assign(new RangeError('column index out of range'), { code: 'ERR_SQLITE_ERROR' });
        this.#bindOne(c, stmt, index, value);
      });
      return { c, stmt };
    }

    #step(c: SqliteC, stmt: number): boolean {
      const rc = c.exports.sqlite3_step(stmt);
      if (rc === SQLITE_ROW) return true;
      if (rc === SQLITE_DONE) return false;
      throw sqliteError(c.string(c.exports.sqlite3_errmsg(this.#db)) ?? `step failed (${rc})`, rc);
    }

    #row(c: SqliteC, stmt: number): unknown {
      const x = c.exports, count = x.sqlite3_column_count(stmt) as number, values: unknown[] = [], names: string[] = [];
      for (let index = 0; index < count; index++) {
        names.push(c.string(x.sqlite3_column_name(stmt, index)) ?? '');
        const type = x.sqlite3_column_type(stmt, index);
        if (type === SQLITE_NULL) values.push(null);
        else if (type === SQLITE_INTEGER) {
          const value = BigInt(x.sqlite3_column_int64(stmt, index));
          if (this.#readBigInts) values.push(value);
          else if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            throw Object.assign(new RangeError(`The value of column ${index} is too large to be represented as a JavaScript number: ${value}`), { code: 'ERR_OUT_OF_RANGE' });
          } else values.push(Number(value));
        } else if (type === SQLITE_FLOAT) values.push(x.sqlite3_column_double(stmt, index));
        else if (type === SQLITE_TEXT) {
          const pointer = x.sqlite3_column_text(stmt, index), length = x.sqlite3_column_bytes(stmt, index);
          values.push(new TextDecoder().decode(c.bytes(pointer, length)));
        } else if (type === SQLITE_BLOB) {
          const pointer = x.sqlite3_column_blob(stmt, index), length = x.sqlite3_column_bytes(stmt, index);
          values.push(pointer ? c.bytes(pointer, length) : new Uint8Array());
        } else values.push(null);
      }
      if (this.#returnArrays) return values;
      const row = Object.create(null) as Record<string, unknown>;
      names.forEach((name, index) => { row[name] = values[index]; });
      return row;
    }

    #finish(c: SqliteC, stmt: number, wrote: boolean): void {
      c.exports.sqlite3_reset(stmt);
      this.#database.afterStatement(wrote);
    }

    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const { c, stmt } = this.#bind(params);
      const wrote = c.exports.sqlite3_stmt_readonly(stmt) === 0;
      try {
        while (this.#step(c, stmt)) { /* a run's rows are not read */ }
        const changes = BigInt(c.exports.sqlite3_changes64(this.#db));
        const last = BigInt(c.exports.sqlite3_last_insert_rowid(this.#db));
        return this.#readBigInts ? { changes, lastInsertRowid: last } : { changes: Number(changes), lastInsertRowid: Number(last) };
      } finally { this.#finish(c, stmt, wrote); }
    }

    get(...params: unknown[]): unknown {
      const { c, stmt } = this.#bind(params);
      const wrote = c.exports.sqlite3_stmt_readonly(stmt) === 0;
      try { return this.#step(c, stmt) ? this.#row(c, stmt) : undefined; }
      finally { this.#finish(c, stmt, wrote); }
    }

    all(...params: unknown[]): unknown[] {
      const { c, stmt } = this.#bind(params);
      const wrote = c.exports.sqlite3_stmt_readonly(stmt) === 0;
      try {
        const rows: unknown[] = [];
        while (this.#step(c, stmt)) rows.push(this.#row(c, stmt));
        return rows;
      } finally { this.#finish(c, stmt, wrote); }
    }

    *iterate(...params: unknown[]): Generator<unknown, void, unknown> {
      // Read whole before the first row is given: a write between rows cannot move the cursor under the caller.
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
