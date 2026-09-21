/**
 * `internalBinding('cares_wrap')`: the address arithmetic Node's `net` needs.
 *
 * Node's own `internal/net.js` recognises an IP with its own regular
 * expressions and does not ask this binding; `net.js` asks it for one thing
 * only, `convertIpv6StringToBuffer`, which it reads the first two bytes of to
 * tell a link-local address from a routable one. Lookups stay the engine's
 * `dns`, which answers for this host and nothing else.
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

export default {
  get isIP() { return internalNet().isIP; },
  get isIPv4() { return internalNet().isIPv4; },
  get isIPv6() { return internalNet().isIPv6; },
  convertIpv6StringToBuffer,
};
