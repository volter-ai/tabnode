/**
 * `internalBinding('cares_wrap')`: the address arithmetic Node's `net` needs.
 *
 * Node's own `internal/net.js` recognises an IP with its own regular
 * expressions and does not ask this binding; `net.js` asks it for one thing
 * only, `convertIpv6StringToBuffer`, which it reads the first two bytes of to
 * tell a link-local address from a routable one. Lookups are the engine's
 * `dns`, a DNS exchange over the process's own UDP with its resolver.
 */
import { libRequire } from '../require-hook';

/** Node's own `isIP` family, from the vendored `internal/net.js`. */
function internalNet(): { isIP(s: string): number; isIPv4(s: string): boolean; isIPv6(s: string): boolean } {
  return libRequire('internal/net') as { isIP(s: string): number; isIPv4(s: string): boolean; isIPv6(s: string): boolean };
}

/**
 * An IPv6 address as its sixteen bytes. `::` fills the gap, and a trailing
 * IPv4 form (`::ffff:127.0.0.1`) is its four bytes at the end, as inet_pton
 * reads one.
 */
export function convertIpv6StringToBuffer(address: string): Uint8Array {
  const bytes = new Uint8Array(16);
  let text = address.split('%')[0];
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const tail: number[] = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    for (const part of dotted[1].split('.')) tail.push(Number(part) & 255);
    text = text.slice(0, dotted.index);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head, rest] = text.split('::');
  const readGroups = (piece: string): number[] => {
    const out: number[] = [];
    for (const group of piece.split(':')) {
      if (group === '') continue;
      const value = Number.parseInt(group, 16);
      out.push((value >> 8) & 255, value & 255);
    }
    return out;
  };
  const left = readGroups(head ?? '');
  const right = rest === undefined ? [] : readGroups(rest);
  const all = rest === undefined
    ? [...left, ...tail]
    : [...left, ...new Array(16 - left.length - right.length - tail.length).fill(0), ...right, ...tail];
  bytes.set(all.slice(0, 16));
  return bytes;
}

/**
 * Node's `CanonicalizeIP` (cares_wrap.cc:1933-1946): `uv_inet_pton` of the string as IPv4, else IPv6 (Node's own
 * `isIPv4`/`isIPv6` accept what it accepts), and `uv_inet_ntop` of the bytes, so the IPv6 form is libuv's
 * `inet_ntop6` (libuv src/inet.c): the longest run of two or more zero words is `::`, the first such where runs tie,
 * hex in lower case, and an IPv4-compatible or IPv4-mapped tail written dotted. Undefined where neither parses.
 */
function canonicalizeIP(input: unknown): string | undefined {
  const ip = `${input}`;
  const net = internalNet();
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return undefined;
  const src = convertIpv6StringToBuffer(ip);
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((src[i]! << 8) | src[i + 1]!);
  let best = { base: -1, len: 0 };
  let cur = { base: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (cur.base === -1) cur = { base: i, len: 1 }; else cur.len++;
    } else if (cur.base !== -1) {
      if (best.base === -1 || cur.len > best.len) best = cur;
      cur = { base: -1, len: 0 };
    }
  }
  if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ':';
      continue;
    }
    if (i !== 0) out += ':';
    if (i === 6 && best.base === 0 &&
        (best.len === 6 || (best.len === 7 && words[7] !== 0x0001) || (best.len === 5 && words[5] === 0xffff))) {
      out += `${src[12]}.${src[13]}.${src[14]}.${src[15]}`;
      return out;
    }
    out += words[i]!.toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}

export default {
  canonicalizeIP,
  get isIP() { return internalNet().isIP; },
  get isIPv4() { return internalNet().isIPv4; },
  get isIPv6() { return internalNet().isIPv6; },
  convertIpv6StringToBuffer,
};
