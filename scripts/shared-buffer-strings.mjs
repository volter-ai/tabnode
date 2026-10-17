// A Buffer over a SharedArrayBuffer written to and read as a string, in a guest of the built engine, with the host's
// TextEncoder and TextDecoder made to refuse a shared view as a browser's do (Node's own accept one):
// `node scripts/shared-buffer-strings.mjs` after `vite build --config vite.lib.config.js`.
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isShared = (view) => view && (view instanceof SharedArrayBuffer || view.buffer instanceof SharedArrayBuffer);
const encodeInto = TextEncoder.prototype.encodeInto, decode = TextDecoder.prototype.decode;
TextEncoder.prototype.encodeInto = function (text, into) { if (isShared(into)) throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': The provided Uint8Array value must not be shared."); return encodeInto.call(this, text, into); };
TextDecoder.prototype.decode = function (input, options) { if (isShared(input)) throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared."); return decode.call(this, input, options); };
const lines = [];
const hostLog = console.log.bind(console);
console.log = (...p) => { const t = p.map(String).join(' '); if (t.includes('[sb]')) lines.push(t.slice(t.indexOf('[sb]'))); };
const { createContainer } = await import(pathToFileURL(resolve(root, 'dist/index.mjs')).href);
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const c = createContainer();
c.vfs.mkdirSync('/app', { recursive: true });
c.vfs.writeFileSync('/app/main.cjs', `
const say = (name, work) => { try { console.log("[sb] " + name + " " + JSON.stringify(work())); } catch (e) { console.log("[sb] " + name + " THREW " + e.message); } };
const buf = Buffer.from(new SharedArrayBuffer(32));
say("write utf8", () => [buf.write("h\\u00e9llo \\u4e16\\u754c", 0, "utf8"), buf.toString("utf8", 0, 13)]);
say("write partial", () => { const small = Buffer.from(new SharedArrayBuffer(4)); return [small.write("a\\u4e16\\u754c"), [...small]]; });
say("latin1", () => { buf.fill(0); buf.write("caf\\u00e9", 0, "latin1"); return buf.toString("latin1", 0, 4); });
say("utf16le", () => { buf.fill(0); buf.write("hi\\u4e16", 0, "utf16le"); return buf.toString("utf16le", 0, 6); });
say("utf16le odd offset", () => { buf.fill(0); buf.write("ok", 1, "utf16le"); return buf.toString("utf16le", 1, 5); });
say("TextDecoder", () => new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(3)).fill(65)));
say("isUtf8", () => require("buffer").isUtf8(Buffer.from(new SharedArrayBuffer(2)).fill(65)));
say("unshared", () => { const plain = Buffer.alloc(8); return [plain.write("ok\\u00e9"), plain.toString("utf8", 0, 4)]; });
`);
await c.run('node /app/main.cjs', { cwd: '/app', onStdout: (t) => console.log(String(t)), onStderr: (t) => console.log('[sb] stderr ' + String(t)) });
for (const l of [...new Set(lines)]) hostLog(l);
process.exit(0);
