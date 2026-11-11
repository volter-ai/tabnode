import type { ProcessCredentials } from '../process-credentials';
import { callingSockets, interfaceAddresses, type TreeSockets } from '../host-sockets';
import { system } from '../system';
/**
 * Node's `os`, its facts the system's (ADR-0017): `uname(2)` for the type, release, version and machine; `/proc` and
 * `sysinfo(2)` for the CPUs, memory, load and uptime, read as libuv reads them on Linux (uv_cpu_info: /proc/stat and
 * /proc/cpuinfo; uv_get_total_memory and uv_get_free_memory: /proc/meminfo's MemTotal and MemAvailable; uv_loadavg:
 * sysinfo; uv_uptime: /proc/uptime; uv_available_parallelism: sched_getaffinity). Where no kernel answers, the realm's
 * system gives its fixed figures (system.ts `realmSystem`).
 */

export function hostname(): string {
  return system().uname().nodename;
}

export function platform(): string {
  return 'linux';
}

export function arch(): string {
  return 'x64';
}

export function type(): string {
  return system().uname().sysname;
}

export function release(): string {
  return system().uname().release;
}

export function version(): string {
  return system().uname().version;
}

export function machine(): string {
  return system().uname().machine;
}

export function tmpdir(): string {
  return '/tmp';
}

export function homedir(): string {
  return '/home/user';
}

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

/** USER_HZ, the unit /proc/stat counts in; libuv multiplies by the clock tick's milliseconds (10). */
const TICK_MS = 10;

export function cpus(): Array<{ model: string; speed: number; times: CpuTimes }> {
  const stat = system().file('/proc/stat');
  if (stat === undefined) {
    const count = system().affinity();
    return Array.from({ length: count }, () => ({ model: 'Virtual CPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
  }
  const info = system().file('/proc/cpuinfo') ?? '';
  const models = [...info.matchAll(/^model name\s*:\s*(.*)$/gmu)].map((match) => match[1]!);
  const speeds = [...info.matchAll(/^cpu MHz\s*:\s*([0-9.]+)$/gmu)].map((match) => Math.floor(Number(match[1])));
  const list: Array<{ model: string; speed: number; times: CpuTimes }> = [];
  for (const line of stat.split('\n')) {
    const match = /^cpu(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+(\d+)/u.exec(line);
    if (!match) continue;
    const at = Number(match[1]);
    const [user, nice, sys, idle, irq] = match.slice(2, 7).map((value) => Number(value) * TICK_MS) as [number, number, number, number, number];
    // libuv's model is "unknown" and its speed 0 where /proc/cpuinfo names none.
    list.push({ model: models[at] ?? models[0] ?? 'unknown', speed: speeds[at] ?? speeds[0] ?? 0, times: { user, nice, sys, idle, irq } });
  }
  return list;
}

/** A /proc/meminfo field, in bytes; undefined where it is not there. */
function meminfo(field: string): number | undefined {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'mu').exec(system().file('/proc/meminfo') ?? '');
  return match ? Number(match[1]) * 1024 : undefined;
}

export function totalmem(): number {
  return meminfo('MemTotal') ?? system().sysinfo().totalram;
}

export function freemem(): number {
  return meminfo('MemAvailable') ?? system().sysinfo().freeram;
}

export function uptime(): number {
  const proc = /^([0-9.]+)/u.exec(system().file('/proc/uptime') ?? '');
  return proc ? Number(proc[1]) : system().sysinfo().uptime;
}

export function loadavg(): [number, number, number] {
  return system().sysinfo().loads;
}

/** uv_available_parallelism: the CPUs the process may run on. */
export function availableParallelism(): number {
  return Math.max(1, system().affinity());
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
  availableParallelism,
  networkInterfaces,
  userInfo,
  endianness,
  getPriority,
  setPriority,
  EOL,
  constants,
  devNull,
};
