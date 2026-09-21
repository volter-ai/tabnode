[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [worker\_threads](../README.md) / Worker

# Class: Worker

## Extends

- `EventEmitter`

## Constructors

### Constructor

> **new Worker**(`filename`, `options?`): `Worker`

#### Parameters

##### filename

`string`

##### options?

###### workerData?

`unknown`

#### Returns

`Worker`

#### Overrides

`EventEmitter.constructor`

## Properties

### resourceLimits

> **resourceLimits**: `object` = `{}`

***

### threadId

> **threadId**: `number` = `0`

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

### getHeapSnapshot()

> **getHeapSnapshot**(): `Promise`\<`unknown`\>

#### Returns

`Promise`\<`unknown`\>

***

### getMaxListeners()

> **getMaxListeners**(): `number`

#### Returns

`number`

#### Inherited from

`EventEmitter.getMaxListeners`

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

### postMessage()

> **postMessage**(`value`, `transferList?`): `void`

#### Parameters

##### value

`unknown`

##### transferList?

`unknown`[]

#### Returns

`void`

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

### ref()

> **ref**(): `void`

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

### terminate()

> **terminate**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

***

### unref()

> **unref**(): `void`

#### Returns

`void`
