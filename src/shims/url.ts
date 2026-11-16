/**
 * `url`, as Node's own `lib/url.js`, for the library's `url` export.
 *
 * A guest's `require('url')` is Node v24.21.0's `lib/url.js` in its process's builtin graph (`node-lib/load.ts`): the
 * legacy `parse`, `format`, `resolve` and `Url` are that file's own JavaScript parser, over Node's `querystring`,
 * `internal/querystring`, `internal/errors` and `internal/validators`, with `internal/url` bound by hand over the
 * realm's WHATWG `URL` (`node-lib/internals/url.ts`). This module loads that same file through the same loader,
 * outside any process, on first use, as `net-module.ts` loads `net`: the default stands for Node's module object and
 * each name for its own member.
 */
import { lazyExport, lazyModule } from '../node-lib/lazy';

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

// Node's `url`, loaded on the first use of anything here, never when this module is evaluated: the engine is imported
// before a node realm's program is attached, and Node's library read then would build the program's bindings in their
// engine form (ADR-0018 §7). Each name stands for Node's own member (lazy.ts).
const nodeUrl = lazyModule<UrlModule>('url');

export const parse = lazyExport<UrlModule['parse']>('url', 'parse');
export const format = lazyExport<UrlModule['format']>('url', 'format');
export const resolve = lazyExport<UrlModule['resolve']>('url', 'resolve');
export const resolveObject = lazyExport<UrlModule['resolveObject']>('url', 'resolveObject');
export const fileURLToPath = lazyExport<UrlModule['fileURLToPath']>('url', 'fileURLToPath');
export const pathToFileURL = lazyExport<UrlModule['pathToFileURL']>('url', 'pathToFileURL');
export const domainToASCII = lazyExport<UrlModule['domainToASCII']>('url', 'domainToASCII');
export const domainToUnicode = lazyExport<UrlModule['domainToUnicode']>('url', 'domainToUnicode');
export const urlToHttpOptions = lazyExport<UrlModule['urlToHttpOptions']>('url', 'urlToHttpOptions');
export const Url = lazyExport<UrlModule['Url']>('url', 'Url');

/** The realm's WHATWG classes, which are what Node's `url.URL` and `url.URLSearchParams` are here. */
export const URL = lazyExport<UrlModule['URL']>('url', 'URL');
export const URLSearchParams = lazyExport<UrlModule['URLSearchParams']>('url', 'URLSearchParams');
export const URLPattern = lazyExport<UrlModule['URLPattern']>('url', 'URLPattern');

export default nodeUrl;
