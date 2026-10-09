// createRequire(file URL) then a relative require, as @librechat/agents' lazyRequire.cjs does, in a guest of the built engine.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = '/Users/yueranyuan/volter/heavy-runs/worker3/tabnode';
const lines = [];
const hostLog = console.log.bind(console);
console.log = (...p) => { const t = p.map(String).join(' '); if (t.includes('[cr]')) lines.push(t.slice(t.indexOf('[cr]'))); };
const { createContainer } = await import(pathToFileURL(resolve(root, 'dist/index.mjs')).href);
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const c = createContainer();
c.vfs.mkdirSync('/app/node_modules/@scope/pkg/dist/cjs/llm/openai', { recursive: true });
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/package.json', JSON.stringify({ name: 'pkg', type: 'module', exports: { '.': { require: './dist/cjs/main.cjs' } } }));
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/dist/cjs/llm/openai/index.cjs', 'exports.ok = "reached";');
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/dist/cjs/lazy.cjs', `
const m = require("node:module");
const url = require("url").pathToFileURL(__filename).href;
console.log("[cr] __filename " + __filename + " | url " + url);
const r = (0, m.createRequire)(url);
try { console.log("[cr] by url: " + r("./llm/openai/index.cjs").ok); } catch (e) { console.log("[cr] by url THREW: " + e.message); }
try { console.log("[cr] by path: " + m.createRequire(__filename)("./llm/openai/index.cjs").ok); } catch (e) { console.log("[cr] by path THREW: " + e.message); }
try { console.log("[cr] resolve by url: " + r.resolve("./llm/openai/index.cjs")); } catch (e) { console.log("[cr] resolve by url THREW: " + e.message); }
`);
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/dist/cjs/main.cjs', 'module.exports = require("./lazy.cjs");');
c.vfs.mkdirSync('/app/node_modules/@scope/pkg/dist/esm/llm/openai', { recursive: true });
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/dist/esm/llm/openai/index.mjs', 'export const ok = "reached esm";');
c.vfs.writeFileSync('/app/node_modules/@scope/pkg/dist/esm/lazy.mjs', 'import { createRequire } from "node:module"; console.log("[cr] esm import.meta.url " + import.meta.url); export const ext = import.meta.url.endsWith(".mjs") ? ".mjs" : import.meta.url.endsWith(".cjs") ? ".cjs" : null; console.log("[cr] esm build extension " + ext);');
c.vfs.writeFileSync('/app/main.cjs', 'require("@scope/pkg"); console.log("[cr] done");');
c.vfs.writeFileSync('/app/main.mjs', 'await import("/app/node_modules/@scope/pkg/dist/esm/lazy.mjs"); console.log("[cr] esm done");');
await c.run('node /app/main.mjs', { cwd: '/app', onStdout: (t) => console.log(String(t)) });
await c.run('node /app/main.cjs', { cwd: '/app', onStdout: (t) => console.log(String(t)) });
for (const l of [...new Set(lines)]) hostLog(l);
process.exit(0);
