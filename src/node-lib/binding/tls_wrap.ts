/**
 * `internalBinding('tls_wrap')`: Node's `TLSWrap` (src/crypto/crypto_tls.cc) over the realm's node-deps.wasm
 * (ADR-0016 §4). The connection's `SSL` lives in the module with two memory BIOs; the underlying stream's bytes are
 * written into `enc_in`, `ClearOut` runs `SSL_read` and hands the plaintext to this handle's reader, writes run
 * `SSL_write`, and `EncOut` writes what `enc_out` holds to the underlying stream. OpenSSL never touches a socket.
 *
 * This file is the V8 half of `crypto_tls.cc` (the control flow between the streams and the callbacks into
 * JavaScript); the OpenSSL half is the export layer's (scripts/node-deps/tabnode_deps.cc). Each method names the
 * lines it carries. Node's `internal/tls/wrap.js` is vendored over it unmodified.
 *
 * What differs from Node, each by name: a write the underlying stream finished synchronously, and an `EncOut` with
 * nothing to write inside `DoWrite`, complete on a binding task where Node uses `SetImmediate` (the engine's binding
 * turn); a server's ClientHello parser (session resumption events) and PSK are refused by name, as are OCSP
 * stapling and `enableTrace`.
 */
import { Buffer } from '../buffer-module';
import {
  LibuvStreamWrap, ShutdownWrap, WriteWrap, streamBaseState, kArrayBufferOffset, kBytesWritten, kLastWriteWasAsync,
  kReadBytesOrError,
} from './stream_wrap';
import { forgetNodeHandle, invokeOwned, unrefHandle } from './handles';
import { UV_ECANCELED, UV_EOF, UV_EPROTO } from './uv';
import { queueBindingTask } from '../../guest-loop';
import {
  copyOut, cString, errorDetail, mallocAnswer, nodeDeps, opensslError, outAnswer, setTlsCallbacks, withBytes, withScratch,
} from './node-deps';
import { SecureContext, errorCodes, refusal } from './crypto';
import { ownCertificate, peerCertificate } from './x509_object';
import { listeningHandles } from './tcp_wrap';
import { handleOwnerSymbol } from './owner-symbol';
import type { TreeSockets } from '../../host-sockets';
import { performance } from '../../system';

const SSL_ERROR_SSL = 1;
const SSL_ERROR_ZERO_RETURN = 6;
const SSL_ERROR_SYSCALL = 5;
/** kClearOutChunkSize (crypto_tls.h). */
const kClearOutChunkSize = 16384;

type StreamHandle = LibuvStreamWrap & Record<string, any>;

/** The realm's TLSWraps by their `TnSsl*`, for the module's callbacks. */
const wraps = new Map<number, TLSWrap>();

export class TLSWrap extends LibuvStreamWrap {
  /** The `TnSsl*`; 0 after `destroySSL` (Node's `ssl_ == nullptr`). */
  ssl = 0;
  _parent: StreamHandle;
  readonly isServer: boolean;
  /** The `SecureContext` the connection was made with (Node's `sc_`). */
  sc: SecureContext;
  sni_context: unknown = null;

  started = false;
  established = false;
  eof = false;
  #shutdown = false;
  #writeSize = 0;
  #pendingCleartext: Uint8Array | null = null;
  #currentWrite: WriteWrap | null = null;
  #currentEmptyWrite: WriteWrap | null = null;
  #writeCallbackScheduled = false;
  #inDoWrite = false;
  #cycleDepth = 0;
  #hasActiveWriteFromPrevOwner: boolean;
  #waitingCertCb = false;
  #certCbRunning = false;

