// Writes src/node-lib/binding/node-crypto-constants.ts: Node's crypto constants (node_constants.cc
// `DefineCryptoConstants`) as node-deps.wasm's built OpenSSL defines them, read once from the module at build time,
// as Node compiles them into its binary, so a process's bootstrap reads a table and never instantiates OpenSSL to
// answer a constant.
//
// Usage: node scripts/node-crypto-constants.mjs   (run by scripts/build-node-deps-wasm.sh after it writes the module)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(`${repo}src/node-lib/binding/node-deps-wasm.ts`, "utf8");
const base64 = /'([A-Za-z0-9+/=]{1000,})'/u.exec(source)?.[1];
if (!base64) throw new Error("src/node-lib/binding/node-deps-wasm.ts holds no module");
const module = new WebAssembly.Module(Buffer.from(base64, "base64"));

// Reading a constant does no I/O: every import answers ENOSYS (52), as an unused WASI call would.
const imports = {};
for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
  if (kind !== "function") throw new Error(`node-deps.wasm imports a ${kind} ${from}.${name}`);
  (imports[from] ??= {})[name] = () => 52;
}
const deps = new WebAssembly.Instance(module, imports).exports;
deps._initialize?.();

const lengthAt = deps.tn_malloc(4) >>> 0;
const at = deps.tn_crypto_constants(lengthAt) >>> 0;
if (!at) throw new Error("tn_crypto_constants answered nothing");
const length = new DataView(deps.memory.buffer).getUint32(lengthAt, true);
const text = new TextDecoder().decode(new Uint8Array(deps.memory.buffer, at, length).slice());
deps.tn_free(at);
deps.tn_free(lengthAt);

// The module's own line form (tabnode_deps.cc `tn_crypto_constants`): `n NAME value` or `s NAME value`.
const table = {};
for (const line of text.split("\n")) {
  if (!line) continue;
  const space = line.indexOf(" ", 2), name = line.slice(2, space), value = line.slice(space + 1);
  table[name] = line[0] === "n" ? Number(value) : value;
}

const body = Object.entries(table).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},`).join("\n");
writeFileSync(`${repo}src/node-lib/binding/node-crypto-constants.ts`, `/**
 * Node's crypto constants (node_constants.cc \`DefineCryptoConstants\`) as node-deps.wasm's built OpenSSL defines
 * them, written by \`scripts/node-crypto-constants.mjs\` from that module when it is built: compiled in, as Node's are.
 * Do not edit.
 */
export const NODE_CRYPTO_CONSTANTS: Readonly<Record<string, number | string>> = {
${body}
};
`);
console.log(`node-crypto-constants.ts: ${Object.keys(table).length} constants`);
