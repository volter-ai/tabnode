/**
 * `node:wasi`, measured against the host's own.
 *
 * Every case a host Node can answer runs on both the host's `node:wasi` and
 * the engine's, and the two answers are compared: the constructor's argument
 * validation (codes and messages), the import object's shape, `start` and
 * `initialize`'s refusals, and a hand-built WebAssembly module that walks the
 * syscall path — path_open of an escaping path (ENOTCAPABLE), of a file in a
 * preopen, fd_read of it, fd_write to stdout, fd_prestat_get of a descriptor
 * that is not there (EBADF), proc_exit with a code — whose memory and output
 * are read back on both sides. Then the same module runs as a guest program
 * of the engine through `require('node:wasi')`, so the wiring is exercised
 * too, not only the class.
 */
import { describe, it, expect } from 'vitest';
import { WASI as HostWASI } from 'node:wasi';
import * as hostFs from 'node:fs';
import * as os from 'node:os';
import * as hostPath from 'node:path';
import { VirtualFS } from '../src/virtual-fs';
import { createFsShim } from '../src/shims/fs';
import { createProcess } from '../src/shims/process';
import { createWasiModule, type WasiHostFs } from '../src/shims/wasi';
import { createContainer } from '../src/index';

// ---------------------------------------------------------------------------
// A WebAssembly encoder small enough to read: the sections the module needs.
// ---------------------------------------------------------------------------

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function sleb(value: number | bigint): number[] {
  let rest = BigInt(value);
  const out: number[] = [];
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];
const name = (text: string): number[] => [...uleb(utf8(text).length), ...utf8(text)];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

const I32 = 0x7f;
const I64 = 0x7e;
const type = (params: number[], results: number[]): number[] => [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];

// Instructions.
const i32c = (value: number): number[] => [0x41, ...sleb(value)];
const i64c = (value: bigint): number[] => [0x42, ...sleb(value)];
const call = (index: number): number[] => [0x10, ...uleb(index)];
const i32store = [0x36, 0x02, 0x00];
const i32load = [0x28, 0x02, 0x00];
const END = 0x0b;

/** Addresses in the guest's memory the module and the test agree on. */
const AT = {
  escapePath: 100, filePath: 120, greeting: 140, iovOut: 160, iovIn: 168, prestat: 180,
  errnoEscape: 1000, errnoOpen: 1004, openedFd: 1008, errnoWrite: 1012, nwritten: 1016, errnoPrestat: 1020,
  errnoRead: 1024, nread: 1028, readBuffer: 2000,
} as const;
const ESCAPE_PATH = '../escape.txt';
const FILE_PATH = 'hello.txt';
const GREETING = 'hi\n';
const FILE_CONTENT = 'hello from the preopen';
const EXIT_CODE = 7;
const RIGHT_FD_READ = 2n;

/**
 * A module importing five syscalls and exporting `memory` and `_start`, whose
 * `_start` records what each syscall answered.
 */
