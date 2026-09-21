/**
 * OpenSSL numbers the engine actually answers. A leaf: no imports, so the
 * constants table can read them without entering the crypto shim, which is
 * an EventEmitter and sits in a load cycle with this table.
 */
export declare const cryptoConstants: {
    SSL_OP_ALL: number;
    RSA_PKCS1_PADDING: number;
    RSA_PKCS1_OAEP_PADDING: number;
    RSA_PKCS1_PSS_PADDING: number;
};
//# sourceMappingURL=crypto-constants.d.ts.map