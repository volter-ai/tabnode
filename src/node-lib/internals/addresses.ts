/**
 * `internal/socketaddress` and `internal/blocklist`, bound by hand.
 *
 * `net.js` exposes both as `net.SocketAddress` and `net.BlockList` and asks
 * one thing of each: `BlockList.isBlockList(value)` when a program hands one
 * to `createServer` or `connect`, and `blockList.check(address, family)` for
 * every connection. They validate and hold, and the check is address
 * arithmetic; nothing here reaches the network, because there is none.
 */
import { libRequire } from '../require-hook';
import { convertIpv6StringToBuffer } from '../binding/cares_wrap';

function isIP(value: string): number {
  return (libRequire('internal/net') as { isIP(s: string): number }).isIP(value);
}

/** An address as a big integer, so a range and a subnet are comparisons. */
function toNumber(address: string, family: string): bigint {
  if (family === 'ipv4') {
    let value = 0n;
    for (const part of address.split('.')) value = (value << 8n) | BigInt(Number(part) & 255);
    return value;
  }
  let value = 0n;
  for (const byte of convertIpv6StringToBuffer(address)) value = (value << 8n) | BigInt(byte);
  return value;
}

const kAddress = Symbol('address');
const kPort = Symbol('port');
const kFamily = Symbol('family');
const kFlowLabel = Symbol('flowlabel');

export class SocketAddress {
  constructor(options: { address?: string; port?: number; family?: string; flowlabel?: number } = {}) {
    const family = (options.family ?? 'ipv4').toLowerCase();
    if (family !== 'ipv4' && family !== 'ipv6') {
      throw Object.assign(new TypeError(`The argument 'options.family' must be one of: 'ipv4', 'ipv6'. Received '${options.family}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    const address = options.address ?? (family === 'ipv4' ? '127.0.0.1' : '::');
    if (typeof address !== 'string' || isIP(address) === 0) {
      throw Object.assign(new TypeError(`The argument 'options.address' is invalid. Received '${address}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    const port = options.port ?? 0;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw Object.assign(new RangeError(`The value of "options.port" is out of range. It must be >= 0 && <= 65535. Received ${port}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    (this as Record<symbol, unknown>)[kAddress] = address;
    (this as Record<symbol, unknown>)[kPort] = port;
    (this as Record<symbol, unknown>)[kFamily] = family;
    (this as Record<symbol, unknown>)[kFlowLabel] = options.flowlabel ?? 0;
  }

  get address(): string { return (this as unknown as Record<symbol, string>)[kAddress]; }
  get port(): number { return (this as unknown as Record<symbol, number>)[kPort]; }
  get family(): string { return (this as unknown as Record<symbol, string>)[kFamily]; }
  get flowlabel(): number { return (this as unknown as Record<symbol, number>)[kFlowLabel]; }

  toJSON(): { address: string; port: number; family: string; flowlabel: number } {
    return { address: this.address, port: this.port, family: this.family, flowlabel: this.flowlabel };
  }

  static isSocketAddress(value: unknown): value is SocketAddress {
    return value instanceof SocketAddress;
  }

  /** Node's `SocketAddress.parse('host:port')`; null for anything it cannot read. */
  static parse(input: string): SocketAddress | undefined {
    try {
      const url = new URL(`http://${input}`);
      const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      const family = isIP(host) === 6 ? 'ipv6' : 'ipv4';
      return new SocketAddress({ address: host, port: Number(url.port || 0), family });
    } catch {
      return undefined;
    }
  }
}

type Rule =
  | { kind: 'address'; family: string; value: bigint; text: string }
  | { kind: 'range'; family: string; start: bigint; end: bigint; text: string }
  | { kind: 'subnet'; family: string; network: bigint; mask: bigint; text: string };

export class BlockList {
  private entries: Rule[] = [];

  private static familyOf(family?: string): string {
    const name = (family ?? 'ipv4').toLowerCase();
    if (name !== 'ipv4' && name !== 'ipv6') {
      throw Object.assign(new TypeError(`The argument 'family' must be one of: 'ipv4', 'ipv6'. Received '${family}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    return name;
  }

  private static addressOf(value: string | SocketAddress, family: string): string {
    if (value instanceof SocketAddress) return value.address;
    if (typeof value !== 'string' || isIP(value) === 0) {
      throw Object.assign(new TypeError(`The argument 'address' is invalid. Received '${String(value)}'`), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    void family;
    return value;
  }

  addAddress(address: string | SocketAddress, family?: string): void {
    const name = address instanceof SocketAddress ? address.family : BlockList.familyOf(family);
    const text = BlockList.addressOf(address, name);
    this.entries.push({ kind: 'address', family: name, value: toNumber(text, name), text: `Address: ${name.toUpperCase()} ${text}` });
  }

  addRange(start: string | SocketAddress, end: string | SocketAddress, family?: string): void {
    const name = start instanceof SocketAddress ? start.family : BlockList.familyOf(family);
    const from = BlockList.addressOf(start, name);
    const to = BlockList.addressOf(end, name);
    const low = toNumber(from, name);
    const high = toNumber(to, name);
    if (high < low) {
      throw Object.assign(new TypeError("The argument 'end' is invalid."), { code: 'ERR_INVALID_ARG_VALUE' });
    }
    this.entries.push({ kind: 'range', family: name, start: low, end: high, text: `Range: ${name.toUpperCase()} ${from}-${to}` });
  }

  addSubnet(network: string | SocketAddress, prefix: number, family?: string): void {
    const name = network instanceof SocketAddress ? network.family : BlockList.familyOf(family);
    const text = BlockList.addressOf(network, name);
    const bits = name === 'ipv4' ? 32 : 128;
    if (typeof prefix !== 'number' || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw Object.assign(new RangeError(`The value of "prefix" is out of range. It must be >= 0 && <= ${bits}. Received ${prefix}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
    this.entries.push({ kind: 'subnet', family: name, network: toNumber(text, name) & mask, mask, text: `Subnet: ${name.toUpperCase()} ${text}/${prefix}` });
  }

  check(address: string | SocketAddress, family?: string): boolean {
    const name = address instanceof SocketAddress ? address.family : (family ?? 'ipv4').toLowerCase();
    if (name !== 'ipv4' && name !== 'ipv6') return false;
    const text = address instanceof SocketAddress ? address.address : address;
    if (typeof text !== 'string' || isIP(text) === 0) return false;
    const value = toNumber(text, name);
    for (const rule of this.entries) {
      if (rule.family !== name) continue;
      if (rule.kind === 'address' && rule.value === value) return true;
      if (rule.kind === 'range' && value >= rule.start && value <= rule.end) return true;
      if (rule.kind === 'subnet' && (value & rule.mask) === rule.network) return true;
    }
    return false;
  }

  get rules(): string[] {
    return this.entries.map((rule) => rule.text);
  }

  static isBlockList(value: unknown): value is BlockList {
    return value instanceof BlockList;
  }
}

export const internalSocketAddress = { SocketAddress, kSocketAddressHandle: Symbol('kSocketAddressHandle') };
export const internalBlockList = { BlockList };
