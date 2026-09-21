/**
 * Node.js crypto module shim
 *
 * Digests, HMAC and PBKDF2 are the real algorithms over pure-JS primitives,
 * because a guest calls them synchronously and WebCrypto is async-only.
 * Random values and asymmetric signing use WebCrypto, which does have them.
 */
import { Buffer as HostBuffer } from 'buffer/index.js';
import { EventEmitter } from '../node-lib/events-module';
import { cryptoConstants as constants } from './crypto-constants';
export { constants };
export declare function randomBytes(size: number): Buffer;
export declare function randomBytes(size: number, callback: (error: Error | null, buffer: Buffer) => void): void;
export declare function randomFillSync<T extends ArrayBufferView | ArrayBufferLike>(buffer: T, offset?: number, size?: number): T;
/**
 * Node's asynchronous fill. The overloads are Node's: `(buf, cb)`,
 * `(buf, offset, cb)`, `(buf, offset, size, cb)`, with the same argument
 * checks `randomFillSync` makes.
 */
export declare function randomFill<T extends ArrayBufferView | ArrayBufferLike>(buffer: T, callback: (error: Error | null, buffer: T) => void): void;
export declare function randomFill<T extends ArrayBufferView | ArrayBufferLike>(buffer: T, offset: number, callback: (error: Error | null, buffer: T) => void): void;
export declare function randomFill<T extends ArrayBufferView | ArrayBufferLike>(buffer: T, offset: number, size: number, callback: (error: Error | null, buffer: T) => void): void;
export declare function randomUUID(): string;
export declare function randomInt(max: number): number;
export declare function randomInt(min: number, max: number): number;
export declare function randomInt(max: number, callback: (error: undefined, value: number) => void): void;
export declare function randomInt(min: number, max: number, callback: (error: undefined, value: number) => void): void;
export declare function getRandomValues<T extends ArrayBufferView>(array: T): T;
/**
 * Node throws ERR_CRYPTO_UNSUPPORTED_OPERATION rather than returning
 * something that only looks like a result; so does this shim.
 */
export declare function unsupported(operation: string): never;
type HostBytes = InstanceType<typeof HostBuffer>;
declare class Hash {
    private state;
    private done;
    readonly algorithm: string;
    constructor(algorithm: string);
    update(data: unknown, inputEncoding?: string): this;
    digest(outputEncoding?: string): Buffer | string;
    digestAsync(outputEncoding?: string): Promise<Buffer | string>;
    copy(): Hash;
}
declare class Hmac {
    private inner;
    private outer;
    private done;
    constructor(algorithm: string, key: HostBytes);
    update(data: unknown, inputEncoding?: string): this;
    digest(outputEncoding?: string): Buffer | string;
    digestAsync(outputEncoding?: string): Promise<Buffer | string>;
}
export declare function createHash(algorithm: string, options?: {
    outputLength?: number;
}): Hash;
export declare function createHmac(algorithm: string, key: unknown, options?: {
    encoding?: string;
}): Hmac;
/** The one-shot digest, `crypto.hash`, added in Node 21. */
export declare function hash(algorithm: string, data: unknown, outputEncoding?: string): Buffer | string;
type BinaryLike = string | Buffer | Uint8Array;
export declare function pbkdf2Sync(password: BinaryLike, salt: BinaryLike, iterations: number, keylen: number, digest: string): Buffer;
export declare function pbkdf2(password: BinaryLike, salt: BinaryLike, iterations: number, keylen: number, digest: string, callback: (err: Error | null, derivedKey?: Buffer) => void): void;
/**
 * Calculates and returns a signature for data using the given private key
 * This is the one-shot API that jose uses
 */
export declare function sign(algorithm: string | null | undefined, data: Buffer | Uint8Array, key: KeyLike, callback?: (error: Error | null, signature: Buffer) => void): Buffer | void;
/**
 * Verifies the given signature for data using the given key
 */
export declare function verify(algorithm: string | null | undefined, data: Buffer | Uint8Array, key: KeyLike, signature: Buffer | Uint8Array, callback?: (error: Error | null, result: boolean) => void): boolean | void;
export declare function createSign(algorithm: string): Sign;
export declare function createVerify(algorithm: string): Verify;
declare class Sign extends EventEmitter {
    private algorithm;
    private data;
    constructor(algorithm: string);
    update(data: string | Buffer | Uint8Array, encoding?: string): this;
    sign(privateKey: KeyLike, outputEncoding?: string): Buffer | string;
}
declare class Verify extends EventEmitter {
    private algorithm;
    private data;
    constructor(algorithm: string);
    update(data: string | Buffer | Uint8Array, encoding?: string): this;
    verify(publicKey: KeyLike, signature: Buffer | string, signatureEncoding?: string): boolean;
}
export declare class KeyObject {
    private _keyData;
    private _type;
    private _algorithm?;
    constructor(type: 'public' | 'private' | 'secret', keyData: CryptoKey | Uint8Array, algorithm?: string);
    get type(): string;
    get asymmetricKeyType(): string | undefined;
    get symmetricKeySize(): number | undefined;
    export(options?: {
        type?: string;
        format?: string;
    }): Buffer | string;
}
export declare function createSecretKey(key: BinaryLike | ArrayBufferView, encoding?: string): KeyObject;
export declare function createPublicKey(key: KeyLike): KeyObject;
export declare function createPrivateKey(key: KeyLike): KeyObject;
export declare function timingSafeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
export declare function getCiphers(): string[];
export declare function getHashes(): string[];
type KeyLike = string | Buffer | KeyObject | {
    key: string | Buffer;
    passphrase?: string;
};
declare const _default: {
    randomBytes: typeof randomBytes;
    randomFill: typeof randomFill;
    randomFillSync: typeof randomFillSync;
    randomUUID: typeof randomUUID;
    randomInt: typeof randomInt;
    getRandomValues: typeof getRandomValues;
    hash: typeof hash;
    createHash: typeof createHash;
    createHmac: typeof createHmac;
    createSign: typeof createSign;
    createVerify: typeof createVerify;
    sign: typeof sign;
    verify: typeof verify;
    pbkdf2: typeof pbkdf2;
    pbkdf2Sync: typeof pbkdf2Sync;
    timingSafeEqual: typeof timingSafeEqual;
    getCiphers: typeof getCiphers;
    getHashes: typeof getHashes;
    constants: {
        SSL_OP_ALL: number;
        RSA_PKCS1_PADDING: number;
        RSA_PKCS1_OAEP_PADDING: number;
        RSA_PKCS1_PSS_PADDING: number;
    };
    KeyObject: typeof KeyObject;
    createSecretKey: typeof createSecretKey;
    createPublicKey: typeof createPublicKey;
    createPrivateKey: typeof createPrivateKey;
};
export default _default;
//# sourceMappingURL=crypto.d.ts.map