/**
 * `dns`, answered by the realm's network namespace (`../network-namespace.ts`). Node's `dns.lookup` is getaddrinfo:
 * the process's own `/etc/hosts`, then the resolver its `/etc/resolv.conf` names; `dns.resolve*` is a query to that
 * resolver. The resolver here is the namespace's, which its host answers (a container's names, by the networks the
 * asker shares with it, as Docker's embedded resolver at 127.0.0.11 answers them). A name the resolver does not hold
 * is `ENOTFOUND`; it never becomes this host or a wildcard.
 */
import { heldWork } from '../host-globals';
import { getEngineNamespace, type ResolverAnswer } from '../network-namespace';

// DNS lookup callback type
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void;
type LookupOptions = { family?: number | 'IPv4' | 'IPv6'; all?: boolean; order?: 'verbatim' | 'ipv4first' | 'ipv6first' };
type ResolveCallback = (err: Error | null, addresses?: string[]) => void;

/**
 * Node counts a lookup request until its callback runs. This answer uses the engine's own immediate, which a
 * guest run does not count. Hold the asking process's work through the callback (and through the resolver's
 * answer, when the namespace's host answers later) so a lookup stays pending until its answer is delivered. A
 * callback that throws is the asking process's uncaught exception, as a throw from a getaddrinfo callback is in
 * Node: thrown from the immediate, or from a fresh one when the resolver answered later.
 */
function answerLater(answer: () => void | Promise<void>): void {
  const held = heldWork();
  held.count += 1;
  setImmediate(() => {
    let pending: Promise<void> | undefined;
    try { const result: unknown = answer(); if (result instanceof Promise) pending = result; }
    finally { if (!pending) held.count -= 1; }
    pending?.then(() => { held.count -= 1; }, (cause: unknown) => {
      setImmediate(() => { try { throw cause; } finally { held.count -= 1; } });
    });
  });
}

/** What a resolver's failure is to a callback: the error it threw, or one naming what it threw. */
const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));

/** The namespace's resolver, asked for one family: what it holds for the name, compared without case or a trailing dot. */
async function ask(hostname: string, family: 4 | 6): Promise<ResolverAnswer> {
  return getEngineNamespace().resolve(hostname.toLowerCase().replace(/\.$/, ''), family);
}

/** getaddrinfo's EAI_NONAME, which Node names ENOTFOUND; a resolver query's ENOTFOUND (NXDOMAIN) or ENODATA. */
function notFound(hostname: string, syscall = 'getaddrinfo', code: 'ENOTFOUND' | 'ENODATA' = 'ENOTFOUND'): Error {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), {
    code, ...(syscall === 'getaddrinfo' ? { errno: -3008 } : {}), syscall, hostname,
  });
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

/** /etc/hosts aliases from this process's mounted file, in file order. */
function hostsAddresses(content: string, hostname: string): Array<{ address: string; family: number }> | undefined {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  const addresses: Array<{ address: string; family: number }> = [];
  for (const line of content.split(/\r?\n/)) {
    const [address, ...names] = line.split('#', 1)[0].trim().split(/\s+/);
    const family = literalFamily(address ?? '');
    if (family && names.some(alias => alias.toLowerCase().replace(/\.$/, '') === name)
      && !addresses.some(row => row.address === address && row.family === family)) addresses.push({ address, family });
  }
  return addresses.length ? addresses : undefined;
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
  lookupWithHosts(undefined, hostname, optionsOrCallback, callback);
}

