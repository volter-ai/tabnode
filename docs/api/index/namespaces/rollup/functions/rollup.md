[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [rollup](../README.md) / rollup

# Function: rollup()

> **rollup**(`options`): `Promise`\<[`RollupBundle`](../interfaces/RollupBundle.md)\>

A script is not finished while its build is running. Rollup's work is held
so the process loop waits: the graph while `rollup()` builds it, the chunks
while `generate` or `write` renders them. A React Router build is Vite's
build, which is rollup's, and printed nothing for the half second the engine
waited, so the Dockerfile stage moved on with no `build/`.

## Parameters

### options

[`RollupBuildOptions`](../interfaces/RollupBuildOptions.md)

## Returns

`Promise`\<[`RollupBundle`](../interfaces/RollupBundle.md)\>