function buildModule(): Uint8Array {
  // Function indices: imports first, in order; then _start.
  const [PATH_OPEN, FD_WRITE, FD_PRESTAT_GET, FD_READ, PROC_EXIT, START] = [0, 1, 2, 3, 4, 5];
  const types = [
    type([I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]), // path_open
    type([I32, I32, I32, I32], [I32]), // fd_write, fd_read
    type([I32, I32], [I32]), // fd_prestat_get
    type([I32], []), // proc_exit
    type([], []), // _start
  ];
  const imports = [
    [...name('wasi_snapshot_preview1'), ...name('path_open'), 0x00, ...uleb(0)],
    [...name('wasi_snapshot_preview1'), ...name('fd_write'), 0x00, ...uleb(1)],
    [...name('wasi_snapshot_preview1'), ...name('fd_prestat_get'), 0x00, ...uleb(2)],
    [...name('wasi_snapshot_preview1'), ...name('fd_read'), 0x00, ...uleb(1)],
    [...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0x00, ...uleb(3)],
  ];
  const body = [
    // errnoEscape = path_open(3, 0, "../escape.txt", len, 0, FD_READ, 0, 0, &openedFd)
    ...i32c(AT.errnoEscape),
    ...i32c(3), ...i32c(0), ...i32c(AT.escapePath), ...i32c(ESCAPE_PATH.length), ...i32c(0), ...i64c(RIGHT_FD_READ), ...i64c(0n), ...i32c(0), ...i32c(AT.openedFd),
    ...call(PATH_OPEN), ...i32store,
    // errnoOpen = path_open(3, 0, "hello.txt", len, 0, FD_READ, 0, 0, &openedFd)
    ...i32c(AT.errnoOpen),
    ...i32c(3), ...i32c(0), ...i32c(AT.filePath), ...i32c(FILE_PATH.length), ...i32c(0), ...i64c(RIGHT_FD_READ), ...i64c(0n), ...i32c(0), ...i32c(AT.openedFd),
    ...call(PATH_OPEN), ...i32store,
    // errnoRead = fd_read(openedFd, &iovIn, 1, &nread)
    ...i32c(AT.errnoRead),
    ...i32c(AT.openedFd), ...i32load, ...i32c(AT.iovIn), ...i32c(1), ...i32c(AT.nread),
    ...call(FD_READ), ...i32store,
    // errnoWrite = fd_write(1, &iovOut, 1, &nwritten)
    ...i32c(AT.errnoWrite),
    ...i32c(1), ...i32c(AT.iovOut), ...i32c(1), ...i32c(AT.nwritten),
    ...call(FD_WRITE), ...i32store,
    // errnoPrestat = fd_prestat_get(9, &prestat)
    ...i32c(AT.errnoPrestat),
    ...i32c(9), ...i32c(AT.prestat),
    ...call(FD_PRESTAT_GET), ...i32store,
    // proc_exit(EXIT_CODE)
    ...i32c(EXIT_CODE), ...call(PROC_EXIT),
    END,
  ];
  const code = [...uleb(body.length + 1), ...uleb(0), ...body];
  const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  const data = (at: number, bytes: number[]): number[] => [0x00, ...i32c(at), END, ...uleb(bytes.length), ...bytes];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec([uleb(4)])),
    ...section(5, vec([[0x00, ...uleb(1)]])),
    ...section(7, vec([[...name('memory'), 0x02, ...uleb(0)], [...name('_start'), 0x00, ...uleb(START)]])),
    ...section(10, vec([code])),
    ...section(11, vec([
      data(AT.escapePath, utf8(ESCAPE_PATH)),
      data(AT.filePath, utf8(FILE_PATH)),
      data(AT.greeting, utf8(GREETING)),
      data(AT.iovOut, [...le32(AT.greeting), ...le32(GREETING.length)]),
      data(AT.iovIn, [...le32(AT.readBuffer), ...le32(64)]),
    ])),
  ];
  return new Uint8Array(bytes);
}

/** What a run of the module leaves behind, read the same way on both sides. */
interface Outcome {
  exitCode: number;
  errnos: { escape: number; open: number; read: number; write: number; prestat: number };
  openedFd: number;
  nread: number;
  read: string;
  nwritten: number;
  stdout: string;
}

function outcomeOf(memory: WebAssembly.Memory, exitCode: number, stdout: string): Outcome {
  const view = new DataView(memory.buffer);
  const nread = view.getUint32(AT.nread, true);
  return {
    exitCode,
    errnos: {
      escape: view.getUint32(AT.errnoEscape, true),
      open: view.getUint32(AT.errnoOpen, true),
      read: view.getUint32(AT.errnoRead, true),
      write: view.getUint32(AT.errnoWrite, true),
      prestat: view.getUint32(AT.errnoPrestat, true),
    },
    openedFd: view.getUint32(AT.openedFd, true),
    nread,
    read: new TextDecoder().decode(new Uint8Array(memory.buffer, AT.readBuffer, nread)),
    nwritten: view.getUint32(AT.nwritten, true),
    stdout,
  };
}

// ---------------------------------------------------------------------------
// The two sides.
// ---------------------------------------------------------------------------

type AnyWASI = new (options?: unknown) => { wasiImport: Record<string, unknown>; start(instance: unknown): number; initialize(instance: unknown): void; getImportObject(): Record<string, Record<string, unknown>> };

