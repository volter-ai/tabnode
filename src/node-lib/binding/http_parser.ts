/**
 * `internalBinding('http_parser')` (ADR-0018 §1, item 10): Node v24.21.0's src/node_http_parser.cc over the llhttp
 * 9.4.3 (Node's deps/llhttp) in the process's libnode.so. Its C is the `node` program's
 * (native/node/node_http_parser.c): the Parser's llhttp_t and settings, its StringPtrs and their slab, its header
 * counts and limits, Execute and its answer, and the ConnectionsList's two ordered sets. This file is its V8 half:
 * each method reads its arguments as V8 reads them, a buffer is copied into the process's memory for the length of
 * an `execute`, and the callbacks llhttp makes reach the parser's JavaScript through the program's `http_parser_*`
 * imports, inside that `execute`, each in the parser's async context as InternalCallbackScope enters it
 * (`initialize`'s AsyncReset). Execute's parse error is the Error V8 makes ("Parse Error", its bytesParsed, code and
 * reason); an exception a callback throws propagates out of `execute`, as V8's does once the native call returns,
 * and no JavaScript runs in the call after it, as none does with an exception pending. Node's own `_http_common.js`,
 * `_http_server.js` and `_http_client.js` run over it unchanged.
 *
 * Where it is not Node's: `consume` makes the parser no listener of its stream (Node's PushStreamListener, through
 * which a socket's reads go to Execute in C and to `kOnExecute`): a StreamBase's listeners are not built, so a
 * consumed socket's bytes reach the parser through `_http_server.js`'s own `data` listener and `execute`, Node's path
 * for a socket that is no StreamBase. `free`'s EmitTraceEventDestroy has no trace to emit to.
 *
 * A realm the host gives no `node` program has no llhttp, as it has no OpenSSL: the binding answers that the realm
 * has no program (`libnode`).
 */
import { address, fromMemory, intoMemory, libnode, readRecord, setHttpParserCallbacks, withRoom, type LibnodeExports } from './libnode';
import { ownedRun, ownerOfInstance } from './handles';
import { AsyncResource } from '../../shims/async_hooks';
import { Buffer } from '../buffer-module';
import { internalOptions } from '../internals/runtime';

type I32 = number;

/** native/node/node_http_parser.c's exports, by their C names. */
interface HttpParserExports extends LibnodeExports {
  tabnode_http_parser_new(): I32;
  tabnode_http_parser_close(parser: I32): void;
  tabnode_http_parser_remove(parser: I32): void;
  tabnode_http_parser_initialize(parser: I32, type: I32, maxHttpHeaderSize: number, lenient: I32, list: I32): void;
  tabnode_http_parser_pause(parser: I32, shouldPause: I32): void;
  tabnode_http_parser_execute(parser: I32, data: I32, length: I32): I32;
  tabnode_http_parser_table(parser: I32): I32;
  tabnode_http_parser_current_buffer(parser: I32, lengthAt: I32): I32;
  tabnode_connections_new(): I32;
  tabnode_connections_free(list: I32): void;
  tabnode_connections_list(list: I32, which: I32, headersTimeout: I32, requestTimeout: I32, countAt: I32): I32;
  tabnode_http_parser_binding(lengthAt: I32): I32;
}

function program(): HttpParserExports {
  return libnode().exports as HttpParserExports;
}

/** OneByteString: each byte one UTF-16 unit, as V8 makes a Latin-1 string (TextDecoder's "latin1" is windows-1252). */
function oneByteString(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192) {
    text += String.fromCharCode.apply(null, bytes.subarray(at, at + 8192) as unknown as number[]);
  }
  return text;
}

/** A string of `length` bytes at `at` in the process's memory, read as OneByteString reads it ("" for none). */
function oneByteAt(at: number, length: number): string {
  return length === 0 ? '' : oneByteString(libnode().read(address(at), length));
}

/** The table node_http_parser.c lays a callback's strings out in: count, URL, status message, the headers. */
const TABLE_BYTES = 4 + 8 + 8 + 64 * 8;

