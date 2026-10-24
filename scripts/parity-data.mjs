import { readFileSync } from 'node:fs';

export const manifest = JSON.parse(readFileSync(new URL('./node24-test-files.json', import.meta.url), 'utf8'));
export function limitations() {
  const text = readFileSync(new URL('../LIMITATIONS.md', import.meta.url), 'utf8');
  const entries = [...text.matchAll(/^```json\s*\n([\s\S]*?)^```/gm)].map((match) => JSON.parse(match[1]));
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`duplicate or missing limitation id: ${entry.id}`);
    ids.add(entry.id);
    if (!['platform', 'harness'].includes(entry.kind) || !entry.nodeBehavior || !entry.reason || !entry.evidence?.length) {
      throw new Error(`limitation ${entry.id} lacks behavioral evidence`);
    }
    for (const key of ['tests', 'nativeEntries', 'publicEntries']) {
      if (!Array.isArray(entry[key]) || entry[key].some((name) => typeof name !== 'string' || /[*?]/u.test(name))) {
        throw new Error(`limitation ${entry.id} must enumerate exact ${key}`);
      }
    }
    for (const test of entry.tests) {
      if (!manifest.files.includes(test) || !entry.failureIncludes?.[test]?.length) {
        throw new Error(`limitation ${entry.id}: missing test or observed signature for ${test}`);
      }
    }
    if (entry.nativeEntries.length && !entry.errorCode) throw new Error(`limitation ${entry.id} has no named native error`);
  }
  return entries;
}

export function namedFailure(result, entries) {
  return entries.find((entry) => entry.review?.verdict !== 'overturned' && entry.tests.includes(result.file)
    && entry.failureIncludes[result.file].every((signature) => result.stderr.includes(signature)));
}

// Longest module prefix wins; unrecognized families stay in the denominator.
const prefixes = ['child-process', 'worker', 'worker-thread', 'async-hooks', 'async-local-storage',
  'diagnostics-channel', 'diagnostics_channel', 'querystring', 'string-decoder', 'perf-hooks',
  'http2', 'https', 'http', 'net', 'fs', 'stream', 'buffer', 'events', 'util', 'assert', 'path',
  'readline', 'os', 'tty', 'zlib', 'crypto', 'tls', 'dns', 'vm', 'v8', 'dgram', 'cluster',
  'module', 'repl', 'inspector', 'timers', 'process', 'url', 'wasi', 'domain', 'sqlite', 'test-runner']
  .sort((a, b) => b.length - a.length);
export function moduleFor(file) {
  if (file.startsWith('test/wasi/')) return 'wasi';
  const name = file.split('/').at(-1).replace(/^test-/, '').replace(/\.(?:c?js|mjs)$/u, '');
  const prefix = prefixes.find((part) => name === part || name.startsWith(`${part}-`));
  const aliases = { 'worker-thread': 'worker_threads', worker: 'worker_threads', 'async-local-storage': 'async_hooks', 'test-runner': 'node:test' };
  return aliases[prefix] ?? (prefix ?? name.split('-')[0]).replaceAll('-', '_');
}
