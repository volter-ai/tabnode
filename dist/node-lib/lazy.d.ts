/**
 * A vendored module object, whose properties are read when they are asked for.
 *
 * A module object is a program's to write on, and packages do: `graceful-fs`
 * -- which half of npm loads, openvscode-server through `fs-extra` and
 * `@vscode/deviceid` -- defines `Symbol.for('graceful-fs.queue')` on `fs` with
 * `Object.defineProperty` and then clones the module, which walks its keys.
 * Every trap here read the loaded module and none read the proxy's own target,
 * where a define with no trap of its own lands: the read came back
 * `undefined`, `key in fs` answered false, and `Reflect.ownKeys(fs)` threw
 * `'ownKeys' on proxy: trap result did not include
 * 'Symbol(graceful-fs.queue)'` -- a proxy may neither hide nor deny a
 * non-configurable own key of its target. graceful-fs threw out of its own
 * module load, so every program that loads it died there: in the substrate's
 * tab, openvscode-server's server at boot and its extension host, which exited
 * 1 without a word because a forked host's console goes to its parent over IPC
 * and the server drops those messages.
 *
 * So a define lands on the module, as it would in Node, and a
 * non-configurable one lands on the target as well because the proxy has to
 * report it from there; every read answers the target first and the module
 * after. This is the shape the guest global's proxy in `src/runtime.ts` uses,
 * for the same reason.
 */
export declare function lazyModule<T extends object>(name: string): T;
/**
 * One export of a vendored module that is a class or a function: callable,
 * constructible, and the same object to `instanceof` as the real one.
 */
export declare function lazyExport<T>(name: string, key: string): T;
//# sourceMappingURL=lazy.d.ts.map