/** Execute's answer kinds (node_http_parser.c `result`). */
const kResultNothing = 0, kResultRead = 1, kResultParseError = 2;

/** Every open parser by its address, held as Node's Parser holds its object (a BaseObject never made weak). */
const parsers = new Map<number, HTTPParser>();

function parserAt(at: number): HTTPParser {
  const parser = parsers.get(address(at));
  if (!parser) throw new Error(`node: llhttp called back a parser no binding holds (${address(at)})`);
  return parser;
}

/** CreatePerIsolateProperties' constants and CreatePerContextProperties' method lists, as the program compiled them. */
interface ParserTables { constants: Map<string, number>; methods: string[]; allMethods: string[] }
let tables: ParserTables | undefined;
function parserTables(): ParserTables {
  if (tables) return tables;
  const x = program();
  let text = '';
  withRoom(4, (lengthAt) => address(x.tabnode_http_parser_binding(lengthAt)), (view, at) => {
    text = new TextDecoder().decode(libnode().read(at, view.getUint32(0, true)));
    x.tabnode_free(at);
  });
  const parsed: ParserTables = { constants: new Map(), methods: [], allMethods: [] };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [kind, name, value] = line.split(' ');
    if (kind === 'c') parsed.constants.set(name!, Number(value));
    else if (kind === 'm') parsed.methods.push(name!);
    else parsed.allMethods.push(name!);
  }
  return tables = parsed;
}

/** The engine's caller of a parser's callback: in its owner's run and its async context; a throw is kept. */
type Callback = (...args: unknown[]) => unknown;

/** Parser (node_http_parser.cc:295-1147): an AsyncWrap over its C parser. */
export class HTTPParser {
  #parser: number;
  #resource: AsyncResource | null = null;
  /** The exception a callback threw in this `execute`, which propagates once it returns (V8's pending exception). */
  #thrown: { error: unknown } | null = null;
  [index: number]: unknown;
  /** CreatePerIsolateProperties' constants on the constructor (`httpParserBinding` defines each from the program). */
  declare static REQUEST: number;
  declare static RESPONSE: number;
  declare static kOnMessageBegin: number;
  declare static kOnHeaders: number;
  declare static kOnHeadersComplete: number;
  declare static kOnBody: number;
  declare static kOnMessageComplete: number;
  declare static kOnExecute: number;
  declare static kOnTimeout: number;