function engineSide() {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/sandbox', { recursive: true });
  vfs.writeFileSync('/sandbox/hello.txt', FILE_CONTENT);
  vfs.writeFileSync('/escape.txt', 'must not be reachable');
  vfs.writeFileSync('/stdin.txt', '');
  let stderr = '';
  const process = createProcess({ cwd: '/', onStdout: () => {}, onStderr: (text) => { stderr += text; } });
  const fs = createFsShim(vfs, () => process.cwd());
  const { WASI } = createWasiModule(fs as unknown as WasiHostFs, process);
  return { WASI: WASI as unknown as AnyWASI, fs: fs as unknown as WasiHostFs, vfs, process, stderr: () => stderr, sandbox: '/sandbox', stdoutFile: '/stdout.txt', stdinFile: '/stdin.txt' };
}

function hostSide() {
  const root = hostFs.mkdtempSync(hostPath.join(os.tmpdir(), 'engine-wasi-'));
  const sandbox = hostPath.join(root, 'sandbox');
  hostFs.mkdirSync(sandbox);
  hostFs.writeFileSync(hostPath.join(sandbox, 'hello.txt'), FILE_CONTENT);
  hostFs.writeFileSync(hostPath.join(root, 'escape.txt'), 'must not be reachable');
  hostFs.writeFileSync(hostPath.join(root, 'stdin.txt'), '');
  return { WASI: HostWASI as unknown as AnyWASI, fs: hostFs as unknown as WasiHostFs, sandbox, stdoutFile: hostPath.join(root, 'stdout.txt'), stdinFile: hostPath.join(root, 'stdin.txt'), root };
}

function thrown(fn: () => unknown): { code?: string; message: string; name: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    const e = error as Error & { code?: string };
    return { code: e.code, message: e.message, name: e.name };
  }
}

function runModule(side: { WASI: AnyWASI; fs: WasiHostFs; sandbox: string; stdoutFile: string }): Promise<Outcome> {
  return (async () => {
    const stdout = side.fs.openSync(side.stdoutFile, 'w');
    const wasi = new side.WASI({ version: 'preview1', preopens: { '/sandbox': side.sandbox }, stdout, returnOnExit: true });
    const { instance } = await WebAssembly.instantiate(buildModule(), wasi.getImportObject());
    const exitCode = wasi.start(instance);
    side.fs.closeSync(stdout);
    const written = readWhole(side.fs, side.stdoutFile);
    return outcomeOf((instance.exports as { memory: WebAssembly.Memory }).memory, exitCode, written);
  })();
}

function readWhole(fs: WasiHostFs, path: string): string {
  const fd = fs.openSync(path, 'r');
  const size = fs.fstatSync(fd).size;
  const buffer = new Uint8Array(size);
  fs.readSync(fd, buffer, 0, size, 0);
  fs.closeSync(fd);
  return new TextDecoder().decode(buffer);
}

const bothSides = () => ({ host: hostSide(), engine: engineSide() });

// ---------------------------------------------------------------------------
// The differential.
// ---------------------------------------------------------------------------

