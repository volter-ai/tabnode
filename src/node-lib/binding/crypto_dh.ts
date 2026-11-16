/**
 * KEY AGREEMENT OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_dh.cc`
 * (DiffieHellman, DiffieHellmanGroup, DHBitsJob) and `src/crypto/crypto_ec.cc` (ECDH, ECDHConvertKey, getCurves), over
 * their OpenSSL half (native/node/crypto_dh.cc, crypto_ec.cc) and the engine device.
 *
 * Routing (ADR-0018 §5): an agreement WebCrypto defines is the device's `deriveBits`: ECDH on P-256, P-384 or P-521
 * (an ECDH object's `computeSecret`, and DHBitsJob's: `crypto.diffieHellman` and WebCrypto's ECDH) and X25519
 * (DHBitsJob's), each over the keys' device CryptoKeys (crypto_keys.ts), after the checks Node's C++ makes first
 * (the key pair's validity, the peer's point), which are OpenSSL's. A peer's point reaches the device uncompressed,
 * as OpenSSL converts it. Diffie-Hellman groups and primes, ECDH on every other curve, and X448 are OpenSSL's.
 */
import { Buffer } from '../buffer-module';
import { address } from './libnode';
import { withBytes } from './openssl';
import { engineCallAsync, engineCallSync, type EngineKey } from './engine_device';
import { answer, bufferSource, checked, CryptoJob, glue, rethrow, toArrayBuffer, toBuffer, Values } from './crypto_util';
import { handleFromKeyData, kKeyTypePrivate, kKeyTypePublic, KeyObjectHandle, opensslBindingValues } from './crypto_keys';

const dhs = new FinalizationRegistry<number>((dh) => glue().tabnode_dh_free(dh));
const ecdhs = new FinalizationRegistry<number>((ecdh) => glue().tabnode_ecdh_free(ecdh));

/** POINT_CONVERSION_UNCOMPRESSED (openssl/ec.h). */
const POINT_CONVERSION_UNCOMPRESSED = 4;

/** The device's ECDH of a curve: its WebCrypto name and the secret's length in bits (the field's whole bytes). */
function deviceCurve(nid: number): { namedCurve: string; bits: number } | undefined {
  const values = opensslBindingValues();
  if (nid === values.NID_X9_62_prime256v1) return { namedCurve: 'P-256', bits: 256 };
  if (nid === values.NID_secp384r1) return { namedCurve: 'P-384', bits: 384 };
  if (nid === values.NID_secp521r1) return { namedCurve: 'P-521', bits: 528 };
  return undefined;
}

/** DiffieHellman (crypto_dh.cc:41-385), made by `New` or by `DiffieHellmanGroup`: OpenSSL's. */
class DiffieHellmanBase {
  protected dh = 0;

  protected made(dh: number): void {
    rethrow();
    this.dh = address(dh);
    dhs.register(this, this.dh, this);
  }

  /** GenerateKeys (226-240). */
  generateKeys(): Buffer { return toBuffer(answer((lengthAt) => glue().tabnode_dh_generate_keys(this.dh, lengthAt))); }

  /** ComputeSecret (302-339). */
  computeSecret(key: unknown): Buffer {
    const exports = glue();
    return toBuffer(answer((lengthAt) => withBytes(bufferSource(key), (at, length) =>
      exports.tabnode_dh_compute_secret(this.dh, at, length, lengthAt))));
  }

  /** GetPrime, GetGenerator, GetPublicKey, GetPrivateKey (242-300). */
  getPrime(): Buffer { return this.get(0); }
  getGenerator(): Buffer { return this.get(1); }
  getPublicKey(): Buffer { return this.get(2); }
  getPrivateKey(): Buffer { return this.get(3); }
  private get(which: number): Buffer {
    return toBuffer(answer((lengthAt) => glue().tabnode_dh_get(this.dh, which, lengthAt)));
  }

  /** SetPublicKey, SetPrivateKey (341-371). */
  setPublicKey(key: unknown): void { this.set(0, key); }
  setPrivateKey(key: unknown): void { this.set(1, key); }
  private set(which: number, key: unknown): void {
    const exports = glue();
    checked(withBytes(bufferSource(key), (at, length) => exports.tabnode_dh_set_key(this.dh, which, at, length)));
  }

