/**
 * Node.js url module shim
 * Uses browser's built-in URL API
 */

export interface UrlObject {
  protocol?: string | null;
  slashes?: boolean | null;
  auth?: string | null;
  host?: string | null;
  port?: string | null;
  hostname?: string | null;
  hash?: string | null;
  search?: string | null;
  query?: string | Record<string, string | string[]> | null;
  pathname?: string | null;
  path?: string | null;
  href?: string;
}

/**
 * The legacy `url.parse` gives a path back as a path. Node's
 * `url.parse("/workspace/app/x")` has `href` and `pathname` equal to the input
 * and no host; the shim resolved every input against a made-up
 * `http://localhost`, so `href` came back as a URL, and Tailwind v3, which runs
 * each config dependency through `url.parse(file).href` before it stats it,
 * stated a path that does not exist. An input with no scheme is split into its
 * path, search and hash, as Node does.
 */
export function parse(
  urlString: string,
  parseQueryString: boolean = false,
  slashesDenoteHost: boolean = false
): UrlObject {
  if (typeof urlString === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(urlString) && !urlString.startsWith('//')) {
    const __hashAt = urlString.indexOf('#');
    const __hash = __hashAt >= 0 ? urlString.slice(__hashAt) : null;
    const __beforeHash = __hashAt >= 0 ? urlString.slice(0, __hashAt) : urlString;
    const __searchAt = __beforeHash.indexOf('?');
    const __search = __searchAt >= 0 ? __beforeHash.slice(__searchAt) : null;
    const __pathname = __searchAt >= 0 ? __beforeHash.slice(0, __searchAt) : __beforeHash;
    return {
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: __hash,
      search: __search,
      query: parseQueryString ? Object.fromEntries(new URLSearchParams(__search || '')) : (__search ? __search.slice(1) : null),
      pathname: __pathname || null,
      path: (__pathname + (__search || '')) || null,
      href: urlString
    };
  }
  try {
    const url = new URL(urlString, 'http://localhost');
    const result: UrlObject = {
      protocol: url.protocol,
      slashes: url.protocol.endsWith(':'),
      auth: url.username ? `${url.username}:${url.password}` : null,
      host: url.host,
      port: url.port || null,
      hostname: url.hostname,
      hash: url.hash || null,
      search: url.search || null,
      query: parseQueryString ? Object.fromEntries(url.searchParams) : url.search?.slice(1) || null,
      pathname: url.pathname,
      path: url.pathname + url.search,
      href: url.href,
    };
    return result;
  } catch {
    // Handle relative URLs
    return {
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: null,
      search: null,
      query: null,
      pathname: urlString,
      path: urlString,
      href: urlString,
    };
  }
}

export function format(urlObject: UrlObject): string {
  if (urlObject.href) {
    return urlObject.href;
  }

  let result = '';

  if (urlObject.protocol) {
    result += urlObject.protocol;
    if (!urlObject.protocol.endsWith(':')) {
      result += ':';
    }
  }

  if (urlObject.slashes || urlObject.protocol === 'http:' || urlObject.protocol === 'https:') {
    result += '//';
  }

  if (urlObject.auth) {
    result += urlObject.auth + '@';
  }

  if (urlObject.hostname) {
    result += urlObject.hostname;
  } else if (urlObject.host) {
    result += urlObject.host;
  }

  if (urlObject.port) {
    result += ':' + urlObject.port;
  }

  if (urlObject.pathname) {
    result += urlObject.pathname;
  }

  if (urlObject.search) {
    result += urlObject.search;
  } else if (urlObject.query) {
    if (typeof urlObject.query === 'string') {
      result += '?' + urlObject.query;
    } else {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(urlObject.query)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            params.append(key, v);
          }
        } else {
          params.set(key, value);
        }
      }
      const search = params.toString();
      if (search) {
        result += '?' + search;
      }
    }
  }

  if (urlObject.hash) {
    result += urlObject.hash;
  }

  return result;
}

export function resolve(from: string, to: string): string {
  try {
    return new URL(to, from).href;
  } catch {
    return to;
  }
}

// Re-export URL and URLSearchParams from globals
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

/**
 * Convert a file:// URL to a file path
 * Node.js: url.fileURLToPath('file:///home/user/file.txt') -> '/home/user/file.txt'
 */
export function fileURLToPath(url: string | URL): string {
  const urlObj = typeof url === 'string' ? new globalThis.URL(url) : url;
  if (urlObj.protocol !== 'file:') {
    throw new TypeError('The URL must be of scheme file');
  }
  // Decode percent-encoded characters and return pathname
  return decodeURIComponent(urlObj.pathname);
}

/**
 * Convert a file path to a file:// URL
 * Node.js: url.pathToFileURL('/home/user/file.txt') -> URL { href: 'file:///home/user/file.txt' }
 */
/**
 * `url.pathToFileURL` takes any path Node takes. This encoded the whole path
 * after `file://`, so a path that did not begin with `/` became the URL's host,
 * and a virtual module id, the Vue plugin's `\0plugin-vue:export-helper`, was
 * no host at all: Vite's SSR loader asked for the file URL of every module it
 * instantiated and vue3-ssr's render died on "Invalid URL". A relative path is
 * resolved against the working directory first, as Node resolves it, and each
 * segment is encoded on its own, so the URL's path is the path.
 */
export function pathToFileURL(path: string): URL {
  if (typeof path !== 'string') {
    throw new TypeError('The "path" argument must be of type string. Received ' + typeof path);
  }
  const cwd = typeof globalThis.process?.cwd === 'function' ? globalThis.process.cwd() : '/';
  const resolved = path.startsWith('/') ? path : cwd.replace(/\/$/, '') + '/' + path;
  return new globalThis.URL('file://' + resolved.split('/').map((segment) => encodeURIComponent(segment)).join('/'));
}

export const URLPattern = (globalThis as unknown as { URLPattern?: unknown }).URLPattern;

export default {
  parse,
  format,
  resolve,
  URL,
  URLSearchParams,
  URLPattern,
  fileURLToPath,
  pathToFileURL,
};
