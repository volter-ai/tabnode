/**
 * Service Worker for Mini WebContainers
 * Intercepts fetch requests and routes them to virtual servers
 * Version: 16 - a host per page: each page's channel, servers and preview are its own
 */

const DEBUG = false;

// Every page that holds a container's servers is a host of its own: its own
// channel, its own servers, its own preview. Two pages of one origin, each
// with its container, share this worker and never each other's ports. A host
// is keyed by the id of the window that sent `init`.
const hosts = new Map();
let latestHost = null;
// An `init` whose sender is unknown replaces the previous such channel.
const UNNAMED_HOST = 'unnamed-host';
// The documents and workers a host's servers made, by client id, so their
// requests reach the host that served them.
const clientHosts = new Map();
// The event a request arrived with, so every route to a server can ask which
// host it is for without the event being passed along.
const requestEvents = new WeakMap();

function openHost(id, channel) {
  const previous = hosts.get(id);
  if (previous) {
    for (const pending of pendingRequests.values()) {
      if (pending.host === previous && pending.flowControl === 1) pending.fail(new Error('Host connection replaced'));
    }
    for (const upload of controlledUploads) {
      if (upload.host === previous) upload.controller.abort(new Error('Host connection replaced'));
    }
    previous.port.onmessage = null;
    previous.port.close();
  }
  const host = {
    id,
    port: channel,
    registeredPorts: new Set(),
    flowControlledPorts: new Map(),
    primaryPort: null,
    ownDocuments: new Set(),
  };
  hosts.set(id, host);
  latestHost = host;
  void pruneClients();
  return host;
}

/** The host a client belongs to: a host's own window, or a document or worker one of its servers made. */
function ownerOf(clientId) {
  if (!clientId) return null;
  return hosts.get(clientId) ?? hosts.get(clientHosts.get(clientId)) ?? null;
}

/**
 * The host a request is for. One host is the answer while there is one. With
 * more, the requesting client's own host; else the host that owns the
 * document named by the referrer, which is how a frame's navigation carries
 * its parent; else the only host holding the port; else the latest host.
 */
async function hostForEvent(event, port) {
  if (hosts.size === 0) return null;
  if (hosts.size === 1) return hosts.values().next().value;
  const direct = ownerOf(event.clientId);
  if (direct) return direct;
  const referrer = event.request.referrer;
  if (referrer) {
    const all = await self.clients.matchAll({ type: 'all', includeUncontrolled: true });
    const owners = new Set(all.filter((client) => client.url === referrer).map((client) => ownerOf(client.id)).filter(Boolean));
    if (owners.size === 1) return owners.values().next().value;
  }
  if (port !== undefined) {
    const holding = [...hosts.values()].filter((host) => host.registeredPorts.has(port));
    if (holding.length === 1) return holding[0];
  }
  return latestHost;
}

/** The host a request is for, found through the event it arrived with; remembers the clients it makes. */
async function hostForRequest(request, port) {
  const event = requestEvents.get(request);
  const host = event ? await hostForEvent(event, port) : latestHost;
  if (host && event) {
    if (event.resultingClientId) clientHosts.set(event.resultingClientId, host.id);
    if (event.clientId && !hosts.has(event.clientId)) clientHosts.set(event.clientId, host.id);
  }
  return host;
}

// Pending requests waiting for response
const pendingRequests = new Map();
let requestId = 0;

// HTTP response flow control is a transport property, never a path/package
// heuristic. Legacy ports keep their existing protocol until their host opts
// in; each host's `flowControlledPorts` holds what its ports negotiated.
const controlledUploads = new Set();
const MAX_STREAM_CHUNK_BYTES = 65536;

