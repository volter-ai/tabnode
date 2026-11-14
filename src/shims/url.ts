/**
 * `url`, as Node's own `lib/url.js`, for the library's `url` export.
 *
 * A guest's `require('url')` is Node v24.21.0's `lib/url.js` in its process's builtin graph (`node-lib/load.ts`): the
 * legacy `parse`, `format`, `resolve` and `Url` are that file's own JavaScript parser, over Node's `querystring`,
 * `internal/querystring`, `internal/errors` and `internal/validators`, with `internal/url` bound by hand over the
 * realm's WHATWG `URL` (`node-lib/internals/url.ts`). This module loads that same file through the same loader,
 * outside any process, when it is evaluated, as `net-module.ts` loads `net`: the default is Node's module object and
 * each name is its own member.
 */
import { loadNodeLib } from '../node-lib/load';

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
  URL: typeof globalThis.URL;
  URLSearchParams: typeof globalThis.URLSearchParams;
  URLPattern: unknown;
}

const nodeUrl = loadNodeLib('url') as UrlModule;

export const parse = nodeUrl.parse;
export const format = nodeUrl.format;
export const resolve = nodeUrl.resolve;
export const resolveObject = nodeUrl.resolveObject;
export const fileURLToPath = nodeUrl.fileURLToPath;
export const pathToFileURL = nodeUrl.pathToFileURL;
export const domainToASCII = nodeUrl.domainToASCII;
export const domainToUnicode = nodeUrl.domainToUnicode;
export const urlToHttpOptions = nodeUrl.urlToHttpOptions;
export const Url = nodeUrl.Url;

/** The realm's WHATWG classes, which are what Node's `url.URL` and `url.URLSearchParams` are here. */
export const URL = nodeUrl.URL;
export const URLSearchParams = nodeUrl.URLSearchParams;
export const URLPattern = nodeUrl.URLPattern;

export default nodeUrl;
