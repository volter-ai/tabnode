[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [url](../README.md) / URL

# Variable: URL

> `const` **URL**: \{(`url`, `base?`): `URL`; `prototype`: `URL`; `canParse`: `boolean`; `createObjectURL`: `string`; `parse`: `URL` \| `null`; `revokeObjectURL`: `void`; \} = `globalThis.URL`

## Type Declaration

## Parameters

### url

`string` \| `URL`

### base?

`string` \| `URL`

## Returns

`URL`

### prototype

> **prototype**: `URL`

### canParse()

> **canParse**(`url`, `base?`): `boolean`

The **`URL.canParse()`** static method of the URL interface returns a boolean indicating whether or not an absolute URL, or a relative URL combined with a base URL, are parsable and valid.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/canParse_static)

#### Parameters

##### url

`string` \| `URL`

##### base?

`string` \| `URL`

#### Returns

`boolean`

### createObjectURL()

> **createObjectURL**(`obj`): `string`

The **`createObjectURL()`** static method of the URL interface creates a string containing a URL representing the object given in the parameter.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/createObjectURL_static)

#### Parameters

##### obj

`Blob` \| `MediaSource`

#### Returns

`string`

### parse()

> **parse**(`url`, `base?`): `URL` \| `null`

The **`URL.parse()`** static method of the URL interface returns a newly created URL object representing the URL defined by the parameters.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/parse_static)

#### Parameters

##### url

`string` \| `URL`

##### base?

`string` \| `URL`

#### Returns

`URL` \| `null`

### revokeObjectURL()

> **revokeObjectURL**(`url`): `void`

The **`revokeObjectURL()`** static method of the URL interface releases an existing object URL which was previously created by calling Call this method when you've finished using an object URL to let the browser know not to keep the reference to the file any longer.

[MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/revokeObjectURL_static)

#### Parameters

##### url

`string`

#### Returns

`void`
