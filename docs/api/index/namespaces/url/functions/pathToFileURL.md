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
resolved against the working directory first, as Node resolves it.

Node encodes only what the URL would otherwise read as something else (`%`,
`\`, a newline, a carriage return, a tab, `?`, `#`, `|`, `^`, `[`, `]`, `~`) and leaves the rest
to the URL's own path encoding (lib/internal/url.js, encodePathChars). This
encoded each segment whole, so `@` became `%40`: @librechat/agents makes its
`require` from `pathToFileURL(__filename).href` and asks it for
`./llm/openai/index.cjs`, which was looked for under `node_modules/%40librechat`
and not found, and LibreChat answered every message with that error (mini run 5).

## Parameters

### path

`string`

## Returns

`URL`
