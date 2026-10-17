[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ServerBridge

# Class: ServerBridge

Server Bridge manages virtual HTTP servers and routes requests

## Extends

- [`PortBridge`](PortBridge.md)

## Constructors

### Constructor

> **new ServerBridge**(`options?`): `ServerBridge`

#### Parameters

##### options?

`BridgeOptions` = `{}`

#### Returns

`ServerBridge`

#### Overrides

[`PortBridge`](PortBridge.md).[`constructor`](PortBridge.md#constructor)

## Properties

### servers

> **servers**: `Map`\<`number`, `VirtualServer`\>

#### Inherited from

[`PortBridge`](PortBridge.md).[`servers`](PortBridge.md#servers)

***

### DEBUG

> `static` **DEBUG**: `boolean` = `false`

#### Inherited from

[`PortBridge`](PortBridge.md).[`DEBUG`](PortBridge.md#debug)

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

[`PortBridge`](PortBridge.md).[`addListener`](PortBridge.md#addlistener)

***

### bodyOf()

> `protected` **bodyOf**(`bytes`): `Uint8Array`

A server of this engine reads a request's body as Node's Buffer.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`Uint8Array`

#### Overrides

[`PortBridge`](PortBridge.md).[`bodyOf`](PortBridge.md#bodyof)

***

### close()

> **close**(): `void`

Give back everything this bridge opened: the service worker keepalive,
and in an engine's bridge its upgrade channel. A host that is done with a
container calls it and has its process back; calling it twice is nothing.

#### Returns

`void`

#### Overrides

[`PortBridge`](PortBridge.md).[`close`](PortBridge.md#close)

***

### createFetchHandler()

> **createFetchHandler**(): (`request`) => `Promise`\<`Response`\>

Create a mock request handler for testing without Service Worker

#### Returns

(`request`) => `Promise`\<`Response`\>

#### Inherited from

[`PortBridge`](PortBridge.md).[`createFetchHandler`](PortBridge.md#createfetchhandler)

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

[`PortBridge`](PortBridge.md).[`emit`](PortBridge.md#emit)

***

### getServerPorts()

> **getServerPorts**(): `number`[]

Get all registered server ports

#### Returns

`number`[]

#### Inherited from

[`PortBridge`](PortBridge.md).[`getServerPorts`](PortBridge.md#getserverports)

***

### getServerUrl()

> **getServerUrl**(`port`): `string`

Get server URL for a port

#### Parameters

##### port

`number`

#### Returns

`string`

#### Inherited from

[`PortBridge`](PortBridge.md).[`getServerUrl`](PortBridge.md#getserverurl)

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

#### Inherited from

[`PortBridge`](PortBridge.md).[`handleRequest`](PortBridge.md#handlerequest)

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

#### Inherited from

[`PortBridge`](PortBridge.md).[`handleStreamingRequest`](PortBridge.md#handlestreamingrequest)

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

#### Inherited from

[`PortBridge`](PortBridge.md).[`initServiceWorker`](PortBridge.md#initserviceworker)

***

### isGuest()

> `protected` **isGuest**(`entry`): `boolean`

A guest's listener (the old null sentinel, now a request adapter) is answered over the loopback.

#### Parameters

##### entry

`VirtualServer`

#### Returns

`boolean`

#### Overrides

[`PortBridge`](PortBridge.md).[`isGuest`](PortBridge.md#isguest)

***

### listenerCount()

> **listenerCount**(`event`): `number`

#### Parameters

##### event

`string` \| `symbol`

#### Returns

`number`

#### Inherited from

[`PortBridge`](PortBridge.md).[`listenerCount`](PortBridge.md#listenercount)

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

[`PortBridge`](PortBridge.md).[`off`](PortBridge.md#off)

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

[`PortBridge`](PortBridge.md).[`on`](PortBridge.md#on)

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

[`PortBridge`](PortBridge.md).[`once`](PortBridge.md#once)

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

#### Inherited from

[`PortBridge`](PortBridge.md).[`registerServer`](PortBridge.md#registerserver)

***

### removeAllListeners()

> **removeAllListeners**(`event?`): `this`

#### Parameters

##### event?

`string` \| `symbol`

#### Returns

`this`

#### Inherited from

[`PortBridge`](PortBridge.md).[`removeAllListeners`](PortBridge.md#removealllisteners)

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

[`PortBridge`](PortBridge.md).[`removeListener`](PortBridge.md#removelistener)

***

### requestGuest()

> `protected` **requestGuest**(`port`, `method`, `url`, `headers`, `body`): `Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

A request to a guest's listener, over the engine's loopback.

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

`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`

#### Returns

`Promise`\<[`ResponseData`](../interfaces/ResponseData.md)\>

#### Overrides

[`PortBridge`](PortBridge.md).[`requestGuest`](PortBridge.md#requestguest)

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

#### Inherited from

[`PortBridge`](PortBridge.md).[`setPrimaryPort`](PortBridge.md#setprimaryport)

***

### streamGuest()

> `protected` **streamGuest**(`port`, `method`, `url`, `headers`, `body`, `onStart`, `onChunk`, `onEnd`, `flow?`): `Promise`\<`void`\>

A guest's answer streamed off its connection as it arrives.

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

`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`

##### onStart

(`statusCode`, `statusMessage`, `headers`) => `void`

##### onChunk

(`chunk`) => `void`

##### onEnd

() => `void`

##### flow?

[`LoopbackStreamFlow`](../interfaces/LoopbackStreamFlow.md)

#### Returns

`Promise`\<`void`\>

#### Overrides

[`PortBridge`](PortBridge.md).[`streamGuest`](PortBridge.md#streamguest)

***

### unregisterServer()

> **unregisterServer**(`port`): `void`

Unregister a server

#### Parameters

##### port

`number`

#### Returns

`void`

#### Inherited from

[`PortBridge`](PortBridge.md).[`unregisterServer`](PortBridge.md#unregisterserver)

***

### waitForPrimaryPortMapping()

> **waitForPrimaryPortMapping**(`port`, `options`): `Promise`\<`void`\>

Wait until the controlling worker has installed this listening port as
the origin's primary mapping. This exchanges metadata only: it never
calls the application's HTTP handler. Cancellation belongs to the caller.
An older worker must update before using this door; no HTTP probe substitutes.

#### Parameters

##### port

`number`

##### options

###### signal

`AbortSignal`

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`PortBridge`](PortBridge.md).[`waitForPrimaryPortMapping`](PortBridge.md#waitforprimaryportmapping)
