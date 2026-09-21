/**
 * Node.js os module shim
 * Provides operating system utilities
 */
export declare function hostname(): string;
export declare function platform(): string;
export declare function arch(): string;
export declare function type(): string;
export declare function release(): string;
export declare function version(): string;
export declare function machine(): string;
export declare function tmpdir(): string;
export declare function homedir(): string;
export declare function cpus(): Array<{
    model: string;
    speed: number;
    times: {
        user: number;
        nice: number;
        sys: number;
        idle: number;
        irq: number;
    };
}>;
export declare function totalmem(): number;
export declare function freemem(): number;
export declare function uptime(): number;
export declare function loadavg(): [number, number, number];
export declare function networkInterfaces(): Record<string, Array<{
    address: string;
    netmask: string;
    family: string;
    mac: string;
    internal: boolean;
    cidr: string;
}>>;
export declare function userInfo(): {
    username: string;
    uid: number;
    gid: number;
    shell: string;
    homedir: string;
};
export declare function endianness(): 'BE' | 'LE';
export declare function getPriority(pid?: number): number;
export declare function setPriority(pid: number | number, priority?: number): void;
export declare const EOL = "\n";
export declare const constants: {
    signals: {
        SIGHUP: number;
        SIGINT: number;
        SIGQUIT: number;
        SIGILL: number;
        SIGTRAP: number;
        SIGABRT: number;
        SIGBUS: number;
        SIGFPE: number;
        SIGKILL: number;
        SIGUSR1: number;
        SIGSEGV: number;
        SIGUSR2: number;
        SIGPIPE: number;
        SIGALRM: number;
        SIGTERM: number;
        SIGCHLD: number;
        SIGCONT: number;
        SIGSTOP: number;
        SIGTSTP: number;
        SIGTTIN: number;
        SIGTTOU: number;
        SIGURG: number;
        SIGXCPU: number;
        SIGXFSZ: number;
        SIGVTALRM: number;
        SIGPROF: number;
        SIGWINCH: number;
        SIGIO: number;
        SIGPWR: number;
        SIGSYS: number;
    };
    errno: {};
    priority: {
        PRIORITY_LOW: number;
        PRIORITY_BELOW_NORMAL: number;
        PRIORITY_NORMAL: number;
        PRIORITY_ABOVE_NORMAL: number;
        PRIORITY_HIGH: number;
        PRIORITY_HIGHEST: number;
    };
};
export declare const devNull = "/dev/null";
declare const _default: {
    hostname: typeof hostname;
    platform: typeof platform;
    arch: typeof arch;
    type: typeof type;
    release: typeof release;
    version: typeof version;
    machine: typeof machine;
    tmpdir: typeof tmpdir;
    homedir: typeof homedir;
    cpus: typeof cpus;
    totalmem: typeof totalmem;
    freemem: typeof freemem;
    uptime: typeof uptime;
    loadavg: typeof loadavg;
    networkInterfaces: typeof networkInterfaces;
    userInfo: typeof userInfo;
    endianness: typeof endianness;
    getPriority: typeof getPriority;
    setPriority: typeof setPriority;
    EOL: string;
    constants: {
        signals: {
            SIGHUP: number;
            SIGINT: number;
            SIGQUIT: number;
            SIGILL: number;
            SIGTRAP: number;
            SIGABRT: number;
            SIGBUS: number;
            SIGFPE: number;
            SIGKILL: number;
            SIGUSR1: number;
            SIGSEGV: number;
            SIGUSR2: number;
            SIGPIPE: number;
            SIGALRM: number;
            SIGTERM: number;
            SIGCHLD: number;
            SIGCONT: number;
            SIGSTOP: number;
            SIGTSTP: number;
            SIGTTIN: number;
            SIGTTOU: number;
            SIGURG: number;
            SIGXCPU: number;
            SIGXFSZ: number;
            SIGVTALRM: number;
            SIGPROF: number;
            SIGWINCH: number;
            SIGIO: number;
            SIGPWR: number;
            SIGSYS: number;
        };
        errno: {};
        priority: {
            PRIORITY_LOW: number;
            PRIORITY_BELOW_NORMAL: number;
            PRIORITY_NORMAL: number;
            PRIORITY_ABOVE_NORMAL: number;
            PRIORITY_HIGH: number;
            PRIORITY_HIGHEST: number;
        };
    };
    devNull: string;
};
export default _default;
//# sourceMappingURL=os.d.ts.map