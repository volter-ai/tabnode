// The public doors through which a host gives a realm its network namespace (ADR-0008): `createContainer({ network })`
// (every run of the container, and every process a run forks, is in it; a container given none has a fresh one of its
// own), `new NativeStreamScope(limits, emit, ownerPid, network)` (every TCP handle the scope makes is made in it), and
// HTTP's Agent (`installHttpClientTransport`), which sends a connection where the caller's namespace routes it.
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualFS, createContainer, installHttpClientTransport, loopbackOnlyNamespace, NativeStreamScope, type NetworkNamespace } from '../src/index';
import { httpModule } from '../src/node-lib/http-module';
import { netModule } from '../src/node-lib/net-module';
import { inside } from './node-compat/namespace-run';
import { ServerBridge } from '../src/server-bridge';
import type { HttpClientExchangeRequest } from '../src/http-client-transport';

const UV_EADDRNOTAVAIL = -99;

/** Each container a test makes is disposed after it, so no test's default scope owner is another test's leftover. */
const containers: Array<ReturnType<typeof createContainer>> = [];
function made(options?: Parameters<typeof createContainer>[0]): ReturnType<typeof createContainer> {
  const container = createContainer(options);
  containers.push(container);
  return container;
}
afterEach(() => { for (const container of containers.splice(0)) container.dispose(); });

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

describe('made({ network })', () => {
  it('holds the namespace it was given, and a container given none has a fresh one, not another container\'s', () => {
    const front = containerNamespace('web', '172.18.0.2');
    const first = made({ network: front });
    const second = made();
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
      const result = await made({ vfs, network: containerNamespace(id as string, address as string, held as Record<string, string>) })
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
      return made({ vfs, network }).run('node /work/listen.js', { cwd: '/work' });
    }));
    expect(results.map(result => result.stdout.trim())).toEqual(['listening', 'listening']);
    expect(namespaces.map(network => network.listened)).toEqual([[5432], [5432]]);
  });
});

describe('a container\'s own code and its engine continuations', () => {
  /** A namespace whose resolver answers a tick later, as a host that asks its page does. */
  function asyncResolving(id: string, address: string, held: Record<string, string>): NetworkNamespace & { listened: Array<{ port: number; address: string }> } {
    const listened: Array<{ port: number; address: string }> = [];
    return {
      id, listened,
      addresses: () => [{ address, prefixLength: 16, interface: 'eth0' }],
      connect: () => -111,
      listen: (listener) => { listened.push({ port: listener.port, address: listener.address }); return () => undefined; },
      resolve: (name, family) => new Promise(resolve => setTimeout(() => resolve(name in held ? (family === 4 ? [held[name]!] : []) : undefined), 1)),
    };
  }

  it('runs execute and runFile in the container\'s namespace, and their continuations too', async () => {
    const network = asyncResolving('web', '172.18.0.2', {});
    const vfs = new VirtualFS();
    program(vfs, 'later.js', "module.exports = new Promise(resolve => setTimeout(() => resolve(Object.keys(require('os').networkInterfaces())), 1));\n");
    const container = made({ vfs, network });
    expect(container.execute("module.exports = Object.keys(require('os').networkInterfaces());").exports).toEqual(['lo', 'eth0']);
    expect(await (container.runFile('/work/later.js').exports as Promise<string[]>)).toEqual(['lo', 'eth0']);
  });

  it('answers a lookup from an asynchronous resolver in the asking run\'s namespace', async () => {
    const vfs = new VirtualFS();
    program(vfs, 'ask.js', "require('dns').lookup('db', (error, address) => console.log(error ? error.code : address));\n");
    const result = await made({ vfs, network: asyncResolving('web', '172.18.0.2', { db: '172.18.0.3' }) })
      .run('node /work/ask.js', { cwd: '/work' });
    expect(result.stdout.trim()).toBe('172.18.0.3');
  });

  it('listens on listen(port, host) in the run\'s namespace, the host named by its asynchronous resolver', async () => {
    const network = asyncResolving('web', '172.18.0.2', { web: '172.18.0.2' });
    const vfs = new VirtualFS();
    program(vfs, 'serve.js', "const server = require('net').createServer().listen(3000, 'web', () => { console.log(server.address().address); server.close(); });\n");
    const result = await made({ vfs, network }).run('node /work/serve.js', { cwd: '/work' });
    expect(result.stdout.trim()).toBe('172.18.0.2');
    expect(network.listened).toEqual([{ port: 3000, address: '172.18.0.2' }]);
  });

  it('listens on listen(port, \'0.0.0.0\') in the run\'s namespace, where its host is told of it', async () => {
    const network = asyncResolving('web', '172.18.0.2', {});
    const vfs = new VirtualFS();
    program(vfs, 'serve.js', "const server = require('net').createServer().listen(3000, '0.0.0.0', () => { console.log('listening'); server.close(); });\n");
    const result = await made({ vfs, network }).run('node /work/serve.js', { cwd: '/work' });
    expect(result.stdout.trim()).toBe('listening');
    expect(network.listened).toEqual([{ port: 3000, address: '0.0.0.0' }]);
  });
});

