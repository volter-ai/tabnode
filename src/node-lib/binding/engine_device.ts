/**
 * THE ENGINE DEVICE, AS THE crypto BINDING REACHES IT (ADR-0018 §5, item 7; browser-substrate ADR-0236 hole 12). The
 * machine's WebCrypto is a device of the machine: `/dev/engine`, whose driver is the kernel's
 * (browser-substrate `packages/wali/linux/arch/wasm/kernel/engine.c`) and whose device is the machine's own thread,
 * which runs each of SubtleCrypto's calls (`host/machine.mjs` `engineCall`, `engineEncode`). The process's session is
 * one descriptor of the `node` program's (`native/node/engine_device.c`), opened at the binding's first device call;
 * the keys the device makes stay in the session as handles, as a hardware key store keeps them, until the process lets
 * each go (`forget`) or the session ends with the process.
 *
 * The wire is the device's (the substrate's one other client, `packages/node/src/linux-web-crypto.ts`, writes the
 * same): a request is its tag and its answer's room (a u32 each), its call's JSON length (a u32), its JSON
 * (`{ call, args }`, a buffer as `{ $b: [offset, length] }` into the bytes after the JSON, undefined as `{ $u: 1 }`,
 * a key as `{ $k: handle }`), then its bytes; an answer is its tag, its status (0 fulfilled, 1 refused by the browser,
 * else -errno) and its length, then its JSON's length, its JSON and its bytes, an ArrayBuffer as `$b`, a view as
 * `$u8`, a key as `{ $k, type, extractable, algorithm, usages }`.
 *
 * A synchronous call blocks in Linux on the descriptor (`tabnode_engine_wait`, a poll, then the read), as a blocking
 * read of any device waits, while the machine's thread answers it; an asynchronous call's answer is due while the
 * descriptor is a uv_poll_t of the loop (`tabnode_engine_watch`), and its readiness is the engine's `engine_ready`
 * import, followed by a drain, so the call settles in the poll phase as a threadpool completion does. Answers come
 * in any order, so whichever call reads one gives it to the call its tag names.
 *
 * The device takes a request and writes an answer of at most 1 MiB (`WASM_ENGINE_BYTES`): a call larger is refused
 * here, by name, before it is written (browser-substrate ADR-0236 hole 12's open item); it is never split.
 */
import { address, libnode } from './libnode';

/** The device's bound on a request's call and on an answer (engine.c `WASM_ENGINE_BYTES`). */
export const ENGINE_BYTES = 1 << 20;
/** A request's header (its tag, its answer's room) and its JSON's length. */
const ASKED = 12;
/** A read's header (engine.c `struct wasm_engine_header`): the tag, the status, the length. */
const HEADER = 12;
const POLLIN = 0x1, POLLOUT = 0x4;
const EAGAIN = -11;
const FULFILLED = 0, REFUSED = 1;

/** The device's exports of the program (native/node/engine_device.c). */
interface DeviceExports {
  tabnode_engine_open(): number;
  tabnode_engine_write(fd: number, at: number, length: number): number;
  tabnode_engine_read(fd: number, at: number, room: number): number;
  tabnode_engine_wait(fd: number, events: number): number;
  tabnode_engine_watch(fd: number): number;
  tabnode_engine_unwatch(): void;
  tabnode_malloc(size: number): number;
  tabnode_free(at: number): void;
}

/** SubtleCrypto's calls the device runs (host/machine.mjs `ENGINE_CALLS`), and its own `forget`. */
export type EngineCall = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'digest' | 'generateKey' | 'deriveKey'
  | 'deriveBits' | 'importKey' | 'exportKey' | 'wrapKey' | 'unwrapKey' | 'forget';

/** A key the device holds: its handle in the session, and its description as the device gave it. */
export interface EngineKey {
  readonly handle: number;
  readonly type: 'secret' | 'public' | 'private';
  readonly extractable: boolean;
  readonly algorithm: Record<string, unknown>;
  readonly usages: string[];
}

interface Answer { status: number; bytes: Uint8Array }

