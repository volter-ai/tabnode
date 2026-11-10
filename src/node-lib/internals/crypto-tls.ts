/**
 * The two `internal/crypto/*` names Node's own `tls` files read (ADR-0016 §4), hand-bound until `crypto` itself is
 * Node's files over node-deps.wasm (ADR-0016 §5):
 * - `internal/crypto/util`'s `toBuf`, which `internal/tls/secure-context.js` takes; its body is Node's
 *   (lib/internal/crypto/util.js:107-114).
 * - `internal/crypto/x509`'s `InternalX509Certificate`, which `internal/tls/wrap.js` takes for
 *   `getPeerX509Certificate()`/`getX509Certificate()`. Node's class is `crypto`'s `X509Certificate`, which needs
 *   `internal/crypto/keys` on OpenSSL; until then it is refused by name. A handshake never constructs one.
 */
import { Buffer } from '../buffer-module';
import { nodeLibInternalRequire } from '../load';

function toBuf(val: unknown, encoding?: string): unknown {
  if (typeof val === 'string') {
    if (encoding === 'buffer') encoding = 'utf8';
    return Buffer.from(val, encoding as never);
  }
  return val;
}

export const internalCryptoUtil = { toBuf };

class InternalX509Certificate {
  constructor() {
    const { ERR_FEATURE_UNAVAILABLE_ON_PLATFORM } = (nodeLibInternalRequire('internal/errors') as any).codes;
    throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM(
      'X509Certificate from a TLS socket (getPeerX509Certificate, getX509Certificate) before crypto is OpenSSL\'s; ' +
      'getPeerCertificate() answers');
  }
}

export const internalCryptoX509 = { InternalX509Certificate };
