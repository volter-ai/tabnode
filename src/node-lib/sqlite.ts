/**
 * Node's native `node:sqlite` API over SQLite's own WebAssembly C API.
 * Only private in-memory databases are supported. A file database requires
 * SQLite's VFS and coherent locks at the descriptor owner (ADR-0006), which
 * this binding does not provide; it refuses before opening or changing files.
 */
import { sqliteC, type SqliteC } from './sqlite-wasm';
import { fileURLToPath } from '../shims/url';

export interface SqliteHost {
  resolvePath(path: string): string;
  /** The original process owns destruction; the resource never keeps it alive. */
  own(resource: { close(): void }): () => void;
}

const SQLITE_OK = 0, SQLITE_ROW = 100, SQLITE_DONE = 101;
const SQLITE_INTEGER = 1, SQLITE_FLOAT = 2, SQLITE_TEXT = 3, SQLITE_BLOB = 4, SQLITE_NULL = 5;
const SQLITE_OPEN_READWRITE = 0x2, SQLITE_OPEN_CREATE = 0x4;
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

export function createSqliteModule(host: SqliteHost) {
  class DatabaseSync {
    #path: string;
    #readOnly: boolean;
    #foreignKeys: boolean;
    #c: SqliteC | null = null;
    #db = 0;
    #location: string | null = null;
    #release: (() => void) | undefined;
    #statements = new Set<StatementSync>();

    constructor(path: unknown, options: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {}) {
      if (typeof path !== 'string' && !(path instanceof Uint8Array) && !(path instanceof URL)) {
        throw argType('The "path" argument must be a string, Uint8Array, or URL without null bytes.');
      }
      this.#path = path instanceof URL ? fileURLToPath(path) : typeof path === 'string' ? path : new TextDecoder().decode(path);
      if (this.#path.includes('\0')) throw Object.assign(new TypeError('The "path" argument must not contain null bytes.'), { code: 'ERR_INVALID_ARG_VALUE' });
      this.#readOnly = options?.readOnly === true;
      this.#foreignKeys = options?.enableForeignKeyConstraints !== false;
      if (options?.open !== false) this.open();
    }

    get isOpen(): boolean { return this.#db !== 0; }
    get isTransaction(): boolean { return this.#db !== 0 && this.#c!.exports.sqlite3_get_autocommit(this.#db) === 0; }
    location(): string | null { return this.#location; }

    open(): void {
      if (this.#db) throw invalidState('database is already open');
      // Resolve once at open, using the owning process's cwd. Never follow a
      // later chdir, and never interpret a URL differently from the fs door.
      this.#location = this.#path === ':memory:' || this.#path === '' ? null : host.resolvePath(this.#path);
      if (this.#location !== null) {
        throw Object.assign(new Error('File-backed node:sqlite is unavailable: the descriptor owner must provide SQLite VFS and coherent file locks. Use :memory: for a private database.'), { code: 'ERR_NOT_SUPPORTED' });
      }
      this.#c = sqliteC();
      this.#release = host.own({ close: () => this.#destroy() });
      try {
        this.#connect();
        if (this.#foreignKeys) this.#execRaw('PRAGMA foreign_keys = ON');
        if (this.#readOnly) this.#execRaw('PRAGMA query_only = ON');
      } catch (cause) {
        try { this.#destroy(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'SQLite open failed and cleanup failed'); }
        throw cause;
      }
    }

    #connect(): void {
      const c = this.#c!, cell = c.cell();
      let name = 0;
      try {
        name = c.cString(':memory:');
        const rc = c.exports.sqlite3_open_v2(name, cell, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, 0);
        this.#db = new DataView(c.memory.buffer).getUint32(cell, true);
        if (rc !== SQLITE_OK) throw sqliteError(this.#errmsg(), rc);
      } finally { c.free(cell); c.free(name); }
    }

    #errmsg(): string { return this.#c!.string(this.#c!.exports.sqlite3_errmsg(this.#db)) ?? 'unknown error'; }

    #execRaw(sql: string): void {
      const c = this.#c!, text = c.cString(sql);
      let error = 0;
      try {
        error = c.cell();
        const rc = c.exports.sqlite3_exec(this.#db, text, 0, 0, error);
        if (rc !== SQLITE_OK) {
          const pointer = new DataView(c.memory.buffer).getUint32(error, true);
          const message = c.string(pointer) ?? this.#errmsg();
          c.free(pointer);
          throw sqliteError(message, rc);
        }
      } finally { c.free(text); c.free(error); }
    }

    #require(): number {
      if (!this.#db) throw invalidState('database is not open');
      return this.#db;
    }

    /** The open connection and SQLite, for a statement (internal). */
    connection(): { c: SqliteC; db: number } { return { c: this.#c!, db: this.#require() }; }
    track(statement: StatementSync): void { this.#statements.add(statement); }

    exec(sql: string): void {
      if (typeof sql !== 'string') throw argType('The "sql" argument must be a string.');
      this.#require();
      this.#execRaw(sql);
    }

    prepare(sql: string): StatementSync {
      if (typeof sql !== 'string') throw argType('The "sql" argument must be a string.');
      this.#require();
      return new StatementSync(this, sql);
    }

    function(): never { throw sqliteError('DatabaseSync.function() is not available in this engine\'s node:sqlite'); }

    #destroy(): void {
      const failures: unknown[] = [];
      for (const statement of this.#statements) {
        try { statement.release(); } catch (cause) { failures.push(cause); }
      }
      this.#statements.clear();
      if (this.#db) {
        // Close and process exit roll back; neither is a commit or a writer.
        if (this.isTransaction) {
          try { this.#execRaw('ROLLBACK'); } catch (cause) { failures.push(cause); }
        }
        const rc = this.#c!.exports.sqlite3_close_v2(this.#db);
        if (rc === SQLITE_OK) this.#db = 0;
        else failures.push(sqliteError(this.#errmsg(), rc));
      }
      if (!this.#db) { this.#release?.(); this.#release = undefined; }
      if (failures.length) throw new AggregateError(failures, 'SQLite destruction failed');
    }

    close(): void { this.#require(); this.#destroy(); }
    [Symbol.dispose](): void { if (this.#db) this.#destroy(); }
  }

  class StatementSync {
    #database: DatabaseSync;
    #sql: string;
    #stmt = 0;
    #db = 0;
    #readBigInts = false;
    #returnArrays = false;
    #allowBareNames = true;
    #allowUnknownNames = false;
    #busy = false;
    #released = false;

    constructor(database: DatabaseSync, sql: string) {
      this.#database = database;
      this.#sql = sql;
      this.#compile();
      database.track(this);
    }

    #compile(): { c: SqliteC; stmt: number; db: number } {
      if (this.#released) throw invalidState('statement has been finalized');
      const { c, db } = this.#database.connection();
      if (this.#stmt && this.#db === db) return { c, stmt: this.#stmt, db };
      const text = c.cString(this.#sql);
      let cell = 0;
      try {
        cell = c.cell();
        const rc = c.exports.sqlite3_prepare_v2(db, text, -1, cell, 0);
        const prepared = new DataView(c.memory.buffer).getUint32(cell, true);
        if (rc !== SQLITE_OK) {
          if (prepared) c.exports.sqlite3_finalize(prepared);
          throw sqliteError(c.string(c.exports.sqlite3_errmsg(db)) ?? 'prepare failed', rc);
        }
        if (!prepared) throw sqliteError('SQL does not contain a statement');
        this.#stmt = prepared;
        this.#db = db;
      } finally { c.free(text); c.free(cell); }
      return { c, stmt: this.#stmt, db };
    }

    /** Destroyed by the original database owner, including process exit. */
    release(): void {
      this.#released = true;
      if (this.#stmt) {
        const stmt = this.#stmt;
        this.#stmt = 0;
        this.#db = 0;
        const { c } = this.#database.connection();
        // sqlite3_finalize destroys the statement even when returning its last
        // evaluation error; that error has already belonged to step().
        c.exports.sqlite3_finalize(stmt);
      }
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
    setAllowBareNamedParameters(enabled: boolean): void {
      if (typeof enabled !== 'boolean') throw argType('The "enabled" argument must be a boolean.');
      this.#allowBareNames = enabled;
    }
    setAllowUnknownNamedParameters(enabled: boolean): void {
      if (typeof enabled !== 'boolean') throw argType('The "enabled" argument must be a boolean.');
      this.#allowUnknownNames = enabled;
    }

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
      if (this.#busy) throw invalidState('statement is already executing');
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
          let index = names.indexOf(key) + 1;
          if (!index && this.#allowBareNames) {
            const matches = names.flatMap((name, i) => name !== null && /^[$:@]/u.test(name) && name.slice(1) === key ? [i + 1] : []);
            if (matches.length > 1) throw invalidState(`Ambiguous named parameter '${key}'`);
            index = matches[0] ?? 0;
          }
          if (!index) {
            if (!this.#allowUnknownNames) throw invalidState(`Unknown named parameter '${key}'`);
            continue;
          }
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
      if (this.#released || this.#stmt !== stmt) throw invalidState('statement has been finalized');
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

    #finish(c: SqliteC, stmt: number): void {
      if (this.#stmt === stmt) c.exports.sqlite3_reset(stmt);
    }

    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
      const { c, stmt } = this.#bind(params);
      try {
        while (this.#step(c, stmt)) { /* a run's rows are not read */ }
        const changes = BigInt(c.exports.sqlite3_changes64(this.#db));
        const last = BigInt(c.exports.sqlite3_last_insert_rowid(this.#db));
        return this.#readBigInts ? { changes, lastInsertRowid: last } : { changes: Number(changes), lastInsertRowid: Number(last) };
      } finally { this.#finish(c, stmt); }
    }

    get(...params: unknown[]): unknown {
      const { c, stmt } = this.#bind(params);
      try { return this.#step(c, stmt) ? this.#row(c, stmt) : undefined; }
      finally { this.#finish(c, stmt); }
    }

    all(...params: unknown[]): unknown[] {
      const { c, stmt } = this.#bind(params);
      try {
        const rows: unknown[] = [];
        while (this.#step(c, stmt)) rows.push(this.#row(c, stmt));
        return rows;
      } finally { this.#finish(c, stmt); }
    }

    *iterate(...params: unknown[]): Generator<unknown, void, unknown> {
      const { c, stmt } = this.#bind(params);
      this.#busy = true;
      try { while (this.#step(c, stmt)) yield this.#row(c, stmt); }
      finally { this.#busy = false; this.#finish(c, stmt); }
    }
  }

  const constants = {
    SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2,
    SQLITE_CHANGESET_DATA: 1, SQLITE_CHANGESET_NOTFOUND: 2, SQLITE_CHANGESET_CONFLICT: 3,
    SQLITE_CHANGESET_CONSTRAINT: 4, SQLITE_CHANGESET_FOREIGN_KEY: 5,
  };

  return { DatabaseSync, StatementSync, constants };
}
