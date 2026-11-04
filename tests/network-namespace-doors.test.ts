// The public doors through which a host gives a realm its network namespace (ADR-0008): `createContainer({ network })`
// (every run of the container, and every process a run forks, is in it; a container given none has a fresh one of its
// own), `new NativeStreamScope(limits, emit, ownerPid, network)` (every TCP handle the scope makes is made in it), and
// HTTP's Agent (`installHttpClientTransport`), which sends a connection where the caller's namespace routes it.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer, installHttpClientTransport, loopbackOnlyNamespace, NativeStreamScope, type NetworkNamespace } from '../src/index';
import { httpModule } from '../src/node-lib/http-module';
import { inside } from './node-compat/namespace-run';
import type { HttpClientExchangeRequest } from '../src/http-client-transport';

const UV_EADDRNOTAVAIL = -99;

/** A container's namespace on one Docker network: its address, a resolver that holds `db` there, no route out. */
function containerNamespace(id: string, address: string, held: Record<string, string> = {}): NetworkNamespace & { listened: number[] } {
  const listened: number[] = [];
  return {
    id, listened,
    addresses: () => [{ address, prefixLength: 16, interface: 'eth0' }],
    connect: () => -111,
    listen: (listener) => { listened.push(listener.port); return () => undefined; },
    resolve: (name, family) => name in held ? (family === 4 ? [held[name]!] : []) : undefined,
  };
}

function program(vfs: VirtualFS, name: string, source: string): void {
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync(`/work/${name}`, source);
}

describe('createContainer({ network })', () => {
  it('holds the namespace it was given, and a container given none has a fresh one, not another container\'s', () => {
    const front = containerNamespace('web', '172.18.0.2');
    const first = createContainer({ network: front });
    const second = createContainer();
    expect(first.network).toBe(front);
    expect(second.network).not.toBe(front);
    expect(second.network.addresses()).toEqual([]);
    expect(second.network.resolve('db', 4)).toBeUndefined();
  });

  it('puts every run of each container in its own namespace: its interfaces and its resolver', async () => {
    const script = "const os = require('os'); const dns = require('dns');\n"
      + "dns.lookup('db', (error, address) => console.log(JSON.stringify({ eth0: (os.networkInterfaces().eth0 || []).map(row => row.address), db: error ? error.code : address })));\n";
    const answers = await Promise.all([
      ['web', '172.18.0.2', { db: '172.18.0.3' }],
      ['worker', '172.19.0.2', {}],
    ].map(async ([id, address, held]) => {
      const vfs = new VirtualFS();
      program(vfs, 'ask.js', script);
      const result = await createContainer({ vfs, network: containerNamespace(id as string, address as string, held as Record<string, string>) })
        .run('node /work/ask.js', { cwd: '/work' });
      return JSON.parse(result.stdout.trim());
    }));
    expect(answers).toEqual([
      { eth0: ['172.18.0.2'], db: '172.18.0.3' },
      { eth0: ['172.19.0.2'], db: 'ENOTFOUND' },
    ]);
  });

  it('gives each container its own port space: both listen on 5432, and each listen is told to its own namespace', async () => {
    const script = "require('net').createServer().listen(5432, function () { console.log('listening'); this.close(); });\n";
    const namespaces = [containerNamespace('a', '172.18.0.2'), containerNamespace('b', '172.18.0.3')];
    const results = await Promise.all(namespaces.map(async (network) => {
      const vfs = new VirtualFS();
      program(vfs, 'listen.js', script);
      return createContainer({ vfs, network }).run('node /work/listen.js', { cwd: '/work' });
    }));
    expect(results.map(result => result.stdout.trim())).toEqual(['listening', 'listening']);
    expect(namespaces.map(network => network.listened)).toEqual([[5432], [5432]]);
  });
});

