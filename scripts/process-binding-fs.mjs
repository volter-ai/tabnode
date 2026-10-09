// process.binding('fs') as audiobookshelf's ripstat reads it, in a guest of the built engine, beside which of Node's
// allowed names answer: `node scripts/process-binding-fs.mjs` after `vite build --config vite.lib.config.js`.
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
const hostLog = console.log.bind(console);
console.log = (...p) => { const t = p.map(String).join(' '); if (t.includes('[pb]')) lines.push(t.slice(t.indexOf('[pb]'))); };
const { createContainer } = await import(pathToFileURL(resolve(root, 'dist/index.mjs')).href);
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const c = createContainer();
c.vfs.mkdirSync('/app', { recursive: true });
c.vfs.writeFileSync('/app/file.txt', 'twelve bytes');
c.vfs.writeFileSync('/app/main.cjs', `
const { stat, FSReqCallback } = process['binding']('fs');
const ask = (path, bigint) => new Promise((done) => {
  const req = new FSReqCallback(bigint);
  req.oncomplete = (error, data) => done(error
    ? 'error ' + error.code + ' ' + error.syscall + ' ' + error.errno
    : data.constructor.name + ' ' + data.length + ' size ' + data[8] + ' mode ' + (Number(data[1]) & 0o170000).toString(8) + ' mtime ' + (Number(data[12]) > 0 ? 'set' : 'zero'));
  stat(require('path').toNamespacedPath(path), bigint, req);
});
(async () => {
  console.log('[pb] bigint ' + await ask('/app/file.txt', true));
  console.log('[pb] number ' + await ask('/app/file.txt', false));
  console.log('[pb] missing ' + await ask('/app/nope', true));
  const names = ['buffer', 'cares_wrap', 'config', 'constants', 'contextify', 'fs', 'fs_event_wrap', 'icu', 'inspector', 'js_stream', 'os',
    'pipe_wrap', 'process_wrap', 'spawn_sync', 'stream_wrap', 'tcp_wrap', 'tls_wrap', 'tty_wrap', 'udp_wrap', 'uv', 'zlib', 'not_a_binding'];
  const said = names.map((name) => { try { return name + ':' + typeof process.binding(name); } catch (e) { return name + ':THREW ' + e.message; } });
  console.log('[pb] names ' + said.join(' | '));
})();
`);
await c.run('node /app/main.cjs', { cwd: '/app', onStdout: (t) => console.log(String(t)), onStderr: (t) => console.log('[pb] stderr ' + String(t)) });
for (const l of [...new Set(lines)]) hostLog(l);
process.exit(0);
