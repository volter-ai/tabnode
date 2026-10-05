/** WebCrypto exposes key metadata, but never a synchronous opaque-key
 * comparator. Do not replace native key equality with object identity or
 * fabricated bytes. No native KeyObject handle is supplied by this engine. */
const usages = ['encrypt', 'decrypt', 'sign', 'verify', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'];
function unsupported(): never {
  throw Object.assign(new Error('Synchronous native key-handle comparison is unavailable in this engine.'),
    { code: 'ERR_UNSUPPORTED_OPERATION', capability: 'crypto.native-key-comparison' });
}
export const internalCryptoKeys = {
  getKeyObjectHandle: unsupported,
  getKeyObjectType: unsupported,
  getCryptoKeyHandle: unsupported,
  getCryptoKeyType: (key: CryptoKey) => key.type,
  getCryptoKeyExtractable: (key: CryptoKey) => key.extractable,
  getCryptoKeyAlgorithm: (key: CryptoKey) => key.algorithm,
  getCryptoKeyUsagesMask: (key: CryptoKey) => key.usages.reduce((mask, usage) => mask | (1 << usages.indexOf(usage)), 0),
};
