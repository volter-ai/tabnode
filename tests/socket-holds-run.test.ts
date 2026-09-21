// Node keeps a process alive for any active handle, and a connected socket is
// one; `socket.unref()` is how a program says this one should not hold the
// loop. The engine counted a run's timers, its held host work and the ports it
// was listening on, and never a socket — so a program whose only handle is a
// client socket read as idle and was settled with exit 0. VS Code's extension
// host is exactly that program: it holds one socket back to the server that
// forked it and sets no timer, and openvscode-server reported "Extension host
// (Remote) terminated unexpectedly. Code: 0" three times and gave up.
//
// Measured the way `tests/held-async.test.ts` measures: by when the run's own
// promise settles. The server program is a held run, so nothing but its own
// `end()` decides when the client's socket closes, and the client program sets
// no timer at all — its socket is the only thing that can hold it.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

const PORT = 45871;

/** The server: it accepts one connection and ends it two seconds later. */
const SERVER = [
  "const net = require('net');",
  "const server = net.createServer((socket) => {",
  "  console.log('accepted');",
  "  setTimeout(() => socket.end(), 2000);",
  "});",
  `server.listen(${PORT}, () => console.log('listening'));`,
].join('\n');

/** The client: one socket, nothing else. Nothing here can hold the run but it. */
const CLIENT = [
  "const net = require('net');",
  `const socket = net.connect(${PORT}, '127.0.0.1', () => console.log('connected'));`,
].join('\n');

/** The same client, saying its socket should not hold the loop. */
const UNREF = [
  "const net = require('net');",
  `const socket = net.connect(${PORT}, '127.0.0.1', () => console.log('connected'));`,
  "socket.unref();",
].join('\n');

function tab() {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  vfs.writeFileSync('/app/server.js', SERVER);
  vfs.writeFileSync('/app/client.js', CLIENT);
  vfs.writeFileSync('/app/unref.js', UNREF);
  return createContainer({ vfs });
}

/** When the run settled, against when it printed `connected`. */
async function connectThenSettle(
  container: ReturnType<typeof tab>,
  program: string,
): Promise<{ connectedAt: number; settledAt: number; observedAt1500: number; exitCode: number; stdout: string }> {
  let connectedAt = 0;
  let settledAt = 0;
  const run = container.run(`node /app/${program}`, {
    cwd: '/app',
    onStdout: (text: string) => { if (connectedAt === 0 && text.includes('connected')) connectedAt = Date.now(); },
  });
  run.then(() => { settledAt = Date.now(); });
  // Wait for the connect, then read whether the run is still going at 1500 ms.
  while (connectedAt === 0 && settledAt === 0) await new Promise(r => setTimeout(r, 10));
  while (Date.now() - connectedAt < 1500 && settledAt === 0) await new Promise(r => setTimeout(r, 10));
  const observedAt1500 = settledAt;
  const result = await run;
  return { connectedAt, settledAt, observedAt1500, exitCode: result.exitCode, stdout: result.stdout };
}

describe('a run whose only handle is a connected socket', () => {
  it('is alive while the socket is open and ends when it closes, as Node does', async () => {
    const container = tab();
    const abort = new AbortController();
    let listening = false;
    const server = container.run('node /app/server.js', {
      cwd: '/app',
      held: true,
      signal: abort.signal,
      onStdout: (text: string) => { if (text.includes('listening')) listening = true; },
    });
    while (!listening) await new Promise(r => setTimeout(r, 10));

    const held = await connectThenSettle(container, 'client.js');
    // Node would still be running here: the socket is an active handle.
    expect(held.observedAt1500, 'settled while its socket was still open').toBe(0);
    expect(held.stdout).toBe('connected\n');
    expect(held.exitCode).toBe(0);
    // The server ends the connection at 2000 ms; the run ends with it.
    expect(held.settledAt - held.connectedAt).toBeGreaterThan(2000);
    expect(held.settledAt - held.connectedAt).toBeLessThan(3000);

    abort.abort();
    await server;
  }, 30_000);

  it('ends without waiting for a socket the program unref d, as Node does', async () => {
    const container = tab();
    const abort = new AbortController();
    let listening = false;
    const server = container.run('node /app/server.js', {
      cwd: '/app',
      held: true,
      signal: abort.signal,
      onStdout: (text: string) => { if (text.includes('listening')) listening = true; },
    });
    while (!listening) await new Promise(r => setTimeout(r, 10));

    const released = await connectThenSettle(container, 'unref.js');
    expect(released.stdout).toBe('connected\n');
    expect(released.exitCode).toBe(0);
    // Nothing holds it: it settles on the engine's idle rule, long before the
    // server's `end()` at 2000 ms.
    expect(released.settledAt - released.connectedAt).toBeLessThan(1500);

    abort.abort();
    await server;
  }, 30_000);
});
