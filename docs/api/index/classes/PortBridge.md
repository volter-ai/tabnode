[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / PortBridge

# Class: PortBridge

Server Bridge manages virtual HTTP servers and routes requests

## Extends

- `BridgeEvents`

## Extended by

- [`ServerBridge`](ServerBridge.md)

## Constructors

### Constructor

> **new PortBridge**(`options?`): `PortBridge`

#### Parameters

##### options?

`BridgeOptions` = `{}`

#### Returns

`PortBridge`

#### Overrides

`BridgeEvents.constructor`

## Properties

### servers

> **servers**: `Map`\<`number`, `VirtualServer`\>

***

### DEBUG

> `static` **DEBUG**: `boolean` = `false`

## Methods

### addListener()

> **addListener**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`Listener`

#### Returns

`this`

#### Inherited from

`BridgeEvents.addListener`

***

### bodyOf()

> `protected` **bodyOf**(`bytes`): `Uint8Array`

A request's body as the servers of this realm read it.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`Uint8Array`

***

### close()

> **close**(): `void`

Give back everything this bridge opened: the service worker keepalive,
and in an engine's bridge its upgrade channel. A host that is done with a
container calls it and has its process back; calling it twice is nothing.

#### Returns

`void`

***

### createFetchHandler()

> **createFetchHandler**(): (`request`) => `Promise`\<`Response`\>

Create a mock request handler for testing without Service Worker

#### Returns

(`request`) => `Promise`\<`Response`\>

***

### emit()

> **emit**(`event`, ...`args`): `boolean`

#### Parameters

##### event

`string` \| `symbol`

##### args

...`unknown`[]

#### Returns

`boolean`

#### Inherited from

`BridgeEvents.emit`

***

### getServerPorts()

> **getServerPorts**(): `number`[]

Get all registered server ports

#### Returns

`number`[]

***

### getServerUrl()

> **getServerUrl**(`port`): `string`

Get server URL for a port

#### Parameters

##### port

`number`

#### Returns

`string`

***

### handleRequest()

> **handleRequest**(`port`, `method`, `url`, `headers`, `body?`): `Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

Handle an incoming request from Service Worker

#### Parameters

##### port

`number`

##### method

`string`

##### url

`string`

##### headers

`Record`\<`string`, `string`\>

##### body?

`ArrayBuffer`

#### Returns

`Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

***

### handleStreamingRequest()

> **handleStreamingRequest**(`port`, `method`, `url`, `headers`, `body`, `callbacks`, `flow?`): `Promise`\<`boolean`\>

A page-side request streamed to the caller as it arrives, the door a host
reads a guest's server through when it wants chunks rather than a body:
a guest's own server is reached over the loopback as any client reaches
it; a server the host registered answers through its own streaming
method where it has one, else its buffered answer is delivered whole.

#### Parameters

##### port

`number`

##### method

`string`

##### url

`string`

##### headers

`Record`\<`string`, `string`\>

##### body

`ArrayBuffer` \| `undefined`

##### callbacks

###### chunk

###### end

###### start

##### flow?

[`LoopbackStreamFlow`](../interfaces/LoopbackStreamFlow.md)

#### Returns

`Promise`\<`boolean`\>

***

### initServiceWorker()

> **initServiceWorker**(`options?`): `Promise`\<`void`\>

Initialize Service Worker communication

#### Parameters

##### options?

[`InitServiceWorkerOptions`](../interfaces/InitServiceWorkerOptions.md)

Configuration options for the service worker

#### Returns

`Promise`\<`void`\>

***

### isGuest()

> `protected` **isGuest**(`entry`): `boolean`

Whether a registration is a guest's own listener, answered over the
engine's loopback rather than by a server object the host registered. A
bridge with no engine in its realm has none: every server it holds was
registered by the host, a worker's proxies among them.

#### Parameters

##### entry

`VirtualServer`

#### Returns

`boolean`

***

### listenerCount()

> **listenerCount**(`event`): `number`

#### Parameters

##### event

`string` \| `symbol`

#### Returns

`number`

#### Inherited from

`BridgeEvents.listenerCount`

***

### off()

> **off**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`Listener`

#### Returns

`this`

#### Inherited from

`BridgeEvents.off`

***

### on()

> **on**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`Listener`

#### Returns

`this`

#### Inherited from

`BridgeEvents.on`

***

### once()

> **once**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`Listener`

#### Returns

`this`

#### Inherited from

`BridgeEvents.once`

***

### registerServer()

> **registerServer**(`server`, `port`, `hostname?`): `void`

Register a server on a port

#### Parameters

##### server

`IVirtualServer` \| `null`

##### port

`number`

##### hostname?

`string` = `'0.0.0.0'`

#### Returns

`void`

***

### removeAllListeners()

> **removeAllListeners**(`event?`): `this`

#### Parameters

##### event?

`string` \| `symbol`

#### Returns

`this`

#### Inherited from

`BridgeEvents.removeAllListeners`

***

### removeListener()

> **removeListener**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`Listener`

#### Returns

`this`

#### Inherited from

`BridgeEvents.removeListener`

***

### requestGuest()

> `protected` **requestGuest**(`port`, `_method`, `_url`, `_headers`, `_body`): `Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

A request to a guest's listener, over the engine's loopback.

#### Parameters

##### port

`number`

##### \_method

`string`

##### \_url

`string`

##### \_headers

`Record`\<`string`, `string`\>

##### \_body

`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`

#### Returns

`Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

***

### setPrimaryPort()

> **setPrimaryPort**(`port`): `void`

Names the server the service worker serves at the origin's root, as an
app is served at its own origin's root: its documents read their routes
from `location.pathname`, which under /__virtual__/<port>/ is not the
path they expect. Told to the worker now and again whenever the worker
is (re)initialized, since a worker that restarted remembers nothing.

#### Parameters

##### port

`number` \| `null`

#### Returns

`void`

***

### streamGuest()

> `protected` **streamGuest**(`port`, `_method`, `_url`, `_headers`, `_body`, `_onStart`, `_onChunk`, `_onEnd`, `_flow?`): `Promise`\<`void`\>

A guest's answer streamed off its connection as it arrives.

#### Parameters

##### port

`number`

##### \_method

`string`

##### \_url

`string`

##### \_headers

`Record`\<`string`, `string`\>

##### \_body

`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`

##### \_onStart

(`statusCode`, `statusMessage`, `headers`) => `void`

##### \_onChunk

(`chunk`) => `void`

##### \_onEnd

() => `void`

##### \_flow?

[`LoopbackStreamFlow`](../interfaces/LoopbackStreamFlow.md)

#### Returns

`Promise`\<`void`\>

***

### unregisterServer()

> **unregisterServer**(`port`): `void`

Unregister a server

#### Parameters

##### port

`number`

#### Returns

`void`
