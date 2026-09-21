[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [url](../README.md) / pathToFileURL

# Function: pathToFileURL()

> **pathToFileURL**(`path`): `URL`

`url.pathToFileURL` takes any path Node takes. This encoded the whole path
after `file://`, so a path that did not begin with `/` became the URL's host,
and a virtual module id, the Vue plugin's `\0plugin-vue:export-helper`, was
no host at all: Vite's SSR loader asked for the file URL of every module it
instantiated and vue3-ssr's render died on "Invalid URL". A relative path is
resolved against the working directory first, as Node resolves it, and each
segment is encoded on its own, so the URL's path is the path.

## Parameters

### path

`string`

## Returns

`URL`
