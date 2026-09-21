/**
 * Service Worker for Mini WebContainers
 * Intercepts fetch requests and routes them to virtual servers
 * Version: 15 - cleanup: extract helpers, gate debug logs, remove test endpoints
 */

const DEBUG = false;

// Communication port with main thread
let mainPort = null;

// Pending requests waiting for response
const pendingRequests = new Map();
let requestId = 0;

// Registered virtual server ports
const registeredPorts = new Set();

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
  if (type === 'init' && event.ports && event.ports[0]) {
    // Initialize communication channel
    mainPort = event.ports[0];
    mainPort.onmessage = handleMainMessage;
    if (data && Array.isArray(data.ownDocuments)) ownDocuments = new Set(data.ownDocuments.map((path) => ownPath(String(path))));
    DEBUG && console.log('[SW] Initialized communication channel with transferred port');
    // Re-claim clients so that pages opened after SW activation get controlled.
    // Without this, controllerchange never fires for late-arriving pages.
    self.clients.claim();
  }

  if (type === 'server-registered' && data) {
    registeredPorts.add(data.port);
    if (data.primary) primaryPort = data.port;
    DEBUG && console.log(`[SW] Server registered on port ${data.port}`);
  }

  if (type === 'server-unregistered' && data) {
    registeredPorts.delete(data.port);
    if (primaryPort === data.port) primaryPort = null;
    DEBUG && console.log(`[SW] Server unregistered from port ${data.port}`);
  }
});

/**
 * Handle response messages from main thread
 */
function handleMainMessage(event) {
  const { type, id, data, error } = event.data;

  // The page's bridge speaks over this port: which servers it holds, which
  // is the preview's, and which documents are the page's own frames.
  if (type === 'server-registered' && data) {
    registeredPorts.add(data.port);
    if (data.primary) primaryPort = data.port;
    else if (primaryPort === data.port) primaryPort = null;
    return;
  }
  if (type === 'server-unregistered' && data) {
    registeredPorts.delete(data.port);
    if (primaryPort === data.port) primaryPort = null;
    return;
  }
  if (type === 'own-documents' && data && Array.isArray(data.paths)) {
    ownDocuments = new Set(data.paths.map((path) => ownPath(String(path))));
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
async function sendRequest(port, method, url, headers, body) {
  DEBUG && console.log('[SW] sendRequest called, mainPort:', !!mainPort, 'url:', url);

  if (!mainPort) {
    // Ask all clients to re-send the init message
    const allClients = await self.clients.matchAll({ type: 'window' });
    for (const client of allClients) {
      client.postMessage({ type: 'sw-needs-init' });
    }
    // Wait up to 5s for a client to re-initialize the port
    // (main thread may be busy with heavy operations like CLI execution)
    await new Promise(resolve => {
      const check = setInterval(() => { if (mainPort) { clearInterval(check); resolve(); } }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
    if (!mainPort) {
      throw new Error('Service Worker not initialized - no connection to main thread');
    }
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    // Set timeout for request
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);

    mainPort.postMessage({
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
async function sendStreamingRequest(port, method, url, headers, body) {
  DEBUG && console.log('[SW] sendStreamingRequest called, url:', url);

  if (!mainPort) {
    // Ask all clients to re-send the init message
    const allClients = await self.clients.matchAll({ type: 'window' });
    for (const client of allClients) {
      client.postMessage({ type: 'sw-needs-init' });
    }
    await new Promise(resolve => {
      const check = setInterval(() => { if (mainPort) { clearInterval(check); resolve(); } }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
    if (!mainPort) {
      throw new Error('Service Worker not initialized');
    }
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
        resolve: () => {},
        reject: (err) => controller.error(err),
        streamController: controller,
        resolveHeaders,
      });

      // Send request to main thread with streaming flag
      mainPort.postMessage({
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

// The preview's server, whose documents are served at this origin's root as
// they would be at their own origin: an app reads its routes from
// `location.pathname`, and a document under /__virtual__/<port>/ is not at
// the path its router expects.
let primaryPort = null;
// The page's own documents that are frames of it, told by `init`, so a
// nested document at one of these paths is the page's and not the preview's.
let ownDocuments = new Set();
// The documents and workers served from a virtual server at the root, by
// client id, so their requests reach that server without a prefix to read.
const rootedClients = new Map();

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
  if (primaryPort === null && !mainPort && ((client && client.frameType === 'nested') || (event.request.mode === 'navigate' && (event.request.destination === 'iframe' || event.request.destination === 'frame')))) {
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
  if (primaryPort === null) return null;
  if (event.request.mode === 'navigate') {
    if (event.request.destination !== 'iframe' && event.request.destination !== 'frame') return null;
    if (ownDocuments.has(ownPath(url.pathname))) return null;
    return { prefix: null, port: primaryPort };
  }
  if (client && client.frameType === 'nested' && !ownDocuments.has(ownPath(new URL(client.url).pathname))) return { prefix: null, port: primaryPort };
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
    const check = setInterval(() => { if (mainPort) { clearInterval(check); resolve(); } }, 50);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });
}

/** Answers a request for a virtual server at the root, remembering the document or worker it makes. */
function handleRootedRequest(event, port, path) {
  if (event.resultingClientId) {
    rootedClients.set(event.resultingClientId, port);
    if (rootedClients.size > 256) pruneRootedClients();
  }
  return handleVirtualRequest(event.request, port, path, true);
}

/** Forgets the documents and workers that are gone. */
async function pruneRootedClients() {
  const alive = new Set((await self.clients.matchAll({ type: 'all' })).map((client) => client.id));
  for (const id of [...rootedClients.keys()]) if (!alive.has(id)) rootedClients.delete(id);
}

/**
 * Intercept fetch requests
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  DEBUG && console.log('[SW] Fetch:', url.pathname, 'mainPort:', !!mainPort);

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
    if (event.request.referrer || event.clientId || (event.request.mode === 'navigate' && primaryPort !== null)) {
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
    // Build headers object
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Get body if present
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer();
      // A body's length is a header Node's server always has, content-length
      // or a chunked transfer-encoding; a fetch's headers carry neither, and
      // Express 5's body parser takes their absence for no body at all.
      if (body && body.byteLength > 0 && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
        headers['content-length'] = String(body.byteLength);
      }
    }

    // Check if this is an API route that might stream (POST to /api/*)
    const isStreamingCandidate = request.method === 'POST' && path.startsWith('/api/');

    if (isStreamingCandidate) {
      DEBUG && console.log('[SW] Using streaming mode for:', path);
      return handleStreamingRequest(port, request.method, path, headers, body);
    }
    DEBUG && console.log('[SW] Using non-streaming mode for:', request.method, path);

    // Send to main thread
    const response = await sendRequest(port, request.method, path, headers, body);

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
    console.error('[SW] Error handling virtual request:', error);
    return new Response(`Service Worker Error: ${error.message}`, {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/**
 * Handle a streaming request
 */
async function handleStreamingRequest(port, method, path, headers, body) {
  const { stream, headersPromise, id } = await sendStreamingRequest(port, method, path, headers, body);

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