function updateFlowControl(host, type, data) {
  if (type === 'server-registered' || type === 'server-unregistered') {
    for (const upload of controlledUploads) {
      if (upload.host === host && upload.port === data?.port) upload.controller.abort(new Error('Virtual server registration changed'));
    }
    // A port number is not a listener identity. Rebinding must terminate the
    // old connection, even when the replacement advertises identical limits.
    // Otherwise an already-headed response can wait forever on its old owner.
    for (const pending of pendingRequests.values()) {
      if (pending.host === host && pending.flowControl === 1 && pending.port === data?.port)
        pending.fail(new Error(type === 'server-unregistered'
          ? 'Virtual server closed' : 'Virtual server registration changed'));
    }
  }
  if (type === 'server-unregistered') {
    host.flowControlledPorts.delete(data?.port);
  }
  if (type !== 'server-registered' || !data) return;
  if (data.flowControl === 1 && Number.isSafeInteger(data.maxRequestBytes)
      && data.maxRequestBytes > 0 && data.maxChunkBytes === MAX_STREAM_CHUNK_BYTES) {
    host.flowControlledPorts.set(data.port, { maxRequestBytes: data.maxRequestBytes, channel: host.port });
  } else host.flowControlledPorts.delete(data.port);
}

/**
 * Decode base64 string to Uint8Array
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Handle messages from main thread
 */
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  DEBUG && console.log('[SW] Received message:', type, 'hasPort in event.ports:', event.ports?.length > 0);

  // When a MessagePort is transferred, it's in event.ports[0], not event.data.port
  const source = event.source && event.source.id ? hosts.get(event.source.id) : null;

  if (type === 'init' && event.ports && event.ports[0]) {
    // A page's channel replaces only that page's: another page's requests
    // and servers are its own. Existing preview documents/workers retain
    // their virtual origin identity; a channel reconnect must not send their
    // root-relative requests to network.
    const mainPort = event.ports[0];
    const host = openHost(event.source && event.source.id ? event.source.id : UNNAMED_HOST, mainPort);
    const initializedPort = mainPort;
    mainPort.onmessage = (message) => {
      if (hosts.get(host.id) === host && host.port === initializedPort) handleMainMessage(host, message);
    };
    if (data && Array.isArray(data.ownDocuments)) host.ownDocuments = new Set(data.ownDocuments.map((path) => ownPath(String(path))));
    DEBUG && console.log('[SW] Initialized communication channel with transferred port');
    // Re-claim clients so that pages opened after SW activation get controlled.
    // Without this, controllerchange never fires for late-arriving pages.
    self.clients.claim();
  }

  if (type === 'server-registered' && data && source) {
    source.registeredPorts.add(data.port);
    if (data.primary) source.primaryPort = data.port;
    DEBUG && console.log(`[SW] Server registered on port ${data.port}`);
  }

  if (type === 'server-unregistered' && data && source) {
    source.registeredPorts.delete(data.port);
    if (source.primaryPort === data.port) source.primaryPort = null;
    DEBUG && console.log(`[SW] Server unregistered from port ${data.port}`);
  }
});

/**
 * Handle response messages from main thread
 */
