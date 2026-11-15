/**
 * THE SIGNATURES OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_sig.cc`
 * (Sign, Verify, SignJob), over its OpenSSL half (native/node/crypto_sig.cc) and the engine device.
 *
 * Routing (ADR-0018 §5): a signature WebCrypto defines is the device's `sign` or `verify`: RSASSA-PKCS1-v1_5 (an RSA
 * key, PKCS#1 padding), RSA-PSS (an RSA key, PSS padding with a salt length given), ECDSA (an EC key on P-256, P-384 or
 * P-521), each over SHA-1, SHA-256, SHA-384 or SHA-512, and Ed25519 with no context string. The key is the device's
 * CryptoKey of it (crypto_keys.ts), an ECDSA signature P1363 as WebCrypto makes it and converted to DER where Node's
 * encoding is DER (ConvertSignatureToDER). Every other signature (DSA, Ed448, ML-DSA, SLH-DSA, an RSA-PSS key, a
 * salt length WebCrypto cannot name, a context string, MD5 and the other digests) is OpenSSL's. A Sign or a Verify
 * learns its key only at its end, so one over a WebCrypto digest keeps its input until then.
 */
import { Buffer } from '../buffer-module';
import { address } from './libnode';
import { withBytes } from './openssl';
import { engineCallAsync, engineCallSync } from './engine_device';
import {
  answer, bufferSource, checked, CryptoJob, decodeInput, glue, rethrow, toArrayBuffer, toBuffer, Values,
  webCryptoDigest,
} from './crypto_util';
import { isKeyObjectHandle, KeyObjectHandle, kKeyTypePrivate, kKeyTypePublic, opensslBindingValues } from './crypto_keys';
import { mallocAnswer } from './openssl';

const signs = new FinalizationRegistry<number>((sign) => glue().tabnode_sign_free(sign));

/** DSASigEnc (crypto_sig.h:16). */
const kSigEncDER = 0;
/** SignConfiguration::Mode. */
const kSignJobModeSign = 0, kSignJobModeVerify = 1;

/** The device's algorithms for a signature: the key's import and the call's, or none where OpenSSL answers it. */
interface DeviceSignature { importAlgorithm: Record<string, unknown>; algorithm: Record<string, unknown>; ecdsa: boolean }

/** The routing of a signature by `handle`'s key (ADR-0018 §5). */
function deviceSignature(handle: KeyObjectHandle, digest: string | undefined, padding: unknown, saltLength: unknown,
  hasContext: boolean): DeviceSignature | undefined {
  if (hasContext) return undefined;
  const values = opensslBindingValues();
  const key = handle.opensslKey();
  const id = glue().tabnode_key_id(key);
  const hash = digest === undefined ? undefined : webCryptoDigest(digest);
  if (id === values.EVP_PKEY_RSA && hash) {
    if (padding === undefined || padding === values.RSA_PKCS1_PADDING) {
      const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash };
      return { importAlgorithm: algorithm, algorithm, ecdsa: false };
    }
    if (padding === values.RSA_PKCS1_PSS_PADDING && typeof saltLength === 'number' && saltLength >= 0) {
      return { importAlgorithm: { name: 'RSA-PSS', hash }, algorithm: { name: 'RSA-PSS', saltLength }, ecdsa: false };
    }
    return undefined;
  }
  if (id === values.EVP_PKEY_EC && hash) {
    const curve = glue().tabnode_key_curve(key);
    const namedCurve = curve === values.NID_X9_62_prime256v1 ? 'P-256' : curve === values.NID_secp384r1 ? 'P-384'
      : curve === values.NID_secp521r1 ? 'P-521' : undefined;
    if (!namedCurve) return undefined;
    return { importAlgorithm: { name: 'ECDSA', namedCurve }, algorithm: { name: 'ECDSA', hash }, ecdsa: true };
  }
  if (id === values.EVP_PKEY_ED25519 && (digest === undefined || digest === null)) {
    return { importAlgorithm: { name: 'Ed25519' }, algorithm: { name: 'Ed25519' }, ecdsa: false };
  }
  return undefined;
}

