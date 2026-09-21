/**
 * `internalBinding('http_parser')`: Node's `HTTPParser`, on llhttp's own
 * WebAssembly build.
 *
 * Node parses HTTP with llhttp, a C parser it links. The engine's `http` was
 * a hand-written parser in TypeScript, and a hand-written HTTP parser is the
 * shape of bug that does not announce itself: a chunked body whose extension
 * it ignores, a header it folds where Node rejects, a request it accepts that
 * a proxy in front of it reads differently. So the parser here is llhttp
 * itself -- the same parser, the same state machine, the same rejections --
 * compiled to wasm (see `./llhttp-wasm.ts` for the build and its provenance),
 * and this file is only the shape Node's own `_http_common.js` expects around
 * it.
 *
 * WHAT THIS FILE DOES, and nothing else: it hands llhttp the bytes, turns
 * llhttp's eight callbacks into the seven Node hangs off a parser by index,
 * and reports an error the way `execute` reports one. Every rule about
 * HTTP -- what a valid method is, when a message needs EOF, whether a
 * connection may be kept alive -- is llhttp's answer, read back through its
 * own exports.
 *
 * THE ONE ENVIRONMENTAL REQUIREMENT: the module is compiled synchronously,
 * on the first parser a program makes. A browser refuses a synchronous
 * compile of more than 4 KB on the MAIN thread, so `http` works where the
 * engine runs a guest -- the substrate's execution worker, a Node process --
 * and a main-thread realm that asks for it is told exactly that rather than
 * left with a parser that does nothing.
 */
import { LLHTTP_WASM_BASE64 } from './llhttp-wasm';

/** llhttp's `llhttp_type`. */
const TYPE_REQUEST = 1;
const TYPE_RESPONSE = 2;

/** llhttp's `llhttp_errno`, the ones this file acts on. */
const ERROR_OK = 0;
const ERROR_PAUSED = 21;
const ERROR_PAUSED_UPGRADE = 22;

/** The callback slots Node hangs off a parser, by the index its C++ uses. */
const kOnMessageBegin = 0;
const kOnHeaders = 1;
const kOnHeadersComplete = 2;
const kOnBody = 3;
const kOnMessageComplete = 4;
const kOnExecute = 5;
const kOnTimeout = 6;

