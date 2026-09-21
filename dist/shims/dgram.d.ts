/**
 * dgram shim - UDP sockets are not available in browser
 */
import { EventEmitter } from '../node-lib/events-module';
export declare class Socket extends EventEmitter {
    bind(_port?: number, _address?: string, _callback?: () => void): this;
    close(_callback?: () => void): void;
    send(_msg: Buffer | string, _offset?: number, _length?: number, _port?: number, _address?: string, _callback?: (error: Error | null, bytes: number) => void): void;
    address(): {
        address: string;
        family: string;
        port: number;
    };
    setBroadcast(_flag: boolean): void;
    setTTL(_ttl: number): number;
    setMulticastTTL(_ttl: number): number;
    setMulticastLoopback(_flag: boolean): boolean;
    setMulticastInterface(_multicastInterface: string): void;
    addMembership(_multicastAddress: string, _multicastInterface?: string): void;
    dropMembership(_multicastAddress: string, _multicastInterface?: string): void;
    ref(): this;
    unref(): this;
    setRecvBufferSize(_size: number): void;
    setSendBufferSize(_size: number): void;
    getRecvBufferSize(): number;
    getSendBufferSize(): number;
}
export declare function createSocket(_type: string | object, _callback?: (msg: Buffer, rinfo: object) => void): Socket;
declare const _default: {
    Socket: typeof Socket;
    createSocket: typeof createSocket;
};
export default _default;
//# sourceMappingURL=dgram.d.ts.map