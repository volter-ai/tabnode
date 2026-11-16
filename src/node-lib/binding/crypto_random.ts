/**
 * THE RANDOMNESS OF THE crypto BINDING (ADR-0018 item 7): the V8 half of Node v24.21.0's `src/crypto/crypto_random.cc`
 * (RandomBytesJob, RandomPrimeJob, CheckPrimeJob) and of crypto_util.cc's secureBuffer and secureHeapUsed, over the
 * OpenSSL half (native/node/crypto_random.cc), whose randomness is the kernel's getrandom. The device has no
 * randomness call, so OpenSSL answers each of these (ADR-0018 §5).
 */
import { withBytes } from './openssl';
import { CryptoJob, bufferSource, cppError, glue, toArrayBuffer } from './crypto_util';

/** RandomBytesJob (RandomBytesTraits, 39-62): the bytes are written into the buffer at its offset when it completes. */
export class RandomBytesJob extends CryptoJob {
  private readonly target: Uint8Array;
  private readonly offset: number;
  constructor(mode: number, buffer: unknown, offset: number, size: number) {
    super(mode);
    this.target = bufferSource(buffer);
    this.offset = offset >>> 0;
    this.adopt(glue().tabnode_random_bytes_job_new(mode, this.target.byteLength, this.offset, size >>> 0));
  }
  /** EncodeOutput (36-38): undefined, the buffer filled (in place, in Node). */
  protected encode(): unknown {
    this.target.set(this.out(), this.offset);
    return undefined;
  }
}

/** RandomPrimeJob (RandomPrimeTraits, 75-150). */
export class RandomPrimeJob extends CryptoJob {
  constructor(mode: number, size: number, safe: boolean, add?: unknown, rem?: unknown) {
    super(mode);
    const exports = glue();
    const optional = (value: unknown, use: (at: number, length: number) => number): number =>
      (value === undefined ? use(0, 0) : withBytes(bufferSource(value), use));
    this.adopt(optional(add, (addAt, addLength) => optional(rem, (remAt, remLength) =>
      exports.tabnode_random_prime_job_new(mode, size >>> 0, safe ? 1 : 0, addAt, addLength, remAt, remLength))));
  }
  protected encode(): unknown { return toArrayBuffer(this.out()); }
}

/** CheckPrimeJob (CheckPrimeTraits, 152-197). */
export class CheckPrimeJob extends CryptoJob {
  constructor(mode: number, candidate: unknown, checks: number) {
    super(mode);
    const exports = glue();
    this.adopt(withBytes(bufferSource(candidate), (at, length) =>
      exports.tabnode_check_prime_job_new(mode, at, length, checks | 0)));
  }
  protected encode(): unknown { return this.out()[0] !== 0; }
}

/**
 * SecureBuffer (crypto_util.cc:795-845): a Uint8Array of `size` bytes. Node's is a view of OpenSSL's secure heap; a
 * JavaScript buffer here cannot be a view of the process's memory, so it is the realm's, as a V8 sandbox's buffer is
 * the isolate's. Node's "Allocation failed" stands where the secure heap would refuse the allocation.
 */
function secureBuffer(size: number): Uint8Array {
  if (!glue().tabnode_secure_alloc_check(size >>> 0)) throw cppError('ERR_OPERATION_FAILED', 'Allocation failed');
  return new Uint8Array(size >>> 0);
}

/** SecureHeapUsed (crypto_util.cc:870-873). */
function secureHeapUsed(): bigint { return BigInt(glue().tabnode_secure_heap_used()); }

export const randomBinding = { RandomBytesJob, RandomPrimeJob, CheckPrimeJob, secureBuffer, secureHeapUsed };
