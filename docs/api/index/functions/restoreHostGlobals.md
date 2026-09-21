[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / restoreHostGlobals

# Function: restoreHostGlobals()

> **restoreHostGlobals**(): `void`

Give the realm back. Every property the engine took returns to what the
host had, newest first. A host that created a runtime inside its own
process and is done with it gets its own globals back; a runtime created
afterwards installs them again.

## Returns

`void`
