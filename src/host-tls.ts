/**
 * A process's TLS, as its host offers it (ADR-0009 §3, `tls`).
 *
 * On Linux a Node process's TLS is its own library's, the OpenSSL inside `node`, run over a TCP connection the kernel
 * only carries. The engine has no TLS library of its own: a tree whose host has one offers its client and its server
 * under `TREE_TLS`, beside its socket calls (`TREE_SOCKETS`), and `tls` runs them over the bytes of a kernel TCP
 * connection of the process. They read nothing and hold nothing of the process: the engine hands them the
 * connection's bytes and what Node's `SecureContext` would hold (the roots, the name to verify, the key and chain),
 * which it reads through the process's own files or takes from the program.
 */

/** The key a tree offers its process's TLS client under. */
export const TREE_TLS = Symbol.for('tabnode.tree.tls');

/** The connection the client writes its records to: the engine's side of the process's TCP socket. */
export interface TlsTransport {
  write(bytes: Uint8Array): void;
  /** The client will write no more (after its close_notify): the socket's write side shuts down. */
  end(): void;
  /** The client is done with the connection. */
  close(): void;
}

/** The decrypted connection: what the server sends, and what the process writes to it. */
export interface TlsPlainConnection {
  onData(listener: (bytes: Uint8Array) => void): void;
  /** The server's close_notify, or the end of the connection after the handshake. */
  onEnd(listener: () => void): void;
  onClose(listener: () => void): void;
  /** The failure that ended the connection, in Node's shape (`code`, and OpenSSL's `reason` where it has one). */
  onError(listener: (error: Error) => void): void;
  /** Bytes written before the handshake is done are sent once it is. */
  write(bytes: Uint8Array): void;
  /** Sends close_notify, then ends the transport. */
  end(): void;
  close(): void;
}

/** A certificate as Node's `getPeerCertificate()` describes it (OpenSSL's `X509ToObject`). */
export interface TlsPeerCertificate {
  /** Each attribute of the distinguished name by OpenSSL's short name (`CN`, `O`); a repeated one an array. */
  subject: Readonly<Record<string, string | readonly string[]>>;
  issuer: Readonly<Record<string, string | readonly string[]>>;
  /** `DNS:a, IP Address:1.2.3.4`, where the certificate has a subjectAltName. */
  subjectaltname?: string;
  ca: boolean;
  /** As OpenSSL prints a time: `Jan  5 01:02:03 2025 GMT`. */
  valid_from: string;
  valid_to: string;
  /** SHA-1, SHA-256 and SHA-512 of the DER, colon-separated uppercase hex. */
  fingerprint: string;
  fingerprint256: string;
  fingerprint512: string;
  /** Uppercase hex. */
  serialNumber: string;
  /** The DER. */
  raw: Uint8Array;
}

/** The handshake's outcome, what Node's TLSSocket reports from `secureConnect` on. */
export interface TlsSecureConnection {
  /** Whether the server's chain verified to a root and its certificate names the server. */
  authorized: boolean;
  /** Why not, with Node's code (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, ...). */
  authorizationError: Error | undefined;
  /** The ALPN protocol the server chose, or false. */
  alpnProtocol: string | false;
  /** The server's certificates as it sent them, the leaf first. */
  certificates: readonly TlsPeerCertificate[];
  /** The protocol version, as Node names it (`TLSv1.3`). */
  version: string;
  /** The cipher suite, by its IANA name (`TLS_AES_128_GCM_SHA256`). */
  cipher: string;
}

export interface TlsClientSession {
  /** Where the server's bytes go: its records, its FIN, the connection's close. */
  receive(bytes: Uint8Array): void;
  receiveEnd(): void;
  receiveClose(): void;
  plain: TlsPlainConnection;
  /** Settles once: when the handshake is done, or with the failure that ended it (also given to `plain.onError`). */
  secure: Promise<TlsSecureConnection>;
}

export interface TlsClientOptions {
  /** The server's name: what SNI carries (an IP address is not sent) and what its certificate must name. */
  servername: string;
  /** The roots, a PEM bundle's bytes. */
  ca: Uint8Array;
  /** As Node's: unless false, a chain or name that does not verify ends the handshake with that failure. */
  rejectUnauthorized: boolean;
  /** ALPN protocols, in the client's preference. */
  protocols?: readonly string[];
}

export interface TlsServerOptions {
  /** The server's private key, PEM (PKCS #8, PKCS #1 or SEC 1; RSA, EC or Ed25519). */
  key: Uint8Array;
  /** Its certificate chain, PEM, the leaf first. */
  cert: Uint8Array;
  /** ALPN protocols, in the server's preference; a client that offers only others is refused. */
  protocols?: readonly string[];
}

/** A server handshake's outcome, what Node's server-side TLSSocket reports from `secureConnection` on. */
export interface TlsServerSecureConnection {
  alpnProtocol: string | false;
  /** The name the client's SNI carried, or false. */
  servername: string | false;
  version: string;
  cipher: string;
}

export interface TlsServerSession {
  /** Where the client's bytes go: its records, its FIN, the connection's close. */
  receive(bytes: Uint8Array): void;
  receiveEnd(): void;
  receiveClose(): void;
  plain: TlsPlainConnection;
  /** Settles once: when the client's Finished verifies, or with the failure that ended the handshake. */
  secure: Promise<TlsServerSecureConnection>;
}

/** The TLS a host offers its processes. */
export interface TreeTls {
  /** Starts a client handshake over `transport`. */
  connect(transport: TlsTransport, options: TlsClientOptions): TlsClientSession;
  /** Answers a client's handshake over `transport`, with the program's own key and chain. */
  serve(transport: TlsTransport, options: TlsServerOptions): TlsServerSession;
}

/** The TLS a tree offers, where it offers one. */
export function treeTlsOf(tree: unknown): TreeTls | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_TLS];
  return offered !== null && typeof offered === 'object' ? offered as TreeTls : undefined;
}
