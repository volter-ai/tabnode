[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [vite-plugin](../README.md) / tabnodePlugin

# Function: tabnodePlugin()

> **tabnodePlugin**(`options?`): `Plugin`

Vite plugin that serves the tabnode service worker file.

When tabnode is installed as an npm package, the service worker file
is located at node_modules/tabnode/dist/__sw__.js but the browser
tries to load it from the root URL (/__sw__.js). This plugin intercepts
requests to the service worker path and serves the file from the correct location.

## Parameters

### options?

[`TabnodePluginOptions`](../interfaces/TabnodePluginOptions.md) = `{}`

## Returns

`Plugin`

## Example

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { tabnodePlugin } from 'tabnode/vite';

export default defineConfig({
  plugins: [tabnodePlugin()]
});
```
