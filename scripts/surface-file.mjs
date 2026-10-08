// The engine's surface as one file in the package, `dist/surface.json`: what a reader of an installed
// @volter/tabnode can say this version answers, without running it. Made from the two measurements, never typed:
//   measurement/public.json        scripts/public-surface.mjs  (every builtin's exports against Node's own)
//   measurement/native-probe.json  scripts/native-probe.mjs    (the bindings Node's lib asks for, answered or not)
// `npm run build:surface` runs the measurements and then this, after `build:lib` (it measures the built engine).
// Ids: `engine.<builtin>` and `engine.<builtin>.<export>` for the public layer, `engine.<registry>.<key>` under it
// (`engine.binding.fs.internalModuleStat`), the registry being the one Node's lib asked.
import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const read = (path) => JSON.parse(fs.readFileSync(resolve(path), 'utf8'));
const surface = read(arg('public', 'measurement/public.json'));
const probe = read(arg('native', 'measurement/native-probe.json'));
const output = resolve(arg('out', 'dist/surface.json'));
const version = JSON.parse(fs.readFileSync(resolve(root, 'package.json'), 'utf8')).version;
// A top-level export is `<module>:$["name"]`; everything a difference names under it is that export's.
const top = /^([^:]+):\$\["((?:[^"\\]|\\.)*)"\]/;
const builtins = {};
for (const module of surface.modules) builtins[module] = { id: `engine.${module}`, exports: {} };
for (const member of surface.members) {
  const at = top.exec(member.key);
  if (!at || member.key !== at[0]) continue;
  builtins[at[1]].exports[JSON.parse(`"${at[2]}"`)] = { is: 'same', differences: 0 };
}
for (const difference of surface.differences) {
  const at = top.exec(difference.key);
  if (!at) { const module = difference.key.split(':')[0]; if (builtins[module]) builtins[module].shape = (builtins[module].shape ?? 0) + 1; continue; }
  const name = JSON.parse(`"${at[2]}"`);
  const entry = builtins[at[1]].exports[name] ?? (builtins[at[1]].exports[name] = { is: 'extra', differences: 0 });
  entry.differences += 1;
  if (difference.key === at[0] && difference.reason === 'missing-member') entry.is = 'missing';
  else if (entry.is === 'same') entry.is = 'differs';
  if (difference.limitation) entry.limitation = difference.limitation;
}
const counts = { same: 0, differs: 0, missing: 0, extra: 0 };
for (const builtin of Object.values(builtins)) for (const entry of Object.values(builtin.exports)) counts[entry.is] += 1;
const bindings = Object.fromEntries(probe.rows.map((row) => [`engine.${row.key.replace(':', '.')}`, { is: row.status, ...(row.detail ? { detail: row.detail } : {}) }]));
fs.mkdirSync(dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({
  package: '@volter/tabnode', version, nodeVersion: surface.nodeVersion,
  made: 'scripts/surface-file.mjs from scripts/public-surface.mjs and scripts/native-probe.mjs',
  exports: counts, bindingCounts: probe.counts, notProbedComputedReads: probe.notProbedComputedReads,
  builtins, bindings,
}) + '\n');
console.log(`Surface file: ${output}: ${Object.keys(builtins).length} builtins, exports ${JSON.stringify(counts)}, bindings ${JSON.stringify(probe.counts)}`);
