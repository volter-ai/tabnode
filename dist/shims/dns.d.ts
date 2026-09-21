/**
 * dns shim - DNS operations are not available in browser
 * Provides stubs that work for basic use cases
 */
type LookupCallback = (err: Error | null, address?: string, family?: number) => void;
type LookupAllCallback = (err: Error | null, addresses?: Array<{
    address: string;
    family: number;
}>) => void;
/**
 * Lookup a hostname - returns localhost in browser
 */
export declare function lookup(hostname: string, callback: LookupCallback): void;
export declare function lookup(hostname: string, options: {
    family?: number;
    all?: true;
}, callback: LookupAllCallback): void;
export declare function lookup(hostname: string, options: {
    family?: number;
    all?: boolean;
}, callback: LookupCallback | LookupAllCallback): void;
/**
 * Resolve hostname - stub
 */
export declare function resolve(hostname: string, callback: (err: Error | null, addresses?: string[]) => void): void;
export declare function resolve4(hostname: string, callback: (err: Error | null, addresses?: string[]) => void): void;
export declare function resolve6(hostname: string, callback: (err: Error | null, addresses?: string[]) => void): void;
/**
 * Reverse lookup - stub
 */
export declare function reverse(ip: string, callback: (err: Error | null, hostnames?: string[]) => void): void;
/**
 * Set servers - no-op in browser
 */
export declare function setServers(_servers: string[]): void;
/**
 * Get servers - return empty in browser
 */
export declare function getServers(): string[];
/**
 * Set default result order - no-op in browser
 * Order can be 'ipv4first', 'ipv6first', or 'verbatim'
 */
export declare function setDefaultResultOrder(_order: string): void;
/**
 * Get default result order
 */
export declare function getDefaultResultOrder(): string;
export declare const promises: {
    lookup: (hostname: string, options?: {
        family?: number;
        all?: boolean;
    }) => Promise<unknown>;
    resolve: (hostname: string) => Promise<string[]>;
    resolve4: (hostname: string) => Promise<string[]>;
    resolve6: (hostname: string) => Promise<string[]>;
    reverse: (ip: string) => Promise<string[]>;
    setServers: (_servers: string[]) => void;
    getServers: () => string[];
};
export declare const ADDRCONFIG = 0;
export declare const V4MAPPED = 0;
export declare const ALL = 0;
declare const _default: {
    lookup: typeof lookup;
    resolve: typeof resolve;
    resolve4: typeof resolve4;
    resolve6: typeof resolve6;
    reverse: typeof reverse;
    setServers: typeof setServers;
    getServers: typeof getServers;
    setDefaultResultOrder: typeof setDefaultResultOrder;
    getDefaultResultOrder: typeof getDefaultResultOrder;
    promises: {
        lookup: (hostname: string, options?: {
            family?: number;
            all?: boolean;
        }) => Promise<unknown>;
        resolve: (hostname: string) => Promise<string[]>;
        resolve4: (hostname: string) => Promise<string[]>;
        resolve6: (hostname: string) => Promise<string[]>;
        reverse: (ip: string) => Promise<string[]>;
        setServers: (_servers: string[]) => void;
        getServers: () => string[];
    };
    ADDRCONFIG: number;
    V4MAPPED: number;
    ALL: number;
};
export default _default;
//# sourceMappingURL=dns.d.ts.map