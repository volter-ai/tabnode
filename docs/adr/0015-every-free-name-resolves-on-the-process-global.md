# ADR-0015: Every free name a process's code reads resolves on its global, and nothing falls through to the realm's

Status: Accepted.

Date: 2026-11-10. Served: the manager's ruling for the owner, "every free name an internal library or a guest module
reads resolves on the process's guest global, and nothing falls through to the host realm's globalThis; a name the
guest global doesn't hold is a ReferenceError, as in Node", which the owner named the class: Tabnode reaching around
to the browser's global for what Node gives a process.

## Context

### The instance

Rallly's server in a tab died with

```
ReferenceError: Buffer is not defined
    at lib/dispatcher/client-h1.js (node:internal/deps/undici/undici:7144:21)
```

Node compiles undici's bundle inside its process's context, whose global holds Node's `Buffer`. The engine compiled
it with `new Function('globalThis', 'return function (exports, require, module, process, internalBinding,
primordials) {…}')` (`node-lib/load.ts` `compiledNodeLibFor`): `globalThis` alone was the process's, and every other
free identifier in the file resolved on the realm's own global, which in a browser worker has no `Buffer`. Under a
Node host the same code worked only because that realm's global is a Node worker thread's.

### The class, read from source at 2595132

Each place the engine compiles a process's code bound a list of names and let the rest fall through:
- **Node's library** (`compiledNodeLibFor`): only `globalThis` and the six wrapper names.
- **A dependency** (`loadDependencyFor`, `@emnapi/runtime`): only the names its caller lists.
- **A guest module** (`runtime.ts` `__substrateWrapBody`): the wrapper's 27 parameters, and 28 names
  (`__substrateGuestScopeNames`) rewritten where free (or through `with`); every other free name, `TextDecoder`,
  `AbortController`, `crypto`, `XMLHttpRequest`, `localStorage`, `importScripts`, was the realm's.
- **A function a program makes** (`new Function`), **`vm.runInThisContext`** and **`vm.Script`**: `with (guest
  global) { eval(…) }`, where the guest global itself answered every name it did not know with `Reflect.get(realm,
  name)`, and removed only `document`, `window` and `location`.
- **`vm.runInNewContext`**: a name the sandbox lacks read the realm's.
- **`vm.compileFunction`** and **`Function(…)` called without `new`**: the realm's `Function`, at the realm's scope.
- **`createREPL`**: a generator compiled at the realm's scope.

So the guest global was a view of the realm with three names removed, and a free name a body read was the realm's
whenever no list named it. A package that probes `typeof XMLHttpRequest`, `typeof importScripts` or `typeof
localStorage` took its browser path in a Node program.

### Constraints

- **Speed.** A `with` makes every free name of every function inside it a dynamic lookup at each evaluation, the
  realm's intrinsics included; that is why module bodies stopped using it (`runtime.ts`, S2 K1: Cal's server compiled
  8,456 bodies to its first page). A lookup that runs a proxy trap is far slower than V8's global load cache.
- **`typeof`.** `typeof x` of an unresolvable reference is `"undefined"`; a read throws `ReferenceError`. A `with`
  object cannot tell the two apart: it sees `has` and then `get`, for both.
- **Text.** A prepared body is kept under `PREPARED_MODULES_FORMAT` (`prepared-key.ts`), and a function's source is
  data (`String(fn)` sent to a page or a worker), given back exactly by `Function.prototype.toString`
  (`__substrateUnscopeGuestNames`).

## Decision

### 1. What the guest global holds

A process's global holds exactly what Node v24.21.0's global holds with no flags, plus what the process itself puts
there; it is no longer a view of the realm.
- **Node's names** (`NODE_GLOBAL_NAMES`, `guest-scope.ts`): the globals Node's bootstrap installs
  (`internal/bootstrap/node.js`, `internal/bootstrap/web/exposed-wildcard.js` and `exposed-window-or-worker.js`):
  `global`, `process`, `Buffer`, the timers, `queueMicrotask`, `structuredClone`, `atob`, `btoa`, `performance`,
  `fetch`, `crypto`, `navigator`, `console`, and the interfaces (`URL`, `TextDecoder`, `AbortController`, the web
  streams, `WebSocket`, …). Each is answered as before: the engine's own where it has one (`Buffer`, `URL`, `fetch`
  and undici's interfaces, `MessageChannel`, `performance`, `navigator`, the timers, `atob`, `btoa`,
  `WebAssembly`), else the realm's value of the same name, read live.
