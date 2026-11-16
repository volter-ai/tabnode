/**
 * THE KEYS OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_keys.cc`,
 * KeyObjectHandle, NativeKeyObject and NativeCryptoKey, over the glue's OpenSSL half (native/node/crypto_keys.cc).
 *
 * A key is held where it is answered (ADR-0018 §5): its KeyObjectData in the process's OpenSSL (a `KeyObjectData*`
 * of the glue's, one reference a handle), or its CryptoKey in the engine device's session (an `EngineKey`, the
 * handle the device answered), or both. A key the device made (a WebCrypto key generation, a derivation) is the
 * device's; the first call OpenSSL answers on it (an export to PEM, its details, a JWK) takes OpenSSL's copy, the
 * device's export of it (`exportKey` in PKCS#8, SPKI or raw form); a key OpenSSL holds is imported into the device
 * the first time a device call needs it (`importKey`), once for each algorithm it is used with. A key whose material
 * the device will not export (a non-extractable CryptoKey) has no OpenSSL copy, and a call OpenSSL answers on it is
 * refused by the device's error.
 */
import { Buffer } from '../buffer-module';
import { address } from './program';
import { cString } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import { answer, checked, cppError, glue, rethrow, setFields, setKeyDataReader, toBuffer, Values } from './crypto_util';
import { withScratch, word } from './openssl';

/** KeyType (crypto_keys.h:34-38). */
export const kKeyTypeSecret = 0, kKeyTypePublic = 1, kKeyTypePrivate = 2;
/** PKFormatType (ncrypto.h EVPKeyPointer), KeyObjectHandle's formats. */
export const kKeyFormatDER = 0, kKeyFormatPEM = 1, kKeyFormatJWK = 2, kKeyFormatRawPublic = 3,
  kKeyFormatRawPrivate = 4, kKeyFormatRawSeed = 5, kKeyFormatStore = 6;
/** PKEncodingType. */
export const kKeyEncodingPKCS1 = 0, kKeyEncodingPKCS8 = 1, kKeyEncodingSPKI = 2, kKeyEncodingSEC1 = 3;

interface HandleData {
  /** The glue's KeyObjectData*, 0 where OpenSSL holds no copy yet. */
  openssl: number;
  /** The key's type, known from either side. */
  type: number;
  /** The device's CryptoKey of it, by the algorithm it was imported or made for. */
  device: Map<string, EngineKey>;
}

const dataOf = new WeakMap<object, HandleData>();
/** A handle's OpenSSL reference, released when the handle is collected (Node's BaseObject drops its data_). */
const released = new FinalizationRegistry<number>((key) => glue().tabnode_key_free(key));

function newData(openssl: number, type: number): HandleData {
  return { openssl, type, device: new Map() };
}

function own(handle: object, data: HandleData): void {
  dataOf.set(handle, data);
  if (data.openssl) released.register(handle, data.openssl);
}

/** The WebCrypto import form of a key of `type`. */
const importForm = (type: number) => (type === kKeyTypeSecret ? 'raw' : type === kKeyTypePublic ? 'spki' : 'pkcs8');

/** The OpenSSL KeyObjectData* of a handle's data, taken from the device's export where OpenSSL has none. */
function opensslOf(data: HandleData): number {
  if (data.openssl) return data.openssl;
  const key = data.device.values().next().value as EngineKey | undefined;
  if (!key) throw cppError('ERR_CRYPTO_INVALID_STATE');
  const exported = new Uint8Array(engineCallSync('exportKey', [importForm(data.type), key]) as ArrayBuffer);
  const args = data.type === kKeyTypeSecret ? [kKeyTypeSecret, exported]
    : [data.type, exported, kKeyFormatDER, data.type === kKeyTypePublic ? kKeyEncodingSPKI : kKeyEncodingPKCS8,
      undefined, undefined];
  data.openssl = initKey(args).key;
  return data.openssl;
}

/** KeyObjectHandle::Init through the glue: the new data's address and what Init answers. */
function initKey(args: readonly unknown[]): { key: number; returned: number } {
  const exports = glue();
  return withScratch(4, (returnedAt) => {
    const key = new Values(args).call((at, length) => address(exports.tabnode_key_init(at, length, returnedAt)));
    rethrow();
    return { key, returned: word(returnedAt) | 0 };
  });
}