function handleMainMessage(host, event) {
  const { type, id, data, error } = event.data;
  updateFlowControl(host, type, data);

  const controlled = pendingRequests.get(id);
  // A request is answered only by the host it was sent to.
  if (controlled && controlled.host !== host) return;
  if (controlled?.flowControl === 1) {
    controlled.message(type, data, error);
    return;
  }

  // The page's bridge speaks over this port: which servers it holds, which
  // is the preview's, and which documents are the page's own frames.
  if (type === 'server-registered' && data) {
    host.registeredPorts.add(data.port);
    if (data.primary) host.primaryPort = data.port;
    else if (host.primaryPort === data.port) host.primaryPort = null;
    return;
  }
  if (type === 'server-unregistered' && data) {
    host.registeredPorts.delete(data.port);
    if (host.primaryPort === data.port) host.primaryPort = null;
    return;
  }
  if (type === 'own-documents' && data && Array.isArray(data.paths)) {
    host.ownDocuments = new Set(data.paths.map((path) => ownPath(String(path))));
    return;
  }

  DEBUG && console.log('[SW] Received message from main:', type, 'id:', id);

  if (type === 'response') {
    const pending = pendingRequests.get(id);
    DEBUG && console.log('[SW] Looking for pending request:', id, 'found:', !!pending);

    if (pending) {
      pendingRequests.delete(id);

      if (error) {
        DEBUG && console.log('[SW] Response error:', error);
        pending.reject(new Error(error));
      } else {
        DEBUG && console.log('[SW] Response data:', {
          statusCode: data?.statusCode,
          statusMessage: data?.statusMessage,
          headers: data?.headers,
          bodyType: data?.body?.constructor?.name,
          bodyLength: data?.body?.length || data?.body?.byteLength,
        });
        pending.resolve(data);
      }
    }
  }

  // Handle streaming responses
  if (type === 'stream-start') {
    DEBUG && console.log('[SW] stream-start received, id:', id);
    const pending = pendingRequests.get(id);
    if (pending && pending.streamController) {
      // Store headers/status for the streaming response
      pending.streamData = data;
      pending.resolveHeaders(data);
      DEBUG && console.log('[SW] headers resolved for stream', id);
    } else {
      DEBUG && console.log('[SW] No pending request or controller for stream-start', id, !!pending, pending?.streamController);
    }
  }

  if (type === 'stream-chunk') {
    DEBUG && console.log('[SW] stream-chunk received, id:', id, 'size:', data?.chunkBase64?.length);
    const pending = pendingRequests.get(id);
    if (pending && pending.streamController) {
      try {
        // Decode base64 chunk and enqueue
        if (data.chunkBase64) {
          const bytes = base64ToBytes(data.chunkBase64);
          pending.streamController.enqueue(bytes);
          DEBUG && console.log('[SW] chunk enqueued, bytes:', bytes.length);
        }
      } catch (e) {
        console.error('[SW] Error enqueueing chunk:', e);
      }
    } else {
      DEBUG && console.log('[SW] No pending request or controller for stream-chunk', id);
    }
  }

  if (type === 'stream-end') {
    DEBUG && console.log('[SW] stream-end received, id:', id);
    const pending = pendingRequests.get(id);
    if (pending && pending.streamController) {
      try {
        pending.streamController.close();
        DEBUG && console.log('[SW] stream closed');
      } catch (e) {
        DEBUG && console.log('[SW] stream already closed');
      }
      pendingRequests.delete(id);
    }
  }
}

/**
 * Send request to main thread and wait for response
 */
async function sendRequest(host, port, method, url, headers, body) {
  DEBUG && console.log('[SW] sendRequest called, host:', !!host, 'url:', url);

  if (!host) {
    throw new Error('Service Worker not initialized - no connection to main thread');
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { host, resolve, reject });

    // Set timeout for request
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);

    host.port.postMessage({
      type: 'request',
      id,
      data: { port, method, url, headers, body },
    });
  });
}

/**
 * Send streaming request to main thread
 * Returns a ReadableStream that receives chunks from main thread
 */
async function sendStreamingRequest(host, port, method, url, headers, body) {
  DEBUG && console.log('[SW] sendStreamingRequest called, url:', url);

  if (!host) {
    throw new Error('Service Worker not initialized');
  }

  const id = ++requestId;

  let streamController;
  let resolveHeaders;
  const headersPromise = new Promise(resolve => { resolveHeaders = resolve; });

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;

      // Store in pending requests so handleMainMessage can find it
      pendingRequests.set(id, {
        host,
        resolve: () => {},
        reject: (err) => controller.error(err),
        streamController: controller,
        resolveHeaders,
      });

      // Send request to main thread with streaming flag
      host.port.postMessage({
        type: 'request',
        id,
        data: { port, method, url, headers, body, streaming: true },
      });
    },
    cancel() {
      pendingRequests.delete(id);
    }
  });

  return { stream, headersPromise, id };
}

