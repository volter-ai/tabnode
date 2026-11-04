/**
 * `net`, measured against Node's own behaviour.
 *
 * `net` is Node's `lib/net.js`, vendored, on the binding in
 * `src/node-lib/binding/`. So every expectation here is Node's own, checked
 * against a real `node` before it was written: a connect to a port nothing is
 * listening on is refused, a listen with a host is asynchronous, a socket with
 * no handle emits `close` with no argument, `address()` of an unconnected
 * socket is `{}`. The suite that stood here asserted the opposite of most of
 * these, because the hand-written module it measured answered a connect to
 * nothing with success.
 *
 * The engine's whole `net` fidelity number is Node's own `test-net-*` suite,
 * run by `scripts/node-tests.mjs` and
 * recorded in BUILTINS.md. This file is the engine's own shape check: that the
 * loopback pairing behind Node's file carries bytes, ports, paths and
 * refusals the way Node's kernel does, in the network namespace its host gives
 * each realm (`src/network-namespace.ts`).
 */

import { describe, it, expect, vi } from 'vitest';
import { netModule as net, Socket, Server, createServer, createConnection, connect, isIP, isIPv4, isIPv6 } from '../../src/node-lib/net-module';
import { assert } from './common';
import { getEngineNamespace, loopbackOnlyNamespace, setEngineNamespace, type NamespaceConnection, type NamespaceListener, type NetworkNamespace } from '../../src/network-namespace';
import { UV_EADDRINUSE, UV_ECONNREFUSED, UV_EHOSTUNREACH, UV_ENETUNREACH } from '../../src/node-lib/binding/uv';

/** A server listening on an engine-chosen port, and the port. */
function listening(onConnection?: (socket: unknown) => void): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(onConnection as (socket: never) => void);
    server.listen(0, () => {
      const address = server.address() as { port: number };
      resolve({ server, port: address.port });
    });
  });
}

/**
 * A host as the substrate is one: two Docker networks, `front` (172.18.0.0/16, gateway .1) holding `web` (.2) and
 * `api` (.3), and `back` (172.19.0.0/16) holding `api` (.2) and `db` (.3). Each container is a namespace; a peer on a
 * shared network is reached from the connector's address there, one on no shared network is EHOSTUNREACH, and the
 * gateway's port 3128 is a listener the host holds (its egress proxy), answered a tick later.
 */
function dockerHost() {
  const networks: Record<string, Record<string, string>> = {
    web: { front: '172.18.0.2' },
    api: { front: '172.18.0.3', back: '172.19.0.2' },
    db: { back: '172.19.0.3' },
  };
  const gateways: Record<string, string> = { front: '172.18.0.1', back: '172.19.0.1' };
  const told: Array<{ namespace: string; listener: NamespaceListener; released: boolean }> = [];
  const heldByHost: Array<{ from: string; socket: Socket }> = [];
  let refusedPort: number | undefined;
  const namespace = (name: string): NetworkNamespace => ({
    id: name,
    addresses: () => Object.values(networks[name]!).map(address => ({ address, prefixLength: 16 })),
    connect: (address, port): NamespaceConnection | Promise<NamespaceConnection> => {
      const mine = networks[name]!;
      for (const [network, gateway] of Object.entries(gateways)) {
        if (address !== gateway) continue;
        if (!mine[network]) return UV_EHOSTUNREACH;
        if (port !== 3128) return UV_ECONNREFUSED;
        const source = mine[network]!;
        return new Promise(resolve => setTimeout(() => resolve({
          source, accept: (socket) => { heldByHost.push({ from: socket.remoteAddress as string, socket }); socket.end('proxy\n'); },
        }), 0));
      }
      for (const [peer, held] of Object.entries(networks)) {
        const network = Object.keys(held).find(key => held[key] === address);
        if (!network) continue;
        if (peer === name) return UV_ECONNREFUSED;
        return mine[network] ? { namespace: peer, source: mine[network]! } : UV_EHOSTUNREACH;
      }
      return UV_ENETUNREACH;
    },
    listen: (listener) => {
      if (listener.port === refusedPort) return UV_EADDRINUSE;
      const entry = { namespace: name, listener, released: false };
      told.push(entry);
      return () => { entry.released = true; };
    },
    resolve: () => undefined,
  });
  return {
    web: namespace('web'), api: namespace('api'), db: namespace('db'), told, heldByHost,
    refuse: (port: number) => { refusedPort = port; },
  };
}