describe('node:wasi against the host', () => {
  it('validates the constructor options as Node does, code and message alike', () => {
    const { host, engine } = bothSides();
    const cases: Array<[string, unknown]> = [
      ['no options', undefined],
      ['null options', null],
      ['a string for options', 'foo'],
      ['a number for options', 0],
      ['a boolean for options', true],
      ['a function for options', () => {}],
      ['no version', {}],
      ['a non-string version', { version: { x: 'y' } }],
      ['an unknown version', { version: 'not_a_version' }],
      ['args not an array', { version: 'preview1', args: 'fhqwhgads' }],
      ['env not an object', { version: 'preview1', env: 'fhqwhgads' }],
      ['preopens not an object', { version: 'preview1', preopens: 'fhqwhgads' }],
      ['returnOnExit not a boolean', { version: 'preview1', returnOnExit: 'fhqwhgads' }],
      ['stdin not an int32', { version: 'preview1', stdin: 'fhqwhgads' }],
      ['stdout negative', { version: 'preview1', stdout: -1 }],
      ['stderr fractional', { version: 'preview1', stderr: 1.5 }],
      ['a preopen that is not there', { version: 'preview1', preopens: { '/sandbox': '__/not/real/path' } }],
    ];
    for (const [label, options] of cases) {
      const fromHost = thrown(() => new host.WASI(options));
      const fromEngine = thrown(() => new engine.WASI(options));
      expect(fromEngine, label).toEqual(fromHost);
      expect(fromHost, label).not.toBeNull();
    }
    // And what is accepted is accepted on both sides.
    expect(thrown(() => new engine.WASI({ version: 'preview1' }))).toBeNull();
    expect(thrown(() => new engine.WASI({ version: 'unstable' }))).toBeNull();
    expect(thrown(() => new engine.WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: false }))).toBeNull();
    // A preopen that is a file, not a directory: the host's answer is the measure.
    expect(thrown(() => new engine.WASI({ version: 'preview1', preopens: { '/f': '/sandbox/hello.txt' } })))
      .toEqual(thrown(() => new host.WASI({ version: 'preview1', preopens: { '/f': hostPath.join(host.sandbox, 'hello.txt') } })));
  });

  it('exposes the same import object: the same syscalls, in the same shape, under the same names', () => {
    const { host, engine } = bothSides();
    const fromHost = new host.WASI({ version: 'preview1' });
    const fromEngine = new engine.WASI({ version: 'preview1' });
    expect(Object.keys(fromEngine.wasiImport)).toEqual(Object.keys(fromHost.wasiImport));
    expect(Object.keys(fromEngine.getImportObject())).toEqual(Object.keys(fromHost.getImportObject()));
    expect(fromEngine.getImportObject().wasi_snapshot_preview1).toBe(fromEngine.wasiImport);
    expect(Object.keys(new engine.WASI({ version: 'unstable' }).getImportObject())).toEqual(['wasi_unstable']);
    expect(fromEngine.wasiImport.constructor.name).toBe(fromHost.wasiImport.constructor.name);
    expect(typeof fromEngine.wasiImport._setMemory).toBe(typeof fromHost.wasiImport._setMemory);
    for (const key of Object.keys(fromHost.wasiImport)) expect(typeof fromEngine.wasiImport[key], key).toBe('function');
    expect(Object.keys(fromEngine)).toEqual(Object.keys(fromHost));
  });

  it('refuses a syscall before start as Node does', () => {
    const { host, engine } = bothSides();
    const call = (side: { WASI: AnyWASI }) => thrown(() => (new side.WASI({ version: 'preview1' }).wasiImport.fd_write as (...args: number[]) => number)(1, 0, 0, 0));
    expect(call(engine)).toEqual(call(host));
    expect(call(host)?.code).toBe('ERR_WASI_NOT_STARTED');
    // The wrong number of arguments is EINVAL, not a throw, on both.
    const short = (side: { WASI: AnyWASI }) => (new side.WASI({ version: 'preview1' }).wasiImport.fd_write as (...args: number[]) => number)(1, 0);
    expect(short(engine)).toBe(short(host));
  });

  it('validates start() and initialize() as Node does', async () => {
    const { host, engine } = bothSides();
    const memory = () => new WebAssembly.Memory({ initial: 1 });
    const scenarios: Array<[string, (wasi: InstanceType<AnyWASI>) => void]> = [
      ['start without an instance', (wasi) => wasi.start(undefined)],
      ['start with null exports', (wasi) => wasi.start({ exports: null })],
      ['start without _start', (wasi) => wasi.start({ exports: { memory: memory() } })],
      ['start with _initialize too', (wasi) => wasi.start({ exports: { _start() {}, _initialize() {}, memory: memory() } })],
      ['start without memory', (wasi) => wasi.start({ exports: { _start() {} } })],
      ['start with a memory that is not one', (wasi) => wasi.start({ exports: { _start() {}, memory: {} } })],
      ['start twice', (wasi) => { wasi.start({ exports: { _start() {}, memory: memory() } }); wasi.start({ exports: { _start() {}, memory: memory() } }); }],
      ['initialize without an instance', (wasi) => wasi.initialize(undefined)],
      ['initialize with a non-function _initialize', (wasi) => wasi.initialize({ exports: { _initialize: 5, memory: memory() } })],
      ['initialize with _start too', (wasi) => wasi.initialize({ exports: { _start() {}, _initialize() {}, memory: memory() } })],
      ['initialize without memory', (wasi) => wasi.initialize({ exports: { _initialize() {} } })],
      ['initialize twice', (wasi) => { wasi.initialize({ exports: { _initialize() {}, memory: memory() } }); wasi.initialize({ exports: { _initialize() {}, memory: memory() } }); }],
      ['initialize without _initialize is fine', (wasi) => wasi.initialize({ exports: { memory: memory() } })],
      ['start of a program that returns is fine', (wasi) => wasi.start({ exports: { _start() {}, memory: memory() } })],
    ];
    for (const [label, scenario] of scenarios) {
      const fromHost = thrown(() => scenario(new host.WASI({ version: 'preview1' })));
      const fromEngine = thrown(() => scenario(new engine.WASI({ version: 'preview1' })));
      expect(fromEngine, label).toEqual(fromHost);
    }
    // An error a program throws out of _start reaches the caller, and a
    // patched proc_exit is honoured, on both. The module runs here with no
    // preopens, so both its path_opens answer EBADF and the descriptor it then
    // reads is the 0 it left in memory: standard input. `stdin` is an empty
    // file on each side, because the host's real stdin under a test runner is a
    // pipe nobody writes to and uvwasi's fd_read of it blocks the thread
    // outright — no test timeout can interrupt a blocking read, and the suite
    // could not finish.
    for (const side of [host, engine]) {
      const stdin = side.fs.openSync(side.stdinFile, 'r');
      const wasi = new side.WASI({ version: 'preview1', returnOnExit: true, stdin });
      wasi.wasiImport.proc_exit = () => { throw new Error('test error'); };
      const { instance } = await WebAssembly.instantiate(buildModule(), wasi.getImportObject());
      expect(thrown(() => wasi.start(instance))?.message).toBe('test error');
      side.fs.closeSync(stdin);
    }
  });

  it('runs a hand-built module through the syscalls with the same errnos, bytes and exit code', async () => {
    const { host, engine } = bothSides();
    const fromHost = await runModule(host);
    const fromEngine = await runModule(engine);
    expect(fromEngine).toEqual(fromHost);
    // And the values themselves, so a wrong answer on both sides cannot pass.
    expect(fromHost.exitCode).toBe(EXIT_CODE);
    expect(fromHost.errnos).toEqual({ escape: 76, open: 0, read: 0, write: 0, prestat: 8 });
    expect(fromHost.openedFd).toBe(4);
    expect(fromHost.read).toBe(FILE_CONTENT);
    expect(fromHost.nwritten).toBe(GREETING.length);
    expect(fromHost.stdout).toBe(GREETING);
  });
});

