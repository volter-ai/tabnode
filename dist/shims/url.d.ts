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
export declare function parse(urlString: string, parseQueryString?: boolean, slashesDenoteHost?: boolean): UrlObject;
export declare function format(urlObject: UrlObject): string;
export declare function resolve(from: string, to: string): string;
export declare const URL: {
    new (url: string | URL, base?: string | URL): URL;
    prototype: URL;
    canParse(url: string | URL, base?: string | URL): boolean;
    createObjectURL(obj: Blob | MediaSource): string;
    parse(url: string | URL, base?: string | URL): URL | null;
    revokeObjectURL(url: string): void;
};
export declare const URLSearchParams: {
    new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
    prototype: URLSearchParams;
};
/**
 * Convert a file:// URL to a file path
 * Node.js: url.fileURLToPath('file:///home/user/file.txt') -> '/home/user/file.txt'
 */
export declare function fileURLToPath(url: string | URL): string;
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
export declare function pathToFileURL(path: string): URL;
export declare const URLPattern: unknown;
declare const _default: {
    parse: typeof parse;
    format: typeof format;
    resolve: typeof resolve;
    URL: {
        new (url: string | URL, base?: string | URL): URL;
        prototype: URL;
        canParse(url: string | URL, base?: string | URL): boolean;
        createObjectURL(obj: Blob | MediaSource): string;
        parse(url: string | URL, base?: string | URL): URL | null;
        revokeObjectURL(url: string): void;
    };
    URLSearchParams: {
        new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
        prototype: URLSearchParams;
    };
    URLPattern: unknown;
    fileURLToPath: typeof fileURLToPath;
    pathToFileURL: typeof pathToFileURL;
};
export default _default;
//# sourceMappingURL=url.d.ts.map