/** Binding evidence only; the substrate buffers these lines until first HTTP or exit. */
interface SocketIdentity { pid: number | null; id: number | null; socketId: number | null; request: number | null }
const sockets = new WeakMap<object, SocketIdentity>();

export function rememberSocketConnect(socket: object, identity: SocketIdentity): void {
  sockets.set(socket, identity);
}

/** Read Node's existing state, without adding a listener or changing its timer. */
export function traceSocketConnect(stage: string, socket: unknown, timer: unknown, status?: number, request?: number): void {
  if (!socket || typeof socket !== 'object') return;
  const identity = sockets.get(socket);
  if (!identity) return;
  try {
    if (request !== undefined) identity.request = request;
    const view = socket as { connecting?: boolean; destroyed?: boolean; timeout?: number; _events?: { connect?: unknown } };
    const listeners = view._events?.connect;
    console.log('[socket-connect]', JSON.stringify({ at: performance.timeOrigin + performance.now(), stage, ...identity,
      ...(status === undefined ? {} : { status }), connecting: view.connecting, destroyed: view.destroyed,
      timeoutMs: view.timeout ?? null, timerDestroyed: (timer as { _destroyed?: boolean } | null | undefined)?._destroyed ?? null,
      connectListeners: typeof listeners === 'function' ? 1 : Array.isArray(listeners) ? listeners.length : 0 }));
  } catch { /* diagnostic output cannot change callback or timer delivery */ }
}
