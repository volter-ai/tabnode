[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / precompileNodeLib

# Function: precompileNodeLib()

> **precompileNodeLib**(`name`): `boolean`

Compiles a builtin's file ahead of its first require, running none of it: a realm that waits idle for its process
(a spare) spends that wait here instead of in the process's start. False for a name that has no file, or one
already compiled.

## Parameters

### name

`string`

## Returns

`boolean`
