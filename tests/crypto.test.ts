/**
 * Tests for the crypto shim
 */

import { describe, it, expect } from 'vitest';
import crypto, {
  randomBytes,
  randomUUID,
  randomInt,
  createHash,
  createHmac,
  createSign,
  createVerify,
  sign,
  verify,
  timingSafeEqual,
  createSecretKey,
  KeyObject,
} from '../src/shims/crypto';
import { Buffer } from '../src/node-lib/buffer-module';

describe('crypto module', () => {
  describe('randomBytes', () => {
    it('should generate random bytes of specified length', () => {
      const bytes = randomBytes(16);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(16);
    });

    it('should generate different values each time', () => {
      const bytes1 = randomBytes(16);
      const bytes2 = randomBytes(16);
      // Very unlikely to be equal
      expect(bytes1).not.toEqual(bytes2);
    });
  });

  describe('randomUUID', () => {
    it('should generate a valid UUID', () => {
      const uuid = randomUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should generate unique UUIDs', () => {
      const uuid1 = randomUUID();
      const uuid2 = randomUUID();
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('randomInt', () => {
    it('should generate random integer in range', () => {
      for (let i = 0; i < 100; i++) {
        const num = randomInt(10, 20);
        expect(num).toBeGreaterThanOrEqual(10);
        expect(num).toBeLessThan(20);
      }
    });

    it('should handle single argument as max', () => {
      for (let i = 0; i < 100; i++) {
        const num = randomInt(10);
        expect(num).toBeGreaterThanOrEqual(0);
        expect(num).toBeLessThan(10);
      }
    });
  });

  describe('createHash', () => {
    it('should create hash with SHA-256', () => {
      const hash = createHash('sha256');
      hash.update('hello world');
      const digest = hash.digest('hex');
      expect(typeof digest).toBe('string');
      expect(digest.length).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
    });

    it('should handle multiple updates', () => {
      const hash = createHash('sha256');
      hash.update('hello');
      hash.update(' ');
      hash.update('world');
      const digest = hash.digest('hex');
      expect(typeof digest).toBe('string');
    });

    it('should return Buffer when no encoding specified', () => {
      const hash = createHash('sha256');
      hash.update('hello');
      const digest = hash.digest();
      expect(digest).toBeInstanceOf(Uint8Array);
    });

    it('should support base64 encoding', () => {
      const hash = createHash('sha256');
      hash.update('hello');
      const digest = hash.digest('base64');
      expect(typeof digest).toBe('string');
      // Base64 should not contain hex characters only
      expect(digest).toMatch(/[A-Za-z0-9+/=]/);
    });

    it('should produce consistent output for same input', () => {
      const hash1 = createHash('sha256').update('test').digest('hex');
      const hash2 = createHash('sha256').update('test').digest('hex');
      expect(hash1).toBe(hash2);
    });
  });

  describe('createHmac', () => {
    it('should create HMAC with SHA-256', () => {
      const hmac = createHmac('sha256', 'secret-key');
      hmac.update('hello world');
      const digest = hmac.digest('hex');
      expect(typeof digest).toBe('string');
    });

    it('should produce different output with different keys', () => {
      const hmac1 = createHmac('sha256', 'key1').update('data').digest('hex');
      const hmac2 = createHmac('sha256', 'key2').update('data').digest('hex');
      expect(hmac1).not.toBe(hmac2);
    });

    it('should produce consistent output for same key and data', () => {
      const hmac1 = createHmac('sha256', 'key').update('data').digest('hex');
      const hmac2 = createHmac('sha256', 'key').update('data').digest('hex');
      expect(hmac1).toBe(hmac2);
    });
  });

  describe('sign and verify', () => {
    // A browser has no synchronous asymmetric signing, so Node's error is the
    // answer. These used to assert the opposite: that sign() returned bytes
    // and verify() accepted them — a hash of key||data that no real verifier
    // would ever accept, handed back as a signature.
    const testData = Buffer.from('test message to sign');
    const secretKey = 'my-secret-key';

    it('should refuse to sign synchronously instead of fabricating a signature', () => {
      expect(() => sign('SHA256', testData, secretKey)).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' })
      );
    });

    it('should refuse to verify synchronously', () => {
      expect(() => verify('SHA256', testData, secretKey, Buffer.alloc(32))).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' })
      );
    });

    it('should report the real failure to an async signing callback', async () => {
      const key = createSecretKey(Buffer.from('secret'));
      const error = await new Promise<Error | null>(resolve => {
        sign('sha256', Buffer.from('data'), key, resolve);
      });
      expect(error).toBeTruthy();
      expect(error).not.toBeInstanceOf(Uint8Array);
    });
  });

  describe('createSign and createVerify', () => {
    it('should refuse the streaming signing API rather than fabricate output', () => {
      const signer = createSign('SHA256');
      signer.update('test message to sign');
      expect(() => signer.sign('my-secret-key')).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' })
      );
      const verifier = createVerify('SHA256');
      verifier.update('test message to sign');
      expect(() => verifier.verify('my-secret-key', Buffer.alloc(32))).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' })
      );
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal buffers', () => {
      const a = Buffer.from('hello');
      const b = Buffer.from('hello');
      expect(timingSafeEqual(a, b)).toBe(true);
    });

    it('should return false for different buffers', () => {
      const a = Buffer.from('hello');
      const b = Buffer.from('world');
      expect(timingSafeEqual(a, b)).toBe(false);
    });

    it('should return false for different length buffers', () => {
      const a = Buffer.from('hello');
      const b = Buffer.from('hello world');
      expect(timingSafeEqual(a, b)).toBe(false);
    });
  });

  describe('KeyObject', () => {
    it('should create secret key', () => {
      const key = createSecretKey(Buffer.from('secret'));
      expect(key).toBeInstanceOf(KeyObject);
      expect(key.type).toBe('secret');
    });

    it('should report symmetric key size', () => {
      const key = createSecretKey(Buffer.from('1234567890123456')); // 16 bytes
      expect(key.symmetricKeySize).toBe(128); // 16 * 8 = 128 bits
    });
  });

  describe('default export', () => {
    it('should export all functions', () => {
      expect(crypto.randomBytes).toBe(randomBytes);
      expect(crypto.randomUUID).toBe(randomUUID);
      expect(crypto.createHash).toBe(createHash);
      expect(crypto.createHmac).toBe(createHmac);
      expect(crypto.createSign).toBe(createSign);
      expect(crypto.createVerify).toBe(createVerify);
      expect(crypto.sign).toBe(sign);
      expect(crypto.verify).toBe(verify);
      expect(crypto.timingSafeEqual).toBe(timingSafeEqual);
    });
  });

  describe('algorithm support', () => {
    it('should handle SHA-1', () => {
      const hash = createHash('sha1').update('test').digest('hex');
      expect(hash.length).toBe(40); // SHA-1 = 20 bytes = 40 hex chars
    });

    it('should handle SHA-384', () => {
      const hash = createHash('sha384').update('test').digest('hex');
      expect(hash.length).toBe(96); // SHA-384 = 48 bytes = 96 hex chars
    });

    it('should handle SHA-512', () => {
      const hash = createHash('sha512').update('test').digest('hex');
      expect(hash.length).toBe(128); // SHA-512 = 64 bytes = 128 hex chars
    });
  });

  describe('generateKeyPair', () => {
    // jose's Node build promisifies generateKeyPair when it loads; without it,
    // any module that imported jose failed at import.
    it('promisifies to { publicKey, privateKey } as Node does', async () => {
      const { promisify } = await import('node:util');
      const { publicKey, privateKey } = await promisify(crypto.generateKeyPair)('ec', { namedCurve: 'prime256v1' }) as { publicKey: { type: string }; privateKey: { type: string } };
      expect(publicKey.type).toBe('public');
      expect(privateKey.type).toBe('private');
    });

    it('encodes the pair as PEM when asked', async () => {
      const { publicKey, privateKey } = await new Promise<{ publicKey: string; privateKey: string }>((resolve, reject) =>
        crypto.generateKeyPair('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } },
          (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey: publicKey as string, privateKey: privateKey as string })));
      expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
      expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    });

    it('refuses an unknown type synchronously, as Node does', () => {
      expect(() => crypto.generateKeyPair('dsa-nope', {}, () => undefined)).toThrow(/type/);
    });
  });
});