// A Node HTTP producer must stop when its consumer stops reading and must
// observe disconnect. One pull credit bounds the service-worker response queue;
// this protocol requires a paired host bridge and is negotiated per port.
async function sendControlledRequest(host, port, method, url, headers, body, signal) {
  if (!host) throw new Error('Service Worker not initialized');
  if (signal.aborted) throw signal.reason;
  const channel = host.port;
  const id = ++requestId;
  let controller, resolveHeaders, rejectHeaders, resolvePull;
  let headed = false, credited = false, ended = false;
  const headersPromise = new Promise((resolve, reject) => {
    resolveHeaders = resolve;
    rejectHeaders = reject;
  });
  // A synchronous postMessage failure can happen before the first await.
  void headersPromise.catch(() => {});
  const send = (type) => channel.postMessage({ type, id });
  const finish = () => {
    ended = true;
    clearTimeout(headerTimeout);
    pendingRequests.delete(id);
    signal.removeEventListener('abort', abort);
    resolvePull?.();
    resolvePull = undefined;
  };
  const fail = (error, notify = true) => {
    if (ended) return;
    if (notify) {
      try { send('stream-cancel'); } catch { /* connection gone */ }
    }
    rejectHeaders(error);
    controller.error(error);
    finish();
  };
  const abort = () => fail(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
  // Match the existing buffered request's finite header wait. A disappeared
  // Host must not retain this request forever when no AbortSignal fires.
  const headerTimeout = setTimeout(() => fail(new Error('Request header timeout')), 30000);
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull() {
      if (ended) return;
      if (credited) throw new Error('Duplicate stream credit');
      credited = true;
      return new Promise((resolve) => {
        resolvePull = resolve;
        try { send('stream-pull'); } catch (error) { fail(error, false); }
      });
    },
    cancel() {
      if (ended) return;
      try { send('stream-cancel'); } finally { finish(); }
    },
  }, { highWaterMark: 0 });
  pendingRequests.set(id, {
    host,
    flowControl: 1,
    fail,
    port,
    message(type, data, error) {
      try {
        if (type === 'stream-start' && !headed) {
          headed = true;
          clearTimeout(headerTimeout);
          resolveHeaders(data);
        } else if (type === 'stream-chunk' && headed && credited) {
          if (typeof data?.chunkBase64 !== 'string'
              || data.chunkBase64.length > Math.ceil(MAX_STREAM_CHUNK_BYTES / 3) * 4)
            throw new Error('Stream chunk exceeds transport limit');
          const bytes = base64ToBytes(data.chunkBase64);
          if (bytes.byteLength > MAX_STREAM_CHUNK_BYTES)
            throw new Error('Stream chunk exceeds transport limit');
          credited = false;
          controller.enqueue(bytes);
          resolvePull?.();
          resolvePull = undefined;
        } else if (type === 'stream-end' && headed) {
          controller.close();
          finish();
        } else if (type === 'stream-error' || (type === 'response' && error)) {
          fail(new Error(error || data?.message || 'Host stream failed'), false);
        } else throw new Error('Invalid flow-controlled stream message');
      } catch (cause) { fail(cause); }
    },
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    channel.postMessage({ type: 'request', id,
      data: { port, method, url, headers, body, streaming: true, flowControl: 1 } });
    if (signal.aborted) abort();
    const head = await headersPromise;
    const noBody = method === 'HEAD' || [204, 205, 304].includes(head.statusCode);
    if (noBody) await stream.cancel();
    // Match the existing virtual-port document isolation policy. Negotiating
    // flow control must not turn a working preview into a blocked iframe.
    const responseHeaders = new Headers(head.headers);
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    responseHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
    responseHeaders.delete('X-Frame-Options');
    return new Response(noBody ? null : stream, {
      status: head.statusCode, statusText: head.statusMessage, headers: responseHeaders,
    });
  } catch (error) {
    fail(error);
    throw error;
  }
}

