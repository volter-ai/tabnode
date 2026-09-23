[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ServerBridge

# Class: ServerBridge

## Extends

- `EventEmitter`

## Constructors

### Constructor

> **new ServerBridge**(`options?`): `ServerBridge`

#### Parameters

##### options?

`BridgeOptions` = `{}`

#### Returns

`ServerBridge`

#### Overrides

`EventEmitter.constructor`

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

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.addListener`

***

### close()

> **close**(): `void`

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

`EventEmitter.emit`

***

### eventNames()

> **eventNames**(): (`string` \| `symbol`)[]

#### Returns

(`string` \| `symbol`)[]

#### Inherited from

`EventEmitter.eventNames`

***

### getMaxListeners()

> **getMaxListeners**(): `number`

#### Returns

`number`

#### Inherited from

`EventEmitter.getMaxListeners`

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

### listenerCount()

> **listenerCount**(`event`, `listener?`): `number`

#### Parameters

##### event

`string` \| `symbol`

##### listener?

`EventListener`

#### Returns

`number`

#### Inherited from

`EventEmitter.listenerCount`

***

### listeners()

> **listeners**(`event`): `EventListener`[]

#### Parameters

##### event

`string` \| `symbol`

#### Returns

`EventListener`[]

#### Inherited from

`EventEmitter.listeners`

***

### off()

> **off**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.off`

***

### on()

> **on**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.on`

***

### once()

> **once**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.once`

***

### prependListener()

> **prependListener**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.prependListener`

***

### prependOnceListener()

> **prependOnceListener**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.prependOnceListener`

***

### rawListeners()

> **rawListeners**(`event`): `EventListener`[]

#### Parameters

##### event

`string` \| `symbol`

#### Returns

`EventListener`[]

#### Inherited from

`EventEmitter.rawListeners`

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

`EventEmitter.removeAllListeners`

***

### removeListener()

> **removeListener**(`event`, `listener`): `this`

#### Parameters

##### event

`string` \| `symbol`

##### listener

`EventListener`

#### Returns

`this`

#### Inherited from

`EventEmitter.removeListener`

***

### setMaxListeners()

> **setMaxListeners**(`n`): `this`

#### Parameters

##### n

`number`

#### Returns

`this`

#### Inherited from

`EventEmitter.setMaxListeners`

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

### unregisterServer()

> **unregisterServer**(`port`): `void`

Unregister a server

#### Parameters

##### port

`number`

#### Returns

`void`
