/**
 * `dns`, as a Linux process resolves (ADR-0009 §3). Resolution is not a system call: `dns.lookup` is getaddrinfo,
 * libc code that reads the process's own `/etc/hosts` and then exchanges DNS messages over UDP with the nameservers
 * its `/etc/resolv.conf` names; `dns.resolve*` is c-ares, the same exchange. Both are made here, over the calling
 * process's own UDP sockets (`host-sockets.ts`): the namespace's resolver is a server in the namespace (Docker's
 * 127.0.0.11), answered by its kernel for every program, and this engine keeps no table, cache or answer of its own.
 *
 * A name the resolver does not hold (NXDOMAIN) is `ENOTFOUND`; it never becomes this host or a wildcard. A lookup
 * whose servers give no NOERROR or NXDOMAIN within resolv.conf's `timeout`, as musl's `res_msend` waits for one
 * (`msend`), is `EAI_AGAIN`; to a query a server's failure is c-ares's error for it (`ESERVFAIL`, `EREFUSED`,
 * `ENOTIMP`, `EFORMERR`, `ETIMEOUT`, `ECONNREFUSED`). `getServers()` is the process's `/etc/resolv.conf`'s
 * nameservers. A process with no socket calls can ask no server: a name not in its hosts file is `EAI_AGAIN`.
 *
 * A name is the one Node hands its libraries (`to_ascii`), checked as they check it before anything is sent: one
 * musl's getaddrinfo refuses (empty, 255 bytes or more, an empty label, a label over 63 bytes) is `ENOTFOUND` to a
 * lookup, and one c-ares refuses is `EBADNAME` to a query (ADR-0009 §3).
 */
import { heldWork } from '../host-globals';
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

/**
 * musl's `inet_aton` (`inet_aton.c`): one to four parts, each decimal, `0` octal or `0x` hex, the last filling the bytes
 * left; the dotted address, or undefined for text that is not one.
 */
function inetAton(text: string): string | undefined {
  const parts = text.split('.');
  if (parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const match = /^(?:0[xX]([0-9a-fA-F]+)|(0[0-7]*)|([1-9][0-9]*))$/u.exec(part);
    if (!match) return undefined;
    values.push(match[1] !== undefined ? parseInt(match[1], 16) : match[2] !== undefined ? parseInt(match[2], 8) : Number(match[3]));
  }
  const last = values.pop()!;
  if (values.some(value => value > 255) || last >= 2 ** (8 * (4 - values.length))) return undefined;
  const bytes = [...values];
  for (let shift = 8 * (3 - values.length); shift >= 0; shift -= 8) bytes.push(Math.floor(last / 2 ** shift) % 256);
  return bytes.join('.');
}

/** musl's `__lookup_ipliteral` for an address: `inet_aton`'s forms as IPv4, else an IPv6 literal. */
function numericAddress(text: string): { address: string; family: 4 | 6 } | undefined {
  const v4 = inetAton(text);
  if (v4 !== undefined) return { address: v4, family: 4 };
  return literalFamily(text) === 6 && !text.startsWith('[') ? { address: text, family: 6 } : undefined;
}

const isSpace = (character: string | undefined): boolean => character !== undefined && ' \t\n\v\f\r'.includes(character);

/**
 * musl's `name_from_hosts` (`lookup_name.c` 49-97): each line's text before `#`; the name as given, matched exactly
 * where it stands between white space after the line's first character; the line's first field its address. The
 * addresses of `family` (0 for either) in file order, `'nodata'` where a line named it only with another family's.
 */
function hostsAddresses(content: string, name: string, family: number): Array<{ address: string; family: number }> | 'nodata' | undefined {
  const addresses: Array<{ address: string; family: number }> = [];
  let otherFamily = false;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length && addresses.length < 48; index += 1) {
    const raw = lines[index]!;
    const ended = index < lines.length - 1;
    const hash = raw.indexOf('#');
    // fgets keeps the newline; musl puts one where `#` was.
    const line = hash >= 0 ? `${raw.slice(0, hash)}\n` : ended ? `${raw}\n` : raw;
    let at = line.indexOf(name, 1);
    while (at >= 0 && (!isSpace(line[at - 1]) || !isSpace(line[at + name.length]))) at = line.indexOf(name, at + 1);
    if (at < 0) continue;
    let end = 0;
    while (end < line.length && !isSpace(line[end])) end += 1;
    const numeric = numericAddress(line.slice(0, end));
    if (!numeric) continue;
    if (family && numeric.family !== family) { otherFamily = true; continue; }
    addresses.push(numeric);
  }
  return addresses.length ? addresses : otherFamily ? 'nodata' : undefined;
}

