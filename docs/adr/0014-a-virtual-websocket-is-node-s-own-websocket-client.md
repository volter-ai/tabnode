# ADR-0014: A virtual WebSocket is Node's own WebSocket client, and the bridge carries only the channel

Status: Accepted.

Date: 2026-11-06. Served: browser-substrate ROADMAP 55 (the Tabnode row of ROADMAP 25), whose rule is browser-substrate
ADR-0099 "A frame at any depth", part "The carriers" ("The engine's connector"): Tabnode's server bridge carries a
virtual WebSocket as RFC 6455 and the WebSockets Standard do, and owns each client from its `connect` to its single
`close`.

## Context

### What the bridge is

`ServerBridge` (`src/server-bridge.ts`) answers a page's requests and sockets with a guest's own servers, over
connections it makes to the guest's port as its container's process (ADR-0009). Its sockets arrive on the
`vite-ws-channel` `BroadcastChannel`. Callers, by grep:
- in Tabnode, `createContainer` (`src/index.ts`, `new ServerBridge({ tree: vfs })`, one per container) and
  `getServerBridge` (`src/runtime.ts`);
- in browser-substrate (main 655f7df7d3f, and `item25-nested-frames` c8ae3e150b8), the connector
  `TabnodeVirtualWebSocketConnector` (`packages/node/src/tabnode-virtual-websocket.ts`), made once per runtime
  (`tabnode-runtime.ts`, `local-preview.ts`), and `createVirtualWebSocketRelay`, which puts a cross-origin page's
  messages on the channel from the engine's worker (`cross-origin-container-worker.ts`).

### The reference, read from source

Node v24.21.0's WebSocket client is undici 7.29.1's (`deps/undici/src/lib/web/websocket/`), which Tabnode already
vendors unedited in Node's bundle (`src/node-lib/internal/deps/undici/undici.js`, ADR-0009). Read at the tag:
- **Its door.** `new WebSocket(url, init)`, where `WebSocketInit` is `{ protocols, dispatcher, headers }`
  (`websocket.js:716-731`; bundle 15867). `dispatcher` is converted as `any` and defaults to the global dispatcher;
  `headers` is `HeadersInit`. The bundle exports `WebSocket` and `EnvHttpProxyAgent` (bundle 17871, 17880) and no
  `Agent` or `Client`.
- **The handshake** is WebSockets §2.2's "establish a WebSocket connection": a Fetch of mode "websocket", credentials
  "include", cache "no-store" (`connection.js:26-219`; bundle 14730), whose header list starts as `init.headers`
  (`connection.js:50-51`), then `Sec-WebSocket-Key` (16 random bytes), `Sec-WebSocket-Version: 13`, each protocol, and
  `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits` (`connection.js:84-88`). Fetch removes `host`
  (Host is the URL's), and appends `user-agent`, `accept-encoding`, `pragma` and `cache-control` where absent
  (`fetch/index.js:1321, 1468-1531`); it appends `Origin` from the client's origin only (`fetch/index.js:1460`), which
  is unset in the engine's scope, so the given `Origin` stands. The 101 is checked as RFC 6455 §4.1's response steps
  2-6 and §2.2 read: status 101, a requested protocol answered, `Upgrade: websocket`, `Connection: upgrade`,
  `Sec-WebSocket-Accept` the key's digest, an extension only the offered `permessage-deflate`, a protocol only one
  requested (`connection.js:96-214`). Each failure is `failWebsocketConnection(handler, 1002, …)`.
- **The fetch's dispatcher** is the one `init` names (`connection.js:95`, kept as `controller.dispatcher`,
  `fetch/index.js:84-87, 422`). Fetch calls only `dispatcher.dispatch(opts, handler)` with `upgrade: 'websocket'` and
  reads `isMockActive` (`fetch/index.js:2149-2163`); the 101 reaches the handler as `onUpgrade(status, rawHeaders,
  socket)` or `onRequestUpgrade(controller, status, headers, socket)` (`fetch/index.js:2338, 2373`; bundle 14014,
  14040). `EnvHttpProxyAgent(opts)` makes `new Agent(agentOpts)` of every other option (`env-http-proxy-agent.js:18-24`;
  bundle 11001), and an `Agent`'s `connect` may be a function that answers the socket (`agent.js:25-44`,
  `client.js:228-249`); a connect error fails the queued request (`client.js:530-563`).
- **The connection** (`websocket.js:466-626`, bundle 15705-15800): the parser (`receiver.js`) fails 1002 on an invalid
  opcode, a masked server frame, nonzero RSV bits (RSV1 without deflate), a fragmented or over-125-byte control frame,
  a stray continuation or an interleaved data frame, a Close of one byte or with a code outside its table, which
  accepts 1000-1003, 1007-1014 and 3000-4999 (`util.js` `isValidStatusCode`), and 1009 on a message over
  `maxPayloadSize` (`receiver.js:80-84`; bundle 15025), which it reads from `dispatcher.webSocketOptions`
  (`websocket.js:471-477`). A received Close is answered with a Close and the socket is left for the server to close
  (`receiver.js` `parseControlFrame`). Masks are `crypto.randomFillSync` (`frame.js:12`; bundle 14621). The `close`
  event reports the first Close's code, 1005 for one with no body, and 1006 with an `error` event where no Close was
  received; `wasClean` is a Close sent and received (`websocket.js:575-623`; bundle 15774).
