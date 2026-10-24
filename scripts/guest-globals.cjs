// Run under Node and in a guest and compare the lines (each prints one `ORDER [...]` line): scripts/crypto-keys-compare.mjs shows the way to run a file in a guest.
// The globals a walk of `globalThis` meets, as Node has them: each name's descriptor and whether it IS the object the module that owns it exports.
const owners = {
  atob: () => require('buffer').atob, btoa: () => require('buffer').btoa, Buffer: () => require('buffer').Buffer,
  performance: () => require('perf_hooks').performance,
  setTimeout: () => require('timers').setTimeout, clearTimeout: () => require('timers').clearTimeout, setInterval: () => require('timers').setInterval,
  clearInterval: () => require('timers').clearInterval, setImmediate: () => require('timers').setImmediate, clearImmediate: () => require('timers').clearImmediate,
  crypto: () => require('crypto').webcrypto, queueMicrotask: () => queueMicrotask, structuredClone: () => structuredClone, fetch: () => fetch, navigator: () => navigator, global: () => globalThis,
};
const bare = { atob, btoa, Buffer, performance, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, crypto, queueMicrotask, structuredClone, fetch, navigator, global };
const names = ['global', 'clearImmediate', 'setImmediate', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout', 'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'performance', 'fetch', 'crypto', 'navigator', 'Buffer'];
const rows = [];
for (const name of names) {
  const d = Object.getOwnPropertyDescriptor(globalThis, name);
  const kind = !d ? 'none' : 'value' in d ? `value w${+d.writable}` : `accessor get${+!!d.get} set${+!!d.set}`;
  let owner; try { owner = owners[name]() === globalThis[name]; } catch (e) { owner = 'throws'; }
  rows.push(`${name}: ${kind} e${d ? +d.enumerable : '-'} c${d ? +d.configurable : '-'} is-owner's ${owner} bare-is-global ${bare[name] === globalThis[name]} same-twice ${globalThis[name] === globalThis[name]} typeof ${typeof globalThis[name]}`);
}
const walk = []; for (const n in globalThis) walk.push(n);
rows.push('walk: ' + walk.filter((n) => !['__filename', 'module', 'exports', '__dirname', 'require'].includes(n)).sort().join(' '));
rows.push('reachable typeof: ' + ['self', 'window', 'document', 'postMessage', 'addEventListener', 'Worker', 'location', 'importScripts'].map((n) => n + '=' + typeof globalThis[n]).join(' '));
console.log('ORDER ' + JSON.stringify(rows));
