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
// What a program may DO to each of those names, as Node lets it: assign it, define it with a value, delete it, put it
// back, and define it non-configurable and then walk the globals. Each answer is read back three ways: the property,
// the bare name, and the descriptor. The non-configurable define is last and keeps the name's own value, since it
// cannot be undone.
const kindOf = (d) => !d ? 'none' : 'value' in d ? `value w${+d.writable} e${+d.enumerable} c${+d.configurable}` : `accessor get${+!!d.get} set${+!!d.set} e${+d.enumerable} c${+d.configurable}`;
const said = (f) => { try { return String(f()); } catch (e) { return 'throws ' + (e && e.name); } };
const why = (f) => { try { return String(f()); } catch (e) { return 'throws ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 60); } };
const walkOf = () => why(() => { let n = 0; for (const k in globalThis) n += 1; Object.getOwnPropertyNames(globalThis); Object.getOwnPropertyDescriptors(globalThis); Object.keys(globalThis); return 'ok'; });
for (const name of names) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  const first = globalThis[name];
  // An accessor put back still answers what its setter last stored (Node's lazy globals keep the value in a
  // closure), so the value is put back through it too.
  const restore = () => said(() => { Object.defineProperty(globalThis, name, original); if (globalThis[name] !== first) globalThis[name] = first; return globalThis[name] === first && eval(name) === first; });
  const a = {}, b = {};
  const assign = `assign ${said(() => { globalThis[name] = a; return globalThis[name] === a; })} bare ${said(() => eval(name) === a)} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} restored ${restore()}`;
  const define = `define ${said(() => { Object.defineProperty(globalThis, name, { value: b, writable: true, configurable: true, enumerable: true }); return globalThis[name] === b; })} bare ${said(() => eval(name) === b)} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} restored ${restore()}`;
  const remove = `delete ${said(() => delete globalThis[name])} typeof ${said(() => typeof globalThis[name])} in ${said(() => name in globalThis)} bare ${said(() => typeof eval(name))} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} restored ${restore()}`;
  const reassign = `delete-then-assign ${said(() => { delete globalThis[name]; globalThis[name] = a; return globalThis[name] === a; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} restored ${restore()}`;
  rows.push(`${name} | ${assign} | ${define} | ${remove} | ${reassign}`);
}
// A define that names attributes only, or `writable` only, over a name the program has not made its own: the name
// keeps its kind where the descriptor allows it (an accessor stays one for `enumerable`; `writable` makes it a value),
// and an assignment after it is an ordinary one.
for (const name of names) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  const first = globalThis[name];
  const back = () => said(() => { Object.defineProperty(globalThis, name, original); if (globalThis[name] !== first) globalThis[name] = first; return globalThis[name] === first; });
  const c = {};
  const hidden = `attributes-only ${said(() => { Object.defineProperty(globalThis, name, { enumerable: false }); return globalThis[name] === first; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} assign-after ${said(() => { globalThis[name] = c; return globalThis[name] === c; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} restored ${back()}`;
  const writable = `writable-only ${said(() => { Object.defineProperty(globalThis, name, { writable: true }); return globalThis[name] === first; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} assign-after ${said(() => { globalThis[name] = c; return globalThis[name] === c; })} restored ${back()}`;
  rows.push(`${name} | ${hidden} | ${writable}`);
}
// Names Node does not have and a browser does: a program that makes one (a DOM test setup's `globalThis.window`) has
// made a global like any other.
for (const name of ['window', 'document', 'location']) {
  const a = {}, b = {};
  rows.push(`${name} | at first ${said(() => typeof globalThis[name])} in ${name in globalThis} ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} | assign ${said(() => { globalThis[name] = a; return globalThis[name] === a; })} bare ${said(() => eval(name) === a)} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} walked ${said(() => { for (const k in globalThis) if (k === name) return true; return false; })} | define ${said(() => { Object.defineProperty(globalThis, name, { value: b, writable: true, configurable: true, enumerable: false }); return globalThis[name] === b; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} | delete ${said(() => delete globalThis[name])} typeof ${said(() => typeof globalThis[name])} in ${name in globalThis}`);
}
// The two names a program cannot do without: what a delete of each answers and leaves, and that it can be put back.
{
  const kept = process, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  // An assignment reads back, is another object's while it stands, and takes nothing from the program: the file
  // system still answers, and putting the process back puts it back.
  const stand = { marker: true };
  rows.push(`process | assign ${said(() => { globalThis.process = stand; return globalThis.process === stand; })} fs-still-answers ${said(() => require('fs').existsSync(__filename))} put-back ${said(() => { globalThis.process = kept; return globalThis.process === kept; })}`);
  const removed = said(() => delete globalThis.process), after = said(() => typeof globalThis.process), inAfter = said(() => 'process' in globalThis);
  const back = said(() => { Object.defineProperty(globalThis, 'process', descriptor); return globalThis.process === kept; });
  rows.push(`process | ${kindOf(descriptor)} | delete ${removed} typeof ${after} in ${inAfter} restored ${back}`);
  // `globalThis` is itself a property of the global object: once deleted the bare name is gone too, so the object
  // is held by another name to look at it and to put the property back.
  const G = globalThis, self = Object.getOwnPropertyDescriptor(G, 'globalThis');
  const gone = said(() => delete G.globalThis), left = said(() => typeof G.globalThis), bare = said(() => typeof eval('globalThis'));
  const again = said(() => { Object.defineProperty(G, 'globalThis', self); return G.globalThis === G && eval('globalThis') === G; });
  rows.push(`globalThis | ${kindOf(self)} | delete ${gone} property-typeof ${left} bare-typeof ${bare} restored ${again}`);
}
for (const name of names) {
  const first = globalThis[name];
  rows.push(`${name} | fixed ${said(() => { Object.defineProperty(globalThis, name, { value: first, writable: false, configurable: false, enumerable: true }); return globalThis[name] === first; })} then ${kindOf(Object.getOwnPropertyDescriptor(globalThis, name))} walk ${walkOf()} assign-ignored ${said(() => { globalThis[name] = {}; return globalThis[name] === first; })}`);
}
console.log('ORDER ' + JSON.stringify(rows));
