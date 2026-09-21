/**
 * A guest listen is news the page bridge reports, on every host a server
 * binds.
 *
 * The substrate's port contract waits for `runtime.on("port")` with state
 * open, which is `observeBrowserServerPorts` wrapping `registerServer` and
 * binding `server.handleRequest`. A listen with a host (`127.0.0.1`, the
 * gate; `0.0.0.0`) looks the address up and then registers; a listen with
 * no host (openvscode-server's) binds immediately. Both have to report.
 * The wrap the page uses is the one that used to throw on a `null` server.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { ServerBridge } from '../src/server-bridge';

function listen(vfs: VirtualFS, port: number, host?: string): void {
  const bind = host === undefined
    ? `.listen(${port})`
    : `.listen(${port}, ${JSON.stringify(host)})`;
  vfs.writeFileSync('/work/s.js', `require('http').createServer((q, s) => s.end('ok'))${bind};`);
  new Runtime(vfs, { cwd: '/work' }).execute(vfs.readFileSync('/work/s.js', 'utf8') as string, '/work/s.js');
}

/** One tick: a named host's listen goes through `dns.lookup`'s setImmediate. */
function afterLookup(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('a guest listen reaches the bridge', () => {
  it('reports a listen on 0.0.0.0, on 127.0.0.1, and on an unspecified host', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    const seen: number[] = [];
    const bridge = new ServerBridge();
    // The page wraps registerServer and reads handleRequest, as
    // observeBrowserServerPorts does. A null server threw there.
    const register = bridge.registerServer.bind(bridge);
    bridge.registerServer = ((server: { handleRequest: (method: string, url: string, headers: Record<string, string>, body?: unknown) => unknown }, port: number, hostname?: string) => {
      const handle = server.handleRequest.bind(server);
      server.handleRequest = handle;
      register(server as never, port, hostname);
    }) as typeof bridge.registerServer;
    bridge.on('server-ready', (port: number) => { seen.push(port); });

    listen(vfs, 41001, '0.0.0.0');
    listen(vfs, 41002, '127.0.0.1');
    listen(vfs, 41003);
    await afterLookup();

    expect([...seen].sort((a, b) => a - b)).toEqual([41001, 41002, 41003]);
  });
});
