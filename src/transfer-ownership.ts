/** Node's untransferable mark: ownership survives clone but forbids transfer. */
const untransferable = new WeakSet<object>();

export function markUntransferable(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    untransferable.add(value as object);
  }
}

export function isUntransferable(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') &&
    untransferable.has(value as object);
}

/** Keep the host transport/clone operation; refuse before it detaches owned bytes. */
export function validateTransferList(list?: Iterable<unknown>): void {
  if (list === undefined) return;
  for (const value of list) {
    if (isUntransferable(value)) {
      throw new DOMException('Cannot transfer object of unsupported type.', 'DataCloneError');
    }
  }
}