  /** Parser::New (node_http_parser.cc:613-616). */
  constructor() {
    this.#parser = address(program().tabnode_http_parser_new());
    parsers.set(this.#parser, this);
  }

  /** Parser::Close (node_http_parser.cc:619-624): the parser is deleted, and every later call finds no wrap. */
  close(): void {
    const at = this.#parser;
    if (at === 0) return;
    parsers.delete(at);
    this.#parser = 0;
    program().tabnode_http_parser_close(at);
  }

  /** Parser::Free (node_http_parser.cc:627-635): the destroy hooks the destructor will not run. */
  free(): void {
    if (this.#parser === 0) return;
    this.#resource?.emitDestroy();
  }

  /** Parser::Remove (node_http_parser.cc:638-648). */
  remove(): void {
    if (this.#parser !== 0) program().tabnode_http_parser_remove(this.#parser);
  }

  /** Parser::Execute (node_http_parser.cc:664-674): `var bytesParsed = parser->execute(buffer)`. */
  execute(buffer: unknown): unknown {
    if (this.#parser === 0) return undefined;
    if (!ArrayBuffer.isView(buffer)) throw new Error('node: Assertion `args[0]->IsArrayBufferView()\' failed');
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const x = program();
    // ArrayBufferViewContents: the bytes, here a copy in the process's memory for the length of the call.
    const at = intoMemory(bytes);
    try { return this.#answer(x.tabnode_http_parser_execute(this.#parser, at, bytes.byteLength)); }
    finally { x.tabnode_free(at); }
  }

  /** Parser::Finish (node_http_parser.cc:677-685). */
  finish(): unknown {
    if (this.#parser === 0) return undefined;
    return this.#answer(program().tabnode_http_parser_execute(this.#parser, 0, 0));
  }

  /** Execute's answer (node_http_parser.cc:903-943) as V8 makes it, the callbacks' exception first. */
  #answer(resultAt: number): unknown {
    const thrown = this.#thrown;
    this.#thrown = null;
    if (thrown) throw thrown.error;
    const result = readRecord(resultAt, 24);
    const kind = result.getInt32(0, true);
    if (kind === kResultNothing) return undefined;
    const nread = result.getInt32(4, true);
    if (kind === kResultRead) return nread;
    if (kind !== kResultParseError) return undefined;
    const error = new Error('Parse Error') as Error & Record<string, unknown>;
    error.bytesParsed = nread;
    error.code = oneByteAt(result.getUint32(8, true), result.getUint32(12, true));
    error.reason = oneByteAt(result.getUint32(16, true), result.getUint32(20, true));
    return error;
  }

  /**
   * Parser::Initialize (node_http_parser.cc:688-750): initialize(type, resource[, maxHeaderSize[, lenientFlags[,
   * connectionsList]]]).
   */
  initialize(...args: unknown[]): void {
    const type = args[0];
    if (typeof type !== 'number' || (type | 0) !== type) throw new Error('node: Assertion `args[0]->IsInt32()\' failed');
    if (args[1] === null || (typeof args[1] !== 'object' && typeof args[1] !== 'function')) {
      throw new Error('node: Assertion `args[1]->IsObject()\' failed');
    }
    let maxHttpHeaderSize = 0;
    if (args.length > 2) {
      if (typeof args[2] !== 'number') throw new Error('node: Assertion `args[2]->IsNumber()\' failed');
      // static_cast<uint64_t> of the number.
      maxHttpHeaderSize = args[2] > 0 ? Math.trunc(args[2]) : 0;
    }
    if (maxHttpHeaderSize === 0) {
      maxHttpHeaderSize = internalOptions.getOptionValue('--max-http-header-size') as number;
    }
    let lenientFlags = 0;
    if (args.length > 3) {
      if (typeof args[3] !== 'number' || (args[3] | 0) !== args[3]) {
        throw new Error('node: Assertion `args[3]->IsInt32()\' failed');
      }
      lenientFlags = args[3];
    }
    let list = 0;
    if (args.length > 4 && args[4] !== null && args[4] !== undefined) {
      if (typeof args[4] !== 'object') throw new Error('node: Assertion `args[4]->IsObject()\' failed');
      const unwrapped = listAddresses.get(args[4]);
      // ASSIGN_OR_RETURN_UNWRAP of an object that wraps no list.
      if (unwrapped === undefined) return;
      list = unwrapped;
    }
    if (this.#parser === 0) return;
    // set_provider_type and AsyncReset: the parser's callbacks run in the context it is initialized in.
    this.#resource = new AsyncResource(type === parserTables().constants.get('REQUEST') ? 'HTTPINCOMINGMESSAGE' : 'HTTPCLIENTREQUEST');
    program().tabnode_http_parser_initialize(this.#parser, type, maxHttpHeaderSize, lenientFlags >>> 0, list);
  }

  /** Parser::Pause<true> and Pause<false> (node_http_parser.cc:753-766). */
  pause(): void { if (this.#parser !== 0) program().tabnode_http_parser_pause(this.#parser, 1); }
  resume(): void { if (this.#parser !== 0) program().tabnode_http_parser_pause(this.#parser, 0); }

  /** Parser::Consume (node_http_parser.cc:769-776): the parser is no stream's listener here (see above). */
  consume(stream: unknown): void {
    if (stream === null || typeof stream !== 'object') throw new Error('node: Assertion `args[0]->IsObject()\' failed');
  }
  /** Parser::Unconsume (node_http_parser.cc:779-788): already unconsumed. */
  unconsume(): void {}

  /** GetCurrentBuffer (node_http_parser.cc:791-802): Buffer::Copy of the bytes Execute is reading. */
  getCurrentBuffer(): unknown {
    if (this.#parser === 0) return undefined;
    const x = program();
    let bytes = new ArrayBuffer(0);
    withRoom(4, (lengthAt) => address(x.tabnode_http_parser_current_buffer(this.#parser, lengthAt)), (view, at) => {
      const length = view.getUint32(0, true);
      if (at !== 0 && length !== 0) bytes = fromMemory(at, length);
    });
    return Buffer.from(bytes);
  }

  /** The callback at `index`, called as V8 calls it with no exception pending; a throw is kept, and none follows it. */
  invoke(index: number, args: unknown[]): { ok: true; value: unknown } | { ok: false } {
    if (this.#thrown) return { ok: false };
    const callback = this[index];
    if (typeof callback !== 'function') return { ok: true, value: undefined };
    const resource = this.#resource;
    try {
      const value = ownedRun(ownerOfInstance(this), () => (resource
        ? resource.runInAsyncScope(callback as Callback, this, ...args)
        : (callback as Callback).apply(this, args)));
      return { ok: true, value };
    } catch (error) {
      this.#thrown = { error };
      return { ok: false };
    }
  }

  /**
   * V8's IntegerValue of a callback's answer: ToNumber (whose throw is kept as the call's exception, NaN), then the
   * integer toward zero, NaN as 0, within int64's range.
   */
  integerValue(value: unknown): number {
    try {
      const number = +(value as number);
      if (Number.isNaN(number)) return 0;
      return Math.max(-(2 ** 63), Math.min(2 ** 63 - 1024, Math.trunc(number)));
    } catch (error) {
      this.#thrown = { error };
      return NaN;
    }
  }

  /** `object()->Get("maxHeaderPairs")`, kept as an exception where the get throws. */
  maxHeaderPairs(): number {
    if (this.#thrown) return NaN;
    try {
      const value = (this as unknown as { maxHeaderPairs?: unknown }).maxHeaderPairs;
      return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
    } catch (error) {
      this.#thrown = { error };
      return NaN;
    }
  }

  /** The strings of the callback being made (node_http_parser.c `table`). */
  table(): { headers: string[]; url: string; statusMessage: string } {
    const view = readRecord(program().tabnode_http_parser_table(this.#parser), TABLE_BYTES);
    const slice = (offset: number): string => oneByteAt(view.getUint32(offset, true), view.getUint32(offset + 4, true));
    const count = view.getUint32(0, true);
    const headers: string[] = [];
    for (let index = 0; index < count * 2; index++) headers.push(slice(20 + index * 8));
    return { headers, url: slice(4), statusMessage: slice(12) };
  }
}

/** Each ConnectionsList's C list, by its object (ASSIGN_OR_RETURN_UNWRAP). */
const listAddresses = new WeakMap<object, number>();
/** A list's memory once its object is collected (ConnectionsList is MakeWeak). */
const collectedLists = new FinalizationRegistry<number>((at) => program().tabnode_connections_free(at));

/** ConnectionsList (node_http_parser.cc:253-293, 1163-1284). */
export class ConnectionsList {
  readonly #list: number;

  constructor() {
    this.#list = address(program().tabnode_connections_new());
    listAddresses.set(this, this.#list);
    collectedLists.register(this, this.#list);
  }

  all(): HTTPParser[] { return this.#select(0, 0, 0); }
  idle(): HTTPParser[] { return this.#select(1, 0, 0); }
  active(): HTTPParser[] { return this.#select(2, 0, 0); }
  /** Expired (node_http_parser.cc:1223-1284): its two timeouts, in seconds, as their Uint32 values. */
  expired(headersTimeout: unknown, requestTimeout: unknown): HTTPParser[] {
    if (typeof headersTimeout !== 'number') throw new Error('node: Assertion `args[0]->IsNumber()\' failed');
    if (typeof requestTimeout !== 'number') throw new Error('node: Assertion `args[1]->IsNumber()\' failed');
    return this.#select(3, headersTimeout >>> 0, requestTimeout >>> 0);
  }

  #select(which: number, headersTimeout: number, requestTimeout: number): HTTPParser[] {
    const x = program();
    const found: HTTPParser[] = [];
    withRoom(4, (countAt) => address(x.tabnode_connections_list(this.#list, which, headersTimeout, requestTimeout, countAt)),
      (view, at) => {
        const count = view.getUint32(0, true);
        try {
          if (count === 0) return;
          const addresses = readRecord(at, count * 4);
          for (let index = 0; index < count; index++) found.push(parserAt(addresses.getUint32(index * 4, true)));
        } finally { x.tabnode_free(at); }
      });
    return found;
  }
}

/**
 * The program's llhttp callbacks (engine.h `http_parser_*`), which `libnodeImports` answers, each inside the engine's
 * own `execute` or `finish`: no scope closes after them.
 */
setHttpParserCallbacks({
  http_parser_has_callback: (parser: number, index: number): number =>
    (typeof parserAt(parser)[index] === 'function' ? 1 : 0),
  /** on_message_begin's and on_message_complete's call. */
  http_parser_call: (parser: number, index: number): number => (parserAt(parser).invoke(index, []).ok ? 0 : 1),
  /** Flush: kOnHeaders(CreateHeaders(), url). */
  http_parser_flush: (parser: number): number => {
    const target = parserAt(parser);
    const { headers, url } = target.table();
    return target.invoke(parserTables().constants.get('kOnHeaders')!, [headers, url]).ok ? 0 : 1;
  },
  /**
   * on_headers_complete: kOnHeadersComplete(versionMajor, versionMinor, headers, method, url, statusCode,
   * statusMessage, upgrade, shouldKeepAlive), each argument as node_http_parser.cc:443-493 sets it; the answer's
   * IntegerValue, NaN where it threw.
   */
  http_parser_headers_complete: (parser: number, flushed: number, type: number, major: number, minor: number,
    method: number, statusCode: number, upgrade: number, shouldKeepAlive: number): number => {
    const target = parserAt(parser);
    const { constants } = parserTables();
    const request = type === constants.get('REQUEST'), response = type === constants.get('RESPONSE');
    const { headers, url, statusMessage } = target.table();
    const argv: unknown[] = [major, minor, flushed ? undefined : headers, request ? method >>> 0 : undefined,
      !flushed && request ? url : undefined, response ? statusCode : undefined, response ? statusMessage : undefined,
      upgrade !== 0, shouldKeepAlive !== 0];
    const answer = target.invoke(constants.get('kOnHeadersComplete')!, argv);
    return answer.ok ? target.integerValue(answer.value) : NaN;
  },
  /** on_body: kOnBody(Buffer::Copy(at, length)). */
  http_parser_body: (parser: number, at: number, length: number): number => {
    const chunk = Buffer.from(fromMemory(at, address(length)));
    return parserAt(parser).invoke(parserTables().constants.get('kOnBody')!, [chunk]).ok ? 0 : 1;
  },
  /** TrackHeaderPair's `maxHeaderPairs`. */
  http_parser_max_header_pairs: (parser: number): number => parserAt(parser).maxHeaderPairs(),
});

let binding: { HTTPParser: typeof HTTPParser; ConnectionsList: typeof ConnectionsList; methods: string[]; allMethods: string[] } | undefined;

/**
 * CreatePerIsolateProperties and CreatePerContextProperties (node_http_parser.cc:1337-1465): HTTPParser with its
 * constants, ConnectionsList, and `methods` and `allMethods`, the program's, made on the first ask.
 */
export function httpParserBinding(): NonNullable<typeof binding> {
  if (binding) return binding;
  const { constants, methods, allMethods } = parserTables();
  for (const [name, value] of constants) {
    Object.defineProperty(HTTPParser, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return binding = { HTTPParser, ConnectionsList, methods: [...methods], allMethods: [...allMethods] };
}
