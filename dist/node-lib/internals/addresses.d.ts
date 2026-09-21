export declare class SocketAddress {
    constructor(options?: {
        address?: string;
        port?: number;
        family?: string;
        flowlabel?: number;
    });
    get address(): string;
    get port(): number;
    get family(): string;
    get flowlabel(): number;
    toJSON(): {
        address: string;
        port: number;
        family: string;
        flowlabel: number;
    };
    static isSocketAddress(value: unknown): value is SocketAddress;
    /** Node's `SocketAddress.parse('host:port')`; null for anything it cannot read. */
    static parse(input: string): SocketAddress | undefined;
}
export declare class BlockList {
    private entries;
    private static familyOf;
    private static addressOf;
    addAddress(address: string | SocketAddress, family?: string): void;
    addRange(start: string | SocketAddress, end: string | SocketAddress, family?: string): void;
    addSubnet(network: string | SocketAddress, prefix: number, family?: string): void;
    check(address: string | SocketAddress, family?: string): boolean;
    get rules(): string[];
    static isBlockList(value: unknown): value is BlockList;
}
export declare const internalSocketAddress: {
    SocketAddress: typeof SocketAddress;
    kSocketAddressHandle: symbol;
};
export declare const internalBlockList: {
    BlockList: typeof BlockList;
};
//# sourceMappingURL=addresses.d.ts.map