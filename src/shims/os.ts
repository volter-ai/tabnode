import type { ProcessCredentials } from '../process-credentials';
import { currentNetworkNamespace } from '../network-namespace';
/**
 * Node.js os module shim
 * Provides operating system utilities
 */

export function hostname(): string {
  return 'localhost';
}

export function platform(): string {
  return 'linux';
}

export function arch(): string {
  return 'x64';
}

export function type(): string {
  return 'Linux';
}

export function release(): string {
  return '5.10.0';
}

export function version(): string {
  return '#1 SMP';
}

export function machine(): string {
  return 'x86_64';
}

export function tmpdir(): string {
  return '/tmp';
}

export function homedir(): string {
  return '/home/user';
}

export function cpus(): Array<{
  model: string;
  speed: number;
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}> {
  const cpu = {
    model: 'Virtual CPU',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return [cpu, cpu]; // Simulate 2 CPUs
}

export function totalmem(): number {
  return 4 * 1024 * 1024 * 1024; // 4GB
}

export function freemem(): number {
  return 2 * 1024 * 1024 * 1024; // 2GB
}

export function uptime(): number {
  return Math.floor(performance.now() / 1000);
}

export function loadavg(): [number, number, number] {
  return [0.5, 0.5, 0.5];
}

/** A netmask for a prefix length, as Node prints one: dotted for IPv4, compressed hex groups for IPv6. */
function netmaskOf(prefixLength: number, v6: boolean): string {
  if (!v6) {
    const bits = prefixLength <= 0 ? 0 : (0xffffffff << (32 - Math.min(prefixLength, 32))) >>> 0;
    return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
  }
  const groups = Array.from({ length: 8 }, (_, index) => {
    const bits = Math.max(0, Math.min(16, prefixLength - index * 16));
    return ((0xffff << (16 - bits)) & 0xffff).toString(16);
  });
  const zeros = groups.indexOf('0');
  return zeros < 0 ? groups.join(':') : `${groups.slice(0, zeros).join(':')}::`;
}

/** One address as `os.networkInterfaces()` lists it; an IPv6 address carries its scope (its interface's index for a link-local one). */
type InterfaceAddress = { address: string; netmask: string; family: string; mac: string; internal: boolean; cidr: string; scopeid?: number };

/**
 * The interfaces of the calling process's network namespace, as Linux lists them inside it: `lo` (127.0.0.1 and ::1),
 * then one `eth<n>` per interface its host gave it (a network's IPv4 and IPv6 addresses are one interface's), in the
 * order they were made. An IPv6 address carries `scopeid`: its interface's index (lo 1, eth0 2, …) when link-local,
 * else 0.
 */
export function networkInterfaces(): Record<string, InterfaceAddress[]> {
  const interfaces: Record<string, InterfaceAddress[]> = {
    lo: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
      { address: '::1', netmask: netmaskOf(128, true), family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 },
    ],
  };
  const names = new Map<string, string>();
  let next = 0;
  for (const held of currentNetworkNamespace('os.networkInterfaces()').addresses()) {
    let name = held.interface !== undefined ? names.get(held.interface) : undefined;
    if (name === undefined) {
      name = held.interface !== undefined && /^eth\d+$/u.test(held.interface) && !interfaces[held.interface] ? held.interface : `eth${next}`;
      next = Math.max(next, Number(name.slice(3)) + 1);
      if (held.interface !== undefined) names.set(held.interface, name);
      interfaces[name] = [];
    }
    const v6 = held.address.includes(':');
    const index = Object.keys(interfaces).indexOf(name) + 1;
    interfaces[name]!.push({
      address: held.address,
      netmask: netmaskOf(held.prefixLength, v6),
      family: v6 ? 'IPv6' : 'IPv4',
      mac: held.mac ?? interfaces[name]![0]?.mac ?? '00:00:00:00:00:00',
      internal: false,
      cidr: `${held.address}/${held.prefixLength}`,
      ...(v6 ? { scopeid: /^fe[89ab]/iu.test(held.address) ? index : 0 } : {}),
    });
  }
  return interfaces;
}

export function userInfo(credentials?: Pick<ProcessCredentials, 'uid' | 'gid'>): {
  username: string;
  uid: number;
  gid: number;
  shell: string;
  homedir: string;
} {
  return {
    username: 'user',
    uid: credentials?.uid ?? 1000,
    gid: credentials?.gid ?? 1000,
    shell: '/bin/bash',
    homedir: '/home/user',
  };
}

export function endianness(): 'BE' | 'LE' {
  return 'LE';
}

export function getPriority(pid?: number): number {
  return 0;
}

export function setPriority(pid: number | number, priority?: number): void {
  // No-op
}

export const EOL = '\n';

export const constants = {
  signals: {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGURG: 23,
    SIGXCPU: 24,
    SIGXFSZ: 25,
    SIGVTALRM: 26,
    SIGPROF: 27,
    SIGWINCH: 28,
    SIGIO: 29,
    SIGPWR: 30,
    SIGSYS: 31,
  },
  errno: {},
  priority: {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  },
};

export const devNull = '/dev/null';

export default {
  hostname,
  platform,
  arch,
  type,
  release,
  version,
  machine,
  tmpdir,
  homedir,
  cpus,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
  userInfo,
  endianness,
  getPriority,
  setPriority,
  EOL,
  constants,
  devNull,
};
