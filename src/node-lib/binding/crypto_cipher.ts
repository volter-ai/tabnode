/**
 * THE CIPHERS OF THE crypto BINDING (ADR-0018 §5, item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_cipher.cc`
 * (CipherBase, PublicKeyCipher, getCiphers, getSSLCiphers, getCipherInfo), over its OpenSSL half
 * (native/node/crypto_cipher.cc) and the engine device.
 *
 * Routing (ADR-0018 §5). A CipherBase over AES-CBC or AES-CTR with a 128- or 256-bit key is the device's for an
 * update whose whole blocks are more than the measured bound the digests share (crypto_util.ts `DEVICE_BOUND`:
 * `encrypt` and `decrypt` of AES-CBC or AES-CTR over the key's device CryptoKey), and OpenSSL's for a smaller update
 * (its context simply continues), for the bytes its context holds between updates and for `final` (the padding, and the errors Node
 * throws for a wrong final block or a bad decrypt): before each device answer the binding knows what OpenSSL's
 * context holds (Node's own rule, `ossl_cipher_generic_block_update`: a decryption with padding holds back the last
 * whole block, every other holds the partial block), and after it the context is started again where the device left
 * the stream (`tabnode_cipher_rechain`) and given back the bytes it holds. WebCrypto's AES-CBC always pads, so an
 * encryption's whole blocks are the device's answer less its padding block, and a decryption's are answered with one
 * block more (the device's encryption of nothing under the last ciphertext block, whose decryption is a full padding
 * block). WebCrypto's AES-CTR counts the whole 128-bit block, as OpenSSL's does; a stream that ends inside a block
 * continues from its offset in the next one. Every other cipher (AES-192, AES-GCM, CCM, OCB, the wrap modes,
 * ChaCha20-Poly1305 and the rest of OpenSSL's list) is OpenSSL's: WebCrypto's AES-GCM answers a whole message and its
 * tag at once, where Node's `update` answers its bytes before `final`. publicEncrypt, privateDecrypt, privateEncrypt
 * and publicDecrypt are OpenSSL's: Node's errors for them are OpenSSL's.
 */
import { Buffer } from '../buffer-module';
import { address } from './libnode';
import { withBytes, withScratch, word } from './openssl';
import { engineCallSync, type EngineKey } from './engine_device';
import { answer, bufferSource, cppError, decodeInput, DEVICE_BOUND, glue, rethrow, setFields, toBuffer, Values } from './crypto_util';
import { isKeyObjectHandle, type KeyObjectHandle } from './crypto_keys';
import { mallocAnswer } from './openssl';

/** WebCryptoCipherMode (crypto_cipher.h:116-119). */
export const kWebCryptoCipherEncrypt = 0, kWebCryptoCipherDecrypt = 1;

const ciphers = new FinalizationRegistry<number>((cipher) => glue().tabnode_cipher_free(cipher));

/** The names a glue list answers, each NUL-terminated. */
function nameList(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  return text ? text.slice(0, -1).split('\0') : [];
}

/** The DEP0182 warning of SetAuthTag (crypto_cipher.cc:552-562), emitted on the realm's process. */
function emitDeprecation(message: string, code: string): void {
  const process = (globalThis as { process?: { emitWarning?(message: string, type: string, code: string): void } }).process;
  process?.emitWarning?.(message, 'DeprecationWarning', code);
}

/** The device's AES of a CipherBase: its algorithm, its key's CryptoKey, and the stream's state. */
interface DeviceStream {
  name: 'AES-CBC' | 'AES-CTR';
  key: () => EngineKey;
  /** CBC: the last ciphertext block before the held bytes (the IV first); CTR: the next keystream block's counter. */
  chain: Uint8Array;
  /** CBC: the bytes OpenSSL's context holds; CTR: the offset of the next keystream byte in its block. */
  held: Uint8Array;
  offset: number;
}

/** A 128-bit big-endian counter advanced by `blocks` (OpenSSL's ctr128_inc, WebCrypto's AES-CTR of length 128). */
function advance(counter: Uint8Array, blocks: number): Uint8Array {
  const next = counter.slice();
  let carry = blocks;
  for (let index = 15; index >= 0 && carry > 0; index--) {
    const sum = next[index]! + (carry % 256);
    next[index] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum >> 8);
  }
  return next;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  return joined;
}

/** CipherBase (crypto_cipher.cc:214-858). */
export class CipherBase {
  private readonly cipher: number;
  private readonly encrypting: boolean;
  private device: DeviceStream | undefined;
  private finished = false;

