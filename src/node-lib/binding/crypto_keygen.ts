/**
 * KEY GENERATION OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_keygen.h`
 * and `crypto_keygen.cc` (KeyGenJob over KeyPairGenTraits and SecretKeyGenTraits, and EncodeKey), with the jobs of
 * `crypto_rsa.cc`, `crypto_dsa.cc`, `crypto_ec.cc` and `crypto_dh.cc`, over their OpenSSL half
 * (native/node/crypto_keygen.cc and each algorithm's file) and the engine device.
 *
 * Routing (ADR-0018 §5): a key WebCrypto generates is the device's `generateKey`, kept as the device's CryptoKey
 * (crypto_keys.ts) and generated extractable, so OpenSSL can take its copy when a call it answers needs one: an RSA
 * key of the RSASSA-PKCS1-v1_5 or RSA-OAEP variant (Node's two that are an `rsaEncryption` key) with a public exponent
 * of 3 or 65537 and a modulus of 256 to 16,384 bits in whole bytes, an EC key on P-256, P-384 or P-521 with its curve
 * named, an Ed25519 or an X25519 key, and a secret of a whole number of bytes (an HMAC key's). Its encodings (PEM,
 * DER, JWK, raw) are OpenSSL's, of the copy OpenSSL takes from the device's export. RSA-PSS keys (their own
 * `id-RSASSA-PSS` encoding), other exponents and sizes, an explicit curve and every other curve, Ed448, X448, DSA, DH,
 * ML-DSA, ML-KEM and SLH-DSA are OpenSSL's.
 */
import { address } from './program';
import { withScratch, word } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import { answer, CryptoJob, glue, kCryptoJobWebCrypto, setFields, toBuffer, Values } from './crypto_util';
import { createCryptoKey, handleFromKeyData, KeyObjectHandle, opensslBindingValues } from './crypto_keys';

/** RSAKeyVariant (crypto_rsa.h:16-20). */
export const kKeyVariantRSA_SSA_PKCS1_v1_5 = 0, kKeyVariantRSA_PSS = 1, kKeyVariantRSA_OAEP = 2;

/** The job's kind as tabnode_keygen_job_new names it. */
const KIND = { rsa: 0, dsa: 1, ec: 2, dh: 3, nid: 4, secret: 5 } as const;

/** WebCrypto's names of the curves the device holds, by each name Node takes for them (Ec::GetCurveIdFromName). */
const DEVICE_CURVES: Record<string, string> = {
  'P-256': 'P-256', prime256v1: 'P-256', secp256r1: 'P-256', 'P-384': 'P-384', secp384r1: 'P-384',
  'P-521': 'P-521', secp521r1: 'P-521',
};

/** A WebCrypto job's configuration (WebCryptoKeyGenConfig, crypto_keygen.h:25-38), the last arguments of its job. */
interface WebCryptoConfig { algorithm: unknown; usages: number; publicUsages: number; privateUsages: number; extractable: boolean }

/**
 * The device's generation of a key: its algorithm and usages, what it answers (a pair, or a secret), and the
 * algorithm the binding's other calls import the key for (crypto_keys.ts `deviceKey`'s cache), where it differs.
 */
interface DeviceGeneration { algorithm: Record<string, unknown>; usages: string[]; pair: boolean; importedAs?: Record<string, unknown> }

/** A key pair's job (KeyGenJob<KeyPairGenTraits<…>>) or a secret's (KeyGenJob<SecretKeyGenTraits>). */
class KeyGenJob extends CryptoJob {
  private readonly webcrypto: WebCryptoConfig | undefined;

  constructor(mode: number, kind: number, private readonly pair: boolean, args: unknown[],
    private readonly generation: DeviceGeneration | undefined) {
    super(mode);
    if (mode === kCryptoJobWebCrypto) {
      // KeyGenJob::New (crypto_keygen.h:41-79): the algorithm, the usages and whether the private key is extractable.
      const tail = args.slice(pair ? -4 : -3);
      this.webcrypto = pair
        ? { algorithm: tail[0], usages: 0, publicUsages: Number(tail[1]) >>> 0, privateUsages: Number(tail[2]) >>> 0, extractable: tail[3] === true }
        : { algorithm: tail[0], usages: Number(tail[1]) >>> 0, publicUsages: 0, privateUsages: 0, extractable: tail[2] === true };
      args = args.slice(0, pair ? -4 : -3);
    }
    const exports = glue();
    this.adopt(new Values(args).call((at, length) => exports.tabnode_keygen_job_new(kind, mode, at, length)));
  }

  protected device() {
    const generation = this.generation;
    if (!generation) return undefined;
    const args = [generation.algorithm, true, generation.usages];
    const name = JSON.stringify(generation.importedAs ?? generation.algorithm);
    return {
      call: (sync: boolean) => (sync ? engineCallSync('generateKey', args) : engineCallAsync('generateKey', args)),
      result: (value: unknown) => {
        if (!generation.pair) return this.encodeSecret(KeyObjectHandle.fromDevice(value as EngineKey, name));
        const { publicKey, privateKey } = value as { publicKey: EngineKey; privateKey: EngineKey };
        return this.encodePair(KeyObjectHandle.fromDevice(publicKey, name), KeyObjectHandle.fromDevice(privateKey, name));
      },
    };
  }

  /** ToResult's encoding of the job's key (EncodeKey, or EncodeWebCryptoKey for a WebCrypto job). */
  protected encode(): unknown {
    const exports = glue();
    if (!this.pair) return this.encodeSecret(handleFromKeyData(address(exports.tabnode_job_key(this.job, 0))));
    const privateData = address(exports.tabnode_job_key(this.job, 0));
    const publicData = address(exports.tabnode_key_public_of(privateData));
    return this.encodePair(handleFromKeyData(publicData), handleFromKeyData(privateData));
  }

