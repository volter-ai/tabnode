// Every request a server sees carries a Host. HTTP/1.1 requires one and Node's
// own parser answers 400 without it, so a server is written as though it is
// always there: Next's middleware reads `req.headers.get('host')` on its first
// line. A browser's fetch may not send the header and a service worker may not
// add it, so the request reaching the bridge often has none; the server is
// listening on a port, and that is the authority it is reachable at.
import { describe, expect, it } from 'vitest';
import { ServerBridge } from '../src/server-bridge';

/** A server that answers with whatever Host it was given. */
function echoing(): { handleRequest(method: string, url: string, headers: Record<string, string>): Promise<{ statusCode: number; statusMessage: string; headers: Record<string, string>; body: Buffer }> } {
  return {
    handleRequest: async (_method, _url, headers) => ({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(JSON.stringify(headers)),
    }),
  };
}

async function hostSeenBy(hostname: string | undefined, sent: Record<string, string>): Promise<string | undefined> {
  const bridge = new ServerBridge();
  bridge.registerServer(echoing() as never, 8080, hostname);
  const answer = await bridge.handleRequest(8080, 'GET', '/', sent);
  const seen = JSON.parse(String(answer.body)) as Record<string, string>;
  return seen.host ?? seen.Host;
}

describe('a request reaching a guest server', () => {
  it('carries the port it is listening on when the caller sent no Host', async () => {
    expect(await hostSeenBy(undefined, {})).toBe('127.0.0.1:8080');
    expect(await hostSeenBy('0.0.0.0', {})).toBe('127.0.0.1:8080');
    expect(await hostSeenBy('::', {})).toBe('127.0.0.1:8080');
  });

  it('names the hostname the server announced, when it announced one', async () => {
    expect(await hostSeenBy('app.localhost', {})).toBe('app.localhost:8080');
  });

  it('keeps a Host the caller sent, whatever its spelling', async () => {
    expect(await hostSeenBy(undefined, { host: 'sent.example:9000' })).toBe('sent.example:9000');
    expect(await hostSeenBy('app.localhost', { Host: 'sent.example:9000' })).toBe('sent.example:9000');
  });
});