  /** TLSWrap::TLSWrap and TLSWrap::Wrap (crypto_tls.cc:410-559). */
  constructor(parent: StreamHandle, sc: SecureContext, isServer: boolean, hasActiveWriteFromPrevOwner: boolean) {
    super();
    // A TLSWrap is not a handle of the loop: its parent holds the loop, and ref/unref are the parent's
    // (wrap.js proxies them).
    unrefHandle(this);
    forgetNodeHandle(this);
    this._parent = parent;
    this.sc = sc;
    this.isServer = isServer;
    this.#hasActiveWriteFromPrevOwner = hasActiveWriteFromPrevOwner;
    // TLSWrap::InitSSL (476-527).
    const ssl = nodeDeps().tn_ssl_new(sc._ctx, isServer ? 1 : 0) >>> 0;
    if (!ssl) throw opensslError('SSL_new');
    this.ssl = ssl;
    wraps.set(ssl, this);
    // The wrap reads the underlying stream as its listener (stream->PushStreamListener(this)).
    parent.onread = (buffer: ArrayBuffer | null) => this.#onStreamRead(buffer);
    // GetFD (978-980): the underlying stream's.
    Object.defineProperty(this, 'fd', {
      configurable: true,
      enumerable: true,
      get: () => (this._parent?.fd as number) ?? -1,
      set: () => {},
    });
    // GetWriteQueueSize (1572-1581): what enc_out still holds.
    Object.defineProperty(this, 'writeQueueSize', {
      configurable: true,
      enumerable: true,
      get: () => (this.ssl ? nodeDeps().tn_ssl_enc_out_pending(this.ssl) >>> 0 : 0),
      set: () => {},
    });
  }

  // ---- The underlying stream ------------------------------------------------------------------------------

