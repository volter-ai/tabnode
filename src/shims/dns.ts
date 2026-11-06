/**
 * `dns`, as a Linux process resolves (ADR-0009 §3). Resolution is not a system call: `dns.lookup` is getaddrinfo,
 * libc code that reads the process's own `/etc/hosts` and then exchanges DNS messages over UDP with the nameservers
 * its `/etc/resolv.conf` names; `dns.resolve*` is c-ares, the same exchange. Both are made here, over the calling
 * process's own UDP sockets (`host-sockets.ts`): the namespace's resolver is a server in the namespace (Docker's
 * 127.0.0.11), answered by its kernel for every program, and this engine keeps no table, cache or answer of its own.
 *
 * A name the resolver does not hold (NXDOMAIN) is `ENOTFOUND`; it never becomes this host or a wildcard. A server
 * that fails, or does not answer within resolv.conf's `timeout` and `attempts` (glibc's 5 s and 2), is `EAI_AGAIN`
 * to a lookup; to a query it is c-ares's error for it (`ESERVFAIL`, `EREFUSED`, `ENOTIMP`, `EFORMERR`, `ETIMEOUT`,
 * `ECONNREFUSED`). `getServers()` is the process's `/etc/resolv.conf`'s nameservers. A process with no socket calls
 * can ask no server: a name not in its hosts file is `EAI_AGAIN`.
 *
 * A name is the one Node hands its libraries (`to_ascii`), checked as they check it before anything is sent: one
 * musl's getaddrinfo refuses (empty, 255 bytes or more, an empty label, a label over 63 bytes) is `ENOTFOUND` to a
 * lookup, and one c-ares refuses is `EBADNAME` to a query (ADR-0009 §3).
 */
import { heldWork } from '../host-globals';
import { queueGuestNextTick } from '../guest-loop';
import { adaToAscii } from '../node-lib/binding/ada_idna';
import { libRequire } from '../node-lib/require-hook';
import { AsyncLocalStorage } from './async_hooks';
import {
  callingSockets, captureCallingSockets, ipv6Text, linux, socketAddress, socketAddressBuffer, type TreeSockets,
} from '../host-sockets';

// DNS lookup callback type
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void;
type LookupOptions = { family?: number | 'IPv4' | 'IPv6'; all?: boolean; order?: 'verbatim' | 'ipv4first' | 'ipv6first' };
type ResolveCallback = (err: Error | null, addresses?: string[]) => void;

/** The calling call's context, to answer it in: its run (the async context) and its process's socket calls. */
function captureCaller(): <T>(continuation: () => T) => T {
  const snapshot = AsyncLocalStorage.snapshot();
  const sockets = captureCallingSockets();
  return <T>(continuation: () => T): T => snapshot(() => sockets(continuation)) as T;
}

/**
 * Node counts a lookup request until its callback runs. This answer uses the engine's own immediate, which a
 * guest run does not count. Hold the asking process's work through the callback (and through the resolver's
 * answer) so a lookup stays pending until its answer is delivered. A callback that throws is the asking process's
 * uncaught exception, as a throw from a getaddrinfo callback is in Node: thrown from the immediate, or from a fresh
 * one when the resolver answered later.
 */
function answerLater(answer: () => void | Promise<void>): void {
  const held = heldWork();
  held.count += 1;
  // The answer, and what its callback throws, run in the asking call's context: its run and its process (Node's
  // net.js makes a listener's handle in a lookup's callback: listen(port, host)).
  const within = captureCaller();
  setImmediate(() => {
    let pending: Promise<void> | undefined;
    try { const result: unknown = within(answer); if (result instanceof Promise) pending = result; }
    finally { if (!pending) held.count -= 1; }
    pending?.then(() => { held.count -= 1; }, (cause: unknown) => {
      setImmediate(() => { try { within(() => { throw cause; }); } finally { held.count -= 1; } });
    });
  });
}

/** `callback`, called in the context of the call that was given it, wherever the engine resumes it from. */
function inCallersContext<F extends (...args: never[]) => void>(callback: F): F {
  const within = captureCaller();
  return ((...args: Parameters<F>) => within(() => callback(...args))) as F;
}