/** An error the device answers with: the browser's (a DOMException, a TypeError), or the descriptor's errno. */
function deviceError(answer: Answer, value: unknown): Error {
  if (answer.status < 0) {
    return Object.assign(new Error(`engine device: ${-answer.status}`), { errno: answer.status, syscall: 'read' });
  }
  const { name, message, code, dom } = value as { name: string; message: string; code?: string; dom?: boolean };
  const Language = ({ TypeError, RangeError, SyntaxError } as Record<string, new (text: string) => Error>)[name] ?? Error;
  const DOMExceptionClass = (globalThis as unknown as { DOMException: new (text: string, kind: string) => Error }).DOMException;
  const error = dom ? new DOMExceptionClass(message, name) : new Language(message);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

class EngineSession {
  private fd = -1;
  private nextTag = 1;
  private readonly due = new Map<number, (answer: Answer) => void>();
  /** Answers read by a call they were not for, kept for theirs. */
  private readonly read = new Map<number, Answer>();
  private watching = false;
  /** Each key the process holds, let go when its object is collected. */
  private readonly keys = new FinalizationRegistry<number>((handle) => {
    void this.callAsync('forget', [handle]).catch(() => {});
  });

  private exports(): DeviceExports { return libnode().exports as unknown as DeviceExports; }

  private descriptor(): number {
    if (this.fd >= 0) return this.fd;
    const fd = this.exports().tabnode_engine_open();
    if (fd < 0) throw Object.assign(new Error(`open /dev/engine: ${-fd}`), { errno: fd, syscall: 'open', path: '/dev/engine' });
    return this.fd = fd;
  }

  /** `call` answered before this returns: the process blocks in Linux on the device's descriptor. */
  callSync(call: EngineCall, args: readonly unknown[]): unknown {
    const tag = this.write(call, args, true);
    for (;;) {
      const mine = this.read.get(tag);
      if (mine) { this.read.delete(tag); return this.value(mine); }
      this.exports().tabnode_engine_wait(this.fd, POLLIN);
      this.drainAnswers();
    }
  }

  /** `call`, answered in the loop's poll phase once the device has answered it. */
  callAsync(call: EngineCall, args: readonly unknown[]): Promise<unknown> {
    let tag: number;
    try { tag = this.write(call, args, false); } catch (error) { return Promise.reject(error); }
    const answered = new Promise<Answer>((resolve) => { this.due.set(tag, resolve); });
    this.watch();
    return answered.then((answer) => this.value(answer));
  }

  /** The request written; a synchronous call waits for room as a blocking writer waits, an asynchronous one too. */
  private write(call: EngineCall, args: readonly unknown[], _sync: boolean): number {
    const fd = this.descriptor();
    const tag = this.nextTag++ >>> 0;
    const request = encodeRequest(tag, call, args);
    const program = libnode();
    const at = address(this.exports().tabnode_malloc(request.byteLength));
    try {
      program.write(at, request);
      for (;;) {
        const wrote = this.exports().tabnode_engine_write(fd, at, request.byteLength);
        if (wrote === request.byteLength) return tag;
        if (wrote === EAGAIN) { this.exports().tabnode_engine_wait(fd, POLLOUT); continue; }
        throw Object.assign(new Error(`write /dev/engine: ${-wrote}`), { errno: wrote, syscall: 'write', path: '/dev/engine' });
      }
    } finally {
      this.exports().tabnode_free(at);
    }
  }

  /** Every answer that waits read, each given to the call it answers. */
  private drainAnswers(): void {
    const room = ENGINE_BYTES + HEADER;
    const at = address(this.exports().tabnode_malloc(room));
    try {
      for (;;) {
        const length = this.exports().tabnode_engine_read(this.fd, at, room);
        if (length === EAGAIN) return;
        if (length < 0) throw Object.assign(new Error(`read /dev/engine: ${-length}`), { errno: length, syscall: 'read' });
        const bytes = libnode().read(at, length);
        const view = new DataView(bytes.buffer, bytes.byteOffset, length);
        const tag = view.getUint32(0, true);
        const answer = { status: view.getInt32(4, true), bytes: bytes.slice(HEADER, length) };
        const settle = this.due.get(tag);
        if (settle) { this.due.delete(tag); settle(answer); } else this.read.set(tag, answer);
      }
    } finally {
      this.exports().tabnode_free(at);
      this.watch();
    }
  }

  /** The descriptor a wait of the loop's exactly while an asynchronous call's answer is due. */
  private watch(): void {
    const wanted = this.due.size > 0;
    if (wanted === this.watching) return;
    this.watching = wanted;
    if (wanted) this.exports().tabnode_engine_watch(this.fd);
    else this.exports().tabnode_engine_unwatch();
  }

  /** The loop found the descriptor readable (`engine_ready`). */
  ready(status: number): void {
    if (status < 0) {
      const failed = { status, bytes: new Uint8Array(0) };
      for (const [tag, settle] of this.due) { this.due.delete(tag); settle(failed); }
      this.watch();
      return;
    }
    this.drainAnswers();
  }

  /** An answer's value, or the browser's error. */
  private value(answer: Answer): unknown {
    if (answer.status < 0) throw deviceError(answer, null);
    const { bytes } = answer;
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    if (answer.status === REFUSED) throw deviceError(answer, value);
    if (answer.status !== FULFILLED) throw deviceError({ status: -5, bytes }, null);
    const blob = bytes.subarray(4 + length);
    const decode = (member: unknown): unknown => {
      if (Array.isArray(member)) return member.map(decode);
      if (member === null || typeof member !== 'object') return member;
      const record = member as Record<string, unknown>;
      const range = (Array.isArray(record.$b) ? record.$b : record.$u8) as [number, number] | undefined;
      if (range) {
        const copy = blob.slice(range[0], range[0] + range[1]);
        return record.$b ? copy.buffer : copy;
      }
      if (typeof record.$k === 'number') {
        const key: EngineKey = {
          handle: record.$k, type: record.type as EngineKey['type'], extractable: record.extractable as boolean,
          algorithm: decode(record.algorithm) as Record<string, unknown>, usages: record.usages as string[],
        };
        this.keys.register(key, key.handle);
        return key;
      }
      return Object.fromEntries(Object.entries(record).map(([name, inner]) => [name, decode(inner)]));
    };
    return decode(value);
  }
}

/** The keys this process's session holds, as the request's `$k` names them. */
const deviceKeys = new WeakSet<object>();

/** A request as the device reads it (host/machine.mjs `engineCall`). */
function encodeRequest(tag: number, call: EngineCall, args: readonly unknown[]): Uint8Array {
  const blobs: Uint8Array[] = [];
  let size = 0;
  const encode = (value: unknown): unknown => {
    if (value === undefined) return { $u: 1 };
    if (typeof value === 'object' && value !== null && deviceKeys.has(value)) return { $k: (value as EngineKey).handle };
    const bytes = value instanceof ArrayBuffer || value instanceof SharedArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (bytes) { blobs.push(bytes.slice()); size += bytes.byteLength; return { $b: [size - bytes.byteLength, bytes.byteLength] }; }
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, encode(member)]));
    }
    return value;
  };
  const json = new TextEncoder().encode(JSON.stringify({ call, args: args.map(encode) }));
  const request = new Uint8Array(ASKED + json.byteLength + size);
  if (request.byteLength - 8 > ENGINE_BYTES) {
    throw Object.assign(new RangeError(`the engine device takes a call of at most ${ENGINE_BYTES} bytes`),
      { code: 'ERR_OUT_OF_RANGE' });
  }
  const view = new DataView(request.buffer);
  view.setUint32(0, tag, true);
  view.setUint32(4, ENGINE_BYTES, true);
  view.setUint32(8, json.byteLength, true);
  request.set(json, ASKED);
  let at = ASKED + json.byteLength;
  for (const blob of blobs) { request.set(blob, at); at += blob.byteLength; }
  return request;
}