async function readRequestBody(request, limit, registrationSignal) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  const checkAbort = () => {
    if (request.signal.aborted) throw request.signal.reason;
    if (registrationSignal.aborted) throw registrationSignal.reason;
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', abort, { once: true });
  registrationSignal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkAbort();
      const { value, done } = await reader.read();
      checkAbort();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw Object.assign(new Error('Request body exceeds transport limit'), { status: 413 });
      chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
    registrationSignal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

// The preview's server, whose documents are served at this origin's root as
// they would be at their own origin: an app reads its routes from
// `location.pathname`, and a document under /__virtual__/<port>/ is not at
// the path its router expects.
// Each host's `primaryPort`. The page's own documents that are frames of it,
// told by `init`, are each host's `ownDocuments`, so a nested document at one
// of these paths is the page's and not the preview's.
// The documents and workers served from a virtual server at the root, by
// client id, so their requests reach that server without a prefix to read.
const rootedClients = new Map();
const pendingBlobContexts = new Map();

// Blob workers have no script fetch at which to remember resultingClientId,
// and their URL contains no virtual port. Ask the creating preview document
// to identify its object URL, then derive the port from that document's own
// routing context. The document supplies ownership, never a trusted port.
// Querying also recovers attribution after this service worker restarts.
async function blobWorkerContext(client, requestUrl) {
  if (pendingBlobContexts.has(client.id)) return pendingBlobContexts.get(client.id);
  const pending = (async () => {
    const windows = await self.clients.matchAll({ type: 'window' });
    const candidates = await Promise.all(windows.map(async (owner) => {
      const context = await virtualContext({ clientId: owner.id, request: {
        url: requestUrl, referrer: owner.url, mode: 'cors', destination: '',
      } });
      if (!context) return null;
      const host = ownerOf(owner.id);
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        const finish = (value) => { clearTimeout(timer); channel.port1.close(); resolve(value); };
        const timer = setTimeout(() => finish(null), 1000);
        channel.port1.onmessage = (event) => finish(event.data === true ? { context, host } : null);
        try { owner.postMessage({ type: 'virtual-blob-owner', url: client.url }, [channel.port2]); }
        catch { finish(null); }
      });
    }));
    const owners = candidates.filter(Boolean);
    if (owners.length === 0) return null;
    if (owners.some(owner => owner.context.port !== owners[0].context.port || owner.host !== owners[0].host)) throw new Error('Ambiguous virtual blob owner');
    rootedClients.set(client.id, owners[0].context.port);
    if (owners[0].host) clientHosts.set(client.id, owners[0].host.id);
    if (rootedClients.size > 256) pruneClients();
    return owners[0].context;
  })();
  pendingBlobContexts.set(client.id, pending);
  try { return await pending; } finally { pendingBlobContexts.delete(client.id); }
}

/**
 * The virtual server a request outside /__virtual__/ is for, if any: the
 * one a document under /__virtual__/<port>/ was served from (`prefix` set),
 * or the one a document at the root was served from (`prefix` null). A
 * frame's navigation to a path of this origin is the preview's server's
 * when the path is not one of the page's own frame documents, which the
 * page names at `init`. A request from a document
 * or worker served at the root is remembered by its client id; after the
 * worker restarts, a nested document at a path that is not the page's own
 * is the preview's.
 */
async function virtualContext(event) {
  const url = new URL(event.request.url);
  let client = null;
  if (event.clientId) {
    try { client = await self.clients.get(event.clientId); } catch (e) { /* no client */ }
  }
  // A worker that restarted remembers no primary server and no rooted
  // document. A request that could be the preview's, from a nested document
  // or a frame's navigation, asks the page for its registrations first, as a
  // virtual request asks for its port, so a restart does not send the
  // preview's own requests to the network.
  if (hosts.size === 0 && ((client && client.frameType === 'nested') || (event.request.mode === 'navigate' && (event.request.destination === 'iframe' || event.request.destination === 'frame')))) {
    await askForInit();
  }
  const contextUrl = event.request.referrer || (client ? client.url : '');
  if (contextUrl) {
    try {
      const contextMatch = new URL(contextUrl).pathname.match(/^\/__virtual__\/(\d+)/);
      if (contextMatch) return { prefix: contextMatch[0], port: parseInt(contextMatch[1], 10) };
    } catch (e) { /* not a URL */ }
  }
  if (event.clientId && rootedClients.has(event.clientId)) return { prefix: null, port: rootedClients.get(event.clientId) };
  if (client && (client.type === 'worker' || client.type === 'sharedworker') && client.url.startsWith('blob:')) {
    return blobWorkerContext(client, event.request.url);
  }
  const host = await hostForEvent(event);
  if (!host || host.primaryPort === null) return null;
  if (event.request.mode === 'navigate') {
    if (event.request.destination !== 'iframe' && event.request.destination !== 'frame') return null;
    if (host.ownDocuments.has(ownPath(url.pathname))) return null;
    return { prefix: null, port: host.primaryPort };
  }
  if (client && client.frameType === 'nested' && !host.ownDocuments.has(ownPath(new URL(client.url).pathname))) return { prefix: null, port: host.primaryPort };
  return null;
}

