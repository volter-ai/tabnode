/**
 * Every export of Node's `node:crypto`, accounted.
 *
 * `node:crypto` here is a hand-written module over pure-JS primitives and WebCrypto, not Node's own lib file, so
 * nothing but this table says it has what Node's has. An export Node has and this module lacks is `undefined`,
 * which a program meets deep in its own code as "is not a function" (Twenty's server at its bootstrap:
 * `(0 , _crypto.hkdfSync) is not a function`). So every name is one of two things, and the module's export object
 * must hold all of them or the engine does not compile (crypto.ts, `satisfies`):
 *   - 'implemented': the module answers it. It may still refuse an algorithm or a key type it does not carry, by
 *     name, with Node's ERR_CRYPTO_UNSUPPORTED_OPERATION.
 *   - 'throws': calling or constructing it throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM naming itself.
 *
 * The names are `Object.keys(require('node:crypto')).sort()` on Node v24.21.0, the line of the library this engine
 * carries: `node scripts/crypto-exports.mjs` prints them from the Node that runs it and says how they differ from
 * this list. A library bump re-runs it; a name it adds fails the compile until it is given a row.
 *
 * Beside these 70, Node has four legacy names that are not enumerable and so not among its keys: pseudoRandomBytes,
 * prng and rng (accessors answering randomBytes) and fips (an accessor over getFips and setFips). The module
 * defines them the same way (crypto.ts).
 */
export const NODE_CRYPTO_EXPORTS = {
  Certificate: 'throws',
  Cipheriv: 'implemented',
  Decipheriv: 'implemented',
  DiffieHellman: 'throws',
  DiffieHellmanGroup: 'throws',
  ECDH: 'throws',
  Hash: 'implemented',
  Hmac: 'implemented',
  KeyObject: 'implemented',
  Sign: 'implemented',
  Verify: 'implemented',
  X509Certificate: 'throws',
  argon2: 'throws',
  argon2Sync: 'throws',
  checkPrime: 'throws',
  checkPrimeSync: 'throws',
  constants: 'implemented',
  createCipheriv: 'implemented',
  createDecipheriv: 'implemented',
  createDiffieHellman: 'throws',
  createDiffieHellmanGroup: 'throws',
  createECDH: 'throws',
  createHash: 'implemented',
  createHmac: 'implemented',
  createPrivateKey: 'implemented',
  createPublicKey: 'implemented',
  createSecretKey: 'implemented',
  createSign: 'implemented',
  createVerify: 'implemented',
  decapsulate: 'throws',
  diffieHellman: 'throws',
  encapsulate: 'throws',
  generateKey: 'throws',
  generateKeyPair: 'implemented',
  generateKeyPairSync: 'implemented',
  generateKeySync: 'throws',
  generatePrime: 'throws',
  generatePrimeSync: 'throws',
  getCipherInfo: 'throws',
  getCiphers: 'implemented',
  getCurves: 'throws',
  getDiffieHellman: 'throws',
  getFips: 'implemented',
  getHashes: 'implemented',
  getRandomValues: 'implemented',
  hash: 'implemented',
  hkdf: 'implemented',
  hkdfSync: 'implemented',
  pbkdf2: 'implemented',
  pbkdf2Sync: 'implemented',
  privateDecrypt: 'throws',
  privateEncrypt: 'throws',
  publicDecrypt: 'throws',
  publicEncrypt: 'throws',
  randomBytes: 'implemented',
  randomFill: 'implemented',
  randomFillSync: 'implemented',
  randomInt: 'implemented',
  randomUUID: 'implemented',
  randomUUIDv7: 'throws',
  scrypt: 'implemented',
  scryptSync: 'implemented',
  secureHeapUsed: 'implemented',
  setEngine: 'throws',
  setFips: 'throws',
  sign: 'implemented',
  subtle: 'implemented',
  timingSafeEqual: 'implemented',
  verify: 'implemented',
  webcrypto: 'implemented',
} as const satisfies Record<string, 'implemented' | 'throws'>;

export type NodeCryptoExport = keyof typeof NODE_CRYPTO_EXPORTS;
/** The names this module answers only by throwing. */
export type NodeCryptoUnavailable = { [Name in NodeCryptoExport]: (typeof NODE_CRYPTO_EXPORTS)[Name] extends 'throws' ? Name : never }[NodeCryptoExport];
