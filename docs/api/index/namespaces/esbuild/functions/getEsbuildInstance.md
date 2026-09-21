[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [esbuild](../README.md) / getEsbuildInstance

# Function: getEsbuildInstance()

> **getEsbuildInstance**(): `__module` \| `null`

The instance, for the lanes outside this module that need it: the module
transformer and the dev servers. Exporting the `let` itself put a live
binding in the shim's namespace, which is the surface a guest's
`require("esbuild")` reads; an accessor keeps that surface a stable
function rather than a value that changes under the guest.

## Returns

`__module` \| `null`