/**
 * getaddrinfo's EAI_NONAME (-3008, a name nobody holds) or EAI_NODATA (-3007, a held name with no address of the asked
 * family), both of which Node names ENOTFOUND; a resolver query's ENOTFOUND (NXDOMAIN) or ENODATA.
 */
function notFound(hostname: string, syscall = 'getaddrinfo', code: 'ENOTFOUND' | 'ENODATA' = 'ENOTFOUND', errno = -3008): Error {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), {
    code, ...(syscall === 'getaddrinfo' ? { errno } : {}), syscall, hostname,
  });
}

/** A lookup whose servers failed or did not answer: getaddrinfo's EAI_AGAIN. */
function tryAgain(hostname: string): Error {
  return Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo', hostname });
}

/** A query whose servers failed, as c-ares names it. */
function queryFailed(hostname: string, syscall: string, code: string): Error {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), { code, syscall, hostname });
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

/** What `/etc/resolv.conf` says: its nameservers in order, and the `timeout` and `attempts` options (glibc's limits). */
interface ResolverConfig { servers: string[]; timeoutMs: number; attempts: number }
function resolverConfig(content: string | undefined): ResolverConfig {
  const servers: string[] = [];
  let timeout = 5, attempts = 2;
  for (const line of (content ?? '').split(/\r?\n/)) {
    const words = line.split(/[#;]/, 1)[0]!.trim().split(/\s+/);
    if (words[0] === 'nameserver' && words[1] && literalFamily(words[1])) servers.push(words[1]);
    if (words[0] === 'options') {
      for (const option of words.slice(1)) {
        const [key, value] = option.split(':');
        if (key === 'timeout' && /^\d+$/u.test(value ?? '')) timeout = Math.min(30, Math.max(1, Number(value)));
        if (key === 'attempts' && /^\d+$/u.test(value ?? '')) attempts = Math.min(5, Math.max(1, Number(value)));
      }
    }
  }
  return { servers, timeoutMs: timeout * 1000, attempts };
}

/** A nameserver as resolv.conf or setServers names it (`1.2.3.4`, `1.2.3.4:5353`, `::1`, `[::1]:53`), as a sockaddr. */
function serverAddress(server: string, sockets: TreeSockets | undefined): { family: number; address: Uint8Array } | undefined {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(server);
  if (bracketed) {
    const address = socketAddress(6, bracketed[1]!, Number(bracketed[2] ?? 53), sockets);
    return address ? { family: linux.AF_INET6, address } : undefined;
  }
  const withPort = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/u.exec(server);
  if (withPort) {
    const address = socketAddress(4, withPort[1]!, Number(withPort[2]));
    return address ? { family: linux.AF_INET, address } : undefined;
  }
  const v4 = socketAddress(4, server, 53);
  if (v4) return { family: linux.AF_INET, address: v4 };
  const v6 = socketAddress(6, server, 53, sockets);
  return v6 ? { family: linux.AF_INET6, address: v6 } : undefined;
}

/**
 * The record types a query admits (the types Node's `dns.resolve` takes) and the type number each asks for: the one
 * table both admission (`checkedRrtype`) and the question read. Only A and AAAA records' data are read; any other
 * type is answered by its rcode alone.
 */
const RECORD_TYPES: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, CAA: 257, TLSA: 52, ANY: 255,
};

/**
 * The name Node hands its resolver libraries (ADR-0009 §3): Ada's own `ada::idna::to_ascii` of what it was given
 * (`cares_wrap.cc` 1976, 1797), cut at its first NUL, since Node passes it to them as `name.c_str()`.
 */
function asciiName(hostname: string): string {
  const ascii = adaToAscii(hostname);
  const nul = ascii.indexOf('\0');
  return nul < 0 ? ascii : ascii.slice(0, nul);
}

/** Node's own `isIP` (`internal/net.js`), which `lib/dns.js` answers a literal by. */
function nodeIsIP(hostname: string): number {
  return (libRequire('internal/net') as { isIP(value: string): number }).isIP(hostname);
}

/** Node's own validators (`internal/validators.js`). */
const nodeValidators = (): {
  validateStringWithoutNullBytes(value: unknown, name: string): void;
  validateString(value: unknown, name: string): void;
  validateOneOf(value: unknown, name: string, oneOf: readonly unknown[]): void;
  validateBoolean(value: unknown, name: string): void;
} => libRequire('internal/validators') as ReturnType<typeof nodeValidators>;

/** A lookup's name as `lib/dns.js` checks it (`validateStringWithoutNullBytes`). */
function validateHostname(hostname: unknown): void {
  nodeValidators().validateStringWithoutNullBytes(hostname, 'hostname');
}

/** A query's name as Node's resolver checks it, before anything converts it (`validateString(name, 'name')`). */
function validateQueryName(name: unknown): void {
  nodeValidators().validateString(name, 'name');
}

/**
 * A lookup's options, checked before any answer (ADR-0009 §3), in Node's order: the family asked (4, 6, or 0 for
 * either), by Node's own `validateOneOf` on 0, 4 and 6, then `all` and then `verbatim` by Node's own `validateBoolean`
 * (`lib/dns.js` 175-197, `internal/dns/promises.js` 220-232). The one difference is the door's, as Node's: the callback
 * door also takes the family names `'IPv4'` and `'IPv6'` in an options object, the promise door does not.
 */
function lookupOptions(given: number | LookupOptions | undefined, door: 'callback' | 'promise'): { options: LookupOptions; requested: number } {
  if (typeof given === 'number') {
    nodeValidators().validateOneOf(given, 'family', [0, 4, 6]);
    return { options: { family: given }, requested: given + 0 };
  }
  const options = typeof given === 'object' && given ? given : {};
  let requested = 0;
  if (door === 'callback' && options.family === 'IPv4') requested = 4;
  else if (door === 'callback' && options.family === 'IPv6') requested = 6;
  else if (options.family != null) {
    nodeValidators().validateOneOf(options.family, 'options.family', [0, 4, 6]);
    requested = (options.family as number) + 0;
  }
  const flags = options as { all?: unknown; verbatim?: unknown };
  if (flags.all != null) nodeValidators().validateBoolean(flags.all, 'options.all');
  if (flags.verbatim != null) nodeValidators().validateBoolean(flags.verbatim, 'options.verbatim');
  return { options, requested };
}

/**
 * A name's labels as its query carries them (ADR-0009 §3), or undefined for a name the library refuses: one trailing
 * dot is the root's; an empty label anywhere else, a label over 63 bytes, or a name of more than `limit` bytes without
 * that dot is refused, as musl's `res_mkquery` (limit 253) and c-ares's `ares_split_dns_name` (limit 255) refuse it.
 * The root is no labels.
 */
function nameLabels(ascii: string, limit: number): Uint8Array[] | undefined {
  const name = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii;
  if (name === '') return [];
  if (name.length > limit) return undefined;
  const labels = name.split('.').map(label => new TextEncoder().encode(label));
  return labels.every(label => label.byteLength > 0 && label.byteLength <= 63) ? labels : undefined;
}

/** A query message (RFC 1035 §4.1): one question, recursion desired. */
function queryMessage(id: number, labels: readonly Uint8Array[], type: number): Uint8Array {
  const length = 12 + labels.reduce((total, label) => total + 1 + label.byteLength, 0) + 1 + 4;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint16(0, id); view.setUint16(2, 0x0100); view.setUint16(4, 1);
  let at = 12;
  for (const label of labels) { out[at++] = label.byteLength; out.set(label, at); at += label.byteLength; }
  out[at++] = 0;
  view.setUint16(at, type); view.setUint16(at + 2, 1);
  return out;
}

/** A name at `at` in a message, skipped (with its compression pointers): the offset after it. */
function skipName(message: Uint8Array, at: number): number {
  for (let guard = 0; at < message.byteLength && guard < 128; guard += 1) {
    const length = message[at]!;
    if (length === 0) return at + 1;
    if ((length & 0xc0) === 0xc0) return at + 2;
    at += 1 + length;
  }
  return -1;
}

/** A response's rcode and the addresses of `type` in its answer section; undefined for a message that is not one. */
function readResponse(message: Uint8Array, id: number, type: number): { rcode: number; addresses: string[] } | undefined {
  if (message.byteLength < 12) return undefined;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  if (view.getUint16(0) !== id || (view.getUint16(2) & 0x8000) === 0) return undefined;
  const rcode = view.getUint16(2) & 0x000f;
  const questions = view.getUint16(4), answers = view.getUint16(6);
  let at = 12;
  for (let index = 0; index < questions; index += 1) {
    at = skipName(message, at);
    if (at < 0 || at + 4 > message.byteLength) return undefined;
    at += 4;
  }
  const addresses: string[] = [];
  for (let index = 0; index < answers; index += 1) {
    at = skipName(message, at);
    if (at < 0 || at + 10 > message.byteLength) return undefined;
    const recordType = view.getUint16(at), length = view.getUint16(at + 8);
    at += 10;
    if (at + length > message.byteLength) return undefined;
    if (recordType === type && type === 1 && length === 4) addresses.push(Array.from(message.subarray(at, at + 4)).join('.'));
    if (recordType === type && type === 28 && length === 16) addresses.push(ipv6Text(message.subarray(at, at + 16)));
    at += length;
  }
  return { rcode, addresses };
}

/** What one exchange with one server gave: its answer, a send or receive that failed, or no answer in time. */
type ServerOutcome = { answer: { rcode: number; addresses: string[] } } | { error: number } | { timeout: true };

/** One question to one server over a UDP socket of the asking process: sent once, waited for until `timeoutMs`. */
async function askServer(sockets: TreeSockets, server: { family: number; address: Uint8Array }, message: Uint8Array, id: number, type: number, timeoutMs: number): Promise<ServerOutcome> {
  const fd = sockets.socket(server.family, linux.SOCK_DGRAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
  if (fd < 0) return { error: fd };
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; sockets.close(fd); } };
  try {
    const connected = sockets.connect(fd, server.address);
    if (connected < 0) return { error: connected };
    const sent = sockets.sendto(fd, message, linux.MSG_DONTWAIT, null);
    if (sent < 0) return { error: sent };
    const deadline = Date.now() + timeoutMs;
    const buffer = new Uint8Array(65536);
    for (;;) {
      const read = sockets.recvfrom(fd, buffer, linux.MSG_DONTWAIT, socketAddressBuffer());
      if (read >= 0) {
        const answer = readResponse(buffer.subarray(0, read), id, type);
        if (answer) return { answer };
        continue;
      }
      if (read !== -linux.EAGAIN && read !== -linux.EINTR) return { error: read };
      const left = deadline - Date.now();
      if (left <= 0) return { timeout: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        sockets.wait(fd, linux.POLLIN).then(() => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), left);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) return { timeout: true };
    }
  } finally { close(); }
}

