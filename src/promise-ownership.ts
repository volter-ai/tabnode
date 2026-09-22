// A browser rejection event belongs to one guest, not every run sharing the
// worker. Keep provenance on the promise itself; the active/last process at
// event-delivery time is not necessarily the process which rejected it.
const owners = new WeakMap<object, object>();
const constructors = new WeakMap<object, PromiseConstructor>();
export const intrinsicPromise = Promise;

export function promiseOwner(promise: unknown): object | undefined {
  return promise !== null && typeof promise === 'object' ? owners.get(promise) : undefined;
}

export function guestPromise(owner: object): PromiseConstructor {
  let constructor = constructors.get(owner);
  if (!constructor) {
    // Used only by the runtime's existing `new Identifier(...)` seam. The
    // visible global stays native, including prototype/resolve identity.
    // Unobserved async/static/species construction retains unknown ownership.
    constructor = new Proxy(intrinsicPromise, {
      construct(target, args) {
        const promise = Reflect.construct(target, args, target);
        owners.set(promise, owner);
        return promise;
      },
    });
    constructors.set(owner, constructor);
  }
  return constructor;
}