/** Acts as a realm of `network` does: every socket made meanwhile is made in it, and keeps it. */
async function inside<T>(network: NetworkNamespace, act: () => T | Promise<T>): Promise<T> {
  const previous = getEngineNamespace();
  setEngineNamespace(network);
  try { return await act(); } finally { setEngineNamespace(previous); }
}

/** A server that answers each connection with `word` and the address it came from. */
function answering(word: string, port: number, host?: string): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => { socket.end(`${word} ${socket.remoteAddress}\n`); });
    server.once('error', reject);
    if (host === undefined) server.listen(port, () => resolve(server));
    else server.listen(port, host, () => resolve(server));
  });
}

/** Everything a connection reads until it ends, or its error. */
function readAll(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { text += chunk; });
    socket.once('end', () => resolve(text));
    socket.once('error', reject);
  });
}

function failure(socket: Socket | ReturnType<typeof createServer>): Promise<NodeJS.ErrnoException> {
  return new Promise(resolve => socket.once('error', resolve as () => void));
}

describe('net module (Node.js compat)', () => {
  describe('exports', () => {
    it('should export Socket and Server classes', () => {
      expect(typeof Socket).toBe('function');
      expect(typeof Server).toBe('function');
    });

    it('should export factory functions', () => {
      expect(typeof createServer).toBe('function');
      expect(typeof createConnection).toBe('function');
      expect(typeof connect).toBe('function');
    });

    it('should export IP helper functions', () => {
      expect(typeof isIP).toBe('function');
      expect(typeof isIPv4).toBe('function');
      expect(typeof isIPv6).toBe('function');
    });
  });

  describe('IP helpers', () => {
    it('isIP should identify basic IPv4 and IPv6 values', () => {
      assert.strictEqual(isIP('127.0.0.1'), 4);
      assert.strictEqual(isIP('::1'), 6);
      assert.strictEqual(isIP('not-an-ip'), 0);
    });

    it('isIPv4 should match IPv4 addresses', () => {
      assert.strictEqual(isIPv4('127.0.0.1'), true);
      assert.strictEqual(isIPv4('::1'), false);
    });

    it('isIPv6 should match IPv6 addresses', () => {
      assert.strictEqual(isIPv6('::1'), true);
      assert.strictEqual(isIPv6('127.0.0.1'), false);
    });

    it('should reject an out-of-range IPv4 segment, as Node does', () => {
      assert.strictEqual(isIP('999.999.999.999'), 0);
      assert.strictEqual(isIP('127.0.0.256'), 0);
    });
  });

  describe('Socket', () => {
    it('should create a socket instance', () => {
      const socket = new Socket();
      expect(socket).toBeInstanceOf(Socket);
    });

    it('a socket with no handle is Node\'s: open, unconnected, no address', () => {
      const socket = new Socket();
      assert.strictEqual(socket.connecting, false);
      assert.strictEqual(socket.destroyed, false);
      assert.strictEqual(socket.pending, true);
      // Both sides are writable and readable before a handle, so Node reports
      // 'open'; `address()` of a socket with no handle is `{}`, not null.
      assert.strictEqual(socket.readyState, 'open');
      expect(socket.address()).toEqual({});
    });

    it('connect(port, host, callback) reaches a listening server', async () => {
      const { server, port } = await listening();
      const socket = new Socket();
      const onConnect = vi.fn();
      const onCallback = vi.fn();
      socket.on('connect', onConnect);
      socket.connect(port, '127.0.0.1', onCallback);

      assert.strictEqual(socket.connecting, true);
      assert.strictEqual(socket.readyState, 'opening');

      await new Promise((resolve) => socket.once('connect', resolve));

      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onCallback).toHaveBeenCalledTimes(1);
      assert.strictEqual(socket.connecting, false);
      assert.strictEqual(socket.readyState, 'open');
      assert.strictEqual(socket.remoteAddress, '127.0.0.1');
      assert.strictEqual(socket.remotePort, port);
      assert.strictEqual(socket.remoteFamily, 'IPv4');
      socket.destroy();
      server.close();
    });

    it('connect(options, callback) supports the options overload', async () => {
      const { server, port } = await listening();
      const socket = new Socket();
      const onCallback = vi.fn();
      socket.connect({ port, host: '127.0.0.1' }, onCallback);
      await new Promise((resolve) => socket.once('connect', resolve));

      assert.strictEqual(socket.remoteAddress, '127.0.0.1');
      assert.strictEqual(socket.remotePort, port);
      expect(onCallback).toHaveBeenCalledTimes(1);
      socket.destroy();
      server.close();
    });

    it('a connect to a port nothing listens on is ECONNREFUSED, as Node refuses it', async () => {
      const socket = new Socket();
      // A port in the ephemeral range the engine hands out last, so nothing of
      // this suite is bound to it.
      socket.connect(65001, '127.0.0.1');
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => socket.once('error', resolve as () => void));
      assert.strictEqual(error.code, 'ECONNREFUSED');
      assert.strictEqual(error.syscall, 'connect');
      assert.strictEqual(socket.destroyed, true);
    });

    it('address() is the local end once a socket is connected', async () => {
      const { server, port } = await listening();
      const socket = createConnection(port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));

      const address = socket.address() as { address: string; family: string; port: number };
      assert.strictEqual(address.address, '127.0.0.1');
      assert.strictEqual(address.family, 'IPv4');
      expect(typeof address.port).toBe('number');
      expect(address.port).not.toBe(port);
      socket.destroy();
      server.close();
    });

    it('carries bytes both ways and ends both ends, as a connection does', async () => {
      const heard: string[] = [];
      const { server, port } = await listening((connection: unknown) => {
        const peer = connection as Socket;
        peer.setEncoding('utf8');
        peer.on('data', (chunk: unknown) => { heard.push(String(chunk)); peer.write('pong'); });
      });
      const socket = createConnection(port, '127.0.0.1');
      socket.setEncoding('utf8');
      const answered = new Promise<string>((resolve) => socket.once('data', (chunk: unknown) => resolve(String(chunk))));
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write('ping');
      assert.strictEqual(await answered, 'pong');
      assert.deepStrictEqual(heard, ['ping']);

      const closed = new Promise((resolve) => socket.once('close', resolve));
      socket.end();
      await closed;
      server.close();
    });

    it('setters should be chainable', () => {
      const socket = new Socket();
      expect(socket.setEncoding('utf8')).toBe(socket);
      expect(socket.setNoDelay(true)).toBe(socket);
      expect(socket.setKeepAlive(true, 100)).toBe(socket);
      expect(socket.ref()).toBe(socket);
      expect(socket.unref()).toBe(socket);
    });

    it('setTimeout(callback) should register timeout listener', () => {
      const socket = new Socket();
      const onTimeout = vi.fn();
      socket.setTimeout(10, onTimeout);
      socket.emit('timeout');
      expect(onTimeout).toHaveBeenCalledTimes(1);
      socket.setTimeout(0);
    });

    it('destroy() on a socket with no handle emits close with no argument', async () => {
      const socket = new Socket();
      const onClose = vi.fn();
      socket.on('close', onClose);

      socket.destroy();
      assert.strictEqual(socket.destroyed, true);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith();
    });

    it('destroy(error) emits the error, then close', async () => {
      const socket = new Socket();
      const onError = vi.fn();
      const onClose = vi.fn();
      socket.on('error', onError);
      socket.on('close', onClose);

      const failure = new Error('boom');
      socket.destroy(failure);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onError).toHaveBeenCalledWith(failure);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Server', () => {
    it('should create a server instance', () => {
      const server = new Server();
      expect(server).toBeInstanceOf(Server);
      assert.strictEqual(server.listening, false);
    });

    it('createServer(listener) hears the connections it accepts', async () => {
      const onConnection = vi.fn();
      const { server, port } = await listening(onConnection);
      const socket = createConnection(port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      expect(onConnection).toHaveBeenCalledTimes(1);
      expect(onConnection.mock.calls[0][0]).toBeInstanceOf(Socket);
      socket.destroy();
      server.close();
    });

    it('listen(port, host, cb) is asynchronous, as a lookup makes it', async () => {
      const server = createServer();
      const onListening = vi.fn();
      const onCallback = vi.fn();
      server.on('listening', onListening);
      server.listen(0, '127.0.0.1', onCallback);

      // A host means a lookup, and a lookup means the handle is not there yet.
      assert.strictEqual(server.listening, false);
      await new Promise((resolve) => server.once('listening', resolve));

      expect(onListening).toHaveBeenCalledTimes(1);
      expect(onCallback).toHaveBeenCalledTimes(1);
      const address = server.address() as { address: string; family: string; port: number };
      assert.strictEqual(address.address, '127.0.0.1');
      assert.strictEqual(address.family, 'IPv4');
      expect(address.port).toBeGreaterThan(0);
      server.close();
    });

    it('listen(0) should assign a non-zero port', async () => {
      const { server, port } = await listening();
      expect(port).toBeGreaterThan(0);
      server.close();
    });

    it('a port a live server holds is EADDRINUSE', async () => {
      const { server, port } = await listening();
      const second = createServer();
      second.listen(port);
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => second.once('error', resolve as () => void));
      assert.strictEqual(error.code, 'EADDRINUSE');
      server.close();
    });

    it('close() should stop listening and emit close', async () => {
      const { server } = await listening();
      const onClose = vi.fn();
      const onCallback = vi.fn();
      server.on('close', onClose);
      server.close(onCallback);

      assert.strictEqual(server.listening, false);
      await new Promise((resolve) => server.once('close', resolve));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onCallback).toHaveBeenCalledTimes(1);
    });

    it('getConnections() should report the connection count', async () => {
      const { server, port } = await listening();
      const first = createConnection(port, '127.0.0.1');
      const second = createConnection(port, '127.0.0.1');
      await Promise.all([
        new Promise((resolve) => first.once('connect', resolve)),
        new Promise((resolve) => second.once('connect', resolve)),
      ]);

      const count = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, total) => (error ? reject(error) : resolve(total)));
      });
      assert.strictEqual(count, 2);
      first.destroy();
      second.destroy();
      server.close();
    });

    it('ref() and unref() should be chainable', () => {
      const server = createServer();
      expect(server.ref()).toBe(server);
      expect(server.unref()).toBe(server);
    });
  });

  describe('a unix-domain socket, which the engine names by path', () => {
    it('listens on a path, pairs a connect to it, and refuses a path nothing holds', async () => {
      const path = '/tmp/tabnode-net-test.sock';
      const heard: string[] = [];
      const server = createServer((connection: unknown) => {
        const peer = connection as Socket;
        peer.setEncoding('utf8');
        peer.on('data', (chunk: unknown) => { heard.push(String(chunk)); peer.end('ack'); });
      });
      await new Promise((resolve) => server.listen(path, resolve as () => void));
      // Node's `server.address()` for a pipe is the path itself.
      assert.strictEqual(server.address(), path);

      const socket = createConnection(path);
      socket.setEncoding('utf8');
      const answered = new Promise<string>((resolve) => socket.once('data', (chunk: unknown) => resolve(String(chunk))));
      await new Promise((resolve) => socket.once('connect', resolve));
      // Node answers `{}` for a pipe: a unix-domain socket has no address.
      expect(socket.address()).toEqual({});
      socket.write('hello');
      assert.strictEqual(await answered, 'ack');
      assert.deepStrictEqual(heard, ['hello']);

      const missing = createConnection('/tmp/tabnode-no-such.sock');
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => missing.once('error', resolve as () => void));
      assert.strictEqual(error.code, 'ENOENT');

      socket.destroy();
      server.close();
    });
  });

  describe('createConnection/connect()', () => {
    it('createConnection should return a socket that connects', async () => {
      const { server, port } = await listening();
      const socket = createConnection(port, '127.0.0.1');
      expect(socket).toBeInstanceOf(Socket);
      await new Promise((resolve) => socket.once('connect', resolve));
      assert.strictEqual(socket.readyState, 'open');
      assert.strictEqual(socket.remotePort, port);
      socket.destroy();
      server.close();
    });

    it('connect alias should behave like createConnection', async () => {
      const { server, port } = await listening();
      const socket = connect({ port, host: 'localhost' });
      await new Promise((resolve) => socket.once('connect', resolve));
      assert.strictEqual(socket.remotePort, port);
      // Node connects to the address the lookup answered, not to the name.
      assert.strictEqual(socket.remoteAddress, '127.0.0.1');
      socket.destroy();
      server.close();
    });
  });

  describe('a realm in its network namespace', () => {
    it('has its own port space and its own loopback', async () => {
      const host = dockerHost();
      const web = await inside(host.web, () => answering('web', 5432));
      const db = await inside(host.db, () => answering('db', 5432));
      const fromWeb = await inside(host.web, () => readAll(createConnection(5432, '127.0.0.1')));
      const fromDb = await inside(host.db, () => readAll(createConnection(5432, '127.0.0.1')));
      expect(fromWeb.startsWith('web ')).toBe(true);
      expect(fromDb.startsWith('db ')).toBe(true);
      web.close();
      db.close();
    });

    it('reaches a peer on a shared network at its address, leaving by its own address there', async () => {
      const host = dockerHost();
      const api = await inside(host.api, () => answering('api', 8080, '0.0.0.0'));
      const socket = await inside(host.web, () => createConnection(8080, '172.18.0.3'));
      await new Promise(resolve => socket.once('connect', resolve));
      assert.strictEqual(socket.localAddress, '172.18.0.2');
      assert.strictEqual(socket.remoteAddress, '172.18.0.3');
      assert.strictEqual(await readAll(socket), 'api 172.18.0.2\n');
      api.close();
    });

    it('refuses a peer on no shared network with EHOSTUNREACH, as Docker isolates bridges', async () => {
      const host = dockerHost();
      const db = await inside(host.db, () => answering('db', 5432));
      const socket = await inside(host.web, () => createConnection(5432, '172.19.0.3'));
      const error = await failure(socket);
      assert.strictEqual(error.code, 'EHOSTUNREACH');
      assert.strictEqual(error.syscall, 'connect');
      db.close();
    });

    it('does not reach a server bound to the loopback at the namespace\'s address', async () => {
      const host = dockerHost();
      const api = await inside(host.api, () => answering('api', 9000, '127.0.0.1'));
      const socket = await inside(host.web, () => createConnection(9000, '172.18.0.3'));
      assert.strictEqual((await failure(socket)).code, 'ECONNREFUSED');
      api.close();
    });

    it('refuses a bind to an address the namespace does not hold with EADDRNOTAVAIL', async () => {
      const host = dockerHost();
      const server = createServer();
      const error = await inside(host.web, () => { server.listen(0, '172.19.0.3'); return failure(server); });
      assert.strictEqual(error.code, 'EADDRNOTAVAIL');
      assert.strictEqual(error.syscall, 'listen');
    });

    it('tells the host of each listener, which may refuse it and is told when it stops', async () => {
      const host = dockerHost();
      const db = await inside(host.db, () => answering('db', 5432));
      const told = host.told.find(entry => entry.namespace === 'db' && entry.listener.port === 5432);
      expect(told?.listener.family).toBe('IPv6');
      expect(told?.released).toBe(false);
      await new Promise(resolve => db.close(resolve));
      expect(told?.released).toBe(true);

      host.refuse(6000);
      const server = createServer();
      const error = await inside(host.db, () => { server.listen(6000); return failure(server); });
      assert.strictEqual(error.code, 'EADDRINUSE');
    });

    it('hands a connection to a listener the host holds, with the connector\'s bytes', async () => {
      const host = dockerHost();
      const socket = await inside(host.web, () => createConnection(3128, '172.18.0.1'));
      assert.strictEqual(await readAll(socket), 'proxy\n');
      assert.strictEqual(host.heldByHost[0]?.from, '172.18.0.2');
      assert.strictEqual(socket.localAddress, '172.18.0.2');
    });

    it('lets the host open a connection to a listener, from the address the host names', async () => {
      const host = dockerHost();
      const db = await inside(host.db, () => answering('db', 5432));
      const told = host.told.find(entry => entry.namespace === 'db' && entry.listener.port === 5432)!;
      const opened = told.listener.open({ address: '172.19.0.1', port: 40000 }, '172.19.0.3');
      expect(opened).toBeInstanceOf(Socket);
      // A dual-stack listener reads an IPv4 peer as Linux names it.
      assert.strictEqual(await readAll(opened as Socket), 'db ::ffff:172.19.0.1\n');
      db.close();
    });

    it('has only its loopback when its host gave it no namespace: any other address has no route', async () => {
      const socket = await inside(loopbackOnlyNamespace(), () => createConnection(80, '10.1.2.3'));
      assert.strictEqual((await failure(socket)).code, 'ENETUNREACH');
    });
  });

  describe('module object', () => {
    it('should expose key APIs', () => {
      expect(net.Socket).toBe(Socket);
      expect(net.Server).toBe(Server);
      expect(net.createServer).toBe(createServer);
      expect(net.connect).toBe(connect);
      expect(net.isIP).toBe(isIP);
      // Node's legacy alias, and the two classes `net` lazily exposes.
      expect(net.Stream).toBe(Socket);
      expect(typeof net.BlockList).toBe('function');
      expect(typeof net.SocketAddress).toBe('function');
    });
  });
});