/** rcodes a resolver takes as the server's failure, trying the next (RFC 1035 §4.1.1: FORMERR, SERVFAIL, NOTIMP, REFUSED). */
const SERVER_FAILURES = new Set([1, 2, 4, 5]);
/** c-ares's names for a server's failure, by rcode. */
const QUERY_FAILURES: Record<number, string> = { 1: 'EFORMERR', 2: 'ESERVFAIL', 4: 'ENOTIMP', 5: 'EREFUSED' };

/**
 * A question to the process's resolver: each server in order, `attempts` rounds, until one answers NOERROR or
 * NXDOMAIN; otherwise the last failure, as c-ares names it.
 */
async function ask(sockets: TreeSockets | undefined, config: ResolverConfig, labels: readonly Uint8Array[], type: number): Promise<{ rcode: number; addresses: string[] } | { failed: string }> {
  if (!sockets) return { failed: 'ECONNREFUSED' };
  // A resolv.conf naming no server is the local one, as glibc and c-ares take it.
  const servers = (config.servers.length ? config.servers : ['127.0.0.1'])
    .map(server => serverAddress(server, sockets)).filter((server): server is { family: number; address: Uint8Array } => server !== undefined);
  let failed = 'ETIMEOUT';
  for (let attempt = 0; attempt < config.attempts; attempt += 1) {
    for (const server of servers) {
      const id = (Math.random() * 0x10000) & 0xffff;
      const outcome = await askServer(sockets, server, queryMessage(id, labels, type), id, type, config.timeoutMs);
      if ('answer' in outcome) {
        if (!SERVER_FAILURES.has(outcome.answer.rcode)) return outcome.answer;
        failed = QUERY_FAILURES[outcome.answer.rcode] ?? 'ESERVFAIL';
      } else if ('error' in outcome) failed = outcome.error === -linux.ECONNREFUSED ? 'ECONNREFUSED' : 'ESERVFAIL';
      else failed = 'ETIMEOUT';
    }
  }
  return { failed };
}

