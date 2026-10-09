// Web Crypto through a guest's GLOBALS, as an application calls it: every `crypto.subtle` method as a method,
// destructured and bare, and node:crypto's webcrypto. An instrument: it runs a script of forms (default: the
// webcrypto-case's server.js, whose every form is what Node v24.21.0 does) in a guest of the BUILT engine and
// prints the guest's own lines. The receiver a host's method is called on is decided in src/runtime.ts
// (__substrateHeldAsync); a check of that file alone is not this path.
//   npm run build:lib && node scripts/webcrypto-forms.mjs [script] [--engine <dir>] [--node-host]        (Node 24.21.0)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv.slice(2).find((word, index, all) => !word.startsWith('--') && all[index - 1] !== '--engine') ?? '/Users/yueranyuan/volter/heavy-runs/review/after-127/webcrypto-case/server.js';
const hostLog = console.log.bind(console);
const lines = [];
console.log = (...parts) => { for (const line of parts.map(String).join(' ').split('\n')) if (line.includes('[webcrypto-case]')) lines.push(line.slice(line.indexOf('[webcrypto-case]'))); };
// A HOST THAT CHECKS ITS RECEIVER AS A BROWSER'S DOES. Node's own Web Crypto takes a Proxy of its SubtleCrypto for
// the real thing, so under Node alone a method called on the engine's proxy answers and this instrument would show
// nothing; Chrome's refuses it ("TypeError: Illegal invocation", what a tab said). So the host's `crypto` is
// stood in for by one whose every method throws that unless it is called on the very object it was read off.
// `--node-host` runs against Node's own instead.
if (!process.argv.includes('--node-host')) {
  const real = globalThis.crypto, illegal = () => { throw new TypeError('Illegal invocation'); };
  const strict = (source, names) => { const made = {}; for (const name of names) made[name] = function (...args) { if (this !== made) illegal(); return source[name](...args); }; return made; };
  const subtle = strict(real.subtle, ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']);
  const host = strict(real, ['getRandomValues', 'randomUUID']);
  Object.defineProperty(host, 'subtle', { get() { if (this !== host) illegal(); return subtle; }, enumerable: true });
  Object.defineProperty(globalThis, 'crypto', { value: host, configurable: true, writable: true });
}
// `--engine <dir>` runs another build of the engine (a packed one), to read a change before and after.
const engine = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : root;
const { createContainer } = await import(pathToFileURL(resolve(engine, 'dist/index.mjs')).href);
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const container = createContainer();
container.vfs.mkdirSync('/app', { recursive: true });
container.vfs.writeFileSync('/app/forms.cjs', readFileSync(script, 'utf8'));
const run = await container.run('node /app/forms.cjs', { cwd: '/app', env: { WEBCRYPTO_CASE_ONCE: '1' }, onStdout: (text) => console.log(String(text)) });
console.log(String(run.stdout ?? ''));
const seen = [...new Set(lines)];
for (const line of seen) hostLog(line);
if (!seen.some((line) => line.includes('PASS:') || line.includes('FAIL:'))) hostLog(`the guest printed no total (exit ${run.exitCode}); stderr: ${String(run.stderr ?? '').slice(0, 400)}`);
process.exit(seen.some((line) => line.includes(' PASS:')) ? 0 : 1);
