/**
 * A web `Response` that keeps its `Set-Cookie` headers, as Node's does.
 *
 * Node's `Response` (undici's) is built with a `Headers` that holds every
 * header it was given, `Set-Cookie` among them, readable through `get`
 * (joined with ", "), iteration (one entry per cookie) and `getSetCookie()`.
 * A browser's applies the fetch specification's response guard, which drops
 * `Set-Cookie` and `Set-Cookie2` silently: `new Response('', { headers:
 * { 'set-cookie': 'a=1' } }).headers` is empty in a tab. A server that
 * answers with a web Response (Next's route handlers and middleware, Hono,
 * Remix, SvelteKit's adapters, NextAuth among them) then loses every cookie
 * it sets before its answer is written to the socket, and no one can sign in.
 *
 * The response keeps a `Headers` of its own, made without a guard (a
 * `Headers` a program constructs is one, in a browser too), holding what the
 * browser's kept and every `Set-Cookie` the program gave it. Everything else
 * (body, status, the stream, `ok`, `url`) is the browser's own response.
 */
export function nodeResponseClass(Native: typeof Response): typeof Response {
  const kept = new WeakMap<object, Headers>();
  /** The browser's headers with the cookies its guard dropped. */
  const withCookies = (own: Headers, asked: HeadersInit | undefined): Headers => {
    const headers = new Headers(own);
    if (asked === undefined || asked === null) return headers;
    const given = new Headers(asked);
    const cookies = typeof given.getSetCookie === 'function'
      ? given.getSetCookie()
      : (() => { const values: string[] = []; given.forEach((value, name) => { if (name === 'set-cookie') values.push(value); }); return values; })();
    if (cookies.length && headers.has('set-cookie')) headers.delete('set-cookie');
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return headers;
  };
  const initOf = (response: Response, headers: Headers): ResponseInit => ({ status: response.status, statusText: response.statusText, headers });

  class NodeResponse extends Native {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      kept.set(this, withCookies(super.headers, init?.headers));
    }

    get headers(): Headers {
      return kept.get(this) ?? super.headers;
    }

    clone(): Response {
      const copy = super.clone();
      return new NodeResponse(copy.body, initOf(copy, new Headers(this.headers)));
    }

    // A static of the platform's `Response` answers a platform response, of
    // the platform's class; these answer this class's, with the cookies kept.
    static json(data: unknown, init?: ResponseInit): Response {
      const made = Native.json(data, init);
      return new NodeResponse(made.body, initOf(made, withCookies(made.headers, init?.headers)));
    }

    static redirect(url: string | URL, status?: number): Response {
      const made = Native.redirect(url, status);
      return new NodeResponse(null, initOf(made, new Headers(made.headers)));
    }

    static error(): Response {
      return Native.error();
    }

    // A response the platform made (a fetch's answer, `Response.error()`) is
    // a `Response` to a program, as it is on Node; a subclass a program
    // declares keeps the ordinary test.
    static [Symbol.hasInstance](value: unknown): boolean {
      if (this === NodeResponse) return value instanceof Native;
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
  }
  Object.defineProperty(NodeResponse, '__substrateSetCookie', { value: true });
  Object.defineProperty(NodeResponse, 'name', { value: 'Response', configurable: true });
  return NodeResponse;
}