/** A path as the page names its own documents: without a trailing slash. */
function ownPath(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** Asks every window for the page's registrations and waits for them, as a request waits for its port. */
async function askForInit() {
  const allClients = await self.clients.matchAll({ type: 'window' });
  for (const client of allClients) client.postMessage({ type: 'sw-needs-init' });
  await new Promise((resolve) => {
    const check = setInterval(() => { if (hosts.size > 0) { clearInterval(check); resolve(); } }, 50);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });
}

/** Answers a request for a virtual server at the root, remembering the document or worker it makes. */
function handleRootedRequest(event, port, path) {
  if (event.resultingClientId) {
    rootedClients.set(event.resultingClientId, port);
    if (rootedClients.size > 256) pruneClients();
  }
  return handleVirtualRequest(event.request, port, path, true);
}

/** Forgets the documents, workers and hosts that are gone. */
async function pruneClients() {
  const alive = new Set((await self.clients.matchAll({ type: 'all', includeUncontrolled: true })).map((client) => client.id));
  for (const id of [...rootedClients.keys()]) if (!alive.has(id)) rootedClients.delete(id);
  for (const [id, host] of [...clientHosts]) if (!alive.has(id) || !hosts.has(host)) clientHosts.delete(id);
  for (const [id, host] of [...hosts]) {
    if (alive.has(id) || id === UNNAMED_HOST) continue;
    hosts.delete(id);
    host.port.onmessage = null;
    host.port.close();
    if (latestHost === host) latestHost = [...hosts.values()].pop() ?? null;
  }
}

/**
 * Intercept fetch requests
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  requestEvents.set(event.request, event);

  DEBUG && console.log('[SW] Fetch:', url.pathname, 'hosts:', hosts.size);

  // Check if this is a virtual server request
  const match = url.pathname.match(/^\/__virtual__\/(\d+)(\/.*)?$/);

  if (!match) {
    // Not a virtual request, but perhaps from a virtual document: a plain
    // <a href="/about">, an <img src="/x">, a fetch("/api/x") from a page
    // under /__virtual__/<port>/ is that server's. The document is found by
    // the request's client id, which every request from a document carries;
    // the referrer, which a document sent with no referrer never has, is
    // the fallback. A document at the root is the preview's server's, and
    // its own requests are that server's with it.
    if (event.request.referrer || event.clientId || (event.request.mode === 'navigate' && [...hosts.values()].some((host) => host.primaryPort !== null))) {
      event.respondWith((async () => {
        const context = await virtualContext(event);
        if (!context) return fetch(event.request);
        const targetPath = url.pathname + url.search;
        if (context.prefix === null) {
          DEBUG && console.log('[SW] Answering a root request from the virtual server:', url.pathname);
          return handleRootedRequest(event, context.port, targetPath);
        }
        if (event.request.mode === 'navigate') {
          DEBUG && console.log('[SW] Redirecting navigation from virtual context:', url.pathname);
          return Response.redirect(url.origin + context.prefix + targetPath, 302);
        }
        DEBUG && console.log('[SW] Forwarding resource from virtual context:', url.pathname);
        return handleVirtualRequest(event.request, context.port, targetPath);
      })());
    }
    // Not a virtual request, let it pass through
    return;
  }

  DEBUG && console.log('[SW] Virtual request:', url.pathname);

  const port = parseInt(match[1], 10);
  const path = match[2] || '/';

  event.respondWith(handleVirtualRequest(event.request, port, path + url.search));
});

/**
 * Handle a request to a virtual server
 */
async function handleVirtualRequest(request, port, path, rooted = false) {
  try {
    if (hosts.size === 0) await askForInit();
    const host = await hostForRequest(request, port);
    const registration = host ? host.flowControlledPorts.get(port) : undefined;
    // Build headers object
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Fetch omits Host from Request.headers. Preserve the authority addressed
    // by the browser, as an HTTP socket would, rather than letting the server
    // substitute its listening port. Routing to a virtual port does not change
    // the client's authority; server-generated resource identities must agree
    // with those the client computes from its own URL.
    if (headers.host === undefined) headers.host = new URL(request.url).host;

    // Get body if present
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (registration) {
        const upload = { host, port, controller: new AbortController() };
        controlledUploads.add(upload);
        try {
          body = await readRequestBody(request, registration.maxRequestBytes, upload.controller.signal);
        } finally { controlledUploads.delete(upload); }
      } else body = await request.arrayBuffer();
      // A body's length is a header Node's server always has, content-length
      // or a chunked transfer-encoding; a fetch's headers carry neither, and
      // Express 5's body parser takes their absence for no body at all.
      if (body && body.byteLength > 0 && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
        headers['content-length'] = String(body.byteLength);
      }
    }

    if (registration) {
      if (host.flowControlledPorts.get(port) !== registration || host.port !== registration.channel || hosts.get(host.id) !== host)
        throw new Error('Virtual server registration changed during upload');
      return await sendControlledRequest(host, port, request.method, path, headers, body, request.signal);
    }

    // Legacy peers retain their old selection until they negotiate flow control.
    const isStreamingCandidate = request.method === 'POST' && path.startsWith('/api/');

    if (isStreamingCandidate) {
      DEBUG && console.log('[SW] Using streaming mode for:', path);
      return handleStreamingRequest(host, port, request.method, path, headers, body);
    }
    DEBUG && console.log('[SW] Using non-streaming mode for:', request.method, path);

    // Send to main thread
    const response = await sendRequest(host, port, request.method, path, headers, body);

    DEBUG && console.log('[SW] Got response from main thread:', {
      statusCode: response.statusCode,
      headersKeys: response.headers ? Object.keys(response.headers) : [],
      bodyBase64Length: response.bodyBase64?.length,
    });

    // Decode base64 body and create response
    let finalResponse;
    if (response.bodyBase64 && response.bodyBase64.length > 0) {
      try {
        const bytes = base64ToBytes(response.bodyBase64);
        DEBUG && console.log('[SW] Decoded body length:', bytes.length);

        // Use Blob to ensure proper body handling
        const blob = new Blob([bytes], { type: response.headers['Content-Type'] || 'application/octet-stream' });
        DEBUG && console.log('[SW] Created blob size:', blob.size);

        // Merge response headers with CORP/COEP headers to allow iframe embedding
        // The parent page has COEP: credentialless, so we need matching headers
        const respHeaders = new Headers(response.headers);
        respHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
        respHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
        respHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
        // Remove any headers that might block iframe loading
        respHeaders.delete('X-Frame-Options');

        finalResponse = new Response(blob, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: respHeaders,
        });
      } catch (decodeError) {
        console.error('[SW] Failed to decode base64 body:', decodeError);
        finalResponse = new Response(`Decode error: ${decodeError.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } else {
      finalResponse = new Response(null, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
      });
    }

    DEBUG && console.log('[SW] Final Response created, status:', finalResponse.status);

    return finalResponse;
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.error('[SW] Error handling virtual request:', error);
    return new Response(`Service Worker Error: ${error.message}`, {
      status: error.status === 413 ? 413 : 500,
      statusText: error.status === 413 ? 'Content Too Large' : 'Internal Server Error',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/**
 * Handle a streaming request
 */
async function handleStreamingRequest(host, port, method, path, headers, body) {
  const { stream, headersPromise, id } = await sendStreamingRequest(host, port, method, path, headers, body);

  // Wait for headers to arrive
  const responseData = await headersPromise;

  DEBUG && console.log('[SW] Streaming response started:', responseData?.statusCode);

  // Build response headers
  const respHeaders = new Headers(responseData?.headers || {});
  respHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
  respHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  respHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
  respHeaders.delete('X-Frame-Options');

  return new Response(stream, {
    status: responseData?.statusCode || 200,
    statusText: responseData?.statusMessage || 'OK',
    headers: respHeaders,
  });
}

/**
 * Activate immediately
 */
self.addEventListener('install', (event) => {
  DEBUG && console.log('[SW] Installing...');
  event.waitUntil(self.skipWaiting());
});

/**
 * Claim all clients immediately
 */
self.addEventListener('activate', (event) => {
  DEBUG && console.log('[SW] Activated');
  event.waitUntil(self.clients.claim());
});
