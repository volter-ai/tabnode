/**
 * A process's `URL`: the realm's, with Node's `URL.createObjectURL` and `URL.revokeObjectURL`
 * (`lib/internal/url.js` installObjectURLMethods) over the process's blob registry (`internalBinding('blob')`), so a
 * `blob:nodedata:` URL it makes is one `buffer.resolveObjectURL` and undici's `fetch` resolve. The realm's own pair
 * mints the page's blob URLs and stays the realm's. Every other member, construction and `instanceof` are the realm
 * URL's own: the process's is a view of it, as its `ReadableStream` is.
 */
import { loadNodeLibFor, nodeLibBindingFor } from './load';
import type { BlobBinding } from './binding/blob';

const urls = new WeakMap<object, typeof URL>();

export function processUrl(process: object): typeof URL {
  let url = urls.get(process);
  if (url) return url;
  const codes = (): Record<string, new (...args: unknown[]) => Error> => (loadNodeLibFor(process, 'internal/errors') as { codes: Record<string, new (...args: unknown[]) => Error> }).codes;
  const blob = (): { isBlob(value: unknown): boolean } => loadNodeLibFor(process, 'internal/blob') as { isBlob(value: unknown): boolean };
  const binding = (): BlobBinding => nodeLibBindingFor(process, 'blob') as BlobBinding;
  const methods: Record<string, PropertyDescriptor> = {
    createObjectURL: {
      configurable: true, writable: true, enumerable: true,
      value: function createObjectURL(obj: unknown): string {
        if (!blob().isBlob(obj)) throw new (codes().ERR_INVALID_ARG_TYPE!)('obj', 'Blob', obj);
        const id = (loadNodeLibFor(process, 'crypto') as { randomUUID(): string }).randomUUID();
        binding().storeDataObject(id, obj as Blob, (obj as Blob).size, (obj as Blob).type);
        return `blob:nodedata:${id}`;
      },
    },
    revokeObjectURL: {
      configurable: true, writable: true, enumerable: true,
      value: function revokeObjectURL(this: unknown, url: unknown): void {
        // eslint-disable-next-line prefer-rest-params
        if (arguments.length === 0) throw new (codes().ERR_MISSING_ARGS!)('url');
        binding().revokeObjectURL(`${url}`);
      },
    },
  };
  url = new Proxy(globalThis.URL, {
    get: (target, key, receiver) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(methods, key) ? methods[key]!.value : Reflect.get(target, key, receiver),
    getOwnPropertyDescriptor: (target, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(methods, key) ? { ...methods[key] } : Reflect.getOwnPropertyDescriptor(target, key),
    // The process's own pair is the process's to replace; the realm's stays the realm's.
    set: (target, key, value, receiver) => {
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(methods, key)) return Reflect.set(target, key, value, receiver);
      methods[key] = { ...methods[key], value };
      return true;
    },
  });
  urls.set(process, url);
  return url;
}