  /** The `verifyError` accessor, Check (373-385). */
  get verifyError(): number { return checked(glue().tabnode_dh_check(this.dh)); }
}

/** New (129-224). */
export class DiffieHellman extends DiffieHellmanBase {
  constructor(...args: unknown[]) {
    super();
    const exports = glue();
    this.made(new Values(args).call((at, length) => exports.tabnode_dh_new(at, length)));
  }
}

/** DiffieHellmanGroup (114-127). */
export class DiffieHellmanGroup extends DiffieHellmanBase {
  constructor(...args: unknown[]) {
    super();
    if (args.length !== 1) throw new Error('crypto: DiffieHellmanGroup takes one argument');
    if (typeof args[0] !== 'string') throw Object.assign(new TypeError('Group name must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
    const name = args[0];
    this.made(withBytes(name, (at) => glue().tabnode_dh_group_new(at)));
  }
}

/** ECDH (crypto_ec.cc:41-382). */
export class ECDH {
  private readonly ecdh: number;
  /** The key as the device's CryptoKey of it, for the curve's ECDH; cleared when the key changes. */
  private deviceKey: EngineKey | undefined;

  /** ECDH::New (98-117). */
  constructor(curve: unknown) {
    if (typeof curve !== 'string') throw new Error('crypto: ECDH of a curve name');
    const made = withBytes(curve, (at) => glue().tabnode_ecdh_new(at));
    rethrow();
    this.ecdh = address(made);
    ecdhs.register(this, this.ecdh, this);
  }

  /** ECDH::GenerateKeys (119-132). */
  generateKeys(): void {
    checked(glue().tabnode_ecdh_generate_keys(this.ecdh));
    this.deviceKey = undefined;
  }

  /**
   * ECDH::ComputeSecret (161-201): Node's checks, then the derivation, the device's on a curve it holds. Answers
   * Node's string where the peer's bytes are no point.
   */
  computeSecret(key: unknown): Buffer | string {
    const exports = glue();
    const peer = bufferSource(key);
    const checkedPeer = checked(withBytes(peer, (at, length) => exports.tabnode_ecdh_check_secret(this.ecdh, at, length)));
    if (checkedPeer === 2) return 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY';
    const curve = deviceCurve(exports.tabnode_ecdh_curve(this.ecdh));
    if (curve) {
      const algorithm = { name: 'ECDH', namedCurve: curve.namedCurve };
      this.deviceKey ??= handleFromKeyData(address(exports.tabnode_ecdh_key_data(this.ecdh)))
        .deviceKey(algorithm, ['deriveBits'], true);
      const point = ECDHConvertKey(peer, curve.namedCurve === 'P-256' ? 'prime256v1'
        : curve.namedCurve === 'P-384' ? 'secp384r1' : 'secp521r1', POINT_CONVERSION_UNCOMPRESSED) as Buffer;
      const publicKey = engineCallSync('importKey', ['raw', new Uint8Array(point), algorithm, true, []]) as EngineKey;
      return toBuffer(new Uint8Array(engineCallSync('deriveBits', [{ name: 'ECDH', public: publicKey }, this.deviceKey,
        curve.bits]) as ArrayBuffer));
    }
    return toBuffer(answer((lengthAt) => withBytes(peer, (at, length) =>
      exports.tabnode_ecdh_compute_secret(this.ecdh, at, length, lengthAt))));
  }

  /** ECDH::GetPublicKey (203-228). */
  getPublicKey(form: unknown): Buffer {
    if (arguments.length !== 1) throw new Error('crypto: getPublicKey takes the conversion form');
    return toBuffer(answer((lengthAt) => glue().tabnode_ecdh_get_public_key(this.ecdh, Number(form) >>> 0, lengthAt)));
  }

  /** ECDH::GetPrivateKey (230-254). */
  getPrivateKey(): Buffer { return toBuffer(answer((lengthAt) => glue().tabnode_ecdh_get_private_key(this.ecdh, lengthAt))); }

  /** ECDH::SetPrivateKey (256-312). */
  setPrivateKey(key: unknown): void {
    const exports = glue();
    checked(withBytes(bufferSource(key), (at, length) => exports.tabnode_ecdh_set_private_key(this.ecdh, at, length)));
    this.deviceKey = undefined;
  }

  /** ECDH::SetPublicKey (314-336). */
  setPublicKey(key: unknown): void {
    const exports = glue();
    checked(withBytes(bufferSource(key), (at, length) => exports.tabnode_ecdh_set_public_key(this.ecdh, at, length)));
    this.deviceKey = undefined;
  }
}

/** ECDH::ConvertKey (384-416): an empty key is an empty string. */
export function ECDHConvertKey(key: unknown, curve: unknown, form: unknown): Buffer | string {
  if (arguments.length !== 3) throw new Error('crypto: ECDHConvertKey takes three arguments');
  const bytes = bufferSource(key);
  if (bytes.byteLength === 0) return '';
  const exports = glue();
  return toBuffer(answer((lengthAt) => withBytes(bytes, (at, length) => withBytes(String(curve), (curveAt) =>
    exports.tabnode_ecdh_convert_key(at, length, curveAt, Number(form) >>> 0, lengthAt)))));
}

/** ECDH::GetCurves (77-86). */
function getCurves(): string[] {
  const text = new TextDecoder().decode(answer((lengthAt) => glue().tabnode_curve_list(lengthAt)));
  return text ? text.slice(0, -1).split('\0') : [];
}

/** DHBitsJob (DHBitsTraits, crypto_dh.cc:510-556): (mode, the public key's slots, the private key's slots). */
export class DHBitsJob extends CryptoJob {
  constructor(mode: number, ...args: unknown[]) {
    super(mode);
    const exports = glue();
    this.adopt(new Values(args).call((at, length) => exports.tabnode_dh_bits_job_new(mode, at, length)));
  }

  /** A synchronous job's failure is thrown ("diffieHellman failed", DHBitsTraits::DeriveBits). */
  run(): unknown {
    const result = super.run();
    rethrow();
    return result;
  }

  protected device() {
    const exports = glue();
    const values = opensslBindingValues();
    const privateHandle = handleFromKeyData(address(exports.tabnode_dh_bits_job_key(this.job, 1)));
    const publicHandle = handleFromKeyData(address(exports.tabnode_dh_bits_job_key(this.job, 0)));
    const privateKey = privateHandle.opensslKey(), publicKey = publicHandle.opensslKey();
    const id = exports.tabnode_key_id(privateKey);
    if (id !== exports.tabnode_key_id(publicKey)) return undefined;
    let algorithm: Record<string, unknown>, bits: number;
    if (id === values.EVP_PKEY_X25519) {
      algorithm = { name: 'X25519' };
      bits = 256;
    } else {
      if (id !== values.EVP_PKEY_EC) return undefined;
      const nid = exports.tabnode_key_curve(privateKey);
      const curve = nid === exports.tabnode_key_curve(publicKey) ? deviceCurve(nid) : undefined;
      if (!curve) return undefined;
      algorithm = { name: 'ECDH', namedCurve: curve.namedCurve };
      bits = curve.bits;
    }
    const peerOf = (handle: KeyObjectHandle) => (handle.getKeyType() === kKeyTypePublic ? handle : publicOf(handle));
    return {
      call: (sync: boolean) => {
        if (sync) {
          const ours = privateHandle.deviceKey(algorithm, ['deriveBits'], true);
          const theirs = peerOf(publicHandle).deviceKey(algorithm, [], true);
          return engineCallSync('deriveBits', [{ ...algorithm, public: theirs }, ours, bits]);
        }
        return Promise.all([privateHandle.deviceKey(algorithm, ['deriveBits'], false),
          peerOf(publicHandle).deviceKey(algorithm, [], false)])
          .then(([ours, theirs]) => engineCallAsync('deriveBits', [{ ...algorithm, public: theirs }, ours, bits]));
      },
      result: (value: unknown) => value as ArrayBuffer,
    };
  }

  /** DHBitsTraits::EncodeOutput (528-533). */
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** A private key's public half, as a handle of its own (a private key given as the peer agrees with its public key). */
function publicOf(handle: KeyObjectHandle): KeyObjectHandle {
  if (handle.getKeyType() !== kKeyTypePrivate) return handle;
  const publicHandle = new KeyObjectHandle();
  publicHandle.init(kKeyTypePublic, handle, undefined, undefined, undefined, undefined);
  return publicHandle;
}

export const dhBinding = { DiffieHellman, DiffieHellmanGroup, ECDH, ECDHConvertKey, getCurves, DHBitsJob };