/** A container's namespace that records each listen told to it, with the address bound. */
function recordingNamespace(id: string, address: string): NetworkNamespace & { listened: Array<{ port: number; address: string }> } {
  const listened: Array<{ port: number; address: string }> = [];
  return {
    id, listened,
    addresses: () => [{ address, prefixLength: 16, interface: 'eth0' }],
    connect: () => -111,
    listen: (listener) => { listened.push({ port: listener.port, address: listener.address }); return () => undefined; },
    resolve: () => undefined,
  };
}

describe('a run and the frame that started it', () => {
  it('makes a run\'s sockets in its own container\'s namespace when another container\'s code starts it', async () => {
    const a = recordingNamespace('a', '172.18.0.2');
    const b = recordingNamespace('b', '172.19.0.2');
    const vfs = new VirtualFS();
    program(vfs, 'serve.js', "const server = require('net').createServer().listen(3000, () => { console.log('listening'); server.close(); });\n");
    const first = made({ network: a });
    const second = made({ vfs, network: b });
    try {
      // A's own code hands B's run a callback of A's (its frame carries A's namespace), as a page bridge event of a
      // run of A's would start it.
      const later = first.execute('module.exports = (start) => setTimeout(start, 1);').exports as (start: () => void) => void;
      const result = await new Promise<{ stdout: string }>((resolve) => later(() => { void second.run('node /work/serve.js', { cwd: '/work' }).then(resolve); }));
      expect(result.stdout.trim()).toBe('listening');
      expect(b.listened.map(row => row.port)).toEqual([3000]);
      expect(a.listened).toEqual([]);
    } finally { first.dispose(); second.dispose(); }
  });
});

describe('the page bridge and a host\'s late answer', () => {
  it('reaches a guest bound to ::1 alone', async () => {
    const container = made({ network: recordingNamespace('web', '172.18.0.2') });
    try {
      container.execute("require('http').createServer((request, response) => response.end('six')).listen(8461, '::1');");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await container.serverBridge.handleRequest(8461, 'GET', '/', {});
      expect(response.statusCode).toBe(200);
      expect(new TextDecoder().decode(response.body)).toBe('six');
    } finally { container.dispose(); }
  });

  it('hands a listener the host answered after the socket closed an end that closes at once', async () => {
    type Late = { source: string; accept(socket: { on(event: 'close', listener: () => void): void }): void };
    let answer: ((connection: Late) => void) | undefined;
    const network: NetworkNamespace = {
      ...loopbackOnlyNamespace(),
      addresses: () => [{ address: '172.18.0.2', prefixLength: 16 }],
      connect: () => new Promise((resolve) => { answer = resolve as unknown as (connection: Late) => void; }),
    };
    const socket = await inside(network, () => netModule.connect(5432, '172.18.0.9') as unknown as { on(event: string, listener: () => void): void; destroy(): void });
    socket.on('error', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closed = new Promise<string>((resolve) => answer!({ source: '172.18.0.2', accept: (end) => end.on('close', () => resolve('closed')) }));
    expect(await closed).toBe('closed');
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

  it('without one, makes its handles in its owning container\'s namespace: that of the code that made it', async () => {
    const network = containerNamespace('db', '172.19.0.3');
    const scope = await inside(network, () => new NativeStreamScope(limits, () => undefined));
    expect(scope.network).toBe(network);
    const id = scope.call({ operation: 'create', kind: 'tcp', type: 1 }).handle!.id;
    expect(scope.call({ operation: 'bind', id, address: '172.19.0.3', port: 5432 }).status).toBe(0);
  });

  it('without one and outside any container\'s code, in an engine of several containers, asks for it by name', () => {
    const a = made({ network: containerNamespace('a', '172.18.0.2') });
    const b = made({ network: containerNamespace('b', '172.18.0.3') });
    try {
      expect(() => new NativeStreamScope(limits, () => undefined)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    } finally { a.dispose(); b.dispose(); }
  });

  it('forgets a disposed container: one live container is the default owner again', () => {
    const a = made({ network: containerNamespace('a', '172.18.0.2') });
    const b = made({ network: containerNamespace('b', '172.18.0.3') });
    b.dispose();
    expect(new NativeStreamScope(limits, () => undefined).network).toBe(a.network);
  });

  it('with no container, is in the run-less namespace a bare Runtime and a ServerBridge made outside a container use', () => {
    expect(new NativeStreamScope(limits, () => undefined).network).toBe(new ServerBridge().network);
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
