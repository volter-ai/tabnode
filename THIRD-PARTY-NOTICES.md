# Third-party notices

What this repository carries that is someone else's, each under its own
licence, reproduced where it sits. Dependencies fetched by npm carry their
licences in `node_modules` and are not listed here.

| What | Where | Origin | Licence |
|---|---|---|---|
| Node.js's own library files, unmodified | `src/node-lib/**/*.js` | `nodejs/node` v22.18.0, `lib/` | MIT, `src/node-lib/LICENSE` |
| llhttp compiled to WebAssembly, the build undici ships | `src/node-lib/binding/llhttp-wasm.ts` | undici 6.28.0, `lib/llhttp/llhttp-wasm.js` (`nodejs/llhttp`, `nodejs/undici`) | MIT |
| punycode 2.3.1, the library Node ships as its `punycode` builtin | `src/punycode-source.ts` | Mathias Bynens, `mathiasbynens/punycode.js` | MIT |
| The engine this repository is a fork of | the tree | `macaly/almostnode` 0.2.14 | MIT, `LICENSE` |
