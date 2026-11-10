[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [perf\_hooks](../README.md) / performance

# Variable: performance

> `const` **performance**: `object`

## Type Declaration

### clearMarks

> **clearMarks**: (`name?`) => `void`

#### Parameters

##### name?

`string`

#### Returns

`void`

### clearMeasures

> **clearMeasures**: (`name?`) => `void`

#### Parameters

##### name?

`string`

#### Returns

`void`

### clearResourceTimings

> **clearResourceTimings**: () => `void`

#### Returns

`void`

### eventLoopUtilization

> **eventLoopUtilization**: *typeof* `eventLoopUtilization`

### getEntries

> **getEntries**: () => `TimelineEntry`[]

#### Returns

`TimelineEntry`[]

### getEntriesByName

> **getEntriesByName**: (`name`, `type?`) => `TimelineEntry`[]

#### Parameters

##### name

`string`

##### type?

`string`

#### Returns

`TimelineEntry`[]

### getEntriesByType

> **getEntriesByType**: (`type`) => `TimelineEntry`[]

#### Parameters

##### type

`string`

#### Returns

`TimelineEntry`[]

### markResourceTiming

> **markResourceTiming**: () => `undefined`

Node records a PerformanceResourceTiming for each fetch undici makes; this engine keeps no resource timeline.

#### Returns

`undefined`

### now

> **now**: () => `number`

#### Returns

`number`

### setResourceTimingBufferSize

> **setResourceTimingBufferSize**: () => `void`

#### Returns

`void`

### timeOrigin

> `readonly` **timeOrigin**: `number`

### timerify

> **timerify**: \<`T`\>(`fn`) => `T`

#### Type Parameters

##### T

`T` *extends* (...`args`) => `unknown`

#### Parameters

##### fn

`T`

#### Returns

`T`

### mark()

> **mark**(`name`, `options?`): `TimelineEntry`

#### Parameters

##### name

`string`

##### options?

###### detail?

`unknown`

###### startTime?

`number`

#### Returns

`TimelineEntry`

### measure()

> **measure**(`name`, `start?`, `end?`): `TimelineEntry`

#### Parameters

##### name

`string`

##### start?

`string` \| `number` \| \{ `detail?`: `unknown`; `duration?`: `number`; `end?`: `string` \| `number`; `start?`: `string` \| `number`; \}

##### end?

`string` \| `number`

#### Returns

`TimelineEntry`

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### eventLoopUtilization

> **eventLoopUtilization**: `ReturnType`\<*typeof* `eventLoopUtilization`\>

##### timeOrigin

> **timeOrigin**: `number`
