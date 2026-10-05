// All states derive from measured evidence, exact limitations, or an explicit
// work assignment. A matching shape and a passing test are distinct proof rows.
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { limitations, namedFailure, moduleFor } from './parity-data.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const out = resolve(arg('out', 'measurement'));
const read = (file) => JSON.parse(fs.readFileSync(`${out}/${file}`, 'utf8'));
const metadata = read('summary.json');
const results = read('results.json');
const native = read('native.json');
const surface = read('public.json');
const exceptions = limitations();
const work = JSON.parse(fs.readFileSync(new URL('./parity-work.json', import.meta.url), 'utf8'));
const active = new Set(work.doing);
const capabilities = [];
const state = (key, done, exception) => done ? 'done' : exception ? "won't do" : active.has(key) ? 'doing' : 'todo';
for (const result of results.results) {
  const key = `test:${result.file}`;
  const exception = !result.passed ? namedFailure(result, exceptions) : null;
  capabilities.push({ key, layer: 'behavior', module: moduleFor(result.file), state: state(key, result.passed, exception),
    metric: result.passed ? 'exit 0' : result.reason, evidence: `results.json: ${result.file}; exit=${result.code}, signal=${result.signal}, timeout=${result.timedOut}`,
    reason: exception ? `${exception.id}: ${exception.reason}` : '', limitation: exception?.id ?? null });
}
for (const entry of native.entries) {
  const key = `native:${entry.key}`;
  const exception = entry.status === 'REFUSING' ? exceptions.find((item) => item.id === entry.classification.limitation) : null;
  capabilities.push({ key, layer: 'native entry', module: entry.key.split(':')[1].split('.')[0],
    state: state(key, entry.status === 'IMPLEMENTED', exception), metric: entry.status,
    evidence: entry.sites.join('; '), reason: exception ? `${exception.id}: ${exception.reason}` : '', limitation: exception?.id ?? null });
}
for (const entry of native.unresolved) {
  const key = `native-read:${entry.site}:${entry.expression}`;
  capabilities.push({ key, layer: 'native enumeration', module: 'unresolved', state: state(key, false, null), metric: entry.reason,
    evidence: entry.site, reason: '', limitation: null });
}
const publicIssues = new Map();
for (const entry of [...surface.differences, ...surface.unresolved]) {
  if (!publicIssues.has(entry.key)) publicIssues.set(entry.key, []);
  publicIssues.get(entry.key).push(entry);
}
for (const entry of surface.members) {
  const key = `public:${entry.key}`;
  const issues = publicIssues.get(entry.key) ?? [];
  const exception = issues.length && issues.every((issue) => issue.limitation)
    ? exceptions.find((item) => item.id === issues[0].limitation) : null;
  capabilities.push({ key, layer: 'public shape', module: entry.key.split(':')[0], state: state(key, !issues.length, exception),
    metric: issues.length ? issues.map((issue) => issue.reason).join('; ') : `typeof ${entry.expected.type}` + (entry.expected.arity === undefined ? '' : `, arity ${entry.expected.arity}`),
    evidence: 'public.json; public-snapshots (real Node / engine object graphs)', reason: exception ? `${exception.id}: ${exception.reason}` : '', limitation: exception?.id ?? null });
}
const memberKeys = new Set(surface.members.map((entry) => entry.key));
for (const entry of surface.unresolved.filter((issue) => !memberKeys.has(issue.key))) {
  const key = `public:${entry.key}`;
  capabilities.push({ key, layer: 'public enumeration', module: entry.key.split(':')[0], state: state(key, false, null), metric: entry.reason,
    evidence: 'public.json; public-snapshots', reason: '', limitation: null });
}
const statusCounts = Object.fromEntries(['done', 'doing', 'todo', "won't do"].map((label) => [label, capabilities.filter((entry) => entry.state === label).length]));
const capabilityKeys = new Set(capabilities.map((entry) => entry.key));
if (capabilityKeys.size !== capabilities.length) throw new Error('duplicate capability row');
const staleWork = work.doing.filter((key) => !capabilityKeys.has(key));
if (staleWork.length) throw new Error(`doing keys are outside the measured scope: ${staleWork.join(', ')}`);
Object.assign(metadata, { capabilityRows: capabilities.length, statusCounts,
  enumerationFinal: native.unresolved.length === 0 && !surface.unresolved.some((entry) => entry.reason.startsWith('real Node export snapshot failed')) });
fs.writeFileSync(`${out}/capabilities.json`, JSON.stringify({ metadata, capabilities }, null, 2) + '\n');
fs.writeFileSync(`${out}/summary.json`, JSON.stringify(metadata, null, 2) + '\n');
const cell = (text) => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let table = `# Node ${metadata.nodeVersion} capability ledger\n\nCommit: \`${metadata.engineCommit}\`. Production host-run baseline; browser qualification remains separate.\n\n`;
const headline = `${capabilities.length} measured rows: ${statusCounts.done} done; ${statusCounts.doing} doing; ${statusCounts.todo} todo; ${statusCounts["won't do"]} won't do. Scope enumeration finalized: **${metadata.enumerationFinal ? 'yes' : 'no'}**.`;
table += `${headline}\n\nUnresolved native flows count as todo, not as proof that their undiscovered members have been enumerated. `
  + `Matching public shapes prove structure; test rows prove only their exercised behavior.\n\n`;
table += `| Capability | Layer | Module | State | Metric | Evidence | Limitation reason |\n|---|---|---|---|---|---|---|\n`;
for (const entry of capabilities) table += `| ${[entry.key, entry.layer, entry.module, entry.state, entry.metric, entry.evidence, entry.reason].map(cell).join(' | ')} |\n`;
fs.writeFileSync(`${out}/CAPABILITIES.md`, table);
const summary = `\n${headline} Full table: \`CAPABILITIES.md\` in the measurement artifact.\n`;
fs.appendFileSync(`${out}/summary.md`, summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(headline);
