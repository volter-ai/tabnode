import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { manifest, limitations, namedFailure, moduleFor } from './parity-data.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const out = resolve(arg('out', 'measurement'));
const results = JSON.parse(fs.readFileSync(`${out}/results.json`, 'utf8'));
const native = JSON.parse(fs.readFileSync(`${out}/native.json`, 'utf8'));
const surface = JSON.parse(fs.readFileSync(`${out}/public.json`, 'utf8'));
const exceptions = limitations();
if (!results.fullDenominator || results.nodeVersion !== manifest.nodeVersion || results.nodeCommit !== manifest.nodeCommit
  || JSON.stringify(results.results.map((entry) => entry.file).sort()) !== JSON.stringify(manifest.files)) {
  throw new Error('report requires every file of the pinned Node 24 denominator exactly once');
}
if (native.nodeVersion !== manifest.nodeVersion || surface.nodeVersion !== manifest.nodeVersion) throw new Error('surface reports use another Node version');
const passing = [];
const named = [];
const unnamed = [];
const modules = new Map();
for (const result of results.results) {
  const module = moduleFor(result.file);
  const row = modules.get(module) ?? { module, total: 0, passing: 0, harness: 0, platform: 0, open: 0 };
  row.total++;
  if (result.passed) { passing.push(result.file); row.passing++; }
  else {
    const entry = namedFailure(result, exceptions);
    if (entry) { named.push({ file: result.file, limitation: entry.id, kind: entry.kind, reason: result.reason }); row[entry.kind]++; }
    else { unnamed.push({ file: result.file, reason: result.reason }); row.open++; }
  }
  modules.set(module, row);
}
const counts = {
  unresolvedNativeReads: native.unresolved.length,
  unclassifiedNativeEntries: native.entries.filter((entry) => entry.status === 'UNCLASSIFIED').length + native.staleClassifications.length,
  unnamedTestFailures: unnamed.length,
  unattributedPublicDifferences: new Set([...surface.differences.filter((entry) => !entry.limitation), ...surface.unresolved].map((entry) => entry.key)).size,
};
const pendingReview = exceptions.filter((entry) => entry.review?.verdict !== 'confirmed').map((entry) => entry.id);
const openDefects = Object.values(counts).reduce((sum, n) => sum + n, 0);
const metadata = { nodeVersion: manifest.nodeVersion, nodeCommit: manifest.nodeCommit, engineCommit: process.env.GITHUB_SHA ?? arg('commit', 'unknown'),
  mode: 'production bundle in host Node; window installed after engine import', timeoutMs: results.timeoutMs,
  jobs: results.jobs, durationSeconds: results.durationSeconds, counts, openDefects, pendingReview,
  complete: openDefects === 0 && pendingReview.length === 0,
  denominator: manifest.files.length, passing: passing.length, failingNamed: named.length, failingUnnamed: unnamed.length,
  modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)) };
fs.writeFileSync(`${out}/passing.txt`, passing.join('\n') + '\n');
fs.writeFileSync(`${out}/failing-named.txt`, named.map((entry) => `${entry.file}\t${entry.kind}:${entry.limitation}\t${entry.reason}`).join('\n') + '\n');
fs.writeFileSync(`${out}/failing-unnamed.txt`, unnamed.map((entry) => `${entry.file}\t${entry.reason}`).join('\n') + '\n');
fs.writeFileSync(`${out}/summary.json`, JSON.stringify(metadata, null, 2) + '\n');
let coverage = `tabnode is Node 24, except:\n\n`;
for (const entry of exceptions.filter((entry) => entry.review?.verdict !== 'overturned')) {
  coverage += `- **${entry.id}** (${entry.kind}): ${entry.nodeBehavior} ${entry.reason} Evidence: ${entry.evidence.join('; ')}. Exact tests and surface entries: [LIMITATIONS.md](LIMITATIONS.md).\n`;
}
if (!exceptions.length) coverage += '- No exceptions have been accepted yet.\n';
coverage += `- and ${openDefects} open defects not yet classified\n\n`;
coverage += `Generated from measure on \`${metadata.engineCommit}\`, Node ${manifest.nodeVersion}, production bundle, host-run mode, `
  + `\`node scripts/node-tests.mjs --tests ../node-tests --all --report-json measurement/results.json\`, `
  + `${results.jobs} isolated guest processes at a time, ${results.timeoutMs} ms per file. `
  + `The open count sums unresolved measurement entries across four surfaces; several entries can share one root cause. `
  + `This is not browser-tab qualification. ${pendingReview.length} limitation entries await independent confirmation.\n`;
fs.writeFileSync(`${out}/coverage.md`, coverage);
let summary = `# ${unnamed.length} unnamed Node 24 test failures (open defects)\n\n`;
summary += `Commit: \`${metadata.engineCommit}\`. Denominator: **${manifest.files.length}** files at Node ${manifest.nodeVersion} `
  + `(\`${manifest.nodeCommit}\`). ${passing.length} passing; ${named.length} failing named; ${unnamed.length} failing unnamed.\n\n`;
summary += `| Completion count | Open |\n|---|---:|\n`
  + `| Unresolved native surface reads | ${counts.unresolvedNativeReads} |\n`
  + `| Unclassified native entries | ${counts.unclassifiedNativeEntries} |\n`
  + `| Unattributed test failures | ${counts.unnamedTestFailures} |\n`
  + `| Unattributed public surface differences / unmeasured reads | ${counts.unattributedPublicDifferences} |\n\n`;
summary += `Native inventory: ${native.entries.length} entries. Independent limitation reviews pending: ${pendingReview.length}.\n\n`;
summary += `| Module / test family | Files | Passing | Harness | Platform | Open |\n|---|---:|---:|---:|---:|---:|\n`;
for (const row of metadata.modules) summary += `| ${row.module} | ${row.total} | ${row.passing} | ${row.harness} | ${row.platform} | ${row.open} |\n`;
const lists = [['Passing', passing], ['Failing and named', named.map((entry) => `${entry.file} — ${entry.kind}:${entry.limitation}`)],
  ['Failing and UNNAMED', unnamed.map((entry) => entry.file)]];
for (const [title, list] of lists) {
  summary += `\n<details><summary>${title}: ${list.length}</summary>\n\n\`\`\`text\n${list.join('\n')}\n\`\`\`\n\n</details>\n`;
}
summary += `\n${coverage}`;
fs.writeFileSync(`${out}/summary.md`, summary);
const summaryPath = arg('summary', process.env.GITHUB_STEP_SUMMARY);
if (summaryPath) fs.appendFileSync(summaryPath, summary);
console.log(summary);
if (process.argv.includes('--update-docs')) {
  for (const file of ['README.md', 'BUILTINS.md']) {
    const path = resolve(file);
    const text = fs.readFileSync(path, 'utf8');
    const start = '<!-- node24-coverage:start -->';
    const end = '<!-- node24-coverage:end -->';
    if (!text.includes(start) || !text.includes(end)) throw new Error(`missing generated coverage block in ${file}`);
    fs.writeFileSync(path, text.replace(new RegExp(`${start}[\\s\\S]*?${end}`, 'u'), `${start}\n${coverage}\n${end}`));
  }
}
