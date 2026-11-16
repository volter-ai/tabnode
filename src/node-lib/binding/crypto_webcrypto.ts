/**
 * THE ONE-SHOT JOBS OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_aes.cc`
 * (AESCipherJob), `crypto_rsa.cc` (RSACipherJob), `crypto_chacha20_poly1305.cc`, `crypto_kmac.cc`,
 * `crypto_turboshake.cc` (TurboShakeJob, KangarooTwelveJob), `crypto_argon2.cc`, `crypto_kem.cc` and
 * `crypto_spkac.cc` (crypto.Certificate), over their OpenSSL half (native/node) and the engine device.
 *
 * Routing (ADR-0018 §5): WebCrypto's AES-CBC, AES-CTR, AES-GCM and AES-KW with a 128- or 256-bit key are the device's
 * `encrypt` and `decrypt` (AES-KW its `wrapKey` and `unwrapKey` of the bytes as a raw HMAC key, which WebCrypto's
 * AES-KW takes), where WebCrypto takes the call's parameters (a 16-byte IV for CBC, a tag of one of WebCrypto's
 * lengths for GCM); RSA-OAEP over a WebCrypto digest is the device's. AES-192, AES-OCB, ChaCha20-Poly1305, KMAC,
 * TurboSHAKE, KangarooTwelve, Argon2, every encapsulation and the SPKAC calls are OpenSSL's (or Node's own C++).
 */
import { Buffer } from '../buffer-module';
import { withBytes } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import {
  bufferSource, checked, CryptoJob, glue, kCryptoJobWebCrypto, rethrow, toArrayBuffer, toBuffer, Values, webCryptoDigest,
} from './crypto_util';
import { handleOf, opensslBindingValues, type KeyObjectHandle } from './crypto_keys';
import { kWebCryptoCipherEncrypt } from './crypto_cipher';
import { mallocAnswer } from './openssl';
import { libnode } from './libnode';

/** AESKeyVariant (crypto_aes.h), as AES::Initialize names each kKeyVariantAES_*. */
const AES_VARIANTS = ['CTR_128', 'CTR_192', 'CTR_256', 'CBC_128', 'CBC_192', 'CBC_256', 'GCM_128', 'GCM_192',
  'GCM_256', 'KW_128', 'KW_192', 'KW_256', 'OCB_128', 'OCB_192', 'OCB_256'] as const;
const aesVariantConstants = Object.fromEntries(AES_VARIANTS.map((name, index) => [`kKeyVariantAES_${name}`, index]));

/** WebCrypto's AES-GCM tag lengths, in bits. */
const GCM_TAG_BITS = new Set([32, 64, 96, 104, 112, 120, 128]);

/** The device's half of a one-shot cipher: the key's import and the call. */
interface DeviceCipher {
  importAlgorithm: Record<string, unknown>;
  usages: string[];
  call(key: EngineKey, sync: boolean): unknown;
}

/** CipherJob<Traits> (crypto_cipher.h:146-262): (mode, cipher mode, the key's handle, the data, the traits' arguments). */
abstract class OneShotCipherJob extends CryptoJob {
  protected readonly encrypting: boolean;
  protected readonly key: KeyObjectHandle;
  protected readonly data: Uint8Array;

  constructor(mode: number, cipherMode: unknown, key: unknown, data: unknown, readonly rest: unknown[],
    create: string) {
    super(mode);
    this.encrypting = cipherMode === kWebCryptoCipherEncrypt;
    this.key = handleOf(key);
    this.data = bufferSource(data);
    const exports = glue();
    const handle = this.key.opensslKey();
    this.adopt(withBytes(this.data, (dataAt, dataLength) => new Values(rest).call((at, length) =>
      exports[`tabnode_${create}`](mode, Number(cipherMode) >>> 0, handle, dataAt, dataLength, at, length))));
  }

  /** The device's half of this job, or none where OpenSSL answers it. */
  protected deviceCipher(): DeviceCipher | undefined { return undefined; }