- **ECMAScript's names** (`REALM_NAMES`): the language's own globals and V8's (`Object`, `Array`, `Symbol`, `JSON`,
  `Intl`, `WeakRef`, `Iterator`, `undefined`, `eval`, …) are the realm's own. `Promise` is the guest's (its holding
  `Promise`), `WebAssembly` the guest's held namespace, `console` Node's name: those three are Node's names above.
- **What a Node global inherits** from `Object.prototype` (`toString`, `hasOwnProperty`, `constructor`) is found there,
  as Node's global finds it, not on a browser global's own chain (whose `constructor` is
  `DedicatedWorkerGlobalScope`).
- **The engine's plumbing**: a name beginning `__substrate` or `__browserRuntime` is the realm's, so lowered text
  that calls the engine's helpers by bare name keeps working. It is not enumerated.
- **Anything else the realm holds is not the guest's**: `window`, `document`, `self`, `importScripts`,
  `XMLHttpRequest`, `localStorage`, `indexedDB`, `postMessage`, `onmessage`, `WorkerGlobalScope`, `Temporal` (which
  Node v24 lacks), and whatever a host page adds. `get` answers `undefined`, `has` false, and the name is neither an
  own key nor described. The stand-ins that hid `Worker`, `self` and the worker's messaging names are gone: the rule
  hides them.
- **What a process assigns or defines is its own**, on its global's target, enumerable as defined, whatever the name
  (before, a name Node does not give went onto the realm, shared by every process in it and seen by the engine).
  Two exceptions keep their old route: an assignment to one of ECMAScript's names (`globalThis.Map = …`) is the
  realm's, so that a bare `Map` and `globalThis.Map` stay one value (see *Divergences*); a symbol-keyed property is the
  realm's, as before.

### 2. How a free name reaches it: a tree rewrite, with `with` only where names are dynamic

**The rewrite.** Every free identifier of a body is rewritten to a property of the process's scope objects, except
the names left as written:
- `REALM_NAMES`, the engine's plumbing, `arguments`;
- the names the compile site binds itself (a module's 27 wrapper parameters; a Node library file's `exports`,
  `require`, `module`, `process`, `internalBinding`, `primordials`, `globalThis`; a dependency's parameters).

The shapes, each told apart by its own text so a function's source is given back exactly:
- a read, an assignment target, an update operand or a `delete` operand is `__substrateGuestScope.X`;
- a bare call is `(0,__substrateGuestScope["X"])(…)`, keeping Node's undefined receiver;
- a shorthand property is `X: __substrateGuestScope['X']`;
- `typeof X` is `typeof __substrateGuestTypeof.X`;
- `new X` keeps its constructor wrap around the read, and a free `Function(…)` call is now wrapped the same way.

The scope objects, one set per global (`guestScopesOf`, `guest-scope.ts`), made once and read live:
- `__substrateGuestScope` is a proxy whose `get` reads the guest global and throws `ReferenceError: X is not defined`
  when the value is `undefined` and the global does not hold the name; its `set` writes the guest global (an
  assignment it refuses is ignored, as sloppy code ignores it).
- `__substrateGuestTypeof` is the guest global itself, so `typeof` of a name it does not hold is `"undefined"`.

So for rewritten code the answer is exact: a read of a name the guest does not hold is Node's `ReferenceError`, and
`typeof` is `"undefined"`.

**The intrinsics cost nothing.** `Object`, `Array`, `Math`, `JSON`, `Symbol`, `Uint8Array`, `undefined` and every
other name of `REALM_NAMES` are left as written, so V8 resolves them through its global load cache as before: no
lookup through the guest on any hot reference. Neither do the wrapper's parameters (`require`, `module`, `exports`,
`process`, `Buffer`, `console`, the timers, `queueMicrotask`, `structuredClone`, `atob`, `btoa`, `global`,
`globalThis`), which a body reads most.

