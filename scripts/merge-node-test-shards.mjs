// Join complete shard receipts, refusing missing, duplicate or mixed inputs.
// This reads retained results only; it runs no test and invents no result.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { manifest } from './parity-data.mjs';
import { shardFiles } from './node-test-shards.mjs';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const input = resolve(arg('input', 'measurement/shards'));
const output = resolve(arg('out', 'measurement/results.json'));
const expectedCount = Number(arg('shard-count', '16'));
const files = readdirSync(input).filter(name => /^shard-\d+\.json$/.test(name));
if (files.length !== expectedCount) throw new Error(`expected ${expectedCount} shard receipts, got ${files.length}`);
const reports = files.map(name => JSON.parse(readFileSync(resolve(input, name), 'utf8')));
const first = reports[0];
const seen = new Set();
const identical = ['nodeVersion', 'nodeCommit', 'engineCommit', 'engineIntegrity', 'timeoutMs', 'jobs', 'shardCount'];
if (!/^[0-9a-f]{40}$/.test(first.engineCommit) || !/^[0-9a-f]{64}$/.test(first.engineIntegrity)
  || first.nodeVersion !== manifest.nodeVersion || first.nodeCommit !== manifest.nodeCommit
  || !Number.isFinite(first.timeoutMs) || first.timeoutMs <= 0 || !Number.isSafeInteger(first.jobs) || first.jobs < 1) {
  throw new Error('shards lack pinned source, bundle, Node or execution identity');
}
for (const report of reports) {
  if (report.shardCount !== expectedCount || report.fullSelection !== true
    || identical.some(key => report[key] !== first[key]) || seen.has(report.shardIndex)) {
    throw new Error('duplicate, partial-selection or mixed-identity shard receipt');
  }
  const expected = shardFiles(manifest.files, report.shardIndex, expectedCount);
  if (JSON.stringify(report.results.map(row => row.file).sort()) !== JSON.stringify(expected)
    || report.results.some(row => typeof row.passed !== 'boolean' || typeof row.stderr !== 'string')
    || !Number.isFinite(report.startedAtMs) || !Number.isFinite(report.completedAtMs)
    || report.completedAtMs < report.startedAtMs || !Number.isFinite(report.durationSeconds) || report.durationSeconds < 0) {
    throw new Error(`incomplete or malformed shard ${report.shardIndex}`);
  }
  seen.add(report.shardIndex);
}
const results = reports.flatMap(report => report.results).sort((a, b) => a.file.localeCompare(b.file));
if (JSON.stringify(results.map(row => row.file).sort()) !== JSON.stringify(manifest.files)) throw new Error('shard union differs from the full immutable denominator');
const startedAtMs = Math.min(...reports.map(report => report.startedAtMs));
const completedAtMs = Math.max(...reports.map(report => report.completedAtMs));
const { shardIndex, ...identity } = first;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ ...identity, fullDenominator: true, startedAtMs, completedAtMs,
  durationSeconds: (completedAtMs - startedAtMs) / 1000,
  summedShardSeconds: reports.reduce((total, report) => total + report.durationSeconds, 0),
  shards: reports.map(report => ({ index: report.shardIndex, durationSeconds: report.durationSeconds, count: report.results.length })).sort((a,b) => a.index-b.index),
  results }, null, 2) + '\n');
console.log(`Retained every one of ${results.length} pinned Node files across ${expectedCount} shards`);