  /** OnStreamRead (1157-1201), from the parent's `onread`. */
  #onStreamRead(buffer: ArrayBuffer | null): void {
    const nread = streamBaseState[kReadBytesOrError]!;
    if (this.eof) return;
    if (nread < 0) {
      this.#clearOut();
      if (nread === UV_EOF) this.eof = true;
      if (nread === UV_EOF) LibuvStreamWrap.prototype.receiveEof.call(this);
      else this.receiveError(nread);
      return;
    }
    if (!this.ssl || nread === 0) return;
    const bytes = new Uint8Array(buffer!, streamBaseState[kArrayBufferOffset]!, nread);
    const deps = nodeDeps();
    withBytes(bytes, (at, length) => deps.tn_ssl_enc_in(this.ssl, at, length));
    this.#cycle();
  }

  /**
   * TLSWrap::Receive (561-581): bytes the socket had read before it was wrapped (`initRead`), handed in as if the
   * underlying stream had read them now. (Node's name; the plaintext reaches this handle's reader through
   * `#emitRead`.)
   */
  override receive(buffer: Uint8Array): void {
    if (!this.ssl || !(buffer?.byteLength > 0)) return;
    const deps = nodeDeps();
    withBytes(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      (at, length) => deps.tn_ssl_enc_in(this.ssl, at, length));
    this.#cycle();
  }

  /**
   * EmitRead of plaintext: to this handle's reader at once, as Node's EmitRead calls `onread` inside ClearOut, so a
   * read that comes before an SSL error reaches the socket before `onerror` destroys it.
   */
  #emitRead(bytes: Uint8Array): void {
    LibuvStreamWrap.prototype.receive.call(this, bytes);
    this.flushInbound();
  }

  /** Cycle (2158-2170). */
  #cycle(): void {
    if (++this.#cycleDepth > 1) return;
    for (; this.#cycleDepth > 0; this.#cycleDepth--) {
      this.#clearIn();
      this.#clearOut();
      this.#encOut();
    }
  }

  /** EncOut (641-735). */
  #encOut(): void {
    if (this.#writeSize !== 0) return;
    if (this.#hasActiveWriteFromPrevOwner) return;
    if (this.established && this.#currentWrite) this.#writeCallbackScheduled = true;
    if (!this.ssl) return;
    const deps = nodeDeps();
    const pending = deps.tn_ssl_enc_out_pending(this.ssl) >>> 0;
    if (pending === 0) {
      if (!this.#pendingCleartext || this.#pendingCleartext.byteLength === 0) {
        if (!this.#inDoWrite) this.#invokeQueued(0);
        else queueBindingTask(() => this.#invokeQueued(0));
      }
      return;
    }
    const at = deps.tn_ssl_enc_out_peek(this.ssl) >>> 0;
    const data = copyOut(at, pending);
    this.#writeSize = pending;
    const request = new WriteWrap();
    request.handle = this._parent;
    request.oncomplete = (status: number) => this.#onStreamAfterWrite(status);
    const status = this._parent.writeBuffer(request, data);
    if (status !== 0) {
      this.#invokeQueued(status);
      return;
    }
    // "Simulate asynchronous finishing, TLS cannot handle this at the moment."
    if (!streamBaseState[kLastWriteWasAsync]) queueBindingTask(() => this.#onStreamAfterWrite(0));
  }

  /** OnStreamAfterWrite (737-784). */
  #onStreamAfterWrite(status: number): void {
    if (this.#currentEmptyWrite) {
      const finishing = this.#currentEmptyWrite;
      this.#currentEmptyWrite = null;
      this.#done(finishing, status);
      return;
    }
    if (!this.ssl) status = UV_ECANCELED;
    if (status) {
      if (this.#shutdown) return;
      this.#invokeQueued(status);
      return;
    }
    nodeDeps().tn_ssl_enc_out_commit(this.ssl, this.#writeSize);
    this.#clearIn();
    this.#writeSize = 0;
    this.#encOut();
  }

  /** ClearOut (786-911). */
  #clearOut(): void {
    if (this.eof || !this.ssl) return;
    const deps = nodeDeps();
    deps.tn_err_set_mark();
    try {
      let read = 0;
      const out = deps.tn_malloc(kClearOutChunkSize) >>> 0;
      try {
        for (;;) {
          read = deps.tn_ssl_read(this.ssl, out, kClearOutChunkSize);
          if (read <= 0) break;
          this.#emitRead(copyOut(out, read));
          if (!this.ssl) return;
        }
      } finally {
        deps.tn_free(out);
      }
      const err = deps.tn_ssl_get_error(this.ssl, read);
      if (err === SSL_ERROR_ZERO_RETURN) {
        if (!this.eof) {
          this.eof = true;
          LibuvStreamWrap.prototype.receiveEof.call(this);
        }
        return;
      }
      if (err !== SSL_ERROR_SSL && err !== SSL_ERROR_SYSCALL) return;
      const error = this.#sslError();
      // "When TLS Alert are stored in wbio, it should be flushed to socket before destroyed."
      if (deps.tn_ssl_enc_out_pending(this.ssl) !== 0) this.#encOut();
      invokeOwned(this, 'onerror', error);
    } finally {
      deps.tn_err_pop_to_mark();
    }
  }

  /** ClearOut's error object (874-905): GetBIOError's message; library, reason, and `ERR_SSL_` + the reason. */
  #sslError(): Error {
    const { library, reason, reasonCode } = errorDetail(nodeDeps().tn_err_peek() >>> 0);
    const error = new Error(this.#bioError()) as Error & Record<string, unknown>;
    error.library = library ?? undefined;
    error.function = undefined;
    error.reason = reason ?? undefined;
    if (reasonCode !== null) error.code = `ERR_SSL_${reasonCode}`;
    return error;
  }

  /** GetBIOError (397-406), for ClearOut's error and ClearIn's EPROTO (963). */
  #bioError(): string {
    return new TextDecoder('latin1').decode(mallocAnswer((lengthAt) => nodeDeps().tn_err_bio_error(lengthAt))!);
  }

  /** ClearIn (913-968). */
  #clearIn(): void {
    if (!this.ssl) return;
    const pending = this.#pendingCleartext;
    if (!pending || pending.byteLength === 0) return;
    this.#pendingCleartext = null;
    const deps = nodeDeps();
    deps.tn_err_set_mark();
    try {
      const written = withBytes(pending, (at, length) => deps.tn_ssl_write(this.ssl, at, length));
      if (written !== -1) return;
      const err = deps.tn_ssl_get_error(this.ssl, written);
      if (err === SSL_ERROR_SSL || err === SSL_ERROR_SYSCALL) {
        this.#writeCallbackScheduled = true;
        this.#invokeQueued(UV_EPROTO, this.#bioError());
        return;
      }
      this.#pendingCleartext = pending;
    } finally {
      deps.tn_err_pop_to_mark();
    }
  }

  /** InvokeQueued (458-469). */
  #invokeQueued(status: number, error?: string): void {
    if (!this.#writeCallbackScheduled) return;
    if (this.#currentWrite) {
      const write = this.#currentWrite;
      this.#currentWrite = null;
      this.#done(write, status, error);
    }
  }

  /** WriteWrap::Done: the request's `oncomplete(status)`, with the error string Node attaches. */
  #done(write: WriteWrap, status: number, error?: string): void {
    if (error !== undefined) write.error = error;
    invokeOwned(write, 'oncomplete', status);
  }

  // ---- The stream this handle is, to its socket ------------------------------------------------------------

  /** ReadStart/ReadStop (992-1002): the underlying stream's. */
  override readStart(): number {
    const status = super.readStart();
    if (status !== 0) return status;
    return this._parent.readStart();
  }
  override readStop(): number {
    super.readStop();
    return this._parent.readStop();
  }

  /** DoWrite (1014-1147): the bytes are taken whole (writev has joined them); the write completes on EncOut. */
  protected override dispatchWrite(req: WriteWrap, buffer: Uint8Array): number {
    streamBaseState[kBytesWritten] = buffer.byteLength;
    streamBaseState[kLastWriteWasAsync] = 1;
    if (!this.ssl) {
      // StreamBase::Write hands the stream's Error() to the request (stream_base.cc), which `onWriteComplete` reads.
      req.error = 'Write after DestroySSL';
      return UV_EPROTO;
    }
    const length = buffer.byteLength;
    if (length === 0) {
      this.#clearOut();
      if (nodeDeps().tn_ssl_enc_out_pending(this.ssl) === 0) {
        this.#currentEmptyWrite = req;
        const request = new WriteWrap();
        request.handle = this._parent;
        request.oncomplete = (status: number) => this.#onStreamAfterWrite(status);
        // Node completes it with 0 a turn later whenever the underlying write is not asynchronous, a refused one
        // included (1062-1069).
        const status = this._parent.writeBuffer(request, new Uint8Array(0));
        if (status !== 0 || !streamBaseState[kLastWriteWasAsync]) {
          queueBindingTask(() => this.#onStreamAfterWrite(0));
        }
        streamBaseState[kLastWriteWasAsync] = 1;
        return 0;
      }
    }
    this.#currentWrite = req;
    if (length === 0) {
      this.#encOut();
      return 0;
    }
    const deps = nodeDeps();
    deps.tn_err_set_mark();
    try {
      const written = withBytes(buffer, (at, size) => deps.tn_ssl_write(this.ssl, at, size));
      if (written === -1) {
        const err = deps.tn_ssl_get_error(this.ssl, written);
        if (err === SSL_ERROR_SSL || err === SSL_ERROR_SYSCALL) {
          this.#currentWrite = null;
          return UV_EPROTO;
        }
        this.#pendingCleartext = buffer.slice();
      }
    } finally {
      deps.tn_err_pop_to_mark();
    }
    this.bytesWritten += length;
    this.#inDoWrite = true;
    try { this.#encOut(); } finally { this.#inDoWrite = false; }
    streamBaseState[kLastWriteWasAsync] = 1;
    return 0;
  }

  /** DoShutdown (1207-1217): close_notify, EncOut, then the underlying stream's shutdown with this request. */
  override shutdown(req: ShutdownWrap): number {
    const deps = nodeDeps();
    if (this.ssl) {
      deps.tn_err_set_mark();
      if (deps.tn_ssl_shutdown(this.ssl) === 0) deps.tn_ssl_shutdown(this.ssl);
      deps.tn_err_pop_to_mark();
    }
    this.#shutdown = true;
    this.#encOut();
    return this._parent.shutdown(req);
  }

  override hasRef(): boolean { return (this._parent.hasRef as () => boolean)(); }

  // ---- TLSWrap's methods (crypto_tls.cc:2185-2281) ---------------------------------------------------------

  /** Start (583-597): a client's ClientHello. */
  start(): void {
    if (this.started) throw new Error('TLSWrap.start: already started');
    this.started = true;
    this.#clearOut();
    this.#encOut();
  }

  setVerifyMode(requestCert: boolean, rejectUnauthorized: boolean): void {
    nodeDeps().tn_ssl_set_verify_mode(this.ssl, requestCert ? 1 : 0, rejectUnauthorized ? 1 : 0);
  }

  /** EnableSessionCallbacks (1251-1265): a server's starts the ClientHello parser, which is not carried. */
  enableSessionCallbacks(): void {
    if (this.isServer) {
      throw refusal('A TLS server\'s session resumption events (\'resumeSession\', \'newSession\')');
    }
    nodeDeps().tn_ssl_enable_session_callbacks(this.ssl);
  }

  enableKeylogCallback(): void { nodeDeps().tn_ssl_enable_keylog(this.ssl); }

  /** EnableTrace (1284-1305): SSL_trace to stderr; not carried. */
  enableTrace(): void { throw refusal('TLS tracing (enableTrace, --trace-tls)'); }

  /** DestroySSL/Destroy (1307-1334). */
  destroySSL(): void {
    if (!this.ssl) return;
    this.#writeCallbackScheduled = true;
    this.#invokeQueued(UV_ECANCELED, 'Canceled because of SSL destruction');
    wraps.delete(this.ssl);
    nodeDeps().tn_ssl_free(this.ssl);
    this.ssl = 0;
    if (this._parent && this._parent.onread) this._parent.onread = null;
  }

  /** EnableCertCb (1336-1340). */
  enableCertCb(): void {
    this.#waitingCertCb = true;
  }

  /** EnableALPNCb (1353-1361). */
  enableALPNCb(): void { nodeDeps().tn_ssl_enable_alpn_cb(this.ssl); }

  /** GetServername/SetServername (1363-1392). */
  getServername(): string | false {
    const name = cString(nodeDeps().tn_ssl_get_servername(this.ssl));
    return name === null ? false : name;
  }
  setServername(name: string): void {
    withBytes(String(name), (at) => nodeDeps().tn_ssl_set_servername(this.ssl, at));
  }

  /** PSK (1445-1570): not carried. */
  enablePskCallback(): void { throw refusal('TLS pre-shared keys (pskCallback)'); }
  setPskIdentityHint(): void { throw refusal('TLS pre-shared keys (pskIdentityHint)'); }

  /** CertCbDone (1595-1657). */
  certCbDone(): void {
    const ctx = this.sni_context;
    if (ctx instanceof SecureContext) {
      if (nodeDeps().tn_ssl_use_context(this.ssl, ctx._ctx) === 0) throw opensslError('CertCbDone');
    } else if (ctx !== null && typeof ctx === 'object') {
      invokeOwned(this, 'onerror', new TypeError('Invalid SNI context'));
      return;
    }
    this.#certCbRunning = false;
    // The cert callback's continuation, OnClientHelloParseEnd: Cycle.
    this.#cycle();
  }

  /** SetALPNProtocols (1659-1676). */
  setALPNProtocols(protocols: Uint8Array): void {
    if (!ArrayBuffer.isView(protocols)) throw new TypeError('Must give a Buffer as first argument');
    withBytes(new Uint8Array(protocols.buffer, protocols.byteOffset, protocols.byteLength),
      (at, length) => nodeDeps().tn_ssl_set_alpn_protocols(this.ssl, at, length));
  }

  /** SetKeyCert (1678-1703). */
  setKeyCert(context: unknown): void {
    if (!this.isServer) return;
    if (!(context instanceof SecureContext)) throw new TypeError('Must give a SecureContext as first argument');
    if (nodeDeps().tn_ssl_use_context(this.ssl, context._ctx) !== 1) throw opensslError('SetKeyCert');
  }

  /** GetPeerCertificate (1705-1719). */
  getPeerCertificate(detailed?: boolean): Record<string, unknown> | undefined {
    return peerCertificate(this.ssl, detailed !== true, this.isServer);
  }

  /**
   * GetPeerX509Certificate/GetX509Certificate (1721-1752): the binding's `X509Certificate` handle. Its methods are
   * `crypto`'s, and `InternalX509Certificate` is refused by name (ADR-0016 §4), so only the handle's presence is used:
   * `wrap.js`'s verification reads it.
   */
  getPeerX509Certificate(): X509Handle | undefined {
    const deps = nodeDeps();
    const leaf = this.isServer
      ? outAnswer((outAt) => deps.tn_ssl_peer_certificate(this.ssl, outAt))
      : outAnswer((outAt) => deps.tn_ssl_peer_chain_certificate(this.ssl, 0, outAt));
    return leaf ? new X509Handle(leaf) : undefined;
  }
  getX509Certificate(): X509Handle | undefined {
    const der = outAnswer((outAt) => nodeDeps().tn_ssl_certificate(this.ssl, outAt));
    return der ? new X509Handle(der) : undefined;
  }

  /** GetCertificate (1735-1743). */
  getCertificate(): Record<string, unknown> | undefined { return ownCertificate(this.ssl); }

  /** GetFinished/GetPeerFinished (1754-1808). */
  getFinished(): Buffer | undefined { return this.#finished(false); }
  getPeerFinished(): Buffer | undefined { return this.#finished(true); }
  #finished(peer: boolean): Buffer | undefined {
    const deps = nodeDeps();
    return withScratch(128, (at) => {
      const length = (peer ? deps.tn_ssl_peer_finished(this.ssl, at, 128) : deps.tn_ssl_finished(this.ssl, at, 128)) >>> 0;
      return length === 0 ? undefined : Buffer.from(copyOut(at, length));
    });
  }

  /** GetSession/SetSession/IsSessionReused (1810-1860). */
  getSession(): Buffer | undefined {
    const der = outAnswer((outAt) => nodeDeps().tn_ssl_get_session(this.ssl, outAt));
    return der ? Buffer.from(der) : undefined;
  }
  setSession(session: Uint8Array): void {
    if (session === undefined) {
      const { ERR_MISSING_ARGS } = errorCodes();
      throw new ERR_MISSING_ARGS('Session');
    }
    if (!ArrayBuffer.isView(session)) {
      const { ERR_INVALID_ARG_TYPE } = errorCodes();
      throw new ERR_INVALID_ARG_TYPE('Session', ['Buffer', 'TypedArray', 'DataView'], session);
    }
    const result = withBytes(new Uint8Array(session.buffer, session.byteOffset, session.byteLength),
      (at, length) => nodeDeps().tn_ssl_set_session(this.ssl, at, length));
    if (result < 0) throw new Error('SSL_set_session error');
  }
  isSessionReused(): boolean { return nodeDeps().tn_ssl_session_reused(this.ssl) !== 0; }

  /** VerifyError (1862-1891). */
  verifyError(): (Error & { code?: string }) | null | undefined {
    const deps = nodeDeps();
    const result = deps.tn_ssl_verify_result(this.ssl);
    if (result === 0) return null;
    const reason = cString(deps.tn_x509_error_reason(result));
    if (reason === null) return undefined;
    const error = new Error(reason) as Error & { code?: string };
    error.code = cString(deps.tn_x509_error_code(result)) ?? undefined;
    return error;
  }

  /** GetCipher (1893-1899), GetCipherInfo (crypto_common.cc). */
  getCipher(): Record<string, string | undefined> | undefined {
    const deps = nodeDeps();
    const name = cString(deps.tn_ssl_cipher_name(this.ssl));
    if (name === null) return undefined;
    return {
      name,
      standardName: cString(deps.tn_ssl_cipher_standard_name(this.ssl)) ?? undefined,
      version: cString(deps.tn_ssl_cipher_version(this.ssl)) ?? undefined,
    };
  }

  /** LoadSession/EndParser (1901-1915, 2036-2040): the ClientHello parser is not carried. */
  loadSession(): void {}
  endParser(): void {}

  /** GetSharedSigalgs (1917-1994): not carried. */
  getSharedSigalgs(): never { throw refusal('getSharedSigalgs()'); }

  /** ExportKeyingMaterial (1996-2034). */
  exportKeyingMaterial(length: number, label: string, context?: Uint8Array): Buffer {
    const deps = nodeDeps();
    return withScratch(Math.max(1, length), (out) => withBytes(String(label), (labelAt, labelLength) => {
      const useContext = context !== undefined;
      const contextBytes = useContext
        ? new Uint8Array(context!.buffer, context!.byteOffset, context!.byteLength) : new Uint8Array(0);
      const ok = withBytes(contextBytes, (contextAt, contextLength) =>
        deps.tn_ssl_export_keying_material(this.ssl, out, length, labelAt, labelLength, contextAt, contextLength,
          useContext ? 1 : 0));
      if (ok !== 1) throw opensslError('SSL_export_keying_material');
      return Buffer.from(copyOut(out, length));
    }));
  }

  /** Renegotiate (2042-2048). */
  renegotiate(): void {
    const deps = nodeDeps();
    try {
      if (deps.tn_ssl_renegotiate(this.ssl) !== 1) throw opensslError('');
    } finally { deps.tn_err_clear(); }
  }

  /** GetTLSTicket (2050-2068). */
  getTLSTicket(): Buffer | undefined {
    const ticket = outAnswer((outAt) => nodeDeps().tn_ssl_tls_ticket(this.ssl, outAt), false);
    return ticket ? Buffer.from(ticket) : undefined;
  }

  /** NewSessionDone (2070-2075): a server's; not reached while session callbacks are refused. */
  newSessionDone(): void { this.#cycle(); }

  /** SetOCSPResponse/RequestOCSP (2077-2095): not carried. */
  setOCSPResponse(): never { throw refusal('OCSP stapling (setOCSPResponse)'); }
  requestOCSP(): never { throw refusal('OCSP stapling (requestOCSP)'); }

  /** GetEphemeralKeyInfo (2097-2113), GetEphemeralKey (crypto_common.cc). */
  getEphemeralKeyInfo(): Record<string, unknown> | null {
    if (this.isServer) return null;
    const deps = nodeDeps();
    const info: Record<string, unknown> = { type: undefined, name: undefined, size: undefined };
    const found = withScratch(8, (at) => {
      const id = deps.tn_ssl_ephemeral_key(this.ssl, at, at + 4);
      const view = new DataView(deps.memory.buffer);
      const bits = view.getInt32(at, true);
      const curve = cString(view.getUint32(at + 4, true));
      const EVP_PKEY_DH = 28, EVP_PKEY_EC = 408, EVP_PKEY_X25519 = 1034, EVP_PKEY_X448 = 1035;
      if (id === EVP_PKEY_DH) { info.type = 'DH'; info.size = bits; return true; }
      if ((id === EVP_PKEY_EC || id === EVP_PKEY_X25519 || id === EVP_PKEY_X448) && curve !== null) {
        info.type = 'ECDH'; info.name = curve; info.size = bits; return true;
      }
      return false;
    });
    if (!found) {
      const group = cString(deps.tn_ssl_negotiated_group(this.ssl));
      if (group !== null) { info.type = 'TLSGroup'; info.name = group; }
    }
    return info;
  }

  /** GetProtocol (2115-2120). */
  getProtocol(): string | null { return cString(nodeDeps().tn_ssl_get_version(this.ssl)); }

  /** GetALPNNegotiatedProto (2122-2146). */
  getALPNNegotiatedProtocol(): string | false {
    const selected = outAnswer((outAt) => nodeDeps().tn_ssl_get_alpn_selected(this.ssl, outAt), false);
    return selected && selected.byteLength > 0 ? new TextDecoder('latin1').decode(selected) : false;
  }

  /** WritesIssuedByPrevListenerDone (2148-2156). */
  writesIssuedByPrevListenerDone(): void {
    this.#hasActiveWriteFromPrevOwner = false;
    this.#encOut();
  }

  /** SetMaxSendFragment (2172-2183). */
  setMaxSendFragment(size: number): number { return nodeDeps().tn_ssl_set_max_send_fragment(this.ssl, size | 0); }

  // ---- The module's callbacks ----------------------------------------------------------------------------

  /** SSLInfoCallback (599-639). */
  handshake(done: boolean): void {
    if (!done) {
      // `env->GetNow()`: the loop's time in milliseconds, as onhandshakestart compares it.
      invokeOwned(this, 'onhandshakestart', performance.now());
      return;
    }
    this.established = true;
    invokeOwned(this, 'onhandshakedone');
  }

  /** KeylogCallback (143-158): the line and a newline. */
  keylog(line: Uint8Array): void {
    const buffer = Buffer.alloc(line.byteLength + 1);
    buffer.set(line);
    buffer[line.byteLength] = 0x0a;
    invokeOwned(this, 'onkeylog', buffer);
  }

  /** NewSessionCallback (160-208): `onnewsession(sessionId, session)`. */
  newSession(id: Uint8Array, der: Uint8Array): void {
    invokeOwned(this, 'onnewsession', Buffer.from(id), Buffer.from(der));
  }

  /** SSLCertCallback (210-247). */
  cert(servername: string, ocsp: boolean): number {
    if (!this.isServer || !this.#waitingCertCb) return 1;
    if (this.#certCbRunning) return -1;
    this.#certCbRunning = true;
    invokeOwned(this, 'oncertcb', { servername, OCSPRequest: ocsp });
    return this.#certCbRunning ? -1 : 1;
  }

  /** SelectALPNCallback's callback half (256-290): the offset the program's ALPNCallback chose, or -1. */
  alpn(protocols: Uint8Array): number {
    const result = invokeOwned(this, 'ALPNCallback', Buffer.from(protocols));
    return typeof result === 'number' ? result : -1;
  }
}

/**
 * Whether a server listening on `port` in `sockets`'s process is a TLS server: a listening handle whose owner is a
 * `net.Server` holding `_sharedCreds`, the SecureContext Node's `tls.Server` keeps (lib/internal/tls/wrap.js
 * `Server.prototype.setSecureContext`). A page bridge reaching such a port reaches it as a TLS client.
 */
export function listensWithTls(sockets: TreeSockets, port: number): boolean {
  return listeningHandles(sockets, port).some((handle) => {
    const owner = (handle as unknown as Record<symbol, unknown>)[handleOwnerSymbol] as Record<string, any> | undefined;
    return owner?._sharedCreds?.context instanceof SecureContext;
  });
}

/** The handle `getPeerX509Certificate()` answers: the certificate's DER. */
class X509Handle {
  constructor(readonly der: Uint8Array) {}
}

// The module raises these only inside an `SSL_*` call of a live wrap.
setTlsCallbacks({
  handshake: (ssl, done) => wraps.get(ssl)!.handshake(done !== 0),
  keylog: (ssl, line) => wraps.get(ssl)!.keylog(line),
  newSession: (ssl, id, der) => wraps.get(ssl)!.newSession(id, der),
  cert: (ssl, servername, ocsp) => wraps.get(ssl)!.cert(servername, ocsp),
  alpn: (ssl, protocols) => wraps.get(ssl)!.alpn(protocols),
});

/**
 * TLSWrap::Wrap (529-559): `wrap(handle, context, isServer, hasActiveWriteFromPrevOwner)`. The wrap is made through
 * the surface's own `TLSWrap` (`this.TLSWrap`), whose prototype wrap.js extends.
 */
function wrap(this: { TLSWrap?: typeof TLSWrap } | undefined, handle: StreamHandle, context: SecureContext,
  isServer: boolean, hasActiveWriteFromPrevOwner: boolean): TLSWrap {
  const Wrap = this?.TLSWrap ?? TLSWrap;
  if (!(context instanceof SecureContext)) throw new TypeError('Invalid SecureContext');
  if (!handle || typeof handle.readStart !== 'function') throw new TypeError('handle must be a StreamBase');
  return new Wrap(handle, context, !!isServer, !!hasActiveWriteFromPrevOwner);
}

export default {
  TLSWrap,
  wrap,
  // HAVE_SSL_TRACE (crypto_tls.cc:2191): Node's build has it; this one refuses enableTrace by name.
  HAVE_SSL_TRACE: 1,
};
