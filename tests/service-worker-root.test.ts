// The service worker's routing, driven as the browser drives it: fetch events
// with the client ids, destinations and referrers a page produces. The
// preview's server answers at the origin's root; every other server, and a
// preview opened in a tab of its own, is under /__virtual__/<port>/.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const ORIGIN = 'http://shell.test';

interface FakeClient { id: string; url: string; frameType: 'top-level' | 'nested' | 'none' }

interface Worker {
  fetch(input: { url: string; mode?: string; destination?: string; clientId?: string; resultingClientId?: string; referrer?: string }): Promise<{ kind: 'virtual'; port: number; path: string } | { kind: 'network' } | { kind: 'redirect'; location: string }>;
  message(data: unknown): void;
  port(data: unknown): void;
}

/** The worker script, run against a `self` that records what it asked of the page and of the network. */
function loadWorker(clients: FakeClient[], ownDocuments: string[] = []): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const asked: Array<{ port: number; path: string }> = [];
  const mainPort = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage(message: { type: string; id: number; data: { port: number; url: string } }) {
      if (message.type !== 'request') return;
      asked.push({ port: message.data.port, path: message.data.url });
      // The page answers every request with a small document, at once.
      const body = Buffer.from(`served ${message.data.port} ${message.data.url}`).toString('base64');
      queueMicrotask(() => mainPort.onmessage?.({ data: { type: 'response', id: message.id, data: { statusCode: 200, statusMessage: 'OK', headers: { 'Content-Type': 'text/html' }, bodyBase64: body } } }));
    },
  };
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
    clients: {
      claim: async () => {},
      get: async (id: string) => clients.find((client) => client.id === id),
      matchAll: async () => [],
    },
    location: new URL(ORIGIN + '/__sw__.js'),
    skipWaiting: async () => {},
  };
  const context = createContext({
    self, Response, Headers, Blob, URL, ReadableStream, TextEncoder, TextDecoder, console,
    setTimeout, clearTimeout, setInterval, clearInterval, atob, btoa, queueMicrotask,
    fetch: async () => new Response('network', { status: 200, headers: { 'x-answered-by': 'network' } }),
  });
  runInContext(readFileSync(new URL('../public/__sw__.js', import.meta.url), 'utf8'), context);
  const message = (data: unknown, ports: unknown[] = []) => listeners.get('message')!({ data, ports });
  message({ type: 'init', data: { ownDocuments } }, [mainPort]);
  return {
    async fetch(input) {
      const request = new Request(input.url);
      Object.defineProperty(request, 'mode', { value: input.mode ?? 'cors' });
      Object.defineProperty(request, 'destination', { value: input.destination ?? '' });
      Object.defineProperty(request, 'referrer', { value: input.referrer ?? '' });
      let responded: Promise<Response> | undefined;
      const event = { request, clientId: input.clientId ?? '', resultingClientId: input.resultingClientId ?? '', respondWith: (value: Promise<Response>) => { responded = value; } };
      const before = asked.length;
      listeners.get('fetch')!(event);
      if (!responded) return { kind: 'network' };
      const response = await responded;
      if (response.status >= 300 && response.status < 400) return { kind: 'redirect', location: response.headers.get('location') ?? '' };
      if (response.headers.get('x-answered-by') === 'network') return { kind: 'network' };
      const last = asked[asked.length - 1];
      if (asked.length === before || !last) throw new Error('answered by neither the page nor the network');
      return { kind: 'virtual', port: last.port, path: last.path };
    },
    message: (data) => message(data),
    port: (data) => mainPort.onmessage?.({ data }),
  };
}

const shell: FakeClient = { id: 'shell', url: `${ORIGIN}/`, frameType: 'top-level' };
const sandbox: FakeClient = { id: 'sandbox', url: `${ORIGIN}/sandbox.html?port=5173`, frameType: 'nested' };
const rooted: FakeClient = { id: 'app', url: `${ORIGIN}/login`, frameType: 'nested' };
const prefixed: FakeClient = { id: 'tab', url: `${ORIGIN}/__virtual__/5173/login`, frameType: 'top-level' };
const worker: FakeClient = { id: 'worker', url: `${ORIGIN}/src/worker.js`, frameType: 'none' };

