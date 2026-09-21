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
 * refusals the way Node's kernel does.
 */

import { describe, it, expect, vi } from 'vitest';
import { netModule as net, Socket, Server, createServer, createConnection, connect, isIP, isIPv4, isIPv6 } from '../../src/node-lib/net-module';
import { assert } from './common';

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