/** The process's resolver configuration: setServers' servers, else its resolv.conf's. */
type ResolverDoor = () => ResolverConfig;

/**
 * Node's `dns.lookup` (ADR-0009 §3): Node's own front, then, until the libc's `getaddrinfo` is delegated to, the
 * process's hosts file and then its resolver. The engine answers no name itself.
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
  lookupWithHosts(undefined, engineResolver, hostname, optionsOrCallback, callback);
}

function lookupWithHosts(
  readHosts: (() => string) | undefined,
  resolver: ResolverDoor,
  hostname: string,
  optionsOrCallback: number | LookupOptions | LookupCallback,
  callback?: LookupCallback | LookupAllCallback,
): void {
  const given = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  if (typeof given !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  // Node's net.js makes a listener's handle in this callback (listen(port, host)): it runs in the caller's process.
  const cb = inCallersContext(given as LookupCallback) as LookupCallback | LookupAllCallback;
  const sockets = callingSockets();
  if (hostname) validateHostname(hostname);
  const { options, requested } = lookupOptions(typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback, 'callback');
  // Node's own answers (lib/dns.js 204-223), on a later tick: an empty name is null, and a string Node's isIP takes
  // is itself, in its family.
  if (!hostname) {
    queueGuestNextTick(() => {
      if (options.all) (cb as LookupAllCallback)(null, []);
      else (cb as unknown as (err: null, address: null, family: number) => void)(null, null, requested === 6 ? 6 : 4);
    });
    return;
  }
  const literal = nodeIsIP(hostname);
  if (literal) {
    queueGuestNextTick(() => {
      if (options.all) (cb as LookupAllCallback)(null, [{ address: hostname, family: literal }]);
      else (cb as LookupCallback)(null, hostname, literal);
    });
    return;
  }

  answerLater(() => {
    // The name getaddrinfo is given (Node's to_ascii); musl refuses an empty one, or one of 255 bytes or more, before
    // it reads any source (ADR-0009 §3).
    const ascii = asciiName(hostname);
    if (ascii === '' || ascii.length >= 255) { cb(notFound(hostname)); return; }
    // hosts(5) belongs to the requesting process. Preserve the actual addresses and families,
    // including aliases, rather than making every held name an IPv4/IPv6 wildcard.
    let fileAddresses: Array<{ address: string; family: number }> | undefined;
    try { fileAddresses = readHosts ? hostsAddresses(readHosts(), ascii) : undefined; }
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
      if (!addresses.length) { cb(notFound(hostname, 'getaddrinfo', 'ENOTFOUND', -3007)); return; }
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
      return;
    }
    // A name res_mkquery will not encode (the root, an empty label, a label over 63 bytes, more than 253 bytes) is no
    // answer from DNS, and getaddrinfo's EAI_NONAME: nothing is sent (ADR-0009 §3).
    const labels = nameLabels(ascii, 253);
    if (!labels?.length) { cb(notFound(hostname)); return; }
    // The resolver: A, then AAAA (or as `order` puts them), as getaddrinfo asks for an unspecified family.
    const families: Array<4 | 6> = requested ? [requested as 4 | 6] : options.order === 'ipv6first' ? [6, 4] : [4, 6];
    const config = resolver();
    const asked = (async () => {
      const answers: Array<{ rcode: number; addresses: string[] }> = [];
      for (const family of families) {
        const answer = await ask(sockets, config, labels, family === 6 ? 28 : 1);
        if ('failed' in answer) return undefined;
        answers.push(answer);
      }
      return answers;
    })();
    // The callback runs outside the resolver's settlement, so what it throws is its own (answerLater).
    return asked.then((answers) => {
      // A server that failed or did not answer is EAI_AGAIN.
      if (!answers) { cb(tryAgain(hostname)); return; }
      const addresses = answers.flatMap((answer, index) => answer.addresses.map(address => ({ address, family: families[index]! })));
      // A name nobody holds (NXDOMAIN) is EAI_NONAME; a held name with no address of the asked family EAI_NODATA. Node
      // reports both as ENOTFOUND, with their own errno.
      if (!addresses.length) { cb(notFound(hostname, 'getaddrinfo', 'ENOTFOUND', answers.some(answer => answer.rcode === 0) ? -3007 : -3008)); return; }
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0].address, addresses[0].family);
    });
  });
}

/**
 * A query to the process's resolver. A and AAAA records are read; a name it does not hold is ENOTFOUND, a held name
 * with no record of the type ENODATA, as a server answers NOERROR with an empty answer. The data of the other record
 * types is not read: a held name answers ENODATA for them.
 */