describe('the preview at the origin root', () => {
  it('serves a frame navigation from the primary server, and remembers the document it makes', async () => {
    const sw = loadWorker([shell, sandbox, rooted], ['/sandbox.html', '/node-host.html']);
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0', primary: true } });
    expect(await sw.fetch({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'iframe', clientId: 'sandbox', resultingClientId: 'app' })).toEqual({ kind: 'virtual', port: 5173, path: '/' });
    // The document's own requests, and its navigations, are the server's without a prefix to read.
    expect(await sw.fetch({ url: `${ORIGIN}/src/app.js`, clientId: 'app' })).toEqual({ kind: 'virtual', port: 5173, path: '/src/app.js' });
    expect(await sw.fetch({ url: `${ORIGIN}/register?x=1`, mode: 'navigate', destination: 'iframe', clientId: 'app', resultingClientId: 'app2' })).toEqual({ kind: 'virtual', port: 5173, path: '/register?x=1' });
  });

  it('leaves the page and its own frames to the network', async () => {
    const sw = loadWorker([shell, sandbox]);
    // The page's own frames, named over the bridge's port as a re-announcement is.
    sw.port({ type: 'own-documents', data: { paths: ['/sandbox.html', '/node-host.html'] } });
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0', primary: true } });
    expect(await sw.fetch({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'document' })).toEqual({ kind: 'network' });
    expect(await sw.fetch({ url: `${ORIGIN}/sandbox.html?port=5173`, mode: 'navigate', destination: 'iframe', clientId: 'shell' })).toEqual({ kind: 'network' });
    expect(await sw.fetch({ url: `${ORIGIN}/node-host.html`, mode: 'navigate', destination: 'iframe', clientId: 'shell' })).toEqual({ kind: 'network' });
    expect(await sw.fetch({ url: `${ORIGIN}/assets/shell.js`, clientId: 'shell' })).toEqual({ kind: 'network' });
    expect(await sw.fetch({ url: `${ORIGIN}/assets/sandbox.js`, clientId: 'sandbox' })).toEqual({ kind: 'network' });
  });

  it('serves nothing at the root until a server is primary', async () => {
    const sw = loadWorker([shell, sandbox]);
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0' } });
    expect(await sw.fetch({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'iframe', clientId: 'sandbox', resultingClientId: 'app' })).toEqual({ kind: 'network' });
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0', primary: true } });
    expect(await sw.fetch({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'iframe', clientId: 'sandbox', resultingClientId: 'app' })).toEqual({ kind: 'virtual', port: 5173, path: '/' });
    sw.port({ type: 'server-unregistered', data: { port: 5173 } });
    expect(await sw.fetch({ url: `${ORIGIN}/`, mode: 'navigate', destination: 'iframe', clientId: 'sandbox', resultingClientId: 'app' })).toEqual({ kind: 'network' });
  });

  it('after a restart, a nested document at a path that is not the page\'s own is the preview\'s; a worker is not', async () => {
    const sw = loadWorker([shell, sandbox, rooted, worker], ['/sandbox.html']);
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0', primary: true } });
    expect(await sw.fetch({ url: `${ORIGIN}/src/app.js`, clientId: 'app' })).toEqual({ kind: 'virtual', port: 5173, path: '/src/app.js' });
    expect(await sw.fetch({ url: `${ORIGIN}/src/data.json`, clientId: 'worker' })).toEqual({ kind: 'network' });
  });

  it('keeps a document under /__virtual__/<port>/ on its prefix, as before', async () => {
    const sw = loadWorker([prefixed]);
    sw.port({ type: 'server-registered', data: { port: 5173, hostname: '0.0.0.0', primary: true } });
    expect(await sw.fetch({ url: `${ORIGIN}/__virtual__/5173/login`, mode: 'navigate', destination: 'document' })).toEqual({ kind: 'virtual', port: 5173, path: '/login' });
    expect(await sw.fetch({ url: `${ORIGIN}/src/app.js`, clientId: 'tab' })).toEqual({ kind: 'virtual', port: 5173, path: '/src/app.js' });
    expect(await sw.fetch({ url: `${ORIGIN}/register`, mode: 'navigate', destination: 'document', clientId: 'tab' })).toEqual({ kind: 'redirect', location: `${ORIGIN}/__virtual__/5173/register` });
  });
});
