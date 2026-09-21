/**
 * A child process run to completion before the call returns, as
 * `child_process.spawnSync` and `execSync` do in Node.
 *
 * Which program died: Node's own `test/wasi` suite drives every one of its
 * fixtures through `spawnSyncAndAssert`, and generators shell out the same way
 * (`ni`, `pagefind`). What Node does: it runs the child to its end and answers
 * its status, its output and its pid. What the engine did: it answered ENOSYS,
 * because a realm has no primitive that blocks while its own loop runs the
 * child.
 *
 * What it does now: the child runs on a thread of its own, in an engine of its
 * own, and the caller blocks on shared memory until that thread reports the
 * child's end — the shape `esbuild.transformSync` already has here. The thread
 * has no filesystem of its own: every call its engine makes on the tree
 * crosses back to the caller through the same shared window and the caller,
 * still inside the synchronous call, answers it from the filesystem the parent
 * is running on. So the child reads what the parent wrote a statement ago and
 * writes what the parent reads a statement later, as two processes over one
 * filesystem do.
 *
 * What it does not cover, each answered rather than guessed at: a realm that
 * cannot block (a page's main thread, where `Atomics.wait` is refused) and a
 * realm without shared memory answer ENOSYS with the reason on the result's
 * `error`, as Node answers a child it could not start. A program the engine's
 * shell has no command for is ENOENT, as it is on a machine that does not
 * carry that binary. A child is never killed by a signal here, so `signal` is
 * always null and `options.timeout` and `options.killSignal` are not honoured;
 * a child that watches the tree sees no change, because the parent turns no
 * loop while it waits.
 */

import type { VirtualFS } from '../virtual-fs';

/** The tree a synchronous child runs on: the parent's own. */
let hostVfs: VirtualFS | null = null;
export function setSyncChildVfs(vfs: VirtualFS): void { hostVfs = vfs; }

/** The host's `process`, taken before a guest's takes the global name. */
const hostProcess = typeof process !== 'undefined' && process !== null ? (process as unknown as { getBuiltinModule?: (name: string) => unknown }) : null;

/** What a synchronous child answers when it has ended. */
export interface SyncChildResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** What a caller asks for. */
export interface SyncChildRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

const CONTROL_BYTES = 32;
/** The shared window a message crosses through; a longer message crosses in chunks. */
const DATA_BYTES = 1 << 22;
/** Where the caller reads what the thread wrote. */
const TO_PARENT = 0, TO_PARENT_LEN = 1;
/** Where the thread reads what the caller wrote. */
const TO_WORKER = 2, TO_WORKER_LEN = 3;
/** 1 once the thread runs. */
const STARTED = 4;
/**
 * How long a call waits for the thread to be running at all. A worker a realm
 * starts is started by that realm's own loop: in a browser one created and
 * then waited on inside the same synchronous call never starts, which is why
 * the thread is warmed when the shim is initialized there. A Node host starts
 * its threads itself and needs no warming.
 */
const START_WAIT_MS = 5_000;
/** How long a caller waits on one child. */
const RUN_WAIT_MS = 10 * 60_000;
/**
 * How long a caller waits for the thread to say it has the run at all. A
 * `spawnSync` for a program the tab has no binary for must answer, not wait:
 * the thread writes `begin` the moment it takes the message, before it loads
 * anything, so a thread that died, never got the message, or never reached
 * its own code releases the caller here with a reason instead of leaving it on
 * `Atomics.wait` for the whole run bound. Generous enough for a loaded
 * machine, short enough that a wedged thread is a reported error and not a
 * program that hangs with an empty console.
 */
const BEGIN_WAIT_MS = 15_000;
/**
 * How long the thread waits to load a second engine before it reports that it
 * could not. A dynamic import cannot be cancelled, but it can be raced: an
 * import that never settles (a module URL the thread's realm cannot fetch)
 * used to leave the caller blocked with nothing written at either end.
 */
const ENGINE_LOAD_WAIT_MS = 60_000;