  /** SecretKeyGenTraits::EncodeKey (85-89), or the WebCrypto job's CryptoKey (EncodeWebCryptoKey, 162-170). */
  private encodeSecret(handle: KeyObjectHandle): unknown {
    const config = this.webcrypto;
    if (!config) return handle;
    return createCryptoKey(handle, config.algorithm, config.usages, config.extractable);
  }

  /** KeyPairGenTraits::EncodeKey (258-268), or EncodeWebCryptoKey (132-161). */
  private encodePair(publicHandle: KeyObjectHandle, privateHandle: KeyObjectHandle): unknown {
    const config = this.webcrypto;
    if (config) {
      const publicKey = createCryptoKey(publicHandle, config.algorithm, config.publicUsages, true);
      const privateKey = createCryptoKey(privateHandle, config.algorithm, config.privateUsages, config.extractable);
      const pair = {};
      Object.defineProperty(pair, 'publicKey', { value: publicKey, writable: true, enumerable: true, configurable: true });
      Object.defineProperty(pair, 'privateKey', { value: privateKey, writable: true, enumerable: true, configurable: true });
      return pair;
    }
    return [this.encodeHalf(publicHandle, 0), this.encodeHalf(privateHandle, 1)];
  }

  /** One half as its encoding says (tabnode_keygen_encode): its handle, a PEM's string, a Buffer, or a JWK. */
  private encodeHalf(handle: KeyObjectHandle, which: number): unknown {
    const exports = glue();
    const key = handle.opensslKey();
    return withScratch(4, (kindAt) => {
      const bytes = answer((lengthAt) => exports.tabnode_keygen_encode(this.job, key, which, lengthAt, kindAt));
      switch (word(kindAt)) {
        case 0: return handle;
        case 1: return new TextDecoder().decode(bytes);
        case 2: return toBuffer(bytes);
        default: return setFields({}, bytes);
      }
    });
  }
}

/** The public exponent as WebCrypto's BigInteger (its big-endian bytes). */
function exponentBytes(exponent: number): Uint8Array {
  const bytes: number[] = [];
  for (let value = exponent >>> 0; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return new Uint8Array(bytes);
}

/** RsaKeyPairGenJob (RsaKeyGenTraits, crypto_rsa.cc:41-187): (mode, variant, bits, exponent, [PSS's], encodings…). */
export class RsaKeyPairGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) {
    const [variant, bits, exponent] = args as [number, number, number];
    const device = variant !== kKeyVariantRSA_PSS && (exponent === 3 || exponent === 65537)
      && bits % 8 === 0 && bits >= 256 && bits <= 16384;
    super(mode, KIND.rsa, true, args, device ? {
      algorithm: { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: exponentBytes(exponent), hash: 'SHA-256' },
      usages: ['sign', 'verify'], pair: true, importedAs: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    } : undefined);
  }
}

/** DsaKeyPairGenJob (DsaKeyGenTraits, crypto_dsa.cc:30-75): OpenSSL's. */
export class DsaKeyPairGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, KIND.dsa, true, args, undefined); }
}

/** EcKeyPairGenJob (EcKeyGenTraits, crypto_ec.cc:418-491): (mode, curve, param encoding, encodings…). */
export class EcKeyPairGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) {
    const namedCurve = typeof args[0] === 'string' ? DEVICE_CURVES[args[0]] : undefined;
    const named = args[1] === undefined || args[1] === null || args[1] === opensslBindingValues().OPENSSL_EC_NAMED_CURVE;
    super(mode, KIND.ec, true, args, namedCurve && named
      ? { algorithm: { name: 'ECDSA', namedCurve }, usages: ['sign', 'verify'], pair: true } : undefined);
  }
}

/** DhKeyPairGenJob (DhKeyGenTraits, crypto_dh.cc:388-480): OpenSSL's. */
export class DhKeyPairGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) { super(mode, KIND.dh, true, args, undefined); }
}

/** NidKeyPairGenJob (NidKeyPairGenTraits, crypto_keygen.cc:31-49): (mode, id, encodings…). */
export class NidKeyPairGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) {
    const values = opensslBindingValues();
    const generation: DeviceGeneration | undefined = args[0] === values.EVP_PKEY_ED25519
      ? { algorithm: { name: 'Ed25519' }, usages: ['sign', 'verify'], pair: true }
      : args[0] === values.EVP_PKEY_X25519 ? { algorithm: { name: 'X25519' }, usages: ['deriveBits'], pair: true }
        : undefined;
    super(mode, KIND.nid, true, args, generation);
  }
}

/** SecretKeyGenJob (SecretKeyGenTraits, crypto_keygen.cc:51-89): (mode, length in bits). */
export class SecretKeyGenJob extends KeyGenJob {
  constructor(mode: number, ...args: unknown[]) {
    const bits = Number(args[0]) >>> 0;
    super(mode, KIND.secret, false, args, bits > 0 && bits % 8 === 0
      ? { algorithm: { name: 'HMAC', hash: 'SHA-256', length: bits }, usages: ['sign', 'verify'], pair: false } : undefined);
  }
}

/** The key generation part of `internalBinding('crypto')` (Keygen::Initialize and the algorithms' initializers). */
export const keygenBinding = {
  RsaKeyPairGenJob, DsaKeyPairGenJob, EcKeyPairGenJob, DhKeyPairGenJob, NidKeyPairGenJob, SecretKeyGenJob,
  kKeyVariantRSA_SSA_PKCS1_v1_5, kKeyVariantRSA_PSS, kKeyVariantRSA_OAEP,
};