describe('node:wasi as a guest program of the engine', () => {
  it('is required by name, listed as a builtin, and runs the module over the guest stdio', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app/sandbox', { recursive: true });
    vfs.writeFileSync('/app/sandbox/hello.txt', FILE_CONTENT);
    vfs.writeFileSync('/app/module.wasm', buildModule());
    vfs.writeFileSync('/app/run.cjs', `
      const assert = require('assert');
      const warnings = [];
      process.on('warning', (warning) => warnings.push(warning.name));
      const { WASI } = require('node:wasi');
      assert.strictEqual(require('wasi').WASI, WASI);
      assert.ok(require('module').builtinModules.includes('wasi'));
      assert.strictEqual(process.getBuiltinModule('node:wasi').WASI, WASI);
      const wasi = new WASI({ version: 'preview1', preopens: { '/sandbox': '/app/sandbox' }, args: ['a', 'b'], env: { K: 'v' } });
      const bytes = require('fs').readFileSync('/app/module.wasm');
      // Awaited, which is the shape every one of Node's WASI tests uses: the
      // host work a guest waits on holds the run while it is in flight.
      WebAssembly.instantiate(bytes, wasi.getImportObject()).then(({ instance }) => {
        const code = wasi.start(instance);
        const view = new DataView(instance.exports.memory.buffer);
        const nread = view.getUint32(${AT.nread}, true);
        const read = new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, ${AT.readBuffer}, nread));
        setTimeout(() => {
          process.stdout.write('RESULT ' + JSON.stringify({ code, escape: view.getUint32(${AT.errnoEscape}, true), prestat: view.getUint32(${AT.errnoPrestat}, true), read, warnings }) + '\\n');
        }, 0);
      });
    `);
    const container = createContainer({ vfs });
    let stdout = '';
    const result = await container.run('node /app/run.cjs', { cwd: '/app', onStdout: (text) => { stdout += text; } });
    expect(result.exitCode, stdout + result.stderr).toBe(0);
    expect(stdout.startsWith(GREETING), JSON.stringify(stdout)).toBe(true);
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    expect(line, stdout).toBeDefined();
    expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({ code: EXIT_CODE, escape: 76, prestat: 8, read: FILE_CONTENT, warnings: ['ExperimentalWarning'] });
  }, 20_000);
});