/** KeyObjectHandle (crypto_keys.cc:1132-1690). */
export class KeyObjectHandle {
  /** KeyObjectHandle::Create (1189-1202): a handle of the same data. */
  static fromData(data: HandleData): KeyObjectHandle {
    const handle = new KeyObjectHandle();
    const copy = newData(data.openssl ? address(glue().tabnode_key_ref(data.openssl)) : 0, data.type);
    for (const [algorithm, key] of data.device) copy.device.set(algorithm, key);
    own(handle, copy);
    return handle;
  }

  /** A handle of a key the engine device holds (a WebCrypto key generation's, a derivation's). */
  static fromDevice(key: EngineKey, algorithm: string): KeyObjectHandle {
    const handle = new KeyObjectHandle();
    const type = key.type === 'secret' ? kKeyTypeSecret : key.type === 'public' ? kKeyTypePublic : kKeyTypePrivate;
    const data = newData(0, type);
    data.device.set(algorithm, key);
    own(handle, data);
    return handle;
  }

  private data(): HandleData {
    const data = dataOf.get(this);
    if (!data) throw cppError('ERR_CRYPTO_INVALID_STATE');
    return data;
  }

  /** The glue's KeyObjectData* of this handle (OpenSSL's copy). */
  opensslKey(): number { return opensslOf(this.data()); }

  /**
   * The engine device's CryptoKey of this key for `algorithm` (a WebCrypto algorithm object, its name the cache's
   * key), imported from OpenSSL's copy the first time (`importKey`, extractable, with `usages`).
   */
  deviceKey(algorithm: Record<string, unknown>, usages: string[], sync: true): EngineKey;
  deviceKey(algorithm: Record<string, unknown>, usages: string[], sync: false): Promise<EngineKey>;
  deviceKey(algorithm: Record<string, unknown>, usages: string[], sync: boolean): EngineKey | Promise<EngineKey> {
    const data = this.data();
    const name = JSON.stringify(algorithm);
    const held = data.device.get(name);
    if (held) return sync ? held : Promise.resolve(held);
    const form = importForm(data.type);
    const material = this.exportForDevice(form);
    const keep = (key: EngineKey) => { data.device.set(name, key); return key; };
    const args = [form, material, algorithm, true, usages];
    return sync ? keep(engineCallSync('importKey', args) as EngineKey)
      : (engineCallAsync('importKey', args) as Promise<EngineKey>).then(keep);
  }

  /** The key's bytes in WebCrypto's `form` (raw, SPKI or PKCS#8 DER), from OpenSSL's copy. */
  private exportForDevice(form: string): Uint8Array {
    if (form === 'raw') return new Uint8Array(this.export() as Buffer);
    return new Uint8Array(this.export(kKeyFormatDER, form === 'spki' ? kKeyEncodingSPKI : kKeyEncodingPKCS8,
      ...(form === 'pkcs8' ? [undefined, undefined] : [])) as Buffer);
  }

  /** Init (1220-1303). */
  init(...args: unknown[]): unknown {
    const { key, returned } = initKey(args);
    const previous = dataOf.get(this);
    if (previous?.openssl) { released.unregister(this); glue().tabnode_key_free(previous.openssl); }
    own(this, newData(key, glue().tabnode_key_type(key)));
    return returned >= 0 ? returned : undefined;
  }

  /** GetKeyType (1305-1311). */
  getKeyType(): number { return this.data().type; }

  /** GetSymmetricKeySize (1438-1444). */
  getSymmetricKeySize(): number { return glue().tabnode_key_symmetric_size(this.opensslKey()) >>> 0; }

  /** GetAsymmetricKeyType (1381-1417): the type's name, or undefined. */
  getAsymmetricKeyType(): string | undefined {
    const at = address(glue().tabnode_key_asymmetric_type(this.opensslKey()));
    return at ? cString(at) ?? undefined : undefined;
  }

  /** CheckEcKeyData (1419-1436). */
  checkEcKeyData(): boolean { return glue().tabnode_key_check_ec(this.opensslKey()) !== 0; }

  /** Export (1446-1486): a PEM's string, else a Buffer. */
  export(...args: unknown[]): Buffer | string {
    const key = this.opensslKey();
    const exports = glue();
    return withScratch(4, (textAt) => {
      const bytes = answer((lengthAt) => new Values(args).call((at, length) =>
        exports.tabnode_key_export(key, at, length, lengthAt, textAt)));
      return word(textAt) ? new TextDecoder().decode(bytes) : toBuffer(bytes);
    });
  }

