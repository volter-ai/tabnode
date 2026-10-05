/**
 * Host lookup for this engine's loopback. There is no outbound DNS service.
 * The World can wrap this door; a miss must never become a local wildcard.
 */

// DNS lookup callback type
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void;
type LookupOptions = { family?: number | 'IPv4' | 'IPv6'; all?: boolean; order?: 'verbatim' | 'ipv4first' | 'ipv6first' };

function notFound(hostname: string, syscall = 'getaddrinfo'): Error {
  return Object.assign(new Error(`${syscall} ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, syscall, hostname });
}

/** 4 or 6 for an IPv4 or IPv6 literal (brackets allowed), 0 for a name. */
function literalFamily(hostname: string): 4 | 6 | 0 {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(bare)) return 4;
  const host = bare.split('%')[0];
  if (host.includes(':')) {
    try { new URL(`http://[${host}]/`); return 6; } catch { /* malformed names are not IP literals */ }
  }
  return 0;
}

/**
 * Node's getaddrinfo shape over the names this host can actually reach.
 */
export function lookup(
  hostname: string,
  callback: LookupCallback
): void;
export function lookup(
  hostname: string,
  options: LookupOptions & { all: true },
  callback: LookupAllCallback
): void;
export function lookup(
  hostname: string,
  options: number | LookupOptions,
  callback: LookupCallback | LookupAllCallback
): void;
export function lookup(
  hostname: string,
  optionsOrCallback: number | LookupOptions | LookupCallback,
  callback?: LookupCallback | LookupAllCallback
): void {
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  const options = typeof optionsOrCallback === 'number' ? { family: optionsOrCallback } : typeof optionsOrCallback === 'object' && optionsOrCallback ? optionsOrCallback : {};
  if (typeof cb !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (hostname && typeof hostname !== 'string') throw Object.assign(new TypeError('The hostname argument must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  const requested = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family ?? 0;
  if (![0, 4, 6].includes(requested)) throw Object.assign(new TypeError(`Invalid address family: ${requested}`), { code: 'ERR_INVALID_ARG_VALUE' });

  setImmediate(() => {
    if (!hostname) {
      if (options.all) (cb as LookupAllCallback)(null, []);
      else (cb as LookupCallback)(null, undefined, requested === 6 ? 6 : 4);
      return;
    }
    // An IP literal is its own answer, in its own family, as Node's lookup short-circuits it: `::` must stay IPv6.
    const family = literalFamily(hostname);
    if (family) {
      const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
      if (options.all) (cb as LookupAllCallback)(null, [{ address, family }]);
      else (cb as LookupCallback)(null, address, family);
      return;
    }
    if (hostname.toLowerCase().replace(/\.$/, '') === 'localhost') {
      const families = requested ? [requested] : options.order === 'ipv6first' ? [6, 4] : [4, 6];
      const addresses = families.map(family => ({ address: family === 6 ? '::1' : '127.0.0.1', family }));
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
    } else {
      // TCP accepts 0.0.0.0 as this host. Returning it for an unknown name
      // silently connected a program to an unrelated local listener.
      cb(notFound(hostname));
    }
  });
}

/**
 * Resource-record queries require a DNS service, which this host does not have.
 */
export function resolve(
  hostname: string,
  callback: (err: Error | null, addresses?: string[]) => void
): void {
  setImmediate(() => {
    callback(notFound(hostname, 'queryA'));
  });
}

export function resolve4(
  hostname: string,
  callback: (err: Error | null, addresses?: string[]) => void
): void {
  resolve(hostname, callback);
}

export function resolve6(
  hostname: string,
  callback: (err: Error | null, addresses?: string[]) => void
): void {
  setImmediate(() => {
    callback(notFound(hostname, 'queryAaaa'));
  });
}

/**
 * No PTR resolver is installed; an arbitrary address is never localhost.
 */
export function reverse(
  ip: string,
  callback: (err: Error | null, hostnames?: string[]) => void
): void {
  setImmediate(() => {
    callback(notFound(ip, 'getHostByAddr'));
  });
}

/**
 * Set servers - no-op in browser
 */
export function setServers(_servers: string[]): void {
  // No-op
}

/**
 * Get servers - return empty in browser
 */
export function getServers(): string[] {
  return [];
}

/**
 * Set default result order - no-op in browser
 * Order can be 'ipv4first', 'ipv6first', or 'verbatim'
 */
export function setDefaultResultOrder(_order: string): void {
  // No-op in browser
}

/**
 * Get default result order
 */
export function getDefaultResultOrder(): string {
  return 'verbatim';
}

// Promises API
export const promises = {
  lookup: (hostname: string, options?: number | LookupOptions) => {
    return new Promise((resolve, reject) => {
      if (typeof options === 'object' && options?.all) {
        lookup(hostname, options, ((err: Error | null, addresses?: Array<{ address: string; family: number }>) => {
          if (err) reject(err);
          else resolve(addresses || []);
        }) as LookupAllCallback);
        return;
      }

      lookup(hostname, options ?? {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
  },
  resolve: (hostname: string) => {
    return new Promise<string[]>((promiseResolve, promiseReject) => {
      resolve(hostname, (err, addresses) => {
        if (err) promiseReject(err);
        else promiseResolve(addresses || []);
      });
    });
  },
  resolve4: (hostname: string) => promises.resolve(hostname),
  resolve6: (hostname: string) => {
    return new Promise<string[]>((resolve, reject) => {
      resolve6(hostname, (err, addresses) => { if (err) reject(err); else resolve(addresses || []); });
    });
  },
  reverse: (ip: string) => {
    return new Promise<string[]>((resolve, reject) => {
      reverse(ip, (err, hostnames) => { if (err) reject(err); else resolve(hostnames || []); });
    });
  },
  setServers: (_servers: string[]) => {},
  getServers: () => [] as string[],
};

// Constants
export const ADDRCONFIG = 0;
export const V4MAPPED = 0;
export const ALL = 0;

const dnsModule = {
  lookup,
  resolve,
  resolve4,
  resolve6,
  reverse,
  setServers,
  getServers,
  setDefaultResultOrder,
  getDefaultResultOrder,
  promises,
  ADDRCONFIG,
  V4MAPPED,
  ALL,
};

const dnsCodes = {
  NODATA: "ENODATA", FORMERR: "EFORMERR", SERVFAIL: "ESERVFAIL", NOTFOUND: "ENOTFOUND",
  NOTIMP: "ENOTIMP", REFUSED: "EREFUSED", BADQUERY: "EBADQUERY", BADNAME: "EBADNAME",
  BADFAMILY: "EBADFAMILY", BADRESP: "EBADRESP", CONNREFUSED: "ECONNREFUSED", TIMEOUT: "ETIMEOUT",
  EOF: "EOF", FILE: "EFILE", NOMEM: "ENOMEM", DESTRUCTION: "EDESTRUCTION", BADSTR: "EBADSTR",
  BADFLAGS: "EBADFLAGS", NONAME: "ENONAME", BADHINTS: "EBADHINTS", NOTINITIALIZED: "ENOTINITIALIZED",
  LOADIPHLPAPI: "ELOADIPHLPAPI", ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS", CANCELLED: "ECANCELLED"
};

export function createDnsModule() {
  const promiseModule = { ...promises, ...dnsCodes };
  return { ...dnsModule, ...dnsCodes, promises: promiseModule };
}

export default dnsModule;