function query(resolver: ResolverDoor, hostname: string, rrtype: string, given: ResolveCallback): void {
  validateQueryName(hostname);
  const syscall = `query${rrtype.charAt(0)}${rrtype.slice(1).toLowerCase()}`;
  const type = RECORD_TYPES[rrtype]!;
  const callback = inCallersContext(given);
  const sockets = callingSockets();
  const config = resolver();
  // A name c-ares will not encode is its ARES_EBADNAME, Node's EBADNAME: nothing is sent (ADR-0009 §3).
  const labels = nameLabels(asciiName(hostname), 255);
  if (!labels) { answerLater(() => callback(queryFailed(hostname, syscall, 'EBADNAME'))); return; }
  answerLater(() => ask(sockets, config, labels, type)
    .then((outcome) => {
      if ('failed' in outcome) callback(queryFailed(hostname, syscall, outcome.failed));
      else if (outcome.rcode === 3) callback(notFound(hostname, syscall));
      else if (outcome.addresses.length === 0) callback(notFound(hostname, syscall, 'ENODATA'));
      else callback(null, [...outcome.addresses]);
    }));
}

/**
 * A record type as Node's resolver admits it (`callback_resolver.js` 85-105, `promises.js` 353-371): a string, by Node's
 * own `validateString`, that is one of `RECORD_TYPES`' own keys, else Node's own `ERR_INVALID_ARG_VALUE`.
 */