/**
 * What `/etc/resolv.conf` says: its nameservers in order, the `timeout` and `attempts` options (glibc's limits), and,
 * as musl's `__get_resolv_conf` reads them, its search list (the last `search` or `domain` line) and `ndots` (1 unless
 * an `options` line names it, at most 15).
 */
interface ResolverConfig {
  servers: string[]; timeoutMs: number; attempts: number; search: string[]; ndots: number;
  /** musl's `timeout` (seconds, at most 60) and `attempts` (at most 10), which its `res_msend` takes (`resolvconf.c`). */
  lookup: { timeoutMs: number; attempts: number };
}
function resolverConfig(content: string | undefined): ResolverConfig {
  const servers: string[] = [];
  let timeout = 5, attempts = 2, ndots = 1, lookupTimeout = 5, lookupAttempts = 2;
  let search: string[] = [];
  for (const line of (content ?? '').split('\n')) {
    if (/^(?:search|domain)\s/u.test(line)) search = line.slice(7).split(/\s+/u).filter(domain => domain.length > 0);
    if (!/^options\s/u.test(line)) continue;
    // musl reads each option where it first stands on an `options` line, its digits as strtoul reads them.
    const option = (name: string): number | undefined => {
      const at = line.indexOf(`${name}:`);
      return at >= 0 && /\d/u.test(line[at + name.length + 1] ?? '') ? parseInt(line.slice(at + name.length + 1), 10) : undefined;
    };
    ndots = Math.min(15, option('ndots') ?? ndots);
    lookupAttempts = Math.min(10, option('attempts') ?? lookupAttempts);
    lookupTimeout = Math.min(60, option('timeout') ?? lookupTimeout);
  }
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
  return { servers, timeoutMs: timeout * 1000, attempts, search, ndots, lookup: { timeoutMs: lookupTimeout * 1000, attempts: lookupAttempts } };
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

/** DNS's record types this resolver reads the data of; every other type a query asks for is answered by its rcode alone. */
const RECORD_TYPES: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, CAA: 257, TLSA: 52, ANY: 255,
};

/**
 * The name Node hands its resolver libraries: `ada::idna::to_ascii` of what it was given (`cares_wrap.cc`), the WHATWG
 * domain-to-ASCII a URL's host takes; a name that does not convert is the empty name, as `to_ascii` answers it.
 */
