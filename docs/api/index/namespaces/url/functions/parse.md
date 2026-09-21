[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [url](../README.md) / parse

# Function: parse()

> **parse**(`urlString`, `parseQueryString?`, `slashesDenoteHost?`): [`UrlObject`](../interfaces/UrlObject.md)

The legacy `url.parse` gives a path back as a path. Node's
`url.parse("/workspace/app/x")` has `href` and `pathname` equal to the input
and no host; the shim resolved every input against a made-up
`http://localhost`, so `href` came back as a URL, and Tailwind v3, which runs
each config dependency through `url.parse(file).href` before it stats it,
stated a path that does not exist. An input with no scheme is split into its
path, search and hash, as Node does.

## Parameters

### urlString

`string`

### parseQueryString?

`boolean` = `false`

### slashesDenoteHost?

`boolean` = `false`

## Returns

[`UrlObject`](../interfaces/UrlObject.md)