let session: EngineSession | undefined;
/** The process's session on the device, made at its first call. */
function engineSession(): EngineSession { return session ??= new EngineSession(); }

/** A key the device answered marks itself as one of the session's (so a request names it by `$k`). */
function marked(value: unknown): unknown {
  const visit = (member: unknown): void => {
    if (member === null || typeof member !== 'object') return;
    if (typeof (member as EngineKey).handle === 'number' && 'usages' in member) { deviceKeys.add(member); return; }
    if (Array.isArray(member)) member.forEach(visit);
    else if (!(member instanceof ArrayBuffer) && !ArrayBuffer.isView(member)) Object.values(member).forEach(visit);
  };
  visit(value);
  return value;
}

/** A device call answered before it returns (the binding's synchronous form). */
export function engineCallSync(call: EngineCall, args: readonly unknown[]): unknown {
  return marked(engineSession().callSync(call, args));
}

/** A device call answered in the loop's poll phase (the binding's asynchronous and WebCrypto forms). */
export function engineCallAsync(call: EngineCall, args: readonly unknown[]): Promise<unknown> {
  return engineSession().callAsync(call, args).then(marked);
}

/** The `engine_ready` import (native/node engine.h): the session reads what the device answered. */
export function engineReady(status: number): void { session?.ready(status); }
