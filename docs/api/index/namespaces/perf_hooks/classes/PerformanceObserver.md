[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [perf\_hooks](../README.md) / PerformanceObserver

# Class: PerformanceObserver

## Constructors

### Constructor

> **new PerformanceObserver**(`callback`): `PerformanceObserver`

#### Parameters

##### callback

(`list`) => `void`

#### Returns

`PerformanceObserver`

## Properties

### supportedEntryTypes

> `static` **supportedEntryTypes**: `string`[]

## Methods

### disconnect()

> **disconnect**(): `void`

#### Returns

`void`

***

### observe()

> **observe**(`options`): `void`

#### Parameters

##### options

###### entryTypes?

`string`[]

###### type?

`string`

#### Returns

`void`

***

### takeRecords()

> **takeRecords**(): [`PerformanceEntry`](../interfaces/PerformanceEntry.md)[]

#### Returns

[`PerformanceEntry`](../interfaces/PerformanceEntry.md)[]
