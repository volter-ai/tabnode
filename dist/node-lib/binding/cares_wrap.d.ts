/**
 * An IPv6 address as its sixteen bytes. `::` fills the gap, and a trailing
 * IPv4 form (`::ffff:127.0.0.1`) is its four bytes at the end, as inet_pton
 * reads one.
 */
export declare function convertIpv6StringToBuffer(address: string): Uint8Array;
declare const _default: {
    readonly isIP: (s: string) => number;
    readonly isIPv4: (s: string) => boolean;
    readonly isIPv6: (s: string) => boolean;
    convertIpv6StringToBuffer: typeof convertIpv6StringToBuffer;
};
export default _default;
//# sourceMappingURL=cares_wrap.d.ts.map