**`with`, where names are dynamic.** A body the rewrite declines (a `with` statement or a direct `eval` of its own, an
identifier written with escapes, or text that names the engine's reserved scope names), a function made by
`Function` or `AsyncFunction`, a `vm.runInThisContext` script, `vm.compileFunction` and the REPL run inside `with
(W)`, where `W` is a proxy whose `has` is true for a name that is not left to the realm (as above) and that the guest
global or the realm holds. So a name the guest holds is the guest's; a realm-only name is shadowed and reads
`undefined`; a name neither holds falls through and throws; an intrinsic falls through to the realm at once. A
module body's `W` also leaves the wrapper's parameters alone. A script's top-level `this` is the guest global.

### 3. Every compile site takes it

| Site | How |
| --- | --- |
| Module bodies (`runtime.ts` `__substrateScopeGlobalCalls`, `__substrateWrapBody`, `__substrateRunWrapped`) | the rewrite; `W` for a declined body |
| Node's library (`node-lib/load.ts` `compiledNodeLibFor`, `compileNodeLib`) | the rewrite, once a realm per file (a spare's `precompileNodeLib` pays it while idle); `W` if declined |
| A dependency (`load.ts` `loadDependencyFor`) | the rewrite; `W` if declined |
| `new Function`, `AsyncFunction`, `Function(…)` (`__substrateGuestConstructor`, `__substrateFunctionScope`) | `W` |
| `vm.runInThisContext`, `vm.Script#runInThisContext` (`__substrateScriptScope`) | `W`, `this` the guest global |
| `vm.compileFunction` (`__substrateGuestVm`) | `W`, through the function scope |
| `vm.runInNewContext` (`shims/vm.ts`) | a name the sandbox lacks is the realm's only for `REALM_NAMES`, `Promise`, `WebAssembly` and `console` (what V8 puts in a fresh context); any other reads `undefined` |
| `createREPL` (`runtime.ts`) | `W`, leaving the REPL's own `require`, `console`, `process`, `Buffer` |

Not taken, each because it reads no name a process's global answers:
- **primordials** (`load.ts` `primordialsOf`): reads only ECMAScript's names, once a realm, as Node builds them once a
  context from its intrinsics.
- **`path.js`** (`shims/path.ts`) and **`wasi.js`** (`shims/wasi.ts`): Node's files, compiled once a realm, read only
  their parameters and primordials.
- **punycode** (`runtime.ts` `__browserRuntimePunycode`): reads only its parameters.

### 4. A name the realm gains later

Nothing is captured when a scope is made: the guest's held set is a fixed rule (Node's names, ECMAScript's, the
plumbing, and its own), and every answer is read when asked. A name the realm gains later is the guest's only if it is
one of Node's or ECMAScript's names, and is then read live; any other (a page's script, a host's helper) never
reaches a process, and `W` shadows it as soon as the realm holds it. A name the guest gains is answered at once by the
scope objects, which forward to the guest global. The enumeration snapshot of the realm's keys at the guest's start
(`hostAtStart`) is gone: what is enumerated is Node's enumerable names and the guest's own.

### Costs

- **Preparation.** A module body is parsed for the rewrite unless every identifier-like word of its text is a name
  left as written or a keyword (before: unless it named `new`, `eval`, `with` or one of the 28 names). Most bodies
  were parsed already, for `new`. Prepared bodies are kept in the image and the tab's tree, so this is paid once a
  body.
- **The prepared format** moves to `tabnode-prepared-9`: every body prepared before is prepared again once, and a
  consumer that keeps prepared bodies takes a minor release.
- **Node's library** is parsed once a realm per file at its first compile (undici's bundle is the largest).
- **A read of a rewritten name** runs two proxy traps (the scope, then the guest global) and the guest's answer;
  `undefined` costs one `has` trap more. Intrinsics and wrapper parameters run none.
- **`with` code** keeps its dynamic lookups, as before; `W.has` answers an intrinsic from a set without touching the
  guest global.
- **Columns.** A rewritten name lengthens its line, so a stack frame's column on such a line differs; lines do not
  move.

### Divergences from Node, stated

- **In `with` code**, a realm-only name the guest does not hold reads `undefined` instead of throwing (its `typeof`
  is exact). A name neither holds still throws.
- **A strict assignment to an undeclared name** creates it on the guest global instead of throwing.
- **An ECMAScript name assigned on the global** is the realm's, shared by the realm's processes, as it was.
- **Indirect `eval`** (`(0, eval)(s)`, `globalThis.eval(s)`) and a function made through a constructor reached by
  property (`fn.constructor(…)`, `(async () => {}).constructor(…)`) compile at the realm's scope.
- **A sloppy function's `this`** with no receiver is the realm's global, as a function belongs to its realm:
  `Function('return this')()` is not the process's global. Only a realm per process would change it.
- **`vm.runInNewContext`** reads `undefined` for a name the sandbox lacks rather than throwing, and its intrinsics are
  the realm's.

## Where the evidence stops

- **Read:** Tabnode 2595132's `runtime.ts`, `node-lib/load.ts`, `code-transforms.ts`, `shims/vm.ts`, `shims/path.ts`,
  `shims/wasi.ts`, `native-addon.ts`, `host-globals.ts` and `prepared-key.ts`; the list of Node's global names from
  Node's bootstrap files named in §1.
- **Not run.** No test, suite, probe or typecheck, by the owner's rule; the product run is the proof.
