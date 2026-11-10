/**
 * The two `internal/crypto/*` names Node's own `tls` files read (ADR-0016 §4), hand-bound because the engine's
 * `crypto` is its own (BUILTINS.md, Kind 2; ADR-0016 §5):
 * - `internal/crypto/util`'s `toBuf`, which `internal/tls/secure-context.js` takes; its body is Node's
 *   (lib/internal/crypto/util.js:107-114).
 * - `internal/crypto/x509`'s `InternalX509Certificate`, which `internal/tls/wrap.js` takes for
 *   `getPeerX509Certificate()`/`getX509Certificate()`. Node's class is `crypto`'s `X509Certificate`, whose `publicKey`
 *   is a `KeyObject` of `internal/crypto/keys`, the engine's own; it is refused by name (ADR-0016 §4). A handshake never
 *   constructs one.
 */
import { Buffer } from '../buffer-module';
import { refusal } from '../binding/crypto';

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
    throw refusal('X509Certificate of a TLS socket (getPeerX509Certificate, getX509Certificate); ' +
      'getPeerCertificate() answers');
  }
}

export const internalCryptoX509 = { InternalX509Certificate };