interface SyncService {
  control: Int32Array;
  toParent: Uint8Array;
  toWorker: Uint8Array;
  worker: { postMessage(message: unknown): void; terminate(): unknown; unref?: () => void; on?: (event: string, listener: (value: unknown) => void) => unknown; onerror?: unknown };
  /** What the thread reported through its error event, where the realm's loop ran to deliver it. */
  failure?: string;
}
let service: SyncService | null = null;

/** The engine's own module, so the thread can load a second one of it. */
function engineModuleURL(): string | null {
  try {
    const url = (import.meta as unknown as { url?: string }).url;
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch { return null; }
}

/**
 * The thread a synchronous child runs on: a module worker that loads a second
 * engine, answers every filesystem call of its guest back across the window,
 * and reports the child's end. `control[TO_PARENT]` is 1 for a whole message
 * and 2 for a chunk with more to come; the receiver stores 0 to acknowledge.
 */
function workerSource(): string {
  return [
    "globalThis.__substrateSyncChildThread = true;",
    "const inNode = typeof self === 'undefined' || typeof self.postMessage !== 'function';",
    "const port = inNode ? (await import('node:worker_threads')).parentPort : self;",
    "const encoder = new TextEncoder(), decoder = new TextDecoder();",
    "let control, toParent, toWorker, engine, holdsLinks = false;",
    // A message to the caller, chunked; each chunk waits for the caller to take it.
    "function send(text) {",
    "  const bytes = encoder.encode(text); let offset = 0;",
    "  do {",
    "    const length = Math.min(bytes.length - offset, toParent.length);",
    "    toParent.set(bytes.subarray(offset, offset + length)); offset += length;",
    "    control[1] = length; const more = offset < bytes.length;",
    "    Atomics.store(control, 0, more ? 2 : 1); Atomics.notify(control, 0);",
    // A caller that has gone away is not waited on forever: the thread gives
    // up on this child rather than spinning on a window nobody reads.
    "    const until = Date.now() + " + String(RUN_WAIT_MS) + ";",
    "    while (Atomics.load(control, 0) !== 0) {",
    "      Atomics.wait(control, 0, more ? 2 : 1, 1000);",
    "      if (Atomics.load(control, 0) !== 0 && Date.now() > until) throw new Error('the caller of a synchronous child stopped reading');",
    "    }",
    "  } while (offset < bytes.length);",
    "}",
    "function receive() {",
    "  const chunks = [];",
    "  for (;;) {",
    "    const until = Date.now() + " + String(RUN_WAIT_MS) + ";",
    "    while (Atomics.load(control, 2) === 0) {",
    "      Atomics.wait(control, 2, 0, 1000);",
    "      if (Atomics.load(control, 2) === 0 && Date.now() > until) throw new Error('the caller of a synchronous child stopped answering');",
    "    }",
    "    const state = Atomics.load(control, 2);",
    "    chunks.push(toWorker.slice(0, control[3]));",
    "    Atomics.store(control, 2, 0); Atomics.notify(control, 2);",
    "    if (state !== 2) break;",
    "  }",
    "  let total = 0; for (const chunk of chunks) total += chunk.length;",
    "  const joined = new Uint8Array(total); let at = 0;",
    "  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }",
    "  return decoder.decode(joined);",
    "}",
    "function call(method, args) {",
    "  send(JSON.stringify({ t: 'fs', m: method, a: args }));",
    "  const answer = JSON.parse(receive());",
    "  if (!answer.ok) throw Object.assign(new Error(answer.e.message), answer.e);",
    "  return answer.v;",
    "}",
    "const toBytes = (b64) => { const raw = atob(b64); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; };",
    "const fromBytes = (bytes) => { let raw = ''; for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(raw); };",
    "function reviveStat(s) {",
    "  return { size: s.size, mode: s.mode, uid: 0, gid: 0, dev: 0, ino: s.ino, nlink: 1, rdev: 0, blksize: 4096, blocks: Math.ceil(s.size / 512),",
    "    mtime: new Date(s.mtimeMs), atime: new Date(s.atimeMs), ctime: new Date(s.ctimeMs), birthtime: new Date(s.birthtimeMs),",
    "    mtimeMs: s.mtimeMs, atimeMs: s.atimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs,",
    "    isFile: () => s.file, isDirectory: () => s.dir, isSymbolicLink: () => s.link,",
    "    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };",
    "}",
    "function proxyOf(VirtualFS) {",
    "  const stubs = new Map();",
    "  return class ProxyVFS extends VirtualFS {",
    "    get holdsLinks() { return holdsLinks; }",
    "    existsSync(p) { return call('existsSync', [p]); }",
    "    statSync(p) { return reviveStat(call('statSync', [p])); }",
    "    lstatSync(p) { return reviveStat(call('lstatSync', [p])); }",
    "    readFileSync(p, e) { const v = call('readFileSync', [p, typeof e === 'string' ? e : (e && e.encoding) || null]); return typeof v === 'string' ? v : toBytes(v.b64); }",
    "    writeFileSync(p, d) { return call('writeFileSync', [p, typeof d === 'string' ? d : { b64: fromBytes(d instanceof Uint8Array ? d : new Uint8Array(d)) }]); }",
    "    readdirSync(p, o) { return call('readdirSync', [p, o || null]); }",
    "    realpathSync(p) { return call('realpathSync', [p]); }",
    "    readlinkSync(p) { return call('readlinkSync', [p]); }",
    "    symlinkSync(t, p) { return call('symlinkSync', [t, p]); }",
    "    mkdirSync(p, o) { return call('mkdirSync', [p, o || null]); }",
    "    unlinkSync(p) { return call('unlinkSync', [p]); }",
    "    rmdirSync(p, o) { return call('rmdirSync', [p, o || null]); }",
    "    renameSync(a, b) { return call('renameSync', [a, b]); }",
    "    copyFileSync(a, b) { return call('copyFileSync', [a, b]); }",
    "    accessSync(p, m) { return call('accessSync', [p, typeof m === 'number' ? m : null]); }",
    // The tree's own node, which the engine reads for a file's identity and its
    // times: a stub per path, stable for the child's life.
    "    getNode(p) { if (!this.existsSync(p)) return undefined; let stub = stubs.get(p); if (!stub) { const s = this.statSync(p); stub = { type: s.isDirectory() ? 'directory' : 'file', mtime: s.mtimeMs, atime: s.atimeMs }; stubs.set(p, stub); } return stub; }",
    "    readFile(p, o, cb) { const done = typeof o === 'function' ? o : cb; const enc = typeof o === 'string' ? o : (o && o.encoding); queueMicrotask(() => { try { done(null, this.readFileSync(p, enc)); } catch (e) { done(e); } }); }",
    "    stat(p, cb) { queueMicrotask(() => { try { cb(null, this.statSync(p)); } catch (e) { cb(e); } }); }",
    "    lstat(p, cb) { queueMicrotask(() => { try { cb(null, this.lstatSync(p)); } catch (e) { cb(e); } }); }",
    "    readdir(p, o, cb) { const done = typeof o === 'function' ? o : cb; queueMicrotask(() => { try { done(null, this.readdirSync(p, typeof o === 'function' ? null : o)); } catch (e) { done(e); } }); }",
    "    realpath(p, cb) { queueMicrotask(() => { try { cb(null, this.realpathSync(p)); } catch (e) { cb(e); } }); }",
    "    access(p, m, cb) { const done = typeof m === 'function' ? m : cb; queueMicrotask(() => { try { this.accessSync(p, typeof m === 'number' ? m : undefined); done(null); } catch (e) { done(e); } }); }",
    // A child watching the tree sees nothing: the parent is inside one call and
    // turns no loop, so no change can be delivered while the child runs.
    "    watch() { const w = { close() {}, on() { return w; }, ref() { return w; }, unref() { return w; } }; return w; }",
    "    on() { return this; }",
    "    off() { return this; }",
    "  };",
    "}",
    "async function run(message) {",
    "  try {",
    // The sentinel the caller's first bound waits on: written before anything
    // that can block, so the caller learns the thread has the run.
    "    send(JSON.stringify({ t: 'begin' }));",
    "    holdsLinks = message.holdsLinks === true;",
    "    if (!engine) engine = await Promise.race([",
    "      import(message.engineURL),",
    "      new Promise((resolve, reject) => setTimeout(() => reject(new Error('the thread could not load the engine within ' + (message.loadWaitMs / 1000) + ' s from ' + message.engineURL)), message.loadWaitMs)),",
    "    ]);",
    "    const vfs = new (proxyOf(engine.VirtualFS))();",
    "    const container = engine.createContainer({ vfs, cwd: message.cwd, env: message.env });",
    "    const result = await container.run(message.command, {",
    "      cwd: message.cwd, env: message.env,",
    "      ...(typeof message.input === 'string' ? { stdin: message.input } : {}),",
    "      onStdout: (text) => send(JSON.stringify({ t: 'out', s: 1, d: String(text) })),",
    "      onStderr: (text) => send(JSON.stringify({ t: 'out', s: 2, d: String(text) })),",
    "    });",
    "    send(JSON.stringify({ t: 'done', stdout: result.stdout, stderr: result.stderr, status: result.exitCode }));",
    "  } catch (error) {",
    "    send(JSON.stringify({ t: 'failed', message: String((error && error.stack) || error) }));",
    "  }",
    "}",
    "function receiveMessage(message) {",
    "  if (message.type === 'attach') {",
    "    control = new Int32Array(message.control); toParent = new Uint8Array(message.toParent); toWorker = new Uint8Array(message.toWorker);",
    "    Atomics.store(control, 4, 1); Atomics.notify(control, 4);",
    "  } else if (message.type === 'run') { run(message); }",
    "}",
    "if (!inNode) self.onmessage = (event) => receiveMessage(event.data);",
    "else port.on('message', receiveMessage);",
  ].join('\n');
}

/** The Worker class this realm has: a browser's own, or a Node host's thread. */
function workerClass(): (new (url: unknown, options?: unknown) => SyncService['worker']) | null {
  const own = (globalThis as unknown as { Worker?: new (url: unknown, options?: unknown) => SyncService['worker'] }).Worker;
  if (typeof own === 'function') return own;
  const builtin = hostProcess && typeof hostProcess.getBuiltinModule === 'function' ? hostProcess.getBuiltinModule('worker_threads') as { Worker?: new (url: unknown, options?: unknown) => SyncService['worker'] } | undefined : undefined;
  return builtin && typeof builtin.Worker === 'function' ? builtin.Worker : null;
}

/** Whether this realm may block on shared memory at all; the reason when it may not. */
export function syncChildRefusal(): string | null {
  if (typeof SharedArrayBuffer !== 'function' || typeof Atomics === 'undefined') {
    return 'this realm has no shared memory to wait on a child with (SharedArrayBuffer is absent)';
  }
  try {
    // A wait whose value does not match returns at once; a realm that refuses
    // to block at all (a page's main thread) throws here instead.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
  } catch {
    return 'this realm cannot block on shared memory, so it cannot wait for a child (a page\'s main thread refuses Atomics.wait; a worker does not)';
  }
  if (workerClass() === null) return 'this realm cannot start a thread to run a child on (Worker is absent)';
  if (engineModuleURL() === null) return 'the engine cannot name its own module, so a thread cannot load one';
  return null;
}

/**
 * Starts the thread without waiting on it. Called when the shim is
 * initialized in a realm whose worker cannot start inside a synchronous call,
 * and by a call that finds none.
 */
export function warmSyncChild(): void {
  // A thread that is itself running a synchronous child is not given one of
  // its own before it needs it: a realm warms one thread, not one per child.
  if ((globalThis as Record<string, unknown>).__substrateSyncChildThread === true) return;
  if (service || syncChildRefusal() !== null) return;
  const WorkerClass = workerClass()!;
  const control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES));
  const toParent = new Uint8Array(new SharedArrayBuffer(DATA_BYTES));
  const toWorker = new Uint8Array(new SharedArrayBuffer(DATA_BYTES));
  const source = workerSource();
  const inBrowser = typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== 'undefined' || typeof (globalThis as Record<string, unknown>).document !== 'undefined';
  const url = inBrowser && typeof Blob === 'function' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    : new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  const worker = new WorkerClass(url, { type: 'module' });
  const started: SyncService = { control, toParent, toWorker, worker };
  const failed = (event: unknown) => { started.failure = String((event as { message?: unknown } | null)?.message ?? event); };
  if (typeof worker.on === 'function') worker.on('error', failed);
  else worker.onerror = failed;
  // A Node host is not held open by the thread.
  if (typeof worker.unref === 'function') worker.unref();
  worker.postMessage({ type: 'attach', control: control.buffer, toParent: toParent.buffer, toWorker: toWorker.buffer });
  service = started;
}