function lookupWithHosts(
  readHosts: (() => string) | undefined,
  hostname: string,
  optionsOrCallback: number | LookupOptions | LookupCallback,
  callback?: LookupCallback | LookupAllCallback,
): void {
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  const options = typeof optionsOrCallback === 'number' ? { family: optionsOrCallback } : typeof optionsOrCallback === 'object' && optionsOrCallback ? optionsOrCallback : {};
  if (typeof cb !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (hostname && typeof hostname !== 'string') throw Object.assign(new TypeError('The hostname argument must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
  const requested = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family ?? 0;
  if (![0, 4, 6].includes(requested)) throw Object.assign(new TypeError(`Invalid address family: ${requested}`), { code: 'ERR_INVALID_ARG_VALUE' });

  answerLater(() => {
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
    // hosts(5) belongs to the requesting process. Preserve the actual addresses and families,
    // including aliases, rather than making every held name an IPv4/IPv6 wildcard.
    let fileAddresses: Array<{ address: string; family: number }> | undefined;
    try { fileAddresses = readHosts ? hostsAddresses(readHosts(), hostname) : undefined; }
    catch (cause) {
      // nss_files reports an unreadable hosts source as unavailable; lookup continues with
      // the next resolver source. Kernel-owner/protocol, EIO transport and programming failures still surface.
      const code = cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR", "ELOOP", "EMFILE", "ENFILE"].includes(code ?? '')) {
        cb(cause instanceof Error ? cause : new Error(String(cause))); return;
      }
    }
    if (fileAddresses !== undefined) {
      let addresses = fileAddresses.filter(row => !requested || row.family === requested);
      if (options.order === 'ipv4first' || options.order === 'ipv6first') {
        const first = options.order === 'ipv6first' ? 6 : 4;
        addresses = [...addresses.filter(row => row.family === first), ...addresses.filter(row => row.family !== first)];
      }
      if (!addresses.length) { cb(notFound(hostname)); return; }
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
      return;
    }
    // localhost is the namespace's own loopback (RFC 6761), whatever its resolver holds.
    if (hostname.toLowerCase().replace(/\.$/, '') === 'localhost') {
      const families = requested ? [requested] : options.order === 'ipv6first' ? [6, 4] : [4, 6];
      const addresses = families.map(family => ({ address: family === 6 ? '::1' : '127.0.0.1', family }));
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
      return;
    }
    // The resolver: A, then AAAA (or as `order` puts them), as getaddrinfo asks for an unspecified family.
    const families: Array<4 | 6> = requested ? [requested as 4 | 6] : options.order === 'ipv6first' ? [6, 4] : [4, 6];
    const asked = Promise.all(families.map(family => ask(hostname, family)))
      .then(answers => ({ answers }), (cause: unknown) => ({ cause }));
    // The callback runs outside the resolver's settlement, so what it throws is its own (answerLater).
    return asked.then((outcome) => {
      if ('cause' in outcome) { cb(asError(outcome.cause)); return; }
      const addresses = outcome.answers.flatMap((answer, index) => (answer ?? []).map(address => ({ address, family: families[index]! })));
      // A name with no address of the asked family is EAI_NODATA, which Node reports as ENOTFOUND too.
      if (!addresses.length) { cb(notFound(hostname)); return; }
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
    });
  });
}

/** The record types the namespace's resolver holds: a name's addresses. */
const RECORD_FAMILIES: Record<string, 4 | 6> = { A: 4, AAAA: 6 };

/**
 * A query to the namespace's resolver. It holds A and AAAA records: a name it does not hold is ENOTFOUND, one it
 * holds with no record of the type ENODATA, as a server answers NOERROR with an empty answer.
 */
function query(hostname: string, rrtype: string, callback: ResolveCallback): void {
  const syscall = `query${rrtype.charAt(0)}${rrtype.slice(1).toLowerCase()}`;
  const family = RECORD_FAMILIES[rrtype];
  answerLater(() => ask(hostname, family ?? 4)
    .then(held => ({ held }), (cause: unknown) => ({ cause }))
    .then((outcome) => {
      if ('cause' in outcome) callback(asError(outcome.cause));
      else if (outcome.held === undefined) callback(notFound(hostname, syscall));
      else if (family === undefined || outcome.held.length === 0) callback(notFound(hostname, syscall, 'ENODATA'));
      else callback(null, [...outcome.held]);
    }));
}

export function resolve(hostname: string, callback: ResolveCallback): void;
export function resolve(hostname: string, rrtype: string, callback: ResolveCallback): void;
export function resolve(hostname: string, rrtypeOrCallback: string | ResolveCallback, callback?: ResolveCallback): void {
  if (typeof rrtypeOrCallback === 'function') query(hostname, 'A', rrtypeOrCallback);
  else query(hostname, String(rrtypeOrCallback).toUpperCase(), callback as ResolveCallback);
}

export function resolve4(hostname: string, callback: ResolveCallback): void {
  query(hostname, 'A', callback);
}

export function resolve6(hostname: string, callback: ResolveCallback): void {
  query(hostname, 'AAAA', callback);
}

/**
 * The namespace's resolver holds no PTR records; an arbitrary address is never localhost.
 */
export function reverse(
  ip: string,
  callback: (err: Error | null, hostnames?: string[]) => void
): void {
  answerLater(() => {
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
  resolve: (hostname: string, rrtype = 'A') => {
    return new Promise<string[]>((promiseResolve, promiseReject) => {
      resolve(hostname, rrtype, (err, addresses) => {
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

export function createDnsModule(readHosts?: () => string) {
  const processLookup = ((hostname: string, optionsOrCallback: number | LookupOptions | LookupCallback, callback?: LookupCallback | LookupAllCallback) => {
    lookupWithHosts(readHosts, hostname, optionsOrCallback, callback);
  }) as typeof lookup;
  const promiseModule = { ...promises, ...dnsCodes, lookup: (hostname: string, options?: number | LookupOptions) =>
    new Promise((resolve, reject) => {
      if (typeof options === 'object' && options?.all) {
        processLookup(hostname, options, (err: Error | null, addresses?: Array<{ address: string; family: number }>) => err ? reject(err) : resolve(addresses ?? []));
      } else {
        processLookup(hostname, options ?? {}, (err, address, family) => err ? reject(err) : resolve({ address, family }));
      }
    }) };
  return { ...dnsModule, ...dnsCodes, lookup: processLookup, promises: promiseModule };
}

export default dnsModule;
