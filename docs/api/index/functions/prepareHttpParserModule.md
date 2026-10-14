[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / prepareHttpParserModule

# Function: prepareHttpParserModule()

> **prepareHttpParserModule**(): `Promise`\<`Module`\>

Compile llhttp asynchronously once per engine load, before starting realms.
Await this in the realm-creating worker and structured-clone the result to
each guest worker. No parser is instantiated or run on this thread.

## Returns

`Promise`\<`Module`\>
