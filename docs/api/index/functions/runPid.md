[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / runPid

# Function: runPid()

> **runPid**(`token`): \{ `pgid?`: `number`; `pid`: `number`; `ppid`: `number`; \} \| `undefined`

A named run's numbers as its registry reads them now: its pid, its parent and its group. Its parent and group move
(a reparenting, setpgid, setsid), so they are read, never kept.

## Parameters

### token

`string` \| `null` \| `undefined`

## Returns

\{ `pgid?`: `number`; `pid`: `number`; `ppid`: `number`; \} \| `undefined`