function dropService(): void {
  if (!service) return;
  try { service.worker.terminate(); } catch { /* already gone */ }
  service = null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A message to the thread, chunked; each chunk waits for the thread to take it. */
function sendToWorker(active: SyncService, text: string): void {
  const bytes = encoder.encode(text);
  let offset = 0;
  do {
    const length = Math.min(bytes.length - offset, active.toWorker.length);
    active.toWorker.set(bytes.subarray(offset, offset + length));
    offset += length;
    active.control[TO_WORKER_LEN] = length;
    const more = offset < bytes.length;
    Atomics.store(active.control, TO_WORKER, more ? 2 : 1);
    Atomics.notify(active.control, TO_WORKER);
    while (Atomics.load(active.control, TO_WORKER) !== 0) Atomics.wait(active.control, TO_WORKER, more ? 2 : 1, RUN_WAIT_MS);
  } while (offset < bytes.length);
}

/** Blocks until the thread has written a whole message, and returns it. */
function receiveFromWorker(active: SyncService, waitMs: number): string {
  const chunks: Uint8Array[] = [];
  for (;;) {
    Atomics.wait(active.control, TO_PARENT, 0, waitMs);
    const state = Atomics.load(active.control, TO_PARENT);
    if (state === 0) {
      const failure = active.failure;
      dropService();
      throw new Error(`the thread a synchronous child runs on answered nothing within ${waitMs / 1000} s${failure ? ` (${failure})` : ''}`);
    }
    chunks.push(active.toParent.slice(0, active.control[TO_PARENT_LEN]));
    Atomics.store(active.control, TO_PARENT, 0);
    Atomics.notify(active.control, TO_PARENT);
    if (state !== 2) break;
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  return decoder.decode(joined);
}

/** The tree's answer to one call the child made, in the shape JSON carries. */
function answerFilesystem(method: string, args: unknown[]): unknown {
  const vfs = hostVfs as unknown as Record<string, (...rest: unknown[]) => unknown>;
  const plain = args.map((value) => (value === null ? undefined : value));
  if (method === 'statSync' || method === 'lstatSync') {
    const stats = vfs[method]!(plain[0]) as { size: number; mode: number; mtime: Date | number; atime: Date | number; ctime: Date | number; birthtime: Date | number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
    const ms = (value: Date | number) => (value instanceof Date ? value.getTime() : Number(value) || 0);
    return {
      file: stats.isFile(), dir: stats.isDirectory(), link: stats.isSymbolicLink(),
      size: stats.size, mode: stats.mode, ino: inodeOf(String(plain[0])),
      mtimeMs: ms(stats.mtime), atimeMs: ms(stats.atime), ctimeMs: ms(stats.ctime), birthtimeMs: ms(stats.birthtime),
    };
  }
  if (method === 'readFileSync') {
    const value = vfs.readFileSync!(plain[0], plain[1]);
    return typeof value === 'string' ? value : { b64: base64(value as Uint8Array) };
  }
  if (method === 'writeFileSync') {
    const data = plain[1] as string | { b64: string };
    return vfs.writeFileSync!(plain[0], typeof data === 'string' ? data : bytes(data.b64)) ?? null;
  }
  const answer = vfs[method];
  if (typeof answer !== 'function') throw Object.assign(new Error(`ENOSYS: the tree answers no ${method}`), { code: 'ENOSYS' });
  return answer.apply(hostVfs, plain) ?? null;
}

/** A file's identity, stable for as long as the parent's tree holds it. */
const inodes = new Map<string, number>();
let nextInode = 1;
function inodeOf(path: string): number {
  let inode = inodes.get(path);
  if (inode === undefined) { inode = nextInode++; inodes.set(path, inode); }
  return inode;
}

function base64(value: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < value.length; i += 0x8000) raw += String.fromCharCode.apply(null, Array.from(value.subarray(i, i + 0x8000)));
  return btoa(raw);
}
function bytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Runs one child to its end and answers what it did. Throws only when this
 * realm cannot run a synchronous child at all; the caller turns that into the
 * result Node gives for a child it could not start.
 */
export function runSyncChild(request: SyncChildRequest): SyncChildResult {
  const refusal = syncChildRefusal();
  if (refusal !== null) throw new Error(refusal);
  if (hostVfs === null) throw new Error('the engine has no filesystem for a child to run on');
  if (!service) warmSyncChild();
  const active = service!;
  if (Atomics.load(active.control, STARTED) !== 1) {
    Atomics.wait(active.control, STARTED, 0, START_WAIT_MS);
    if (Atomics.load(active.control, STARTED) !== 1) {
      const failure = active.failure;
      dropService();
      throw new Error(`the thread a synchronous child runs on did not start within ${START_WAIT_MS / 1000} s${failure ? ` (${failure})` : ''}`);
    }
  }
  Atomics.store(active.control, TO_PARENT, 0);
  active.worker.postMessage({
    type: 'run',
    command: request.command,
    cwd: request.cwd,
    env: request.env,
    input: request.input,
    engineURL: engineModuleURL(),
    loadWaitMs: ENGINE_LOAD_WAIT_MS,
    holdsLinks: (hostVfs as unknown as { holdsLinks?: boolean }).holdsLinks === true,
  });
  let stdout = '';
  let stderr = '';
  // The first message of a run is the thread's `begin`, and it is waited for
  // on the short bound; everything after it is the child's own work on the
  // long one.
  let waitMs = BEGIN_WAIT_MS;
  for (;;) {
    const message = JSON.parse(receiveFromWorker(active, waitMs)) as
      | { t: 'begin' }
      | { t: 'fs'; m: string; a: unknown[] }
      | { t: 'out'; s: 1 | 2; d: string }
      | { t: 'done'; stdout: string; stderr: string; status: number }
      | { t: 'failed'; message: string };
    waitMs = RUN_WAIT_MS;
    if (message.t === 'begin') continue;
    if (message.t === 'fs') {
      let answer: string;
      try { answer = JSON.stringify({ ok: true, v: answerFilesystem(message.m, message.a) }); }
      catch (error) {
        const failure = error as { message?: string; code?: string; errno?: number; syscall?: string; path?: string };
        answer = JSON.stringify({ ok: false, e: { message: String(failure?.message ?? error), code: failure?.code, errno: failure?.errno, syscall: failure?.syscall, path: failure?.path } });
      }
      sendToWorker(active, answer);
      continue;
    }
    if (message.t === 'out') {
      if (message.s === 1) { stdout += message.d; request.onStdout?.(message.d); }
      else { stderr += message.d; request.onStderr?.(message.d); }
      continue;
    }
    if (message.t === 'failed') throw new Error(message.message);
    // The run's own totals win over what was streamed, as they are what the
    // command reports; a stream that already carried them is not doubled.
    return {
      status: message.status,
      signal: null,
      stdout: message.stdout.length >= stdout.length ? message.stdout : stdout,
      stderr: message.stderr.length >= stderr.length ? message.stderr : stderr,
    };
  }
}
