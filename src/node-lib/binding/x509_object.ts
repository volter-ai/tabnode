/**
 * A certificate as the object `getPeerCertificate()` answers: the V8 half of Node's `X509ToObject`
 * (src/crypto/crypto_x509.cc:720-855) and of `GetPeerCert`'s issuer walk (src/crypto/crypto_common.cc:80-171), over
 * the export layer's certificate half (scripts/node-deps/tabnode_deps.cc, "Certificates as objects"). ADR-0016 §3.
 */
import { Buffer } from '../buffer-module';
import { copyOut, nodeDeps, withBytes, withScratch } from './node-deps';

type Certificate = Record<string, unknown>;

/** A malloc'd answer `(x, ..., size_t* length) => char*` of the module, as bytes (null: "undefined"). */
function answer(call: (lengthAt: number) => number): Uint8Array | null {
  const deps = nodeDeps();
  return withScratch(4, (lengthAt) => {
    const at = call(lengthAt) >>> 0;
    if (!at) return null;
    const length = new DataView(deps.memory.buffer).getUint32(lengthAt, true);
    const bytes = copyOut(at, length);
    deps.tn_free(at);
    return bytes;
  });
}
const latin1 = (bytes: Uint8Array | null): string | undefined =>
  bytes === null ? undefined : new TextDecoder('latin1').decode(bytes);
const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** GetX509NameObject (crypto_x509.cc:611-667): a null-prototype object, an array where a key repeats. */
function nameObject(x: number, issuer: boolean): Record<string, unknown> | undefined {
  const bytes = answer((lengthAt) => nodeDeps().tn_x509_name(x, issuer ? 1 : 0, lengthAt));
  if (bytes === null) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  const parts = utf8(bytes).split('\0');
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const key = parts[index]!;
    const value = parts[index + 1]!;
    if (key in result) {
      const accumulated = result[key];
      if (Array.isArray(accumulated)) accumulated.push(value);
      else result[key] = [accumulated, value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** X509ToObject (crypto_x509.cc:720-855) of the certificate `x` (an `X509*` of the module). */
export function x509ToObject(x: number): Certificate {
  const deps = nodeDeps();
  const text = (field: number) => latin1(answer((lengthAt) => deps.tn_x509_text(x, field, lengthAt)));
  const usage = answer((lengthAt) => deps.tn_x509_key_usage(x, lengthAt));
  const pubkey = answer((lengthAt) => deps.tn_x509_pubkey(x, lengthAt));
  const bits = deps.tn_x509_bits(x);
  const raw = withScratch(4, (outAt) => {
    const length = deps.tn_x509_der(x, outAt) >>> 0;
    const at = new DataView(deps.memory.buffer).getUint32(outAt, true);
    const bytes = copyOut(at, length);
    deps.tn_free(at);
    return bytes;
  });
  return {
    subject: nameObject(x, false),
    issuer: nameObject(x, true),
    subjectaltname: text(0),
    infoAccess: text(1),
    ca: deps.tn_x509_is_ca(x) !== 0,
    modulus: text(8),
    exponent: text(9),
    pubkey: pubkey === null ? undefined : Buffer.from(pubkey),
    bits: bits < 0 ? undefined : bits,
    valid_from: text(2),
    valid_to: text(3),
    fingerprint: text(4),
    fingerprint256: text(5),
    fingerprint512: text(6),
    ext_key_usage: usage === null ? undefined : latin1(usage)!.split('\0').slice(0, -1),
    serialNumber: text(7),
    raw: Buffer.from(raw),
    asn1Curve: text(10),
    nistCurve: text(11),
  };
}

/** A DER certificate copied out of the module, parsed into a new `X509*` of it (freed by the caller). */
export function x509FromDer(der: Uint8Array): number {
  return withBytes(der, (at, length) => nodeDeps().tn_x509_from_der(at, length)) >>> 0;
}

/** A module answer `(…, unsigned char** out) => size_t` as DER bytes. */
export function derAnswer(call: (outAt: number) => number): Uint8Array | null {
  const deps = nodeDeps();
  return withScratch(4, (outAt) => {
    const length = call(outAt) >>> 0;
    const at = new DataView(deps.memory.buffer).getUint32(outAt, true);
    if (!length || !at) return null;
    const bytes = copyOut(at, length);
    deps.tn_free(at);
    return bytes;
  });
}

/**
 * GetPeerCert (crypto_common.cc:289-345): the peer's certificate, or, `detailed`, with `issuerCertificate` linked
 * through the peer's chain (AddIssuerChainToObject) and then the context's store (GetLastIssuedCert), the last one
 * pointing at itself when self-signed. On a client the chain holds the leaf; on a server it does not.
 */
export function peerCertificate(ssl: number, abbreviated: boolean, isServer: boolean): Certificate | undefined {
  const deps = nodeDeps();
  const ders: Uint8Array[] = [];
  if (isServer) {
    const leaf = derAnswer((outAt) => deps.tn_ssl_peer_certificate(ssl, outAt));
    if (leaf) ders.push(leaf);
  }
  const chainLength = deps.tn_ssl_peer_chain_length(ssl);
  for (let index = 0; index < chainLength; index++) {
    const der = derAnswer((outAt) => deps.tn_ssl_peer_chain_certificate(ssl, index, outAt));
    if (der) ders.push(der);
  }
  if (ders.length === 0) return undefined;
  const certs = ders.map(x509FromDer);
  try {
    const first = x509ToObject(certs[0]!);
    if (abbreviated) return first;
    // AddIssuerChainToObject (crypto_common.cc:103-137).
    let cert = certs.shift()!;
    let object = first;
    const owned = [cert];
    for (;;) {
      const index = certs.findIndex((ca) => deps.tn_x509_issued_by(cert, ca) !== 0);
      if (index < 0) break;
      const caInfo = x509ToObject(certs[index]!);
      object.issuerCertificate = caInfo;
      object = caInfo;
      cert = certs.splice(index, 1)[0]!;
      owned.push(cert);
    }
    // GetLastIssuedCert (crypto_common.cc:139-171).
    while (deps.tn_x509_issued_by(cert, cert) === 0) {
      const ca = deps.tn_ssl_issuer_from_store(ssl, cert) >>> 0;
      if (!ca) break;
      const caInfo = x509ToObject(ca);
      object.issuerCertificate = caInfo;
      object = caInfo;
      if (ca === cert) { deps.tn_x509_free(ca); break; }
      owned.push(ca);
      cert = ca;
    }
    if (deps.tn_x509_issued_by(cert, cert) !== 0) object.issuerCertificate = object;
    for (const x of owned) deps.tn_x509_free(x);
    return first;
  } finally {
    for (const x of certs) deps.tn_x509_free(x);
  }
}

/** GetCert (crypto_common.cc:76-84): this end's own certificate, or undefined. */
export function ownCertificate(ssl: number): Certificate | undefined {
  const der = derAnswer((outAt) => nodeDeps().tn_ssl_certificate(ssl, outAt));
  if (!der) return undefined;
  const x = x509FromDer(der);
  try { return x509ToObject(x); } finally { nodeDeps().tn_x509_free(x); }
}
