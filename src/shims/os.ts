import type { ProcessCredentials } from '../process-credentials';
import { callingSockets, interfaceAddresses, type TreeSockets } from '../host-sockets';
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

/** A netmask's prefix length: its leading one bits, as `os.js` counts them for `cidr`. */
function prefixOf(netmask: string, v6: boolean): number {
  if (!v6) return netmask.split('.').reduce((bits, part) => bits + (Number(part) >>> 0).toString(2).replace(/0/gu, '').length, 0);
  let bits = 0;
  for (const group of netmask.split(':')) bits += group === '' ? 0 : parseInt(group, 16).toString(2).replace(/0/gu, '').length;
  return bits;
}

/** One address as `os.networkInterfaces()` lists it; an IPv6 address carries its scope. */
type InterfaceAddress = { address: string; netmask: string; family: string; mac: string; internal: boolean; cidr: string; scopeid?: number };

/**
 * The calling process's interface addresses, as its kernel lists them (getifaddrs, by libuv's rule: interfaces up
 * and running), grouped by interface in the order listed. A process with no socket calls has none.
 */
export function networkInterfaces(sockets: TreeSockets | undefined = callingSockets()): Record<string, InterfaceAddress[]> {
  const interfaces: Record<string, InterfaceAddress[]> = {};
  for (const entry of interfaceAddresses(sockets)) {
    const v6 = entry.family === 'IPv6';
    (interfaces[entry.name] ??= []).push({
      address: entry.address, netmask: entry.netmask, family: entry.family, mac: entry.mac, internal: entry.internal,
      cidr: `${entry.address}/${prefixOf(entry.netmask, v6)}`, ...(v6 ? { scopeid: entry.scopeid } : {}),
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