interface LlhttpExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  llhttp_alloc(type: number): number;
  llhttp_free(ptr: number): void;
  llhttp_reset(ptr: number): void;
  llhttp_execute(ptr: number, data: number, len: number): number;
  llhttp_finish(ptr: number): number;
  llhttp_resume(ptr: number): void;
  llhttp_resume_after_upgrade(ptr: number): void;
  llhttp_pause(ptr: number): void;
  llhttp_get_error_pos(ptr: number): number;
  llhttp_get_error_reason(ptr: number): number;
  llhttp_get_errno(ptr: number): number;
  llhttp_errno_name(errno: number): number;
  llhttp_method_name(method: number): number;
  llhttp_get_http_major(ptr: number): number;
  llhttp_get_http_minor(ptr: number): number;
  llhttp_get_method(ptr: number): number;
  llhttp_get_status_code(ptr: number): number;
  llhttp_get_upgrade(ptr: number): number;
  llhttp_should_keep_alive(ptr: number): number;
  llhttp_message_needs_eof(ptr: number): number;
  llhttp_set_lenient_headers(ptr: number, on: number): void;
  llhttp_set_lenient_chunked_length(ptr: number, on: number): void;
  llhttp_set_lenient_keep_alive(ptr: number, on: number): void;
  llhttp_set_lenient_transfer_encoding(ptr: number, on: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

/** The parser whose `execute` is on the stack; llhttp's callbacks carry no state of ours. */
// eslint-disable-next-line no-var, vars-on-top
var current: HTTPParser | null = null;
// eslint-disable-next-line no-var, vars-on-top
var wasm: LlhttpExports | undefined;
// eslint-disable-next-line no-var, vars-on-top
var memoryBytes: Uint8Array | undefined;

/** The realm's own decoder, over a latin1 view: HTTP's header bytes are latin1. */
// eslint-disable-next-line no-var, vars-on-top
var latin1: TextDecoder | undefined;

function decode(at: number, length: number): string {
  latin1 ??= new TextDecoder('latin1');
  return latin1.decode(bytes().subarray(at, at + length));
}

function bytes(): Uint8Array {
  // A wasm memory can grow, and a view over the old buffer is detached when
  // it does; the view is taken again whenever the buffer is not the one it
  // was made from.
  const memory = llhttp().memory;
  if (memoryBytes === undefined || memoryBytes.buffer !== memory.buffer) {
    memoryBytes = new Uint8Array(memory.buffer);
  }
  return memoryBytes;
}

function llhttp(): LlhttpExports {
  if (wasm !== undefined) return wasm;
  let module: WebAssembly.Module;
  try {
    const binary = Uint8Array.from(atob(LLHTTP_WASM_BASE64), (character) => character.charCodeAt(0));
    module = new WebAssembly.Module(binary);
  } catch (error) {
    throw Object.assign(new Error(
      'http: llhttp could not be compiled in this realm. A browser refuses a synchronous ' +
      'WebAssembly compile of more than 4 KB on the main thread; the engine parses HTTP ' +
      'where it runs a guest, which is a worker.',
    ), { cause: error, code: 'ERR_HTTP_PARSER_UNAVAILABLE' });
  }
  const instance = new WebAssembly.Instance(module, {
    env: {
      wasm_on_message_begin: (): number => current!.onMessageBegin(),
      wasm_on_url: (_p: number, at: number, length: number): number => current!.onUrl(at, length),
      wasm_on_status: (_p: number, at: number, length: number): number => current!.onStatus(at, length),
      wasm_on_header_field: (_p: number, at: number, length: number): number => current!.onHeaderField(at, length),
      wasm_on_header_value: (_p: number, at: number, length: number): number => current!.onHeaderValue(at, length),
      wasm_on_headers_complete: (_p: number, statusCode: number, upgrade: number, shouldKeepAlive: number): number =>
        current!.onHeadersComplete(statusCode, Boolean(upgrade), Boolean(shouldKeepAlive)),
      wasm_on_body: (_p: number, at: number, length: number): number => current!.onBody(at, length),
      wasm_on_message_complete: (): number => current!.onMessageComplete(),
    },
  });
  wasm = instance.exports as unknown as LlhttpExports;
  wasm._initialize();
  return wasm;
}

/** A C string out of the module's memory, for llhttp's own error text. */
function cstring(ptr: number): string {
  if (ptr === 0) return '';
  const view = bytes();
  let end = ptr;
  while (view[end] !== 0) end += 1;
  return decode(ptr, end - ptr);
}

/**
 * Every method llhttp knows, by its own number, asked of llhttp rather than
 * written down here: `allMethods[method]` is what `_http_common.js` reads to
 * name a request's method, and a table written twice is a table that drifts.
 */
// eslint-disable-next-line no-var, vars-on-top
var allMethodsCache: string[] | undefined;
function allMethodsOf(): string[] {
  if (allMethodsCache) return allMethodsCache;
  const exports = llhttp();
  const names: string[] = [];
  for (let method = 0; ; method += 1) {
    let name: string;
    // llhttp traps on a method it does not have rather than answering an
    // empty name, so the end of its table is the first call that traps.
    try { name = cstring(exports.llhttp_method_name(method)); } catch { break; }
    if (name === '') break;
    names.push(name);
  }
  allMethodsCache = names;
  return names;
}

type ParserCallback = ((...args: never[]) => unknown) | null;

export class HTTPParser {
  static readonly REQUEST = TYPE_REQUEST;
  static readonly RESPONSE = TYPE_RESPONSE;
  static readonly kOnMessageBegin = kOnMessageBegin;
  static readonly kOnHeaders = kOnHeaders;
  static readonly kOnHeadersComplete = kOnHeadersComplete;
  static readonly kOnBody = kOnBody;
  static readonly kOnMessageComplete = kOnMessageComplete;
  static readonly kOnExecute = kOnExecute;
  static readonly kOnTimeout = kOnTimeout;
  /** Node's lenient flags. Each one llhttp itself can be told about is passed on. */
  static readonly kLenientNone = 0;
  static readonly kLenientHeaders = 1;
  static readonly kLenientChunkedLength = 2;
  static readonly kLenientKeepAlive = 4;
  static readonly kLenientTransferEncoding = 8;
  static readonly kLenientVersion = 16;
  static readonly kLenientDataAfterClose = 32;
  static readonly kLenientOptionalLFAfterCR = 64;
  static readonly kLenientOptionalCRLFAfterChunk = 128;
  static readonly kLenientOptionalCRBeforeLF = 256;
  static readonly kLenientSpacesAfterChunkSize = 512;
  static readonly kLenientAll = 1023;

  [kOnMessageBegin]: ParserCallback = null;
  [kOnHeaders]: ParserCallback = null;
  [kOnHeadersComplete]: ParserCallback = null;
  [kOnBody]: ParserCallback = null;
  [kOnMessageComplete]: ParserCallback = null;
  [kOnExecute]: ParserCallback = null;
  [kOnTimeout]: ParserCallback = null;

  #ptr = 0;
  #type = TYPE_REQUEST;
  #maxHeaderSize = 16 * 1024;
  #headerBytes = 0;
  #headers: string[] = [];
  #field = '';
  #value = '';
  #readingValue = false;
  #url = '';
  #statusMessage = '';
  #headersSent = false;
  #paused = false;
  /** The buffer `execute` is walking, which `getCurrentBuffer` answers with. */
  #buffer: Uint8Array | null = null;
  #bufferPtr = 0;
  #bufferSize = 0;
  #connections: ConnectionsList | undefined;
  /** The socket `_http_server.js` hangs on a parser, and reads off one here. */
  socket?: { destroy(): void } | null;
  /** When this connection's current head and current message began, in ms. */
  headersStart = 0;
  messageStart = 0;
  /** Whether a message is in flight, which is what `idle()` is the absence of. */
  active = false;

  /**
   * `parser.initialize(type, resource, maxHeaderSize, lenient, headersTimeout)`,
   * which Node calls for every parser it takes off its free list.
   */
  initialize(type: number, _resource?: unknown, maxHeaderSize?: number, lenient?: number, connections?: ConnectionsList): void {
    const exports = llhttp();
    if (this.#ptr !== 0) exports.llhttp_free(this.#ptr);
    this.#type = type;
    this.#ptr = exports.llhttp_alloc(type);
    this.#maxHeaderSize = maxHeaderSize && maxHeaderSize > 0 ? maxHeaderSize : 16 * 1024;
    const flags = lenient ?? 0;
    exports.llhttp_set_lenient_headers(this.#ptr, flags & HTTPParser.kLenientHeaders ? 1 : 0);
    exports.llhttp_set_lenient_chunked_length(this.#ptr, flags & HTTPParser.kLenientChunkedLength ? 1 : 0);
    exports.llhttp_set_lenient_keep_alive(this.#ptr, flags & HTTPParser.kLenientKeepAlive ? 1 : 0);
    exports.llhttp_set_lenient_transfer_encoding(this.#ptr, flags & HTTPParser.kLenientTransferEncoding ? 1 : 0);
    this.#reset();
    this.#connections?.remove(this);
    this.#connections = connections;
    connections?.add(this);
    this.headersStart = 0;
    this.messageStart = 0;
  }

  #reset(): void {
    this.#headers = [];
    this.#headerBytes = 0;
    this.#field = '';
    this.#value = '';
    this.#readingValue = false;
    this.#url = '';
    this.#statusMessage = '';
    this.#headersSent = false;
    this.#paused = false;
  }

  /** Node's `parser.free()`: back on the free list, holding no llhttp state. */
  free(): void {
    if (this.#ptr !== 0) { llhttp().llhttp_free(this.#ptr); this.#ptr = 0; }
    this.#connections?.remove(this);
    this.#connections = undefined;
    this.active = false;
    this.#reset();
  }

  /** Node's `parser.remove()`, which only matters for a consumed stream. */
  remove(): void {}

  close(): void { this.free(); }

  pause(): void { if (this.#ptr !== 0) llhttp().llhttp_pause(this.#ptr); }
  resume(): void { if (this.#ptr !== 0) llhttp().llhttp_resume(this.#ptr); }

  /** The engine's handles are not stream bases, so Node never consumes one. */
  consume(): void {}
  unconsume(): void {}

  getCurrentBuffer(): Uint8Array {
    return this.#buffer ?? new Uint8Array(0);
  }

  /**
   * `parser.execute(buffer)`: the bytes through llhttp, answering how many it
   * took, or an `Error` carrying `bytesParsed`, the llhttp code and llhttp's
   * own reason -- which is the shape `_http_server.js` reads to decide
   * between a 400 and a destroyed socket.
   */
  execute(buffer: Uint8Array): number | Error {
    const exports = llhttp();
    if (this.#ptr === 0) this.initialize(this.#type);
    const length = buffer.length;
    const data = this.#copyIn(buffer);
    const previous = current;
    current = this;
    this.#buffer = buffer;
    let ret: number;
    try {
      ret = exports.llhttp_execute(this.#ptr, data, length);
    } finally {
      current = previous;
    }
    if (ret === ERROR_PAUSED_UPGRADE) {
      // The bytes after the header of an upgraded message are the caller's,
      // not llhttp's: it stops where they begin and says where that was.
      const consumed = exports.llhttp_get_error_pos(this.#ptr) - data;
      exports.llhttp_resume_after_upgrade(this.#ptr);
      this.#buffer = null;
      return consumed;
    }
    if (ret === ERROR_PAUSED) {
      this.#paused = true;
      const consumed = exports.llhttp_get_error_pos(this.#ptr) - data;
      this.#buffer = null;
      return consumed;
    }
    if (ret !== ERROR_OK) {
      const consumed = exports.llhttp_get_error_pos(this.#ptr) - data;
      const error = new Error(cstring(exports.llhttp_get_error_reason(this.#ptr))) as Error & {
        bytesParsed?: number; code?: string; reason?: string;
      };
      error.bytesParsed = consumed < 0 ? 0 : consumed;
      // llhttp's own name already carries the prefix: `HPE_INVALID_METHOD`.
      error.code = cstring(exports.llhttp_errno_name(ret));
      error.reason = error.message;
      this.#buffer = null;
      return error;
    }
    this.#buffer = null;
    return length;
  }

  /** `parser.finish()`: the stream ended; llhttp says whether that was legal. */
  finish(): number | Error | undefined {
    const exports = llhttp();
    if (this.#ptr === 0) return undefined;
    const previous = current;
    current = this;
    let ret: number;
    try { ret = exports.llhttp_finish(this.#ptr); } finally { current = previous; }
    if (ret === ERROR_OK || ret === ERROR_PAUSED || ret === ERROR_PAUSED_UPGRADE) return undefined;
    const error = new Error(cstring(exports.llhttp_get_error_reason(this.#ptr))) as Error & {
      bytesParsed?: number; code?: string;
    };
    error.bytesParsed = 0;
    // llhttp's own name already carries the prefix: `HPE_INVALID_METHOD`.
      error.code = cstring(exports.llhttp_errno_name(ret));
    return error;
  }

  /** Bytes into the module's own memory, in one scratch buffer that grows. */
  #copyIn(buffer: Uint8Array): number {
    const exports = llhttp();
    if (buffer.length > this.#bufferSize) {
      if (this.#bufferPtr !== 0) exports.free(this.#bufferPtr);
      this.#bufferPtr = exports.malloc(buffer.length);
      this.#bufferSize = buffer.length;
      memoryBytes = undefined;
    }
    bytes().set(buffer, this.#bufferPtr);
    return this.#bufferPtr;
  }

  // ---- llhttp's callbacks, each answering 0 for "carry on" -----------------

  onMessageBegin(): number {
    this.#reset();
    this.headersStart = Date.now();
    this.messageStart = this.headersStart;
    this.active = true;
    const callback = this[kOnMessageBegin];
    if (callback) callback.call(this as never);
    return 0;
  }

  onUrl(at: number, length: number): number {
    this.#url += decode(at, length);
    return this.#countHeaderBytes(length);
  }

  onStatus(at: number, length: number): number {
    this.#statusMessage += decode(at, length);
    return this.#countHeaderBytes(length);
  }

  onHeaderField(at: number, length: number): number {
    if (this.#readingValue) { this.#pushHeader(); }
    this.#field += decode(at, length);
    return this.#countHeaderBytes(length);
  }

  onHeaderValue(at: number, length: number): number {
    this.#readingValue = true;
    this.#value += decode(at, length);
    return this.#countHeaderBytes(length);
  }

  #pushHeader(): void {
    this.#headers.push(this.#field, this.#value);
    this.#field = '';
    this.#value = '';
    this.#readingValue = false;
  }

  /**
   * Node refuses a message whose head is longer than `maxHeaderSize`. A
   * callback that answers anything but 0 stops llhttp with `HPE_USER`, which
   * is the code `_http_server.js` reads to answer 431.
   */
  #countHeaderBytes(length: number): number {
    if (this.#headersSent) return 0;
    this.#headerBytes += length;
    if (this.#headerBytes > this.#maxHeaderSize) {
      return -1;
    }
    return 0;
  }

  onHeadersComplete(statusCode: number, upgrade: boolean, shouldKeepAlive: boolean): number {
    if (this.#readingValue || this.#field !== '') this.#pushHeader();
    const exports = llhttp();
    const headers = this.#headers;
    this.#headers = [];
    this.#headersSent = true;
    this.headersStart = 0;
    const callback = this[kOnHeadersComplete];
    if (!callback) return 0;
    const major = exports.llhttp_get_http_major(this.#ptr);
    const minor = exports.llhttp_get_http_minor(this.#ptr);
    const method = this.#type === TYPE_REQUEST ? exports.llhttp_get_method(this.#ptr) : undefined;
    const url = this.#type === TYPE_REQUEST ? this.#url : undefined;
    const answer = (callback as (...args: unknown[]) => unknown).call(
      this, major, minor, headers, method, url, statusCode, this.#statusMessage, upgrade, shouldKeepAlive,
    );
    this.#url = '';
    this.#statusMessage = '';
    // Node's own answer: a number means "this message has no body to read" --
    // a HEAD's response, a 204, a 304 -- which is llhttp's 1.
    if (typeof answer === 'number' && answer > 0) return 1;
    return 0;
  }

  onBody(at: number, length: number): number {
    const callback = this[kOnBody];
    if (callback) {
      const chunk = bytes().slice(at, at + length);
      (callback as (...args: unknown[]) => unknown).call(this, chunk);
    }
    return 0;
  }

  onMessageComplete(): number {
    // A trailer arrives after the head is done; Node takes those through
    // `kOnHeaders`, which is also how it takes a head too large to batch.
    if (this.#readingValue || this.#field !== '') this.#pushHeader();
    if (this.#headers.length > 0) {
      const trailers = this.#headers;
      this.#headers = [];
      const onHeaders = this[kOnHeaders];
      if (onHeaders) (onHeaders as (...args: unknown[]) => unknown).call(this, trailers, '');
    }
    const callback = this[kOnMessageComplete];
    const returned = callback ? (callback as () => unknown).call(this as never) : 0;
    this.active = false;
    this.messageStart = 0;
    // A client that has its message may return non-zero to stop llhttp
    // before the next message on this connection; Node's own callbacks
    // return nothing, which is 0 as before.
    return typeof returned === 'number' ? returned : 0;
  }

  /** Off the list it was initialized onto; `free` is where Node lets one go. */
  detach(): void { this.#connections?.remove(this); this.#connections = undefined; }
}

/**
 * `internalBinding('http_parser')`'s `ConnectionsList`: the parsers a server
 * has open, which is how `_http_server.js` closes its connections and
 * enforces `headersTimeout` and `requestTimeout`. Node keeps the list in C++
 * beside the parsers themselves; here it is a set of the same parsers, and
 * each answers from the timestamps llhttp's own callbacks set on it.
 */
export class ConnectionsList {
  #parsers = new Set<HTTPParser>();

  add(parser: HTTPParser): void { this.#parsers.add(parser); }
  remove(parser: HTTPParser): void { this.#parsers.delete(parser); }

  all(): HTTPParser[] { return [...this.#parsers]; }

  /** A connection with no message in flight. */
  idle(): HTTPParser[] { return [...this.#parsers].filter((parser) => !parser.active); }

  /** A connection with one. */
  active(): HTTPParser[] { return [...this.#parsers].filter((parser) => parser.active); }

  /**
   * The connections that have taken too long: one whose head is still
   * arriving after `headersTimeout`, or whose message has been in flight past
   * `requestTimeout`. A timeout of 0 is off, as it is in Node.
   */
  expired(headersTimeout: number, requestTimeout: number): HTTPParser[] {
    const now = Date.now();
    return [...this.#parsers].filter((parser) => {
      if (headersTimeout > 0 && parser.headersStart > 0 && now - parser.headersStart > headersTimeout) return true;
      if (requestTimeout > 0 && parser.messageStart > 0 && now - parser.messageStart > requestTimeout) return true;
      return false;
    });
  }
}

/** The binding object, built on the first ask. */
export const httpParserBinding = {
  HTTPParser,
  ConnectionsList,
  /**
   * `http.METHODS`: the HTTP methods, which are the ones llhttp lists before
   * `PRI` -- that is where its RTSP block begins, and RTSP's verbs are not
   * HTTP's. Read off the same table as `allMethods`, so the two cannot drift.
   */
  get methods(): string[] {
    const all = allMethodsOf();
    const rtsp = all.indexOf('PRI');
    return [...new Set(rtsp === -1 ? all : all.slice(0, rtsp))].sort();
  },
  get allMethods(): string[] { return allMethodsOf(); },
};

export default httpParserBinding;
