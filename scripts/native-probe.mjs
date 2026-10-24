// One layer under the public surface: of the members Node's own lib files ask of their bindings and hand-bound
// internals (scripts/native-surface.mjs's inventory), which does this engine answer, and which are undefined.
// An export that exists can still be a hole here. An instrument: it prints and writes its table, and changes nothing.
//   node scripts/native-surface.mjs --out measurement/native.json
//   node scripts/native-probe.mjs --inventory measurement/native.json --out measurement/native-probe.json
// It bundles the engine's two registries from source (so it reads this checkout, not a published build) and reads
// each key off the object its registry gives. A registry that needs a running realm to make its object says so,
// and those keys are counted as not probed, never as answered.
import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const inventory = JSON.parse(fs.readFileSync(resolve(arg('inventory', 'measurement/native.json')), 'utf8'));
const output = resolve(arg('out', 'measurement/native-probe.json'));
const hostLog = console.log.bind(console), hostExit = process.exit.bind(process), hostWrite = fs.writeFileSync.bind(fs);
const { build } = await import(pathToFileURL(resolve(root, 'node_modules/esbuild/lib/main.js')).href);
const raw = { name: 'raw', setup(b) {
  b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' }));
  b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8'), loader: 'text' }));
} };
const bundle = resolve(fs.mkdtempSync(resolve(tmpdir(), 'native-probe-')), 'registries.mjs');
await build({
  stdin: { contents: `import ${JSON.stringify(resolve(root, 'src/index.ts'))};\nexport { nodeLibBinding } from ${JSON.stringify(resolve(root, 'src/node-lib/binding/index.ts'))};\nexport { nodeLibInternal } from ${JSON.stringify(resolve(root, 'src/node-lib/internals/index.ts'))};\n`, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent', plugins: [raw],
  // A dependency's compiled addon is not part of what is probed: left as the require it was, which nothing here runs.
  // (A clean install builds @mongodb-js/zstd's, and bundling it failed: no loader for `.node`.)
  external: ['*.node'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
if (typeof globalThis.window === 'undefined') globalThis.window = { navigator: { serviceWorker: {} } };
const { nodeLibBinding, nodeLibInternal } = await import(pathToFileURL(bundle).href);
const made = new Map();
const objectOf = (kind, name) => {
  const key = `${kind}:${name}`;
  if (made.has(key)) return made.get(key);
  let answer;
  try {
    // A hand-bound internal may be made from a process; this stand-in has the members those read.
    const standIn = { platform: 'linux', arch: 'x64', version: `v${inventory.nodeVersion}`, cwd: () => '/', emitWarning: () => undefined };
    const factory = kind === 'binding' ? nodeLibBinding(name) : nodeLibInternal(name, createRequire(import.meta.url), standIn);
    answer = factory === undefined ? { state: 'not registered' } : { state: 'made', value: factory() };
  } catch (error) { answer = { state: 'could not be made here', reason: String(error?.message ?? error).split('\n')[0].slice(0, 160) }; }
  made.set(key, answer);
  return answer;
};
const rows = [];
for (const entry of inventory.entries) {
  const [kind, rest] = [entry.key.slice(0, entry.key.indexOf(':')), entry.key.slice(entry.key.indexOf(':') + 1)];
  // A name may itself hold dots and slashes (internal/fs/utils); the longest registered prefix is the object.
  const parts = rest.split('.');
  let name = parts[0], path = parts.slice(1);
  let status, detail;
  // An internal the engine carries as Node's own file answers with that file's exports, which the public-surface
  // measure and Node's tests cover; the registry is not where it comes from, so it is not probed here.
  const vendored = kind === 'internal' && fs.existsSync(resolve(root, 'src/node-lib', `${name}.js`));
  // `req.oncomplete = …`: a field the lib sets on a request object it made, which the inventory lists beside the
  // members it reads. Named by the field, since the inventory does not say which way the access went.
  const setByLib = /\.prototype\.(?:oncomplete|callback|handle|context|async|buffer|bytes|address|port|addressType|localAddress|localPort|onchange|onerror)$/.test(rest);
  const base = vendored || setByLib ? { state: 'skipped' } : objectOf(kind, name);
  if (vendored) status = "Node's own lib file (not a registry's object)";
  else if (setByLib) status = 'a field the lib sets itself (by its name)';
  else if (base.state !== 'made') { status = base.state; detail = base.reason; }
  else {
    let value = base.value, at = name;
    status = 'answered';
    for (const member of path) {
      if (value === null || value === undefined) { status = 'undefined'; detail = `${at} is ${value === null ? 'null' : 'undefined'}`; break; }
      // An accessor is there if it is declared; calling a prototype's getter with no instance proves nothing.
      let declared;
      for (let holder = Object(value); holder && !declared; holder = Object.getPrototypeOf(holder)) declared = Object.getOwnPropertyDescriptor(holder, member);
      at += `.${member}`;
      if (declared && 'get' in declared && !('value' in declared)) { status = 'answered'; detail = 'accessor'; value = null; break; }
      try { value = value[member]; } catch (error) { status = 'reading it throws'; detail = String(error?.message ?? error).split('\n')[0].slice(0, 160); break; }
    }
    if (status === 'answered' && value === undefined) { status = 'undefined'; detail = `${at} is undefined`; }
    if (status === 'answered' && detail === undefined) detail = typeof value;
  }
  rows.push({ key: entry.key, status, ...(detail ? { detail } : {}), sites: entry.sites?.slice(0, 2) ?? [] });
}
const count = (status) => rows.filter((row) => row.status === status).length;
const statuses = [...new Set(rows.map((row) => row.status))].sort();
hostWrite(output, JSON.stringify({ nodeVersion: inventory.nodeVersion, entries: rows.length, counts: Object.fromEntries(statuses.map((s) => [s, count(s)])),
  notProbedComputedReads: inventory.unresolved?.length ?? 0, rows }, null, 1) + '\n');
hostLog(`Native probe: ${rows.length} members the vendored lib asks for: ${statuses.map((s) => `${count(s)} ${s}`).join(', ')}; ${inventory.unresolved?.length ?? 0} computed or escaping reads are not members this can read`);
for (const status of statuses.filter((s) => s !== 'answered' && !s.startsWith("Node's own") && !s.startsWith('a field the lib'))) {
  hostLog(`\n${status}:`);
  for (const row of rows.filter((r) => r.status === status).slice(0, 400)) hostLog(`  ${row.key}${row.detail ? `  (${row.detail})` : ''}${row.sites[0] ? `  asked at ${row.sites[0]}` : ''}`);
}
hostExit(0);