  /** CipherBase::New (300-341): (encrypt, the cipher's name, the key, the IV or null, the tag's length or -1). */
  constructor(encrypt: unknown, cipherType: unknown, key: unknown, iv: unknown, authTagLength: unknown) {
    if (arguments.length !== 5) throw new Error('crypto: CipherBase takes five arguments');
    const exports = glue();
    this.encrypting = encrypt === true;
    const name = String(cipherType);
    const handle = isKeyObjectHandle(key) ? key : undefined;
    const keyBytes = handle ? new Uint8Array(0) : bufferSource(key);
    const ivBytes = iv === null ? new Uint8Array(0) : bufferSource(iv);
    const tagLength = typeof authTagLength === 'number' && authTagLength >= 0 ? authTagLength : -1;
    this.cipher = withBytes(name, (nameAt) => withBytes(keyBytes, (keyAt, keyLength) =>
      withBytes(ivBytes, (ivAt, ivLength) => address(exports.tabnode_cipher_new(this.encrypting ? 1 : 0, nameAt,
        handle ? handle.opensslKey() : 0, keyAt, keyLength, ivBytes.byteLength ? ivAt : 0, ivLength,
        BigInt(tagLength))))));
    rethrow();
    ciphers.register(this, this.cipher, this);
    const kind = withBytes(name, (nameAt) => exports.tabnode_cipher_device_kind(nameAt));
    if (kind === 0) return;
    const algorithm = { name: kind === 1 ? 'AES-CBC' : 'AES-CTR' } as const;
    let deviceKey: EngineKey | undefined;
    const secret = handle ? undefined : keyBytes.slice();
    this.device = {
      name: algorithm.name,
      key: () => (deviceKey ??= handle ? (handle as KeyObjectHandle).deviceKey(algorithm, ['encrypt', 'decrypt'], true)
        : engineCallSync('importKey', ['raw', secret, algorithm, false, ['encrypt', 'decrypt']]) as EngineKey),
      chain: ivBytes.slice(),
      held: new Uint8Array(0),
      offset: 0,
    };
  }

  /** CipherBase::Update (682-711), its whole blocks the device's where the cipher is (the file's routing). */
  update(data: unknown, encoding?: unknown): Buffer {
    const bytes = decodeInput(data, encoding);
    if (bytes.byteLength > 0x7fffffff) throw cppError('ERR_OUT_OF_RANGE', 'data is too long');
    const device = this.device;
    if (device && !this.finished) {
      const answered = device.name === 'AES-CBC' ? this.cbcUpdate(device, bytes) : this.ctrUpdate(device, bytes);
      if (answered) return toBuffer(answered);
    }
    return toBuffer(this.feed(bytes));
  }

  /** OpenSSL's update of `bytes`. */
  private feed(bytes: Uint8Array): Uint8Array {
    const exports = glue();
    return answer((lengthAt) => withBytes(bytes, (at, length) => exports.tabnode_cipher_update(this.cipher, at, length, lengthAt)));
  }

  /** The context started again at `chain`, then given `held` (whose answer is none: OpenSSL holds them). */
  private rechain(chain: Uint8Array, held: Uint8Array): void {
    const exports = glue();
    if (!withBytes(chain, (at) => exports.tabnode_cipher_rechain(this.cipher, at))) {
      throw cppError('ERR_CRYPTO_INVALID_STATE');
    }
    if (held.byteLength) this.feed(held);
  }

  /**
   * AES-CBC: the whole blocks past what OpenSSL holds after this update are the device's where they are more than
   * the measured bound, OpenSSL's otherwise (its context continues as it is); null where OpenSSL answers.
   */
  private cbcUpdate(device: DeviceStream, bytes: Uint8Array): Uint8Array | null {
    const available = concat(device.held, bytes);
    const pads = glue().tabnode_cipher_pads(this.cipher) === 1;
    const total = available.byteLength;
    const held = !this.encrypting && pads ? (total === 0 ? 0 : ((total - 1) % 16) + 1) : total % 16;
    const blocks = available.subarray(0, total - held);
    if (blocks.byteLength <= DEVICE_BOUND) {
      device.held = available.slice(total - held);
      if (blocks.byteLength === 0) return null;
      if (!this.encrypting) device.chain = blocks.slice(blocks.byteLength - 16);
      const out = this.feed(bytes);
      // OpenSSL's output is the blocks it answered; an encryption's chain is its last ciphertext block.
      if (this.encrypting) device.chain = out.slice(out.byteLength - 16);
      return out;
    }
    const iv = device.chain;
    let out: Uint8Array;
    if (this.encrypting) {
      const encrypted = new Uint8Array(engineCallSync('encrypt', [{ name: 'AES-CBC', iv }, device.key(), blocks]) as ArrayBuffer);
      out = encrypted.slice(0, blocks.byteLength);
      device.chain = out.slice(out.byteLength - 16);
    } else {
      const last = blocks.slice(blocks.byteLength - 16);
      const padding = new Uint8Array(engineCallSync('encrypt', [{ name: 'AES-CBC', iv: last }, device.key(), new Uint8Array(0)]) as ArrayBuffer);
      out = new Uint8Array(engineCallSync('decrypt', [{ name: 'AES-CBC', iv }, device.key(), concat(blocks, padding)]) as ArrayBuffer);
      device.chain = last;
    }
    device.held = available.slice(total - held);
    this.rechain(device.chain, device.held);
    return out;
  }