/** The handle of the key the five slots at `slots` name, parsed as Node's C++ parses them (private or either). */
function slotHandle(slots: readonly unknown[], privateKey: boolean): KeyObjectHandle {
  if (isKeyObjectHandle(slots[0])) return slots[0];
  const handle = new KeyObjectHandle();
  handle.init(privateKey ? kKeyTypePrivate : kKeyTypePublic, ...slots.slice(0, 5));
  return handle;
}

/** The public handle of a key a verification is given (a private key verifies with its public half). */
function publicHandle(handle: KeyObjectHandle): KeyObjectHandle {
  if (handle.getKeyType() === kKeyTypePublic) return handle;
  const publicHandleOf = new KeyObjectHandle();
  publicHandleOf.init(kKeyTypePublic, handle, undefined, undefined, undefined, undefined);
  return publicHandleOf;
}

/** The device's signature in Node's encoding (an ECDSA one P1363 as WebCrypto's, else DER). */
function fromDevice(signature: ArrayBuffer, handle: KeyObjectHandle, route: DeviceSignature, encoding: unknown): Uint8Array {
  const bytes = new Uint8Array(signature);
  if (!route.ecdsa || encoding !== kSigEncDER && encoding !== undefined) return bytes;
  const key = handle.opensslKey();
  return answer((lengthAt) => withBytes(bytes, (at, length) => glue().tabnode_sig_to_der(key, at, length, lengthAt)));
}

/** A signature in Node's encoding as the device verifies it (P1363 for ECDSA); null where it is malformed. */
function toDevice(signature: Uint8Array, handle: KeyObjectHandle, route: DeviceSignature, encoding: unknown): Uint8Array | null {
  if (!route.ecdsa || encoding !== kSigEncDER && encoding !== undefined) return signature;
  const key = handle.opensslKey();
  return mallocAnswer((lengthAt) => withBytes(signature, (at, length) => glue().tabnode_sig_to_p1363(key, at, length, lengthAt)));
}

/** SignBase (crypto_sig.cc:507-542): Sign and Verify, their input kept while a device may answer it. */
class SignBase {
  protected context = address(glue().tabnode_sign_new());
  protected digest: string | undefined;
  protected kept: Uint8Array[] | null = null;
  constructor() { signs.register(this, this.context); }

  /** SignInit, VerifyInit (588-595, 698-705). */
  init(digest: string): void {
    const name = String(digest);
    checked(withBytes(name, (at) => glue().tabnode_sign_init(this.context, at)));
    this.digest = name;
    if (webCryptoDigest(name)) this.kept = [];
  }

  /** SignUpdate, VerifyUpdate (597-606, 707-718). */
  update(data: unknown, encoding?: unknown): void {
    const bytes = decodeInput(data, encoding);
    if (this.kept) { this.kept.push(bytes.slice()); return; }
    this.feed(bytes);
  }

  protected feed(bytes: Uint8Array): void {
    checked(withBytes(bytes, (at, length) => glue().tabnode_sign_update(this.context, at, length)));
  }

  /** The kept input, now OpenSSL's, for an end OpenSSL answers. */
  protected release(): void {
    const kept = this.kept;
    this.kept = null;
    for (const chunk of kept ?? []) this.feed(chunk);
  }

  protected input(): Buffer {
    const kept = this.kept ?? [];
    this.kept = null;
    return Buffer.concat(kept);
  }
}