  /** ExportJWK (1676-1690): the JWK's members on `target`. */
  exportJwk(target: Record<string, unknown>, handleRsaPss: boolean): Record<string, unknown> {
    const key = this.opensslKey();
    return setFields(target, answer((lengthAt) => glue().tabnode_key_export_jwk(key, handleRsaPss ? 1 : 0, lengthAt)));
  }

  /** RawPublicKey, RawPrivateKey, RawSeed (1504-1568, 1647-1674). */
  rawPublicKey(): Buffer { const key = this.opensslKey(); return toBuffer(answer((at) => glue().tabnode_key_raw_public(key, at))); }
  rawPrivateKey(): Buffer { const key = this.opensslKey(); return toBuffer(answer((at) => glue().tabnode_key_raw_private(key, at))); }
  rawSeed(): Buffer { const key = this.opensslKey(); return toBuffer(answer((at) => glue().tabnode_key_raw_seed(key, at))); }

  /** ExportECPublicRaw (1570-1604), ExportECPrivateRaw (1606-1645). */
  exportECPublicRaw(form: number): Buffer {
    const key = this.opensslKey();
    return toBuffer(answer((at) => glue().tabnode_key_ec_public_raw(key, form, at)));
  }
  exportECPrivateRaw(): Buffer {
    const key = this.opensslKey();
    return toBuffer(answer((at) => glue().tabnode_key_ec_private_raw(key, at)));
  }

  /** GetKeyDetail (1360-1379): the details on `target`. */
  keyDetail(target: Record<string, unknown>): Record<string, unknown> {
    const key = this.opensslKey();
    return setFields(target, answer((at) => glue().tabnode_key_detail(key, at)));
  }

  /** Equals (1313-1358). */
  equals(other: KeyObjectHandle): boolean {
    return checked(glue().tabnode_key_equals(this.opensslKey(), other.opensslKey())) === 1;
  }
}

/** Is `value` a KeyObjectHandle (KeyObjectHandle::HasInstance). */
export function isKeyObjectHandle(value: unknown): value is KeyObjectHandle {
  return typeof value === 'object' && value !== null && dataOf.has(value);
}

/** The TnValue of a KeyObjectHandle argument is its OpenSSL data (crypto_util.ts `Values`). */
setKeyDataReader((value) => (isKeyObjectHandle(value) ? value.opensslKey() : undefined));

/** A handle's data, for the jobs that read a key (`KeyObjectHandle* key; ASSIGN_OR_RETURN_UNWRAP`). */
export function handleOf(value: unknown): KeyObjectHandle {
  if (!isKeyObjectHandle(value)) throw new TypeError('Invalid key object handle');
  return value;
}

/** A handle of the data a job made (tabnode_job_key): KeyObjectHandle::Create. */
export function handleFromKeyData(key: number): KeyObjectHandle {
  const handle = new KeyObjectHandle();
  own(handle, newData(key, glue().tabnode_key_type(key)));
  return handle;
}

// ---- NativeKeyObject (1692-1834) -------------------------------------------------------------------------------

const keyObjectData = new WeakMap<object, KeyObjectHandle>();
let nativeKeyObjectClass: (new (handle: KeyObjectHandle) => object) | undefined;

/** CreateNativeKeyObjectClass (1722-1760): NativeKeyObject, given to `callback`, whose answer is answered. */
function createNativeKeyObjectClass(callback: (base: unknown) => unknown): unknown {
  if (nativeKeyObjectClass) throw new Error('crypto: the NativeKeyObject class is made once');
  class NativeKeyObject {
    /** NativeKeyObject::New (1713-1720): the handle's data, its own reference. */
    constructor(handle: unknown) {
      if (arguments.length !== 1 || !isKeyObjectHandle(handle)) throw new Error('crypto: NativeKeyObject of a handle');
      keyObjectData.set(this, handle);
    }
  }
  nativeKeyObjectClass = NativeKeyObject;
  return callback(NativeKeyObject);
}

/** GetSlots (1762-1784): the key's type and a new handle of its data. */
function getKeyObjectSlots(value: unknown): [number, KeyObjectHandle] {
  const handle = typeof value === 'object' && value !== null ? keyObjectData.get(value) : undefined;
  if (!handle) throw cppError('ERR_INVALID_THIS', 'Value of "this" must be of type KeyObject');
  const data = dataOf.get(handle)!;
  return [data.type, KeyObjectHandle.fromData(data)];
}