function checkedRrtype(rrtype: unknown): string {
  nodeValidators().validateString(rrtype, 'rrtype');
  if (!Object.hasOwn(RECORD_TYPES, rrtype as string)) {
    const { codes } = libRequire('internal/errors') as { codes: { ERR_INVALID_ARG_VALUE: new (name: string, value: unknown) => Error } };
    throw new codes.ERR_INVALID_ARG_VALUE('rrtype', rrtype);
  }
  return rrtype as string;
}

/** The resolve family over one resolver. */
function resolveFunctions(resolver: ResolverDoor) {
  function resolve(hostname: string, callback: ResolveCallback): void;
  function resolve(hostname: string, rrtype: string, callback: ResolveCallback): void;
  function resolve(hostname: string, rrtypeOrCallback: string | ResolveCallback, callback?: ResolveCallback): void {
    if (typeof rrtypeOrCallback === 'function') query(resolver, hostname, 'A', rrtypeOrCallback);
    else query(resolver, hostname, checkedRrtype(rrtypeOrCallback), callback as ResolveCallback);
  }
  const resolve4 = (hostname: string, callback: ResolveCallback): void => { query(resolver, hostname, 'A', callback); };
  const resolve6 = (hostname: string, callback: ResolveCallback): void => { query(resolver, hostname, 'AAAA', callback); };
  return { resolve, resolve4, resolve6 };
}

/**
 * Reverse lookups read no PTR record: an address is never named, and never localhost.
 */
export function reverse(
  ip: string,
  callback: (err: Error | null, hostnames?: string[]) => void
): void {
  answerLater(() => {
    callback(notFound(ip, 'getHostByAddr'));
  });
}

