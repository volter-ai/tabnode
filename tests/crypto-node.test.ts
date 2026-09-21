/**
 * The crypto shim against Node's own crypto, digest for digest.
 *
 * Node is the reference: every expectation here is a value node:crypto
 * produces on this host, or a published vector (RFC 6070 for PBKDF2, RFC 4231
 * for HMAC), never a value this shim happens to return.
 */

import { describe, it, expect } from 'vitest';
import {
  createHash as nodeCreateHash,
  createHmac as nodeCreateHmac,
  pbkdf2Sync as nodePbkdf2Sync,
} from 'node:crypto';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import type { Buffer as GuestBufferType } from '../src/node-lib/stream-module';

interface GuestCrypto {
  hash(algorithm: string, data: unknown, outputEncoding?: string): GuestBufferType | string;
  createHash(algorithm: string): GuestHash;
  createHmac(algorithm: string, key: unknown, options?: { encoding?: string }): GuestHmac;
  createSecretKey(key: unknown, encoding?: string): unknown;
  getHashes(): string[];
  pbkdf2Sync(password: unknown, salt: unknown, iterations: number, keylen: number, digest: string): GuestBufferType;
  pbkdf2(password: unknown, salt: unknown, iterations: number, keylen: number, digest: string,
    callback: (error: Error | null, key?: GuestBufferType) => void): void;
  sign(algorithm: string, data: Uint8Array, key: unknown, callback?: (error: Error | null) => void): unknown;
  verify(algorithm: string, data: Uint8Array, key: unknown, signature: Uint8Array): unknown;
}
interface GuestHash {
  update(data: unknown, encoding?: string): GuestHash;
  digest(encoding?: string): GuestBufferType | string;
  copy(): GuestHash;
}
interface GuestHmac {
  update(data: unknown, encoding?: string): GuestHmac;
  digest(encoding?: string): GuestBufferType | string;
}

/** The guest's own crypto and Buffer, reached the way a program reaches them. */
function guestCrypto(): { crypto: GuestCrypto; Buffer: typeof GuestBufferType } {
  return new Runtime(new VirtualFS()).execute(
    'module.exports = {crypto: require("node:crypto"), Buffer};',
    '/crypto.cjs'
  ).exports as { crypto: GuestCrypto; Buffer: typeof GuestBufferType };
}

