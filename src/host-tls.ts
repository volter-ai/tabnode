/**
 * A process's TLS client, as its host offers it (ADR-0009 §3, `tls`).
 *
 * On Linux a Node process's TLS is its own library's, the OpenSSL inside `node`, run over a TCP connection the kernel
 * only carries. The engine has no TLS library of its own: a tree whose host has one offers its client under
 * `TREE_TLS`, beside its socket calls (`TREE_SOCKETS`), and `tls` runs it over the bytes of a kernel TCP connection
 * the process made with Node's own `net`. The client reads nothing and holds nothing of the process: the engine hands
 * it the connection's bytes, the name to verify and the roots, which the engine reads through the process's own files.
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

/** The handshake's outcome, what Node's TLSSocket reports from `secureConnect` on. */
export interface TlsSecureConnection {
  /** Whether the server's chain verified to a root and its certificate names the server. */
  authorized: boolean;
  /** Why not, with Node's code (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, ...). */
  authorizationError: Error | undefined;
  /** The ALPN protocol the server chose, or false. */
  alpnProtocol: string | false;
  /** The server's certificates as it sent them, DER, the leaf first. */
  certificates: readonly Uint8Array[];
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

/** The TLS client a host offers its processes. */
export interface TreeTls {
  /** Starts a client handshake over `transport`. */
  connect(transport: TlsTransport, options: TlsClientOptions): TlsClientSession;
}

/** The TLS client a tree offers, where it offers one. */
export function treeTlsOf(tree: unknown): TreeTls | undefined {
  if (tree === null || (typeof tree !== 'object' && typeof tree !== 'function')) return undefined;
  const offered = (tree as Record<symbol, unknown>)[TREE_TLS];
  return offered !== null && typeof offered === 'object' ? offered as TreeTls : undefined;
}