/** The process's resolvers: those `setServers` gave it, else its `/etc/resolv.conf`'s, else none it can read. */
function serversDoor(readEtc?: (path: '/etc/hosts' | '/etc/resolv.conf') => string): { get(): string[]; set(servers: string[]): void; config(): ResolverConfig } {
  let given: string[] | undefined;
  const file = (): ResolverConfig => {
    try { return resolverConfig(readEtc ? readEtc('/etc/resolv.conf') : undefined); } catch { return resolverConfig(undefined); }
  };
  return {
    get: () => given ? [...given] : file().servers,
    set: (servers) => {
      if (!Array.isArray(servers)) throw Object.assign(new TypeError('The "servers" argument must be an instance of Array.'), { code: 'ERR_INVALID_ARG_TYPE' });
      given = servers.map(server => String(server));
    },
    config: () => {
      const read = file();
      return given ? { ...read, servers: [...given] } : read;
    },
  };
}
const engineServers = serversDoor();
const engineResolver: ResolverDoor = () => engineServers.config();
const engineResolve = resolveFunctions(engineResolver);
export const resolve = engineResolve.resolve;
export const resolve4 = engineResolve.resolve4;
export const resolve6 = engineResolve.resolve6;
export function setServers(servers: string[]): void { engineServers.set(servers); }
export function getServers(): string[] { return engineServers.get(); }

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

/** The promise forms over one lookup and one resolve family. */
function promisesOver(doLookup: typeof lookup, resolvers: ReturnType<typeof resolveFunctions>, servers: { get(): string[]; set(servers: string[]): void }) {
  const promises = {
    lookup: (hostname: string, options?: number | LookupOptions) => {
      // Node's checks first (internal/dns/promises.js 197-239): the name, then the family.
      if (hostname) validateHostname(hostname);
      const { requested: family } = lookupOptions(options, 'promise');
      return new Promise((resolve, reject) => {
        // Node's own answers (internal/dns/promises.js 138-150): an empty name is null, a literal is itself.
        const all = typeof options === 'object' && options?.all === true;
        if (!hostname) { resolve(all ? [] : { address: null, family: family === 6 ? 6 : 4 }); return; }
        const literal = nodeIsIP(hostname);
        if (literal) { const result = { address: hostname, family: literal }; resolve(all ? [result] : result); return; }
        if (all) {
          doLookup(hostname, options, ((err: Error | null, addresses?: Array<{ address: string; family: number }>) => {
            if (err) reject(err);
            else resolve(addresses || []);
          }) as LookupAllCallback);
          return;
        }
        doLookup(hostname, options ?? {}, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address, family });
        });
      });
    },
    resolve: (hostname: string, rrtype = 'A') => {
      // Node's checks first (internal/dns/promises.js 341-346): the record type, then the name.
      checkedRrtype(rrtype);
      validateQueryName(hostname);
      return new Promise<string[]>((promiseResolve, promiseReject) => {
        resolvers.resolve(hostname, rrtype, (err, addresses) => {
          if (err) promiseReject(err);
          else promiseResolve(addresses || []);
        });
      });
    },
    resolve4: (hostname: string) => promises.resolve(hostname),
    resolve6: (hostname: string) => {
      validateQueryName(hostname);
      return new Promise<string[]>((resolve, reject) => {
        resolvers.resolve6(hostname, (err, addresses) => { if (err) reject(err); else resolve(addresses || []); });
      });
    },
    reverse: (ip: string) => new Promise<string[]>((resolve, reject) => {
      reverse(ip, (err, hostnames) => { if (err) reject(err); else resolve(hostnames || []); });
    }),
    setServers: (list: string[]) => servers.set(list),
    getServers: () => servers.get(),
  };
  return promises;
}

// Promises API
export const promises = promisesOver(lookup, engineResolve, engineServers);

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

/** One process's `dns`: its hosts file and its resolv.conf. */
export function createDnsModule(readEtc?: (path: '/etc/hosts' | '/etc/resolv.conf') => string) {
  const readHosts = readEtc ? () => readEtc('/etc/hosts') : undefined;
  const servers = serversDoor(readEtc);
  const resolver: ResolverDoor = () => servers.config();
  const processLookup = ((hostname: string, optionsOrCallback: number | LookupOptions | LookupCallback, callback?: LookupCallback | LookupAllCallback) => {
    lookupWithHosts(readHosts, resolver, hostname, optionsOrCallback, callback);
  }) as typeof lookup;
  const resolvers = resolveFunctions(resolver);
  const promiseModule = { ...promisesOver(processLookup, resolvers, servers), ...dnsCodes };
  return { ...dnsModule, ...dnsCodes, ...resolvers, getServers: servers.get, setServers: servers.set, lookup: processLookup, promises: promiseModule };
}

export default dnsModule;