- **Text** is `util.utf8Decode` (`util.js:315-327`; bundle 14571): with no `process.versions.icu`, which the engine
  does not answer (`node-versions.ts`), it is `buffer.isUtf8` and then `toString('utf-8')`. Tabnode's `isUtf8` is the
  platform's `new TextDecoder('utf-8', { fatal: true })` (`src/node-lib/binding/buffer.ts:456`), and `toString` strips
  no BOM: the WebSockets Standard's "UTF-8 decode without BOM or fail". Invalid text fails 1007 (`websocket.js:541`).
- **`close(code, reason)`** takes no code, 1000 or 3000-4999, else `InvalidAccessError` (`util.js:288-295`; bundle
  14557). Before the connection is established it fails it (`connection.js` `closeWebSocketConnection`).
- **Loading the bundle** sets undici's global dispatcher where none is (bundle 9950-9957): non-configurable
  `Symbol.for('undici.globalDispatcher.1')` and `.2` on the scope's global.

## Decision

### 1. The client end is Node's own WebSocket

Each virtual WebSocket is one `WebSocket` of the engine's own undici (`loadNodeLib('internal/deps/undici/undici')`,
unedited, loaded at the first one), `binaryType` `arraybuffer`:
- **URL:** `ws://<authority><target>`, the target being the connect URL's path and query, and the authority the
  connector's `Host` header where it is an authority (`host[:port]`, a bracketed IPv6 literal allowed), else
  `localhost:<guest port>`. Host is the URL's, as Fetch makes it, so the server sees the authority the page
  addressed.
