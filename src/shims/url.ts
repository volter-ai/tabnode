/**
 * `url`, as Node's own `lib/url.js`, for the library's `url` export.
 *
 * A guest's `require('url')` is Node v24.21.0's `lib/url.js` in its process's builtin graph (`node-lib/load.ts`): the
 * legacy `parse`, `format`, `resolve` and `Url` are that file's own JavaScript parser, over Node's `querystring`,
 * `internal/querystring`, `internal/errors` and `internal/validators`, with `internal/url` bound by hand over the
 * realm's WHATWG `URL` (`node-lib/internals/url.ts`). This module reads that same file through the same loader,
 * outside any process, on its first use (the rule `node-lib/lazy.ts` states); each function is the file's.
 */
import { lazyModule } from '../node-lib/lazy';

export interface UrlObject {
  protocol?: string | null;
  slashes?: boolean | null;
  auth?: string | null;
  host?: string | null;
  port?: string | number | null;
  hostname?: string | null;
  hash?: string | null;
  search?: string | null;
  query?: string | Record<string, string | string[]> | null;
  pathname?: string | null;
  path?: string | null;
  href?: string | null;
}

interface UrlModule {
  parse(urlString: string, parseQueryString?: boolean, slashesDenoteHost?: boolean): UrlObject;
  format(urlObject: UrlObject | URL | string, options?: Record<string, unknown>): string;
  resolve(from: string, to: string): string;
  resolveObject(from: string | UrlObject, to: string): UrlObject;
  fileURLToPath(url: string | URL): string;
  pathToFileURL(path: string): URL;
  domainToASCII(domain: string): string;
  domainToUnicode(domain: string): string;
  urlToHttpOptions(url: URL): Record<string, unknown>;
  Url: new () => UrlObject;
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  URLPattern: unknown;
}

const nodeUrl = lazyModule<UrlModule>('url');

export function parse(urlString: string, parseQueryString = false, slashesDenoteHost = false): UrlObject {
  return nodeUrl.parse(urlString, parseQueryString, slashesDenoteHost);
}
export function format(urlObject: UrlObject | URL | string, options?: Record<string, unknown>): string {
  return nodeUrl.format(urlObject, options);
}
export function resolve(from: string, to: string): string { return nodeUrl.resolve(from, to); }
export function resolveObject(from: string | UrlObject, to: string): UrlObject { return nodeUrl.resolveObject(from, to); }
export function fileURLToPath(url: string | URL): string { return nodeUrl.fileURLToPath(url); }
export function pathToFileURL(path: string): URL { return nodeUrl.pathToFileURL(path); }
export function domainToASCII(domain: string): string { return nodeUrl.domainToASCII(domain); }
export function domainToUnicode(domain: string): string { return nodeUrl.domainToUnicode(domain); }
export function urlToHttpOptions(url: URL): Record<string, unknown> { return nodeUrl.urlToHttpOptions(url); }

/** The realm's WHATWG classes, which are what Node's `url.URL` and `url.URLSearchParams` are here. */
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export default nodeUrl;