function asciiName(hostname: string): string {
  if (!/[^\x00-\x7f]/u.test(hostname)) return hostname;
  try { return new URL(`http://${hostname}/`).hostname; } catch { return ''; }
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

/**
 * musl's `res_msend` (`res_msend.c` 172-262), which a lookup's queries take: one UDP socket per family; every query not
 * yet answered is sent to each of the first three servers at the start of each of `attempts` equal slices of
 * `timeout`; a reply from a server it was sent to, matched to a query by its id, is taken when it is NOERROR or
 * NXDOMAIN, sent again at once to the server that answered SERVFAIL (up to twice the number of queries in each slice,
 * shared among them), and otherwise (FORMERR, NOTIMP, REFUSED) ignored. musl takes a truncated reply again over TCP;
 * this exchange does not. Each query's taken answer, or undefined for one with none when `timeout` has passed.
 */
async function msend(sockets: TreeSockets, config: ResolverConfig, queries: Array<{ message: Uint8Array; id: number; type: number }>): Promise<Array<{ rcode: number; addresses: string[] } | undefined>> {
  const servers = (config.servers.length ? config.servers : ['127.0.0.1']).slice(0, 3)
    .map(server => serverAddress(server, sockets)).filter((server): server is { family: number; address: Uint8Array } => server !== undefined);
  const answers: Array<{ rcode: number; addresses: string[] } | undefined> = queries.map(() => undefined);
  const fds = new Map<number, number>();
  for (const server of servers) {
    if (fds.has(server.family)) continue;
    const fd = sockets.socket(server.family, linux.SOCK_DGRAM | linux.SOCK_NONBLOCK | linux.SOCK_CLOEXEC, 0);
    if (fd >= 0) fds.set(server.family, fd);
  }
  const send = (query: number, server: { family: number; address: Uint8Array }): void => {
    const fd = fds.get(server.family);
    if (fd !== undefined) sockets.sendto(fd, queries[query]!.message, linux.MSG_DONTWAIT, server.address);
  };
  // A reply is taken only from an address it was sent to: the family, port and address of the sockaddr.
  const sameAddress = (from: Uint8Array, server: { family: number; address: Uint8Array }): boolean => {
    const length = server.family === linux.AF_INET ? 8 : 24;
    for (let index = 0; index < length; index += 1) if (from[index] !== server.address[index]) return false;
    return true;
  };
  try {
    if (fds.size === 0) return answers;
    const timeout = config.lookup.timeoutMs, interval = timeout / Math.max(1, config.lookup.attempts);
    const started = Date.now();
    let sliceStart = started - interval, servfailRetry = 0;
    const buffer = new Uint8Array(65536);
    for (let now = Date.now(); now - started < timeout; now = Date.now()) {
      if (answers.every(answer => answer !== undefined)) break;
      if (now - sliceStart >= interval) {
        answers.forEach((answer, query) => { if (!answer) for (const server of servers) send(query, server); });
        sliceStart = now;
        servfailRetry = 2 * queries.length;
      }
      for (const fd of fds.values()) {
        for (;;) {
          const from = socketAddressBuffer();
          const read = sockets.recvfrom(fd, buffer, linux.MSG_DONTWAIT, from);
          if (read < 0) break;
          const server = servers.find(candidate => sameAddress(from, candidate));
          if (!server || read < 4) continue;
          const query = queries.findIndex((candidate, index) => !answers[index]
            && buffer[0] === candidate.message[0] && buffer[1] === candidate.message[1]);
          if (query < 0) continue;
          const rcode = buffer[3]! & 15;
          if (rcode === 2 && servfailRetry > 0) { servfailRetry -= 1; send(query, server); }
          if (rcode !== 0 && rcode !== 3) continue;
          answers[query] = readResponse(buffer.subarray(0, read), queries[query]!.id, queries[query]!.type);
        }
      }
      if (answers.every(answer => answer !== undefined)) break;
      const left = Math.max(0, Math.min(sliceStart + interval, started + timeout) - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ...[...fds.values()].map(fd => sockets.wait(fd, linux.POLLIN)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, left); (timer as unknown as { unref?: () => void }).unref?.(); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return answers;
  } finally { for (const fd of fds.values()) sockets.close(fd); }
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
 * Node's `dns.lookup`: its own answers for an empty name and an IP literal, then musl's getaddrinfo (ADR-0009 §3):
 * `inet_aton`'s numeric forms, the process's hosts file, then its resolver with resolv.conf's search list.
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
  const options = typeof optionsOrCallback === 'number' ? { family: optionsOrCallback } : typeof optionsOrCallback === 'object' && optionsOrCallback ? optionsOrCallback : {};
  if (typeof given !== 'function') throw Object.assign(new TypeError('The callback argument must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  // Node's net.js makes a listener's handle in this callback (listen(port, host)): it runs in the caller's process.
  const cb = inCallersContext(given as LookupCallback) as LookupCallback | LookupAllCallback;
  const sockets = callingSockets();
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
    // The name getaddrinfo is given (Node's to_ascii); musl refuses an empty one, or one of 255 bytes or more, before
    // it reads any source, then takes its sources in order (ADR-0009 §3).
    const ascii = asciiName(hostname);
    if (ascii === '' || ascii.length >= 255) { cb(notFound(hostname)); return; }
    const answer = (addresses: Array<{ address: string; family: number }>): void => {
      if (options.order === 'ipv4first' || options.order === 'ipv6first') {
        const first = options.order === 'ipv6first' ? 6 : 4;
        addresses = [...addresses.filter(row => row.family === first), ...addresses.filter(row => row.family !== first)];
      }
      if (options.all) (cb as LookupAllCallback)(null, addresses);
      else (cb as LookupCallback)(null, addresses[0]!.address, addresses[0]!.family);
    };
    // Numeric: inet_aton's forms; one of the other family is EAI_NODATA.
    const numeric = numericAddress(ascii);
    if (numeric) {
      if (requested && numeric.family !== requested) cb(notFound(hostname, 'getaddrinfo', 'ENOTFOUND', -3007));
      else answer([numeric]);
      return;
    }
    // hosts(5) belongs to the requesting process, read as musl reads it.
    let fileAddresses: ReturnType<typeof hostsAddresses> = undefined;
    try { fileAddresses = readHosts ? hostsAddresses(readHosts(), ascii, requested) : undefined; }
    catch (cause) {
      // nss_files reports an unreadable hosts source as unavailable; lookup continues with
      // the next resolver source. Kernel-owner/protocol, EIO transport and programming failures still surface.
      const code = cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR", "ELOOP", "EMFILE", "ENFILE"].includes(code ?? '')) {
        cb(cause instanceof Error ? cause : new Error(String(cause))); return;
      }
    }
    if (fileAddresses === 'nodata') { cb(notFound(hostname, 'getaddrinfo', 'ENOTFOUND', -3007)); return; }
    if (fileAddresses !== undefined) { answer(fileAddresses); return; }
    // DNS with the search list (musl's name_from_dns_search): a name with fewer dots than ndots and no trailing dot is
    // asked with each search domain first; a name ending in two dots is EAI_NONAME.
    const config = resolver();
    const trailing = ascii.endsWith('.');
    const base = trailing ? ascii.slice(0, -1) : ascii;
    if (base === '' || base.endsWith('.')) { cb(notFound(hostname)); return; }
    const dots = ascii.split('.').length - 1;
    const names = [...(dots >= config.ndots || trailing ? [] : config.search
      .filter(domain => domain.length < 256 - base.length - 1).map(domain => `${base}.${domain}`)), ascii];
    // A, then AAAA (or as `order` puts them), as getaddrinfo asks for an unspecified family.
    const families: Array<4 | 6> = requested ? [requested as 4 | 6] : options.order === 'ipv6first' ? [6, 4] : [4, 6];
    // musl's name_from_dns: a name res_mkquery will not encode, or one the server does not hold, is no answer (0, and
    // nothing is sent for the first); a failed server ends the lookup EAI_AGAIN, a held name with no address EAI_NODATA.
    const fromDns = async (name: string): Promise<0 | 'again' | 'nodata' | Array<{ address: string; family: number }>> => {
      const labels = nameLabels(name, 253);
      if (!labels?.length) return 0;
      if (!sockets) return 'again';
      // A and AAAA together through res_msend, with distinct ids; read in order: none taken EAI_AGAIN, NXDOMAIN 0.
      const queries: Array<{ message: Uint8Array; id: number; type: number }> = [];
      for (const family of families) {
        let id = (Math.random() * 0x10000) & 0xffff;
        if (queries.some(query => query.id === id)) id = (id + 1) & 0xffff;
        const type = family === 6 ? 28 : 1;
        queries.push({ message: queryMessage(id, labels, type), id, type });
      }
      const replies = await msend(sockets, config, queries);
      const addresses: Array<{ address: string; family: number }> = [];
      for (const [index, reply] of replies.entries()) {
        if (!reply) return 'again';
        if (reply.rcode === 3) return 0;
        addresses.push(...reply.addresses.map(address => ({ address, family: families[index]! })));
      }
      return addresses.length ? addresses : 'nodata';
    };
    const asked = (async () => {
      for (const name of names) {
        const found = await fromDns(name);
        if (found !== 0) return found;
      }
      return 0 as const;
    })();
    // The callback runs outside the resolver's settlement, so what it throws is its own (answerLater). No answer is
    // EAI_NONAME, a held name with none of the family EAI_NODATA: Node reports both as ENOTFOUND, with their own errno.
    return asked.then((found) => {
      if (found === 'again') cb(tryAgain(hostname));
      else if (found === 0) cb(notFound(hostname));
      else if (found === 'nodata') cb(notFound(hostname, 'getaddrinfo', 'ENOTFOUND', -3007));
      else answer(found);
    });
  });
}

/**
 * A query to the process's resolver. A and AAAA records are read; a name it does not hold is ENOTFOUND, a held name
 * with no record of the type ENODATA, as a server answers NOERROR with an empty answer. The data of the other record
 * types is not read: a held name answers ENODATA for them.
 */
function query(resolver: ResolverDoor, hostname: string, rrtype: string, given: ResolveCallback): void {
  const syscall = `query${rrtype.charAt(0)}${rrtype.slice(1).toLowerCase()}`;
  const type = RECORD_TYPES[rrtype] ?? 1;
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

/** The record types Node's `dns.resolve` takes; any other is `ERR_INVALID_ARG_VALUE`, thrown as Node throws it. */
const RRTYPES = new Set(['A', 'AAAA', 'ANY', 'CAA', 'CNAME', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SRV', 'TLSA', 'TXT']);
function checkedRrtype(rrtype: unknown): string {
  if (typeof rrtype !== 'string') throw Object.assign(new TypeError(`The "rrtype" argument must be of type string. Received ${typeof rrtype}`), { code: 'ERR_INVALID_ARG_TYPE' });
  if (!RRTYPES.has(rrtype)) throw Object.assign(new TypeError(`The argument 'rrtype' is invalid. Received '${rrtype}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  return rrtype;
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
    lookup: (hostname: string, options?: number | LookupOptions) => new Promise((resolve, reject) => {
      if (typeof options === 'object' && options?.all) {
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
    }),
    resolve: (hostname: string, rrtype = 'A') => {
      checkedRrtype(rrtype);
      return new Promise<string[]>((promiseResolve, promiseReject) => {
        resolvers.resolve(hostname, rrtype, (err, addresses) => {
          if (err) promiseReject(err);
          else promiseResolve(addresses || []);
        });
      });
    },
    resolve4: (hostname: string) => promises.resolve(hostname),
    resolve6: (hostname: string) => new Promise<string[]>((resolve, reject) => {
      resolvers.resolve6(hostname, (err, addresses) => { if (err) reject(err); else resolve(addresses || []); });
    }),
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