// ---- NativeCryptoKey (1862-2153) -------------------------------------------------------------------------------

interface CryptoKeySlots { handle: KeyObjectHandle; algorithm: unknown; usages: number; extractable: boolean }
const cryptoKeySlots = new WeakMap<object, CryptoKeySlots>();
let internalCryptoKey: (new (...args: unknown[]) => object) | undefined;

/** CreateCryptoKeyClass (1955-1992): NativeCryptoKey, given to `callback`; its answer's [1] is the internal class. */
function createCryptoKeyClass(callback: (base: unknown) => unknown): unknown {
  if (internalCryptoKey) throw new Error('crypto: the NativeCryptoKey class is made once');
  class NativeCryptoKey {
    /** NativeCryptoKey::New (1923-1953). */
    constructor(handle: unknown, algorithm: unknown, usagesMask: unknown, extractable: unknown) {
      if (arguments.length !== 4 || !isKeyObjectHandle(handle)) throw new Error('crypto: NativeCryptoKey of a handle');
      cryptoKeySlots.set(this, {
        handle, algorithm, usages: algorithm === undefined ? 0 : Number(usagesMask) >>> 0,
        extractable: algorithm === undefined ? false : extractable === true,
      });
    }
  }
  const answered = callback(NativeCryptoKey) as unknown[];
  internalCryptoKey = answered[1] as new (...args: unknown[]) => object;
  return answered;
}

/** GetSlots (1994-2021): type, extractable, algorithm, usages and a new handle of the key's data. */
function getCryptoKeySlots(value: unknown): [number, boolean, unknown, number, KeyObjectHandle] {
  const slots = typeof value === 'object' && value !== null ? cryptoKeySlots.get(value) : undefined;
  if (!slots) throw cppError('ERR_INVALID_THIS', 'Value of "this" must be of type CryptoKey');
  const data = dataOf.get(slots.handle)!;
  return [data.type, slots.extractable, slots.algorithm, slots.usages, KeyObjectHandle.fromData(data)];
}

/** NativeCryptoKey::Create (1891-1921): a CryptoKey of a handle, through `internal/crypto/keys`' internal class. */
export function createCryptoKey(handle: KeyObjectHandle, algorithm: unknown, usagesMask: number,
  extractable: boolean): object {
  if (!internalCryptoKey) throw new Error('crypto: internal/crypto/keys has not made its CryptoKey class');
  return new internalCryptoKey(handle, algorithm, usagesMask, extractable);
}

/** The keys' part of `internalBinding('crypto')` (Keys::Initialize, crypto_keys.cc:2155-2240). */
export const keysBinding = {
  KeyObjectHandle,
  createNativeKeyObjectClass,
  getKeyObjectSlots,
  createCryptoKeyClass,
  getCryptoKeySlots,
  kKeyTypeSecret, kKeyTypePublic, kKeyTypePrivate,
  kKeyFormatDER, kKeyFormatPEM, kKeyFormatJWK, kKeyFormatRawPublic, kKeyFormatRawPrivate, kKeyFormatRawSeed,
  kKeyFormatStore,
  kKeyEncodingPKCS1, kKeyEncodingPKCS8, kKeyEncodingSPKI, kKeyEncodingSEC1,
  // kSigEncDER, kSigEncP1363 (crypto_sig.h DSASigEnc).
  kSigEncDER: 0, kSigEncP1363: 1,
  // WebCryptoKeyFormat (crypto_keys.h:40-45).
  kWebCryptoKeyFormatRaw: 0, kWebCryptoKeyFormatPKCS8: 1, kWebCryptoKeyFormatSPKI: 2, kWebCryptoKeyFormatJWK: 3,
};

/**
 * The OpenSSL values the binding defines (NODE_DEFINE_CONSTANT of Keys::Initialize, Sign::Initialize, the keygen
 * and X509Certificate initializers), as the program's OpenSSL defines them, read once from it.
 */
let opensslValues: Record<string, number> | undefined;
export function opensslBindingValues(): Record<string, number> {
  if (opensslValues) return opensslValues;
  const text = new TextDecoder().decode(answer((at) => glue().tabnode_crypto_binding_values(at)));
  const parts = text.split('\0');
  const table: Record<string, number> = {};
  for (let index = 0; index + 1 < parts.length; index += 2) table[parts[index]!] = Number(parts[index + 1]);
  return opensslValues = table;
}

/** `Buffer` as KeyObjectHandle's callers read its answers. */
export type { Buffer };