describe('crypto against Node', () => {
  it('one-shot SHA hashes match native Node for text and byte views', () => {
    const { crypto } = guestCrypto();
    for (const algorithm of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']) {
      for (const data of ['', 'hello 🌍', new Uint8Array([0, 128, 255])]) {
        for (const encoding of ['hex', 'base64', 'base64url']) {
          expect(crypto.hash(algorithm, data, encoding))
            .toBe(nodeCreateHash(algorithm).update(data).digest(encoding as 'hex'));
        }
        expect([...(crypto.hash(algorithm, data, 'buffer') as GuestBufferType)])
          .toEqual([...nodeCreateHash(algorithm).update(data).digest()]);
      }
    }
    const view = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
    expect(crypto.hash('sha256', view)).toBe(nodeCreateHash('sha256').update(view).digest('hex'));
    expect(() => crypto.hash('not-a-hash', 'hello')).toThrow();
    expect(() => crypto.hash('sha256', 42)).toThrow(TypeError);
  });

  it('incremental SHA hashes and independent copies match Node across block boundaries', () => {
    const { crypto, Buffer: GuestBuffer } = guestCrypto();
    expect(crypto.getHashes()).toEqual(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']);
    for (const algorithm of crypto.getHashes()) {
      for (const length of [0, 55, 56, 63, 64, 111, 112, 127, 128, 1025]) {
        const data = Buffer.alloc(length, 0xa3);
        const guest = crypto.createHash(algorithm);
        const native = nodeCreateHash(algorithm);
        for (let offset = 0; offset < data.length; offset += 13) {
          expect(guest.update(data.subarray(offset, offset + 13))).toBe(guest);
          native.update(data.subarray(offset, offset + 13));
        }
        const copied = guest.copy();
        const digest = guest.digest() as GuestBufferType;
        expect(GuestBuffer.isBuffer(digest)).toBe(true);
        expect([...digest]).toEqual([...native.digest()]);
        expect(copied.update('tail').digest('hex'))
          .toBe(nodeCreateHash(algorithm).update(data).update('tail').digest('hex'));
        for (const finalized of [() => guest.update('late'), () => guest.digest(), () => guest.copy()]) {
          expect(finalized).toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }));
        }
      }
      for (const [data, encoding] of [['c3a900ff', 'hex'], ['w6kA/w==', 'base64'], ['w6kA_w', 'base64url'],
        ['é 🌍', 'utf8'], ['é🌍', 'utf16le'], ['éÿ', 'latin1']]) {
        expect(crypto.createHash(algorithm).update(data, encoding).digest('base64'))
          .toBe(nodeCreateHash(algorithm).update(data, encoding as 'hex').digest('base64'));
      }
    }
    const data = new Uint8Array([0, 1, 2, 255]);
    const hash = crypto.createHash('sha256').update(new DataView(data.buffer, 1, 2));
    data.fill(7);
    expect(hash.digest('hex'), 'update must consume bytes before a caller mutates its buffer')
      .toBe(nodeCreateHash('sha256').update(new Uint8Array([1, 2])).digest('hex'));
    for (const algorithm of ['sha0', 'sha3-256', 'sha--256', 'not-a-digest']) {
      expect(() => crypto.createHash(algorithm))
        .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }));
    }
    expect(() => crypto.createHash('sha256').update(42)).toThrow(TypeError);
  });

  it('HMAC implements short, long, binary, and secret-object keys with Node finalization', () => {
    const { crypto } = guestCrypto();
    for (const algorithm of crypto.getHashes()) {
      for (const key of ['', 'a secret 🌍', Buffer.alloc(64, 0xaa), Buffer.alloc(131, 0xaa)]) {
        for (const encoding of ['hex', 'base64', 'base64url']) {
          const guest = crypto.createHmac(algorithm, key).update('c3a900ff', 'hex').update('tail');
          const native = nodeCreateHmac(algorithm, key).update('c3a900ff', 'hex').update('tail');
          expect(guest.digest(encoding)).toBe(native.digest(encoding as 'hex'));
          // A second digest is empty in Node, not an error.
          expect(guest.digest(encoding)).toBe(native.digest(encoding as 'hex'));
          expect(() => guest.update('late'))
            .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }));
        }
      }
    }
    // RFC 4231 test case 1: catches a mistake shared by shim and reference.
    expect(crypto.createHmac('sha256', Buffer.alloc(20, 0x0b)).update('Hi There').digest('hex'))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    const backing = new Uint8Array([99, 0, 128, 255, 99]);
    const key = new DataView(backing.buffer, 1, 3);
    const expected = nodeCreateHmac('sha256', key).update('data').digest('hex');
    expect(crypto.createHmac('sha256', key).update('data').digest('hex')).toBe(expected);
    expect(crypto.createHmac('sha256', crypto.createSecretKey(backing.subarray(1, 4)))
      .update('data').digest('hex')).toBe(expected);
    expect(crypto.createHmac('sha256', '0080ff', { encoding: 'hex' }).update('data').digest('hex'))
      .toBe(expected);
    expect(() => crypto.createHmac('sha256', 42)).toThrow(TypeError);
    expect(() => crypto.createHmac('unsupported', 'key'))
      .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }));
  });

  it('PBKDF2 matches standard vectors and Node for multiple blocks and offset inputs', () => {
    const { crypto, Buffer: GuestBuffer } = guestCrypto();
    // RFC 6070 vectors 1 and 2.
    expect(crypto.pbkdf2Sync('password', 'salt', 1, 20, 'sha1').toString('hex'))
      .toBe('0c60c80f961f0e71f3a9b524af6012062fe037a6');
    expect(crypto.pbkdf2Sync('password', 'salt', 2, 20, 'sha1').toString('hex'))
      .toBe('ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957');
    const backing = new Uint8Array([99, 0, 128, 255, 99]);
    for (const algorithm of crypto.getHashes()) {
      for (const keylen of [1, 20, 29, 65, 129]) {
        const password = new DataView(backing.buffer, 1, 3);
        const salt = backing.subarray(2, 4);
        const actual = crypto.pbkdf2Sync(password, salt, 3, keylen, algorithm);
        expect(GuestBuffer.isBuffer(actual)).toBe(true);
        expect([...actual]).toEqual([...nodePbkdf2Sync(password, salt, 3, keylen, algorithm)]);
        expect([...backing], 'derivation must not erase caller-owned memory')
          .toEqual([99, 0, 128, 255, 99]);
      }
    }
    for (const iterations of [0, -1, 1.5, NaN, Infinity, 0x80000000]) {
      expect(() => crypto.pbkdf2Sync('p', 's', iterations, 1, 'sha256')).toThrow(RangeError);
    }
    for (const keylen of [0, -1, 0.5, NaN, Infinity, 0x80000000]) {
      expect(() => crypto.pbkdf2Sync('p', 's', 1, keylen, 'sha256')).toThrow(RangeError);
    }
    expect(() => crypto.pbkdf2Sync('p', 's', '1' as unknown as number, 1, 'sha256')).toThrow(TypeError);
    expect(() => crypto.pbkdf2Sync('p', 's', 1, 1, 'unknown'))
      .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }));
  });

  it('callback PBKDF2 is deferred, copies input, and agrees with synchronous output', async () => {
    const { crypto } = guestCrypto();
    const password = new Uint8Array([0, 128, 255]);
    const expected = [...nodePbkdf2Sync(password, 'salt', 17, 65, 'sha224')];
    let synchronous = true;
    const derived = new Promise<number[]>((resolve, reject) => {
      crypto.pbkdf2(password, 'salt', 17, 65, 'sha224', (error, bytes) => {
        if (error) return reject(error);
        try {
          expect(synchronous).toBe(false);
          resolve([...bytes!]);
        } catch (failure) {
          reject(failure);
        }
      });
    });
    password.fill(7);
    synchronous = false;
    expect(await derived).toEqual(expected);
    expect(() => crypto.pbkdf2('p', 's', 1, 1, 'sha256', undefined as never)).toThrow(TypeError);
    expect(() => crypto.pbkdf2('p', 's', 0, 1, 'sha256', () => {})).toThrow(RangeError);
  });

  it('unsupported synchronous signatures and failed async signing never fabricate success', async () => {
    const { crypto } = guestCrypto();
    const key = crypto.createSecretKey(new Uint8Array([1, 2, 3]));
    expect(() => crypto.sign('sha256', new Uint8Array([4]), key))
      .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' }));
    expect(() => crypto.verify('sha256', new Uint8Array([4]), key, new Uint8Array(32)))
      .toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' }));
    await new Promise<void>(resolve => {
      crypto.sign('sha256', new Uint8Array([4]), key, error => {
        expect(error?.name).toBe('NotSupportedError');
        resolve();
      });
    });
  });

  it('MD5 used by config-loader cache keys matches reference vectors and copies', () => {
    const { crypto } = guestCrypto();
    expect(crypto.createHash('md5').update('abc').digest('hex'))
      .toBe('900150983cd24fb0d6963f7d28e17f72');
    const source = crypto.createHash('md5').update('prefix');
    expect(source.copy().update('one').digest('hex'))
      .toBe(nodeCreateHash('md5').update('prefixone').digest('hex'));
    expect(source.update('two').digest('hex'))
      .toBe(nodeCreateHash('md5').update('prefixtwo').digest('hex'));
  });
});