describe('new NativeStreamScope(limits, emit, ownerPid, network)', () => {
  const limits = { maxHandles: 8, maxReadChunkBytes: 65536, maxQueuedBytes: 1 << 20, maxQueuedHandles: 4, maxPendingWriteBytes: 1 << 20 };

  it('makes every TCP handle in the namespace it was given: a bind there takes its address, a listen is told to it', () => {
    const network = containerNamespace('db', '172.19.0.3');
    const scope = new NativeStreamScope(limits, () => undefined, () => 7, network);
    expect(scope.network).toBe(network);
    const created = scope.call({ operation: 'create', kind: 'tcp', type: 1 });
    expect(created.status).toBe(0);
    const id = created.handle!.id;
    expect(scope.call({ operation: 'bind', id, address: '172.19.0.3', port: 5432 }).status).toBe(0);
    expect(scope.call({ operation: 'listen', id, backlog: 16 }).status).toBe(0);
    expect(network.listened).toEqual([5432]);
  });

  it('without one, makes its handles in a fresh namespace of its own loopback, where no container address is held', () => {
    const scope = new NativeStreamScope(limits, () => undefined);
    const id = scope.call({ operation: 'create', kind: 'tcp', type: 1 }).handle!.id;
    expect(scope.call({ operation: 'bind', id, address: '172.19.0.3', port: 5432 }).status).toBe(UV_EADDRNOTAVAIL);
    expect(scope.call({ operation: 'bind', id, address: '127.0.0.1', port: 5432 }).status).toBe(0);
  });
});

describe('HTTP\'s Agent routes by the caller\'s namespace', () => {
  /** The host exchange, recording each URL it is asked for and answering 200. */
  function exchange(asked: string[]) {
    return () => async (request: HttpClientExchangeRequest) => {
      asked.push(request.url);
      return { status: 200, statusText: 'OK', headers: [['content-length', '2']] as Array<[string, string]>, body: new Response('ok').body };
    };
  }
  function get(url: string): Promise<{ status?: number; code?: string }> {
    return new Promise((resolve) => {
      const request = (httpModule as unknown as { get(url: string, answer: (response: { statusCode?: number; resume(): void }) => void): { on(event: 'error', listener: (error: { code?: string }) => void): void } })
        .get(url, (response) => { response.resume(); resolve({ status: response.statusCode }); });
      request.on('error', (error) => resolve({ code: error.code }));
    });
  }
  /** The page's services on the host's port 2375, reached where the namespace's routes reach the host: the host's loopback, a gateway. */
  const hostService = (network: NetworkNamespace, host: string, port: number): boolean =>
    port === 2375 && ((host === 'localhost' && network.id === 'host') || host === '172.18.0.1');

  it('keeps a name the namespace holds on its own network, and sends one it does not hold to the exchange', async () => {
    const asked: string[] = [];
    const uninstall = installHttpClientTransport(exchange(asked), { hostService });
    try {
      const web = containerNamespace('web', '172.18.0.2', { db: '172.18.0.3' });
      expect(await inside(web, () => get('http://db:8080/'))).toEqual({ code: 'ECONNREFUSED' });
      expect(await inside(web, () => get('http://registry.example/'))).toEqual({ status: 200 });
      expect(asked).toEqual(['http://registry.example/']);
    } finally { uninstall(); }
  });

  it('answers a container\'s localhost:2375 from its own loopback, and the host\'s from the page\'s service', async () => {
    const asked: string[] = [];
    const uninstall = installHttpClientTransport(exchange(asked), { hostService });
    try {
      const web = containerNamespace('web', '172.18.0.2');
      const host = { ...containerNamespace('host', '172.18.0.1'), id: 'host' };
      expect(await inside(web, () => get('http://localhost:2375/version'))).toEqual({ code: 'ECONNREFUSED' });
      expect(await inside(web, () => get('http://172.18.0.1:2375/version'))).toEqual({ status: 200 });
      expect(await inside(host, () => get('http://localhost:2375/version'))).toEqual({ status: 200 });
      expect(asked).toEqual(['http://172.18.0.1:2375/version', 'http://localhost:2375/version']);
    } finally { uninstall(); }
  });

  it('fails a lookup whose resolver fails with EAI_AGAIN, never sending it out', async () => {
    const asked: string[] = [];
    const uninstall = installHttpClientTransport(exchange(asked), { hostService });
    try {
      const failing: NetworkNamespace = { ...loopbackOnlyNamespace(), resolve: () => Promise.reject(new Error('resolver down')) };
      expect(await inside(failing, () => get('http://db:8080/'))).toEqual({ code: 'EAI_AGAIN' });
      expect(asked).toEqual([]);
    } finally { uninstall(); }
  });
});
