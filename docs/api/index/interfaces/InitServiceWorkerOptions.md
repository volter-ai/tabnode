[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / InitServiceWorkerOptions

# Interface: InitServiceWorkerOptions

## Properties

### ownDocuments?

> `optional` **ownDocuments?**: `string`[]

The page's own documents that are frames of it (a sandbox, a worker
host), by path, so the worker does not take one for the preview's.

***

### swUrl?

> `optional` **swUrl?**: `string`

The URL path to the service worker file

#### Default

```ts
'/__sw__.js'
```