  protected device() {
    const cipher = this.deviceCipher();
    if (!cipher) return undefined;
    return {
      call: (sync: boolean) => (sync
        ? cipher.call(this.key.deviceKey(cipher.importAlgorithm, cipher.usages, true), true)
        : this.key.deviceKey(cipher.importAlgorithm, cipher.usages, false).then((key) => cipher.call(key, false))),
      result: (value: unknown) => value,
    };
  }

  /** CipherJob::ToResult (crypto_cipher.h:224-247): the bytes as an ArrayBuffer. */
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** A device call in the job's form. */
function call(sync: boolean, name: 'encrypt' | 'decrypt' | 'wrapKey' | 'unwrapKey' | 'importKey' | 'exportKey',
  args: unknown[]): unknown {
  return sync ? engineCallSync(name, args) : engineCallAsync(name, args);
}

/** The raw HMAC key WebCrypto's AES-KW wraps and unwraps a secret's bytes as. */
const KW_CARRIER = { name: 'HMAC', hash: 'SHA-256' };

/** AESCipherJob (AESCipherTraits, crypto_aes.cc:507-597): (…, variant, iv or counter, length or tag, data). */
export class AESCipherJob extends OneShotCipherJob {
  constructor(mode: number, cipherMode: unknown, key: unknown, data: unknown, ...rest: unknown[]) {
    super(mode, cipherMode, key, data, rest, 'aes_cipher_job_new');
  }

  protected deviceCipher(): DeviceCipher | undefined {
    const variant = AES_VARIANTS[Number(this.rest[0])];
    if (!variant || variant.endsWith('_192') || variant.startsWith('OCB')) return undefined;
    const usages = ['encrypt', 'decrypt'];
    const op = this.encrypting ? 'encrypt' : 'decrypt';
    const data = this.data;
    if (variant.startsWith('CBC')) {
      const iv = bufferSource(this.rest[1]);
      if (iv.byteLength !== 16) return undefined;
      return { importAlgorithm: { name: 'AES-CBC' }, usages, call: (key, sync) => call(sync, op, [{ name: 'AES-CBC', iv }, key, data]) };
    }
    if (variant.startsWith('CTR')) {
      const counter = bufferSource(this.rest[1]);
      const length = Number(this.rest[2]);
      if (counter.byteLength !== 16 || !(length >= 1 && length <= 128)) return undefined;
      return {
        importAlgorithm: { name: 'AES-CTR' }, usages,
        call: (key, sync) => call(sync, op, [{ name: 'AES-CTR', counter, length }, key, data]),
      };
    }
    if (variant.startsWith('GCM')) {
      const iv = bufferSource(this.rest[1]);
      const tagLength = Number(this.rest[2]) * 8;
      if (iv.byteLength === 0 || !GCM_TAG_BITS.has(tagLength)) return undefined;
      const algorithm: Record<string, unknown> = { name: 'AES-GCM', iv, tagLength };
      if (this.rest[3] !== undefined) algorithm.additionalData = bufferSource(this.rest[3]);
      return { importAlgorithm: { name: 'AES-GCM' }, usages, call: (key, sync) => call(sync, op, [algorithm, key, data]) };
    }
    // AES-KW: the bytes as a raw HMAC key, wrapped or unwrapped (crypto_aes.cc AES_Cipher over the wrap mode).
    if (data.byteLength < 16 || data.byteLength % 8 !== 0) return undefined;
    return {
      importAlgorithm: { name: 'AES-KW' }, usages: ['wrapKey', 'unwrapKey'],
      call: (key, sync) => {
        if (this.encrypting) {
          const wrap = (carrier: unknown) => call(sync, 'wrapKey', ['raw', carrier, key, 'AES-KW']);
          const carrier = call(sync, 'importKey', ['raw', data, KW_CARRIER, true, ['sign']]);
          return sync ? wrap(carrier) : (carrier as Promise<unknown>).then(wrap);
        }
        const unwrapped = call(sync, 'unwrapKey', ['raw', data, key, 'AES-KW', KW_CARRIER, true, ['sign']]);
        const exported = (carrier: unknown) => call(sync, 'exportKey', ['raw', carrier]);
        return sync ? exported(unwrapped) : (unwrapped as Promise<unknown>).then(exported);
      },
    };
  }
}

/** RSACipherJob (RSACipherTraits, crypto_rsa.cc:245-300): (…, variant, digest, label). */
export class RSACipherJob extends OneShotCipherJob {
  constructor(mode: number, cipherMode: unknown, key: unknown, data: unknown, ...rest: unknown[]) {
    super(mode, cipherMode, key, data, rest, 'rsa_cipher_job_new');
  }