  /**
   * AES-CTR: an update of more than the measured bound is the device's, from the keystream's offset in its block;
   * one at or below it OpenSSL's (its context continues as it is); null where OpenSSL answers.
   */
  private ctrUpdate(device: DeviceStream, bytes: Uint8Array): Uint8Array | null {
    const total = device.offset + bytes.byteLength;
    if (bytes.byteLength <= DEVICE_BOUND) {
      device.chain = advance(device.chain, Math.floor(total / 16));
      device.offset = total % 16;
      return null;
    }
    const input = concat(new Uint8Array(device.offset), bytes);
    const stream = new Uint8Array(engineCallSync('encrypt', [{ name: 'AES-CTR', counter: device.chain, length: 128 },
      device.key(), input]) as ArrayBuffer);
    device.chain = advance(device.chain, Math.floor(total / 16));
    device.offset = total % 16;
    this.rechain(device.chain, new Uint8Array(device.offset));
    return stream.slice(input.byteLength - bytes.byteLength);
  }

  /** CipherBase::Final (808-833): OpenSSL's, which holds the stream's last bytes. */
  final(): Buffer {
    this.finished = true;
    return toBuffer(answer((lengthAt) => glue().tabnode_cipher_final(this.cipher, lengthAt)));
  }

  /** CipherBase::SetAutoPadding (713-729). */
  setAutoPadding(autoPadding?: unknown): boolean {
    return glue().tabnode_cipher_set_auto_padding(this.cipher, arguments.length < 1 || autoPadding === true ? 1 : 0) === 1;
  }

  /** CipherBase::GetAuthTag (500-518): undefined unless computed. */
  getAuthTag(): Buffer | undefined {
    const tag = mallocAnswer((lengthAt) => glue().tabnode_cipher_get_auth_tag(this.cipher, lengthAt));
    return tag === null ? undefined : toBuffer(tag);
  }

  /** CipherBase::SetAuthTag (520-569). */
  setAuthTag(tag: unknown): boolean {
    const exports = glue();
    return withScratch(4, (deprecatedAt) => {
      const result = withBytes(bufferSource(tag), (at, length) =>
        exports.tabnode_cipher_set_auth_tag(this.cipher, at, length, deprecatedAt));
      rethrow();
      if (word(deprecatedAt)) {
        emitDeprecation('Using AES-GCM authentication tags of less than 128 bits without specifying the authTagLength ' +
          'option when initializing decryption is deprecated.', 'DEP0182');
      }
      return result === 1;
    });
  }

  /** CipherBase::SetAAD (593-616). */
  setAAD(data: unknown, plaintextLength: unknown): boolean {
    const exports = glue();
    const result = withBytes(bufferSource(data), (at, length) =>
      exports.tabnode_cipher_set_aad(this.cipher, at, length, Number(plaintextLength) | 0));
    rethrow();
    return result === 1;
  }
}

/** PublicKeyCipher::Cipher (861-925): `operation` 0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt, 3 publicDecrypt. */
function publicKeyCipher(operation: number) {
  return (...args: unknown[]): Buffer => {
    const exports = glue();
    return toBuffer(answer((lengthAt) => new Values(args).call((at, length) =>
      exports.tabnode_public_key_cipher(operation, at, length, lengthAt))));
  };
}

/** CipherBase::GetCiphers (190-212). */
function getCiphers(): string[] {
  return nameList(answer((lengthAt) => glue().tabnode_cipher_list(lengthAt)));
}

/** CipherBase::GetSSLCiphers (166-188). */
function getSSLCiphers(): string[] {
  return nameList(answer((lengthAt) => glue().tabnode_ssl_cipher_list(lengthAt)));
}

/** GetCipherInfo (41-163): the info on `info`, or undefined. */
function getCipherInfo(info: Record<string, unknown>, nameOrNid: unknown, keyLength?: unknown, ivLength?: unknown): unknown {
  const exports = glue();
  const fields = mallocAnswer((lengthAt) => new Values([nameOrNid, keyLength, ivLength]).call((at, length) =>
    exports.tabnode_cipher_info(at, length, lengthAt)));
  rethrow();
  if (fields === null) return undefined;
  return setFields(info, fields);
}

export const cipherBinding = {
  CipherBase,
  getCiphers,
  getSSLCiphers,
  getCipherInfo,
  publicEncrypt: publicKeyCipher(0),
  privateDecrypt: publicKeyCipher(1),
  privateEncrypt: publicKeyCipher(2),
  publicDecrypt: publicKeyCipher(3),
  kWebCryptoCipherEncrypt,
  kWebCryptoCipherDecrypt,
};
