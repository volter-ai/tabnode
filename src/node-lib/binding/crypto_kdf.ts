/**
 * THE KEY DERIVATIONS OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's
 * `src/crypto/crypto_pbkdf2.cc`, `crypto_scrypt.cc` and `crypto_hkdf.cc` (PBKDF2Job, ScryptJob, HKDFJob), over their
 * OpenSSL half (native/node/crypto_pbkdf2.cc, crypto_scrypt.cc, crypto_hkdf.cc) and the engine device.
 *
 * Routing (ADR-0018 §5): PBKDF2 and HKDF over a digest WebCrypto defines (SHA-1, SHA-256, SHA-384, SHA-512) are the
 * device's (`importKey` of the secret as a PBKDF2 or HKDF key, then `deriveBits`), synchronous and asynchronous alike;
 * a derivation of zero bytes (which WebCrypto's deriveBits cannot ask for) and one over any other digest are
 * OpenSSL's, and scrypt is OpenSSL's (WebCrypto has none).
 */
import { withBytes } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import { bufferSource, CryptoJob, glue, toArrayBuffer, webCryptoDigest } from './crypto_util';
import { isKeyObjectHandle } from './crypto_keys';
import { Buffer } from '../buffer-module';

/** `use` with a secret's handle data, or its bytes in the process's memory (0 for the handle). */
function withSecret<T>(secret: unknown, use: (key: number, at: number, length: number) => T): T {
  if (isKeyObjectHandle(secret)) return use(secret.opensslKey(), 0, 0);
  return withBytes(bufferSource(secret), (at, length) => use(0, at, length));
}

/** A secret's bytes, as the device imports them. */
function secretBytes(secret: unknown): Uint8Array {
  return isKeyObjectHandle(secret) ? new Uint8Array(secret.export() as Buffer) : bufferSource(secret);
}

/** The device's derivation of `length` bytes: `importKey` of the secret for `name`, then `deriveBits`. */
function deviceDerivation(name: string, secret: Uint8Array, algorithm: Record<string, unknown>, length: number) {
  const importArgs = ['raw', secret, name, false, ['deriveBits']];
  return {
    call: (sync: boolean) => {
      if (sync) return engineCallSync('deriveBits', [algorithm, engineCallSync('importKey', importArgs), length * 8]);
      return (engineCallAsync('importKey', importArgs) as Promise<EngineKey>)
        .then((key) => engineCallAsync('deriveBits', [algorithm, key, length * 8]));
    },
    result: (value: unknown) => value,
  };
}

/** PBKDF2Job (PBKDF2Traits, crypto_pbkdf2.cc:46-121). */
export class PBKDF2Job extends CryptoJob {
  private readonly route: { hash: string; secret: unknown; salt: Uint8Array; iterations: number; length: number } | undefined;
  constructor(mode: number, password: unknown, salt: unknown, iterations: number, length: number, digest: string) {
    super(mode);
    const saltBytes = bufferSource(salt);
    const exports = glue();
    this.adopt(withSecret(password, (key, at, size) => withBytes(saltBytes, (saltAt, saltSize) =>
      withBytes(String(digest), (nameAt) =>
        exports.tabnode_pbkdf2_job_new(mode, key, at, size, saltAt, saltSize, iterations | 0, length | 0, nameAt)))));
    const hash = webCryptoDigest(String(digest));
    this.route = hash && length > 0 && iterations > 0
      ? { hash, secret: password, salt: saltBytes.slice(), iterations, length } : undefined;
  }
  protected device() {
    const route = this.route;
    if (!route) return undefined;
    return deviceDerivation('PBKDF2', secretBytes(route.secret),
      { name: 'PBKDF2', hash: route.hash, salt: route.salt, iterations: route.iterations }, route.length);
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** ScryptJob (ScryptTraits, crypto_scrypt.cc:55-140): OpenSSL's. */
export class ScryptJob extends CryptoJob {
  constructor(mode: number, password: unknown, salt: unknown, N: number, r: number, p: number, maxmem: number,
    length: number) {
    super(mode);
    const exports = glue();
    this.adopt(withBytes(bufferSource(password), (at, size) => withBytes(bufferSource(salt), (saltAt, saltSize) =>
      exports.tabnode_scrypt_job_new(mode, at, size, saltAt, saltSize, N >>> 0, r >>> 0, p >>> 0, Math.trunc(maxmem),
        length | 0))));
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** HKDFJob (HKDFTraits, crypto_hkdf.cc:45-131). */
export class HKDFJob extends CryptoJob {
  private readonly route: { hash: string; secret: unknown; salt: Uint8Array; info: Uint8Array; length: number } | undefined;
  constructor(mode: number, hash: string, key: unknown, salt: unknown, info: unknown, length: number) {
    super(mode);
    const saltBytes = bufferSource(salt), infoBytes = bufferSource(info);
    const exports = glue();
    this.adopt(withBytes(String(hash), (nameAt) => withSecret(key, (handle, at, size) =>
      withBytes(saltBytes, (saltAt, saltSize) => withBytes(infoBytes, (infoAt, infoSize) =>
        exports.tabnode_hkdf_job_new(mode, nameAt, handle, at, size, saltAt, saltSize, infoAt, infoSize,
          length >>> 0))))));
    const webcrypto = webCryptoDigest(String(hash));
    this.route = webcrypto && length > 0
      ? { hash: webcrypto, secret: key, salt: saltBytes.slice(), info: infoBytes.slice(), length } : undefined;
  }
  protected device() {
    const route = this.route;
    if (!route) return undefined;
    return deviceDerivation('HKDF', secretBytes(route.secret),
      { name: 'HKDF', hash: route.hash, salt: route.salt, info: route.info }, route.length);
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

export const kdfBinding = { PBKDF2Job, ScryptJob, HKDFJob };