  protected deviceCipher(): DeviceCipher | undefined {
    const hash = typeof this.rest[1] === 'string' ? webCryptoDigest(this.rest[1]) : undefined;
    const values = opensslBindingValues();
    if (Number(this.rest[0]) !== 2 || !hash || glue().tabnode_key_id(this.key.opensslKey()) !== values.EVP_PKEY_RSA) {
      return undefined;
    }
    const algorithm: Record<string, unknown> = { name: 'RSA-OAEP' };
    if (this.rest[2] !== undefined) algorithm.label = bufferSource(this.rest[2]);
    const op = this.encrypting ? 'encrypt' : 'decrypt';
    return {
      importAlgorithm: { name: 'RSA-OAEP', hash }, usages: [op],
      call: (key, sync) => call(sync, op, [algorithm, key, this.data]),
    };
  }
}

/** ChaCha20Poly1305CipherJob (crypto_chacha20_poly1305.cc): (…, iv, additional data). OpenSSL's. */
export class ChaCha20Poly1305CipherJob extends OneShotCipherJob {
  constructor(mode: number, cipherMode: unknown, key: unknown, data: unknown, ...rest: unknown[]) {
    super(mode, cipherMode, key, data, rest, 'chacha20_poly1305_job_new');
  }
}

/** A DeriveBitsJob whose arguments after the mode are Node's, made by the export `create`. */
abstract class ArgumentsJob extends CryptoJob {
  constructor(mode: number, protected readonly args: unknown[], create: string) {
    super(mode);
    const exports = glue();
    this.adopt(new Values(args).call((at, length) => exports[`tabnode_${create}`](mode, at, length)));
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** KmacJob (KmacTraits, crypto_kmac.cc): (mode, sign mode, key, name, customization, key length, length, data, signature). */
export class KmacJob extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'kmac_job_new'); }
  /** KmacTraits::EncodeOutput: the MAC, or whether it is the signature. */
  protected encode(): unknown {
    if (this.args[0] === 0) return toArrayBuffer(this.out());
    return glue().tabnode_kmac_job_verified(this.job) === 1;
  }
}

/** TurboShakeJob (crypto_turboshake.cc:425-500): (mode, name, domain separation, output length, data). */
export class TurboShakeJob extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'turboshake_job_new'); }
}

/** KangarooTwelveJob (crypto_turboshake.cc:527-632): (mode, name, customization, output length, data). */
export class KangarooTwelveJob extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'kangarootwelve_job_new'); }
}

/** Argon2Job (Argon2Traits, crypto_argon2.cc): (mode, pass, salt, lanes, key length, memory, passes, secret, ad, type). */
export class Argon2Job extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'argon2_job_new'); }
}

