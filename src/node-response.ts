import { defineOnHost, takeFromHost } from './host-globals';

/**
 * A web `Response` that keeps its `Set-Cookie` headers, as Node's does.
 *
 * Node's `Response` (undici's) is built with a `Headers` that holds every
 * header it was given, `Set-Cookie` and `Set-Cookie2` among them, readable
 * through `get` (joined with ", "), iteration (one entry per cookie) and
 * `getSetCookie()`, and mutable afterwards. A browser's applies the fetch
 * specification's response guard, which drops both silently, on construction
 * and on every later `append` or `set`: `new Response('', { headers:
 * { 'set-cookie': 'a=1' } }).headers` is empty in a tab. A server that answers
 * with a web Response (Next's route handlers and middleware, Hono, Remix,
 * SvelteKit's adapters, NextAuth among them) then loses every cookie it sets
 * before its answer is written to the socket, and no one can sign in.
 *
 * The realm's `Response` stays the browser's own class in all but its
 * constructor: the constructor is a function whose `prototype` is the
 * browser's `Response.prototype`, so a fetch's answer, `Response.error()` and
 * a program's subclass are each `instanceof Response`, share its prototype and
 * name it as their `constructor`, as on Node. A response a program constructs
 * keeps a `Headers` of its own, made without a guard (a `Headers` a program
 * constructs is one, in a browser too), holding the browser's headers and every
 * cookie the program gave; `headers` answers it. The body methods whose answer
 * depends on the content type (`formData`, `blob`) read the kept one, as Node
 * reads the response's own headers.
 */
const INSTALLED = Symbol.for('tabnode.response.keepsSetCookie');

type ResponseConstructor = typeof Response & { [INSTALLED]?: true };

/** The browser's headers with the cookies its guard dropped. */
function withCookies(own: Headers, given: Headers | undefined): Headers {
  const headers = new Headers(own);
  if (!given) return headers;
  const cookies: string[] = [];
  if (typeof given.getSetCookie === 'function') cookies.push(...given.getSetCookie());
  else given.forEach((value, name) => { if (name === 'set-cookie') cookies.push(value); });
  if (cookies.length) {
    headers.delete('set-cookie');
    for (const cookie of cookies) headers.append('set-cookie', cookie);
  }
  const cookie2 = given.get('set-cookie2');
  if (cookie2 !== null) headers.set('set-cookie2', cookie2);
  return headers;
}

/** The headers an init names, read once (an iterable may be a generator), as a guard-free `Headers`. */
function givenHeaders(init: ResponseInit | undefined): Headers | undefined {
  const headers = init?.headers;
  return headers === undefined || headers === null ? undefined : new Headers(headers);
}

/**
 * The init with its headers replaced, read as the platform reads a
 * dictionary: each member by name, inherited ones too (a `Response` passed as
 * the init, as Next's `NextResponse` does, carries its status on a getter of
 * its prototype, which a spread would not copy).
 */
function withHeaders(init: ResponseInit | undefined, headers: Headers): ResponseInit {
  const status = init?.status;
  const statusText = init?.statusText;
  return {
    headers,
    ...(status === undefined ? {} : { status }),
    ...(statusText === undefined ? {} : { statusText }),
  };
}

/**
 * Install the corrected constructor on `target` (the realm's global object),
 * over the `Response` it has. Every property it changes is remembered for the
 * host to have back (`restoreHostGlobals`); a realm that has it already is left.
 */
export function installNodeResponse(target: { Response?: typeof Response }): void {
  const Native = target.Response as ResponseConstructor | undefined;
  if (typeof Native !== 'function' || Native[INSTALLED]) return;
  const proto = Native.prototype;
  const nativeHeaders = Object.getOwnPropertyDescriptor(proto, 'headers')?.get;
  const nativeFormData = proto.formData;
  const nativeBlob = proto.blob;
  const nativeArrayBuffer = proto.arrayBuffer;
  const nativeClone = proto.clone;
  if (!nativeHeaders) return;
  const kept = new WeakMap<object, Headers>();

  const NodeResponse = function Response(this: unknown, body?: BodyInit | null, init?: ResponseInit): Response {
    if (!new.target) throw new TypeError("Class constructor Response cannot be invoked without 'new'");
    const given = givenHeaders(init);
    const response = Reflect.construct(Native, [body, given ? withHeaders(init, given) : init], (new.target as unknown) === NodeResponse ? Native : new.target) as Response;
    kept.set(response, withCookies(nativeHeaders.call(response) as Headers, given));
    return response;
  } as unknown as ResponseConstructor;
  NodeResponse.prototype = proto;
  Object.defineProperty(NodeResponse, 'length', { value: 0, configurable: true });
  Object.defineProperty(NodeResponse, INSTALLED, { value: true });
  Object.setPrototypeOf(NodeResponse, Object.getPrototypeOf(Native));

  // Node's statics answer a response whose headers are as mutable as a
  // constructed one's (json) or immutable (redirect, error), as here.
  Object.defineProperty(NodeResponse, 'json', {
    value: function json(data: unknown, init?: ResponseInit): Response {
      const given = givenHeaders(init);
      const response = Native.json(data, given ? withHeaders(init, given) : init);
      kept.set(response, withCookies(nativeHeaders.call(response) as Headers, given));
      return response;
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(NodeResponse, 'redirect', { value: function redirect(url: string | URL, status?: number): Response { return Native.redirect(url, status); }, writable: true, configurable: true });
  Object.defineProperty(NodeResponse, 'error', { value: function error(): Response { return Native.error(); }, writable: true, configurable: true });

  defineOnHost(proto, 'headers', {
    get(this: Response): Headers { return kept.get(this) ?? (nativeHeaders.call(this) as Headers); },
    enumerable: true, configurable: true,
  });
  defineOnHost(proto, 'constructor', { value: NodeResponse, writable: true, enumerable: false, configurable: true });

  // A clone's headers are a copy of the original's, cookies and all.
  defineOnHost(proto, 'clone', {
    value: function clone(this: Response): Response {
      const copy = nativeClone.call(this);
      const headers = kept.get(this);
      if (headers) kept.set(copy, new Headers(headers));
      return copy;
    },
    writable: true, enumerable: true, configurable: true,
  });

  /** The kept content type where it is no longer the one the browser's body was built with. */
  const changedType = (response: Response): string | null | undefined => {
    const headers = kept.get(response);
    if (!headers) return undefined;
    const current = headers.get('content-type');
    return current === (nativeHeaders.call(response) as Headers).get('content-type') ? undefined : current;
  };
  defineOnHost(proto, 'formData', {
    value: async function formData(this: Response): Promise<FormData> {
      const type = changedType(this);
      if (type === undefined) return nativeFormData.call(this);
      const bytes = await nativeArrayBuffer.call(this);
      return nativeFormData.call(Reflect.construct(Native, [bytes, type === null ? {} : { headers: { 'content-type': type } }]) as Response);
    },
    writable: true, enumerable: true, configurable: true,
  });
  defineOnHost(proto, 'blob', {
    value: async function blob(this: Response): Promise<Blob> {
      const type = changedType(this);
      if (type === undefined) return nativeBlob.call(this);
      return new Blob([await nativeArrayBuffer.call(this)], type === null ? {} : { type });
    },
    writable: true, enumerable: true, configurable: true,
  });

  takeFromHost(target, 'Response', NodeResponse);
}

