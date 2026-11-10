[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [perf\_hooks](../README.md) / default

# Variable: default

> `const` **default**: `object`

## Type Declaration

### constants

> **constants**: `Readonly`\<\{ `NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE`: `16`; `NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY`: `32`; `NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED`: `2`; `NODE_PERFORMANCE_GC_FLAGS_FORCED`: `4`; `NODE_PERFORMANCE_GC_FLAGS_NO`: `0`; `NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE`: `64`; `NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING`: `8`; `NODE_PERFORMANCE_GC_INCREMENTAL`: `8`; `NODE_PERFORMANCE_GC_MAJOR`: `4`; `NODE_PERFORMANCE_GC_MINOR`: `1`; `NODE_PERFORMANCE_GC_WEAKCB`: `16`; \}\>

### createHistogram

> **createHistogram**: *typeof* [`createHistogram`](../functions/createHistogram.md)

### monitorEventLoopDelay

> **monitorEventLoopDelay**: *typeof* [`monitorEventLoopDelay`](../functions/monitorEventLoopDelay.md)

### performance

> **performance**: `object`

#### performance.clearMarks

> **clearMarks**: (`name?`) => `void`

##### Parameters

###### name?

`string`

##### Returns

`void`

#### performance.clearMeasures

> **clearMeasures**: (`name?`) => `void`

##### Parameters

###### name?

`string`

##### Returns

`void`

#### performance.clearResourceTimings

> **clearResourceTimings**: () => `void`

##### Returns

`void`

#### performance.eventLoopUtilization

> **eventLoopUtilization**: *typeof* `eventLoopUtilization`

#### performance.getEntries

> **getEntries**: () => `TimelineEntry`[]

##### Returns

`TimelineEntry`[]

#### performance.getEntriesByName

> **getEntriesByName**: (`name`, `type?`) => `TimelineEntry`[]

##### Parameters

###### name

`string`

###### type?

`string`

##### Returns

`TimelineEntry`[]

#### performance.getEntriesByType

> **getEntriesByType**: (`type`) => `TimelineEntry`[]

##### Parameters

###### type

`string`

##### Returns

`TimelineEntry`[]

#### performance.markResourceTiming

> **markResourceTiming**: () => `undefined`

Node records a PerformanceResourceTiming for each fetch undici makes; this engine keeps no resource timeline.

##### Returns

`undefined`

#### performance.now

> **now**: () => `number`

##### Returns

`number`

#### performance.setResourceTimingBufferSize

> **setResourceTimingBufferSize**: () => `void`

##### Returns

`void`

#### performance.timeOrigin

> `readonly` **timeOrigin**: `number`

#### performance.timerify

> **timerify**: \<`T`\>(`fn`) => `T`

##### Type Parameters

###### T

`T` *extends* (...`args`) => `unknown`

##### Parameters

###### fn

`T`

##### Returns

`T`

#### performance.mark()

> **mark**(`name`, `options?`): `TimelineEntry`

##### Parameters

###### name

`string`

###### options?

###### detail?

`unknown`

###### startTime?

`number`

##### Returns

`TimelineEntry`

#### performance.measure()

> **measure**(`name`, `start?`, `end?`): `TimelineEntry`

##### Parameters

###### name

`string`

###### start?

`string` \| `number` \| \{ `detail?`: `unknown`; `duration?`: `number`; `end?`: `string` \| `number`; `start?`: `string` \| `number`; \}

###### end?

`string` \| `number`

##### Returns

`TimelineEntry`

#### performance.toJSON()

> **toJSON**(): `object`

##### Returns

`object`

###### eventLoopUtilization

> **eventLoopUtilization**: `ReturnType`\<*typeof* `eventLoopUtilization`\>

###### timeOrigin

> **timeOrigin**: `number`

### PerformanceObserver

> **PerformanceObserver**: *typeof* [`PerformanceObserver`](../classes/PerformanceObserver.md)