/** KEMEncapsulateJob (crypto_kem.cc:62-190): (mode, the public key's slots). */
export class KEMEncapsulateJob extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'kem_encapsulate_job_new'); }
  /** A synchronous job's failure is thrown (THROW_ERR_CRYPTO_OPERATION_FAILED). */
  run(): unknown {
    const result = super.run();
    rethrow();
    return result;
  }
  /** KEMEncapsulateJob::ToResult (127-176): { sharedKey, ciphertext } for WebCrypto, else [sharedKey, ciphertext]. */
  protected encode(): unknown {
    const program = libnode();
    const sharedKey = this.out();
    const ciphertext = withLength((lengthAt) => glue().tabnode_kem_job_ciphertext(this.job, lengthAt), program);
    if (this.mode === kCryptoJobWebCrypto) {
      const output = {};
      Object.defineProperty(output, 'sharedKey', { value: toArrayBuffer(sharedKey), writable: true, enumerable: true, configurable: true });
      Object.defineProperty(output, 'ciphertext', { value: toArrayBuffer(ciphertext), writable: true, enumerable: true, configurable: true });
      return output;
    }
    return [toBuffer(sharedKey), toBuffer(ciphertext)];
  }
}

/** A borrowed answer (`(…, size_t* length) => const void*`) copied out. */
function withLength(get: (lengthAt: number) => number, program: ReturnType<typeof libnode>): Uint8Array {
  const lengthAt = program.exports.tabnode_malloc(4) >>> 0;
  try {
    const at = get(lengthAt) >>> 0;
    const lengthBytes = program.read(lengthAt, 4);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, true);
    return at && length ? program.read(at, length) : new Uint8Array(0);
  } finally { program.exports.tabnode_free(lengthAt); }
}

/** KEMDecapsulateJob (KEMDecapsulateTraits, crypto_kem.cc:212-255): (mode, the private key's slots, ciphertext). */
export class KEMDecapsulateJob extends ArgumentsJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, args, 'kem_decapsulate_job_new'); }
  run(): unknown {
    const result = super.run();
    rethrow();
    return result;
  }
  /** KEMDecapsulateTraits::EncodeOutput: a Buffer. */
  protected encode(): unknown { return toBuffer(this.out()); }
}

/** SPKAC (crypto_spkac.cc:21-79): an empty input is Node's empty string. */
function certVerifySpkac(spkac: unknown): boolean | string {
  const bytes = bufferSource(spkac);
  if (bytes.byteLength === 0) return '';
  return checked(withBytes(bytes, (at, length) => glue().tabnode_spkac_verify(at, length))) === 1;
}
function certExportPublicKey(spkac: unknown): Buffer | string {
  const bytes = bufferSource(spkac);
  if (bytes.byteLength === 0) return '';
  const key = mallocAnswer((lengthAt) => withBytes(bytes, (at, length) => glue().tabnode_spkac_export_public_key(at, length, lengthAt)));
  rethrow();
  return key === null ? '' : toBuffer(key);
}
function certExportChallenge(spkac: unknown): Buffer | string {
  const bytes = bufferSource(spkac);
  if (bytes.byteLength === 0) return '';
  const challenge = mallocAnswer((lengthAt) => withBytes(bytes, (at, length) => glue().tabnode_spkac_export_challenge(at, length, lengthAt)));
  rethrow();
  // StringBytes::Encode(BUFFER): a Buffer.
  return challenge === null ? '' : toBuffer(challenge);
}

/** kTypeArgon2d, kTypeArgon2i, kTypeArgon2id (Argon2::Initialize): ncrypto's Argon2Type, read from the program. */
export const ARGON2_TYPE_NAMES = ['kTypeArgon2d', 'kTypeArgon2i', 'kTypeArgon2id'];
export function argon2Type(name: string): number { return glue().tabnode_argon2_type(ARGON2_TYPE_NAMES.indexOf(name)); }

export const webcryptoBinding = {
  AESCipherJob, RSACipherJob, ChaCha20Poly1305CipherJob, KmacJob, TurboShakeJob, KangarooTwelveJob, Argon2Job,
  KEMEncapsulateJob, KEMDecapsulateJob, certVerifySpkac, certExportPublicKey, certExportChallenge,
  ...aesVariantConstants,
};