/** Sign (crypto_sig.cc:544-669). */
export class Sign extends SignBase {
  /** SignFinal (632-669): the key's five slots, padding, salt length, DSA encoding. */
  sign(...args: unknown[]): Buffer {
    if (this.kept) {
      const handle = slotHandle(args, true);
      const route = deviceSignature(handle, this.digest, args[5], args[6], false);
      if (route) {
        const key = handle.deviceKey(route.importAlgorithm, ['sign'], true);
        const signature = engineCallSync('sign', [route.algorithm, key, this.input()]) as ArrayBuffer;
        return toBuffer(fromDevice(signature, handle, route, args[7]));
      }
      this.release();
    }
    const sign = this.context;
    return toBuffer(answer((lengthAt) => new Values(args).call((at, length) =>
      glue().tabnode_sign_final(sign, at, length, lengthAt))));
  }
}

/** Verify (crypto_sig.cc:671-796). */
export class Verify extends SignBase {
  /** VerifyFinal (749-796): the key's five slots, signature, padding, salt length, DSA encoding. */
  verify(...args: unknown[]): boolean {
    if (this.kept) {
      const handle = slotHandle(args, false);
      const route = deviceSignature(handle, this.digest, args[6], args[7], false);
      if (route) {
        const signature = toDevice(bufferSource(args[5]), handle, route, args[8]);
        if (signature === null) return false;
        const key = publicHandle(handle).deviceKey(route.importAlgorithm, ['verify'], true);
        return engineCallSync('verify', [route.algorithm, key, signature, this.input()]) === true;
      }
      this.release();
    }
    const sign = this.context;
    return checked(new Values(args).call((at, length) => glue().tabnode_verify_final(sign, at, length))) === 1;
  }
}

/** SignJob (SignTraits, 798-1062): a WebCrypto signature is the device's `sign` or `verify`. */
export class SignJob extends CryptoJob {
  private readonly args: unknown[];
  constructor(mode: number, ...args: unknown[]) {
    super(mode);
    this.args = args;
    this.adopt(new Values(args).call((at, length) => glue().tabnode_sign_job_new(mode, at, length)));
  }

  /** SignJob's synchronous failure is thrown (SignTraits::DeriveBits's CheckThrow), its result else. */
  run(): unknown {
    const result = super.run();
    rethrow();
    return result;
  }

  protected device() {
    const args = this.args;
    const signing = args[0] === kSignJobModeSign;
    const slots = args.slice(1, 6);
    const digest = typeof args[7] === 'string' ? args[7] : undefined;
    const handle = slotHandle(slots, signing);
    const route = deviceSignature(handle, digest, args[9], args[8], args[11] !== undefined
      && bufferSource(args[11]).byteLength > 0);
    if (!route) return undefined;
    const data = bufferSource(args[6]);
    const keyHandle = signing ? handle : publicHandle(handle);
    const usages = [signing ? 'sign' : 'verify'];
    const call = (key: unknown, sync: boolean): unknown => {
      if (signing) return sync ? engineCallSync('sign', [route.algorithm, key, data]) : engineCallAsync('sign', [route.algorithm, key, data]);
      const signature = toDevice(bufferSource(args[12]), handle, route, args[10]);
      if (signature === null) return sync ? false : Promise.resolve(false);
      const verifyArgs = [route.algorithm, key, signature, data];
      return sync ? engineCallSync('verify', verifyArgs) : engineCallAsync('verify', verifyArgs);
    };
    return {
      call: (sync: boolean) => (sync ? call(keyHandle.deviceKey(route.importAlgorithm, usages, true), true)
        : keyHandle.deviceKey(route.importAlgorithm, usages, false).then((key) => call(key, false))),
      result: (value: unknown) => (signing
        ? toArrayBuffer(fromDevice(value as ArrayBuffer, handle, route, args[10])) : value === true),
    };
  }

  /** EncodeOutput (1051-1061). */
  protected encode(): unknown {
    if (this.args[0] === kSignJobModeSign) return toArrayBuffer(this.out());
    return glue().tabnode_sign_job_verified(this.job) === 1;
  }
}

export const sigBinding = { Sign, Verify, SignJob, kSignJobModeSign, kSignJobModeVerify };