- **`init.protocols`:** the connector's whole list. **`init.headers`:** the connector's request headers (ADR-0099 "The
  request": `Origin`, `Cookie`, `User-Agent`, `Accept`, Fetch Metadata), less `Host`.
- **`init.dispatcher`:** one per connection, a thin object over an `EnvHttpProxyAgent({ connect, httpProxy: '',
  httpsProxy: '' })` (no proxy is ever taken from the engine's environment):
  - `connect` opens `connectLoopback(tree, guestPort)` (ADR-0009 §3, the same door the bridge's requests take) and
    answers it once it is connected (`secureConnect` for a TLS server's port), or answers its error, recording a
    refusal (`ECONNREFUSED`) for §3. Until that answer the connection is the client's, not undici's (undici has no
    HTTP context for it before its callback): a cancel (§2) or the bridge's close (§5) destroys it and answers the
    connect with an error, so undici fails the request; a connect asked for a client already cancelled is answered
    with that error at once;
  - `webSocketOptions` is `{ maxPayloadSize: 32 MiB }` (browser-substrate ADR-0099 *Kept*, the size limit,
    `MAX_VIRTUAL_WEBSOCKET_FRAME_BYTES`), so a received message over it fails with 1009;
  - `dispatch(opts, handler)` hands undici's handler on with its `onUpgrade` and `onRequestUpgrade` observed: the
    101's `Set-Cookie` values, each as sent, and the upgraded socket are read there and the call goes on unchanged.
- The agent is destroyed at the connection's end.

So undici decides every protocol case: the handshake and its 101 checks, masking, the parser and its checks, the
close-code table, the closing handshake, 1005 and 1006, `wasClean`, and the 1002, 1007 and 1009 failures.

### 2. The channel

The connector (C) and the bridge (B) speak, on `vite-ws-channel`:
- C → B `connect { clientId, connector, url, protocols, headers, framing? }`: `connector` the connector's id (§3);
  `url` any URL whose port is the guest port and whose path and query are the request target; `headers` a
  `HeadersInit`.
- C → B `message { clientId, payload }`: a string, an `ArrayBuffer` or a view; `send` on the client's socket.
- C → B `disconnect { clientId, kind, code?, reason? }`:
  - `kind: 'close'` is `close(code, reason)`: with no code, a Close with no body, or 1000 where a reason is given
    (`closeWebSocketConnection`); with 1000 or 3000-4999, that code; with 1001, *Kept* (1) below;
  - `kind: 'fail'`, with a code or none, closes the connection with no Close (RFC 6455 §7.1.1): `socket.destroy()` on
    the socket §1's dispatcher saw once the connection is open; a code is *Kept* (2);
  - while the connection is still being made, either kind cancels it: `close()`, which undici answers by failing the
    connection and aborting its fetch; a loopback connection not yet answered is destroyed as §1 says; and a socket
    already upgraded, or one whose 101 arrives for a client already gone, is destroyed. No `connected` follows, and
    the client's one `close` is undici's failure, 1006, not clean.
- B → C `connected { targetClient, protocol, extensions, setCookie }`: at the socket's `open`, its `protocol` and
  `extensions` and the 101's `Set-Cookie` values, for the jar (ADR-0099 "A 101's `Set-Cookie` headers are stored in
  the jar").
- B → C `message { targetClient, payload }`: a string or an `ArrayBuffer`.
- B → C `close { targetClient, code, reason, wasClean }`: the socket's `close` event as undici fires it, once per
  client; a failure is 1006 and not clean.

A channel message that throws in its operation (a `send` before `open`, a `close` code or reason undici refuses, a
protocol list its constructor refuses) fails that client, as the substrate's relay fails a socket whose operation
throws (ADR-0099 "Validation").

### 3. A bridge answers the connectors its runtime registered

`ServerBridge.registerConnector(id)` registers a connector's random id with that bridge and answers the call that
removes it; the bridge's `close` removes all of its own. A bridge acts on a `connect` only for a registered id
(HTML §9.5's `BroadcastChannel` reaches every same-origin listener, so the id is what scopes it), and on `message`
and `disconnect` only for clients it took. Where every bridge a connector is registered with refuses a connect
(nothing listens on the port: the kernel refuses the connection), the last refusal answers `close` 1006, not clean;
a bridge whose port answers anything else answers for itself.

### 4. A byte pipe

A `connect` with `framing: 'none'` asks for no frames (VS Code's remote protocol, whose server writes its own 101 and
then bytes): the bridge makes the upgrade request over `__upgradeOverLoopback` with the connector's headers and the
WebSocket handshake headers, and carries each read as one `message` and each `message` as one write. Its 101's
`Set-Cookie` is read from the response's raw headers. The request's connection is the request's until its 101 hands it
to the client: a `disconnect` before then cancels the request through `__upgradeOverLoopback`'s abort signal, which
destroys that connection, and answers the client's one `close`, 1006, not clean; a result that arrives for a cancelled
client is destroyed. Once connected, `disconnect` `close` ends the connection (FIN) and `fail` destroys it. RFC 6455 does not apply, and a byte pipe has no closing handshake: its end is reported `close` 1005, clean,
when the connection ended without error, and 1006, not clean, when it errored.

### 5. The bridge's close

A bridge that closes (its container disposed) tells each of its clients `close` 1006, not clean, while its channel can
carry it, and gives back its channel; then each connection is ended by its state, as browser-substrate ADR-0099's
runtime release ends a socket:
- CONNECTING is cancelled as §2 cancels it;
- OPEN is closed as *Kept* (1) closes one at the runtime's release;
- CLOSING is aborted: its upgraded socket is destroyed. undici's `close` does nothing for a CLOSING socket
  (`closeWebSocketConnection`, bundle 14820-14825), and ADR-0099 *Kept* aborts CLOSING because the carriers go with
  the runtime;
- each byte pipe is destroyed, and one whose upgrade request is outstanding has that request cancelled as §4 cancels
  it.

### Kept

- **(1) 1001 is sent as a Close with no body.** Where the reference sends 1001 (the WebSockets Standard's "make
  disappear", which HTML's unloading document cleanup runs: an established socket's closing handshake starts with
  1001; and at the runtime's release, ADR-0099 "OPEN closed with 1001 at the server"), the bridge calls `close()`, so
  the server reads 1005. Reason: undici's public `close` takes only 1000 and 3000-4999 (`util.js:288-295`), and the
  only other route to its closing handshake is a second, unbundled undici (its websocket modules import its whole
  fetch and dispatcher graph: 49 files, 753 KB at 7.29.1). Closes with a browser-substrate ROADMAP 55 note.
- **(2) The relay's 1002 for a malformed operation is a failure with no Close.** ADR-0099 *Kept* fails a socket whose
  document operation the relay refuses with 1002; here it is §2's `fail`: `socket.destroy()` once open, `close()`
  while connecting, reported 1006, not clean. Reason: as (1). The 1002, 1007 and 1009 the parser originates are
  undici's own, with their Close. Closes with a browser-substrate ROADMAP 55 note.
- **permessage-deflate is offered, accepted and inflated**, as undici does (`connection.js:84-88, 176-183`,
  `permessage-deflate.js`): the page sees whole messages, and a 101 naming an extension not offered fails. This is the
  reference's case, not a departure; browser-substrate ROADMAP 55 and 57 are corrected to it (the carrier fails only
  an extension it did not offer).
- **undici's global dispatcher.** Loading the bundle in the engine's scope defines the two global-dispatcher symbols on
  the realm's global where they are absent. The bridge never uses that dispatcher: every connection names its own.

## Where the evidence stops

- **Read:** undici 7.29.1 at Node v24.21.0 (`deps/undici/src/lib/web/websocket/`, `web/fetch/index.js`,
  `dispatcher/{env-http-proxy-agent,agent,client,dispatcher-base}.js`) and the vendored bundle's lines cited;
  browser-substrate ADR-0099 at `item25-nested-frames` c8ae3e150b8 ("The request", "Opening and the hub", "The
  carriers", *Kept*); the connector at main 655f7df7d3f.
- **Extrapolation:** that the bundle loads in the engine's own scope as it loads in a process's (its `net`, `tls`,
  `zlib`, `crypto` and `worker_threads` the engine's), and that an upgraded socket undici's `Agent` hands over is
  released by the agent's `destroy` without being touched.
- **Coded, not run.**
