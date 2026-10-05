import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, limitations } from './parity-data.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const output = resolve(arg('out', 'measurement/public.json'));
const engine = resolve(arg('engine', 'dist/index.mjs'));
if (process.version !== `v${manifest.nodeVersion}`) throw new Error(`public reference requires Node ${manifest.nodeVersion}, got ${process.version}`);
const modules = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))].sort();
const worker = fileURLToPath(new URL('./public-surface-worker.mjs', import.meta.url));
const snapshots = `${dirname(output)}/public-snapshots`;
fs.mkdirSync(snapshots, { recursive: true });
async function capture(mode, module, index) {
  const path = `${snapshots}/${index}-${mode}.json`;
  await new Promise((done) => {
    const child = spawn(process.execPath, [worker, JSON.stringify({ mode, module, engine, output: path })], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('error', (error) => { clearTimeout(timer); fs.writeFileSync(path, JSON.stringify({ module, error: { message: error.message } })); done(); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify({ module, error: { message: `snapshot exited ${code ?? signal} without recording exports` } }));
      done();
    });
  });
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
const differences = [];
const unresolved = [];
const members = [];
const exceptions = limitations();
function compare(module, expected, actual) {
  const seen = new Map();
  const diff = (path, reason, a, b) => {
    const key = `${module}:${path}`;
    const exception = exceptions.find((entry) => entry.review?.verdict !== 'overturned' && entry.publicEntries.includes(key));
    differences.push({ key, reason, expected: a, actual: b, limitation: exception?.id ?? null });
  };
  if (expected.error) { unresolved.push({ key: `${module}:$`, reason: `real Node export snapshot failed: ${expected.error.message}` }); return; }
  function visit(path, e, a) {
    const en = e.ref === undefined ? e : expected.snapshot.nodes[e.ref];
    const an = !a ? null : a.ref === undefined ? a : actual.snapshot.nodes[a.ref];
    const key = `${module}:${path}`;
    members.push({ key, expected: { type: en.type, arity: en.arity }, actual: an ? { type: an.type, arity: an.arity } : null });
    if (!an) diff(path, 'missing-member', en.type, actual.error ?? null);
    else {
      if (en.type !== an.type) diff(path, 'typeof', en.type, an.type);
      if (en.arity !== an.arity) diff(path, 'arity', en.arity, an.arity);
    }
    if (en.type === 'accessor') {
      if (an && (en.get !== an.get || en.set !== an.set)) diff(path, 'accessor-arity', en, an);
      unresolved.push({ key: `${module}:${path}`, reason: 'accessor return type not observed' });
      return;
    }
    if (e.ref === undefined) return;
    if (seen.has(e.ref)) {
      if (a?.ref !== seen.get(e.ref)) diff(path, 'shared-reference-identity', seen.get(e.ref), a?.ref ?? null);
      return;
    }
    seen.set(e.ref, a?.ref);
    if (en.error || an?.error) unresolved.push({ key: `${module}:${path}`, reason: en.error ?? an.error });
    for (const key of Object.keys(en.properties ?? {}).sort()) visit(`${path}[${JSON.stringify(key)}]`, en.properties[key], an?.properties?.[key]);
    // A prototype is part of the public shape, including inherited members.
    if (en.prototype) visit(`${path}.[[Prototype]]`, en.prototype, an?.prototype);
  }
  visit('$', expected.snapshot.root, actual.snapshot?.root);
}
for (const [index, module] of modules.entries()) {
  // Host and engine live in separate processes; the engine's global takeover
  // cannot contaminate its real Node reference.
  const expected = await capture('node', module, index);
  const actual = await capture('engine', module, index);
  compare(module, expected, actual);
}
const report = { nodeVersion: manifest.nodeVersion, modules, members, differences, unresolved };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Public surface: ${differences.filter((entry) => !entry.limitation).length} unattributed differences, ${unresolved.length} unmeasured reads across ${modules.length} builtins`);
