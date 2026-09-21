/**
 * OpenSSL numbers the engine actually answers. A leaf: no imports, so the
 * constants table can read them without entering the crypto shim, which is
 * an EventEmitter and sits in a load cycle with this table.
 */
export const cryptoConstants = {
  SSL_OP_ALL: 0,
  RSA_PKCS1_PADDING: 1,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
};
